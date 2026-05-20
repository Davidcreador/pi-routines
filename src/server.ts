/**
 * @file server.ts — embedded `node:http` server for API-triggered routines.
 *
 * Lifecycle: OFF by default. Started by `/routine-server start [port]`,
 * stopped by `/routine-server stop` and by the extension cleanup hook.
 *
 * Security posture (see PROMPT.md → Security Requirements):
 *   - Bind 127.0.0.1 ONLY.
 *   - Re-check `req.socket.remoteAddress` is loopback at request time.
 *   - Reject any method other than POST.
 *   - Reject Host headers that don't match `127.0.0.1[:port]` / `localhost[:port]`.
 *   - Reject bodies > 4 KiB.
 *   - Per-token bucket rate limit: 60 req/min.
 *   - Tokens compared in constant time; never logged in full.
 *
 * The server only knows how to enqueue \u2014 actual firing is gated through
 * the scheduler's idle/drain logic, identical to all other trigger kinds.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nanoid } from "nanoid";
import { drainQueue } from "./scheduler.ts";
import { verifyToken } from "./tokens.ts";
import { resolveRoutine } from "./tools/_resolve.ts";
import type { ApiTrigger, RoutineRuntimeState } from "./types.ts";
import { MAX_QUEUE_DEPTH, MULTI_TRIGGER_COLLAPSE_MS } from "./types.ts";

/** Default port if none supplied. */
export const DEFAULT_PORT = 7424;
/** Max body size accepted (bytes). */
const MAX_BODY_BYTES = 4 * 1024;
/** Rate limit window (ms) and capacity per token. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_CAPACITY = 60;

/** Live server state. Stored on a module-level singleton so cleanup is easy. */
interface ServerState {
	server: Server;
	port: number;
	startedAt: number;
	requestCount: number;
	rate: Map<string, number[]>; // routineId -> request timestamps within window
}

let active: ServerState | null = null;

/** True if the server is currently listening. */
export function isServerRunning(): boolean {
	return active !== null;
}

/** Snapshot for the status command. */
export function serverStatus(): {
	running: boolean;
	port: number | null;
	uptimeMs: number;
	requestCount: number;
} {
	if (!active) return { running: false, port: null, uptimeMs: 0, requestCount: 0 };
	return {
		running: true,
		port: active.port,
		uptimeMs: Date.now() - active.startedAt,
		requestCount: active.requestCount,
	};
}

function isLoopback(addr: string | undefined): boolean {
	if (!addr) return false;
	// Strip IPv6-mapped IPv4 prefix.
	const a = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
	return a === "127.0.0.1" || a === "::1" || a === "localhost";
}

function isAllowedHost(host: string | undefined, port: number): boolean {
	if (!host) return false;
	const candidates = [
		"127.0.0.1",
		`127.0.0.1:${port}`,
		"localhost",
		`localhost:${port}`,
		"[::1]",
		`[::1]:${port}`,
	];
	return candidates.includes(host);
}

/** Bump the in-window count for a token; return true if over capacity. */
function isRateLimited(state: ServerState, routineId: string): boolean {
	const now = Date.now();
	const arr = state.rate.get(routineId) ?? [];
	const cutoff = now - RATE_LIMIT_WINDOW_MS;
	const fresh = arr.filter((t) => t > cutoff);
	if (fresh.length >= RATE_LIMIT_CAPACITY) {
		state.rate.set(routineId, fresh);
		return true;
	}
	fresh.push(now);
	state.rate.set(routineId, fresh);
	return false;
}

/** Read up to MAX_BODY_BYTES of body; reject (throw) if exceeded. */
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let total = 0;
		let rejected = false;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			if (rejected) return;
			total += chunk.length;
			if (total > MAX_BODY_BYTES) {
				rejected = true;
				reject(new Error("body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!rejected) resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", (e) => {
			if (!rejected) reject(e);
		});
	});
}

/** Sanitize caller-supplied args: cap depth 3, cap stringified to 1 KiB. */
function sanitizeArgs(raw: unknown): Record<string, unknown> | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	function checkDepth(v: unknown, depth: number): boolean {
		if (depth > 3) return false;
		if (v === null || typeof v !== "object") return true;
		for (const child of Object.values(v as Record<string, unknown>)) {
			if (!checkDepth(child, depth + 1)) return false;
		}
		return true;
	}
	if (!checkDepth(raw, 1)) return null;
	const json = JSON.stringify(raw);
	if (json.length > 1024) return null;
	return raw as Record<string, unknown>;
}

interface StartContext {
	pi: ExtensionAPI;
	getCtx: () => ExtensionContext | null;
}

/**
 * Start the HTTP server. Returns the actual bound port (useful when caller
 * passes `0` for "pick any free port"). Idempotent on success: a second call
 * with the server already running returns the existing port.
 */
export async function startServer(
	runtime: RoutineRuntimeState,
	port: number,
	ctx: StartContext,
): Promise<number> {
	if (active) return active.port;

	const server = createServer((req, res) => {
		void handleRequest(req, res, runtime, ctx).catch((err) => {
			console.error("[pi-routines] server handler error:", err);
			try {
				res.writeHead(500);
				res.end();
			} catch {
				/* ignore */
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onErr = (err: Error) => {
			server.removeListener("listening", onOk);
			reject(err);
		};
		const onOk = () => {
			server.removeListener("error", onErr);
			resolve();
		};
		server.once("error", onErr);
		server.once("listening", onOk);
		server.listen(port, "127.0.0.1");
	});

	const addr = server.address();
	const boundPort = typeof addr === "object" && addr ? addr.port : port;
	active = {
		server,
		port: boundPort,
		startedAt: Date.now(),
		requestCount: 0,
		rate: new Map(),
	};
	return boundPort;
}

/** Stop the HTTP server. Idempotent. */
export async function stopServer(_runtime: RoutineRuntimeState): Promise<void> {
	if (!active) return;
	const { server } = active;
	active = null;
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
		// Force-close any keepalive connections so we don't hang on shutdown.
		server.closeAllConnections?.();
	});
}

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	runtime: RoutineRuntimeState,
	ctx: StartContext,
): Promise<void> {
	if (!active) {
		res.writeHead(503);
		res.end();
		return;
	}
	active.requestCount++;

	// 1. Loopback re-check (defense in depth).
	if (!isLoopback(req.socket.remoteAddress ?? undefined)) {
		res.writeHead(403);
		res.end();
		return;
	}

	// 2. Method.
	if (req.method !== "POST") {
		res.writeHead(405);
		res.end();
		return;
	}

	// 3. Host header allowlist (DNS-rebinding defense).
	if (!isAllowedHost(req.headers.host, active.port)) {
		res.writeHead(403);
		res.end();
		return;
	}

	// 4. Route parse: POST /routines/:id/trigger
	const url = req.url ?? "";
	const m = /^\/routines\/([^/]+)\/trigger$/.exec(url);
	if (!m) {
		res.writeHead(404);
		res.end();
		return;
	}
	const routineId = decodeURIComponent(m[1] ?? "");

	// 5. Auth.
	const authHeader = req.headers.authorization ?? "";
	const bearer = /^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim();
	if (!bearer) {
		res.writeHead(401);
		res.end();
		return;
	}
	const routine = resolveRoutine(runtime.store, routineId);
	if (!routine) {
		// Don't leak existence info — verify against a placeholder so timing
		// is comparable to an unknown-id case is not strictly needed here:
		// the spec maps "no such routine" to 404. We DO require auth first
		// so we don't reveal routine ids to unauthenticated callers; since
		// the token is keyed by routineId, an unknown id can never have a
		// valid token, so a 401 is technically also correct. Spec: 404.
		// Apply 401 first if token is structurally bad, else 404.
		res.writeHead(404);
		res.end();
		return;
	}
	const ok = await verifyToken(routine.id, bearer);
	if (!ok) {
		res.writeHead(401);
		res.end();
		return;
	}

	// 6. Confirm the routine actually has an "api" trigger.
	const apiTrigger = routine.triggers.find((t): t is ApiTrigger => t.kind === "api");
	if (!apiTrigger) {
		res.writeHead(404);
		res.end();
		return;
	}

	// 6b. Paused routines refuse api fires (HTTP 423 Locked). Resume with
	// /routine-resume to re-enable.
	if (routine.paused) {
		res.writeHead(423, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "routine is paused" }));
		return;
	}

	// 7. Rate-limit.
	if (isRateLimited(active, routine.id)) {
		res.writeHead(429);
		res.end();
		return;
	}

	// 8. Body parse (optional).
	let bodyText = "";
	try {
		bodyText = await readBody(req);
	} catch {
		res.writeHead(413);
		res.end();
		return;
	}
	let args: Record<string, unknown> | null = null;
	if (bodyText.length > 0) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(bodyText);
		} catch {
			res.writeHead(400);
			res.end();
			return;
		}
		if (parsed && typeof parsed === "object" && "args" in (parsed as object)) {
			const raw = (parsed as { args: unknown }).args;
			if (apiTrigger.allowArgs) {
				args = sanitizeArgs(raw);
				if (args === null && raw !== undefined) {
					res.writeHead(400);
					res.end();
					return;
				}
			}
			// If allowArgs is false, args are silently dropped.
		}
	}

	// 9. Enqueue (same logic shape as scheduler.onTriggerFire).
	const runId = nanoid();
	const triggerIndex = routine.triggers.indexOf(apiTrigger);

	if (!runtime.queue.includes(routine.id)) {
		if (runtime.queue.length >= MAX_QUEUE_DEPTH) runtime.queue.shift();
		runtime.triggerOrigin.set(routine.id, { index: triggerIndex, kind: "api" });
		if (args) {
			runtime.apiArgs ??= new Map();
			runtime.apiArgs.set(routine.id, args);
		}
		runtime.queue.push(routine.id);
		// Collapse window bookkeeping is per-scheduler; the API path uses its
		// own dedup (queue.includes) so multi-trigger collisions across api+pulse
		// within MULTI_TRIGGER_COLLAPSE_MS still get deduped via the queue.
		void MULTI_TRIGGER_COLLAPSE_MS; // (referenced for documentation)
	}

	// Best-effort kickoff; do not await downstream LLM turn.
	void drainQueue(runtime, ctx.pi, ctx.getCtx).catch((err) => {
		console.error("[pi-routines] api-trigger drain failed:", err);
	});

	res.writeHead(202, { "content-type": "application/json" });
	res.end(JSON.stringify({ runId }));
}
