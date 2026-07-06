import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { request as httpRequest } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-srv-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { startServer, stopServer } = await import("../src/server.ts");
const tokens = await import("../src/tokens.ts");
const { emptyStore } = await import("../src/store.ts");

import type { Routine, RoutineRuntimeState } from "../src/types.ts";

after(async () => {
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	await fs.rm(tmpHome, { recursive: true, force: true });
});

function makeRuntime(): RoutineRuntimeState {
	return {
		store: emptyStore(),
		timers: new Map(),
		queue: [],
		isRoutineTurnActive: false,
		activeRoutineName: null,
		lastUiCtx: null,
		triggerOrigin: new Map(),
		pendingRun: null,
	};
}

function makeRoutine(id: string, allowArgs = false): Routine {
	return {
		id,
		name: id,
		prompt: "hello",
		triggers: [{ kind: "api", allowArgs }],
		context: "session",
		quiet: false,
		createdAt: 0,
	};
}

// Minimal ExtensionAPI stub — `drainQueue` calls `getCtx()` and we return
// null so it exits early. The server enqueues regardless.
const fakePi = {} as unknown as Parameters<typeof startServer>[2]["pi"];
const getCtx = () => null as unknown as ReturnType<Parameters<typeof startServer>[2]["getCtx"]>;

let runtime: RoutineRuntimeState;
let port: number;

beforeEach(async () => {
	tokens._resetTokenCache();
	await fs.rm(path.dirname(path.join(tmpHome, ".pi/agent/extensions/routines/tokens.json")), {
		recursive: true,
		force: true,
	});
	runtime = makeRuntime();
	port = await startServer(runtime, 0, { pi: fakePi, getCtx });
});

afterEach(async () => {
	await stopServer(runtime);
});

async function request(opts: {
	method?: string;
	pathname: string;
	headers?: Record<string, string>;
	body?: string;
	host?: string;
}): Promise<{ status: number; body: string }> {
	const url = `http://127.0.0.1:${port}${opts.pathname}`;
	const res = await fetch(url, {
		method: opts.method ?? "POST",
		headers: {
			host: opts.host ?? `127.0.0.1:${port}`,
			...opts.headers,
		},
		body: opts.body,
	});
	return { status: res.status, body: await res.text() };
}

describe("server — auth", () => {
	it("returns 202 with valid token", async () => {
		const r = makeRoutine("r1");
		runtime.store.routines[r.id] = r;
		const token = await tokens.generateToken(r.id);
		const res = await request({
			pathname: "/routines/r1/trigger",
			headers: { authorization: `Bearer ${token}` },
		});
		assert.equal(res.status, 202);
		const json = JSON.parse(res.body);
		assert.ok(typeof json.runId === "string" && json.runId.length > 0);
		assert.equal(runtime.queue.length, 1);
		assert.equal(typeof runtime.queue[0], "object");
		assert.equal(typeof runtime.queue[0] === "object" ? runtime.queue[0].routineId : "", "r1");
	});

	it("401 on wrong token", async () => {
		const r = makeRoutine("r1");
		runtime.store.routines[r.id] = r;
		await tokens.generateToken(r.id);
		const res = await request({
			pathname: "/routines/r1/trigger",
			headers: { authorization: "Bearer wrong" },
		});
		assert.equal(res.status, 401);
	});

	it("401 on missing Authorization header", async () => {
		const r = makeRoutine("r1");
		runtime.store.routines[r.id] = r;
		await tokens.generateToken(r.id);
		const res = await request({ pathname: "/routines/r1/trigger" });
		assert.equal(res.status, 401);
	});

	it("404 on unknown routine", async () => {
		const res = await request({
			pathname: "/routines/nope/trigger",
			headers: { authorization: "Bearer anything" },
		});
		assert.equal(res.status, 404);
	});

	it("404 if routine exists but has no api trigger", async () => {
		runtime.store.routines.r1 = {
			id: "r1",
			name: "r1",
			prompt: "",
			triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
			context: "session",
			quiet: false,
			createdAt: 0,
		};
		await tokens.generateToken("r1");
		const token = await tokens.generateToken("r1");
		const res = await request({
			pathname: "/routines/r1/trigger",
			headers: { authorization: `Bearer ${token}` },
		});
		assert.equal(res.status, 404);
	});
});

describe("server — method/host hardening", () => {
	it("405 on non-POST method", async () => {
		const res = await request({ pathname: "/routines/r1/trigger", method: "GET" });
		assert.equal(res.status, 405);
	});

	it("403 on disallowed Host header (DNS-rebinding defense)", async () => {
		const r = makeRoutine("r1");
		runtime.store.routines[r.id] = r;
		const token = await tokens.generateToken(r.id);
		// fetch() overrides Host from the URL, so use node:http directly.
		const status = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				{
					host: "127.0.0.1",
					port,
					method: "POST",
					path: "/routines/r1/trigger",
					headers: {
						Host: "evil.example.com",
						authorization: `Bearer ${token}`,
					},
				},
				(res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				},
			);
			req.on("error", reject);
			req.end();
		});
		assert.equal(status, 403);
	});
});

describe("server — rate limiting", () => {
	it("returns 429 after 60 requests in window", async () => {
		const r = makeRoutine("r1");
		runtime.store.routines[r.id] = r;
		const token = await tokens.generateToken(r.id);
		const headers = { authorization: `Bearer ${token}` };
		let last = 0;
		for (let i = 0; i < 61; i++) {
			const res = await request({ pathname: "/routines/r1/trigger", headers });
			last = res.status;
		}
		assert.equal(last, 429);
	});
});

describe("server — body & args", () => {
	it("rejects body > 4KiB with 413", async () => {
		const r = makeRoutine("r1");
		runtime.store.routines[r.id] = r;
		const token = await tokens.generateToken(r.id);
		const big = JSON.stringify({ args: { x: "a".repeat(5000) } });
		const res = await request({
			pathname: "/routines/r1/trigger",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: big,
		});
		assert.equal(res.status, 413);
	});

	it("ignores args when allowArgs is false", async () => {
		const r = makeRoutine("r1", false);
		runtime.store.routines[r.id] = r;
		const token = await tokens.generateToken(r.id);
		const res = await request({
			pathname: "/routines/r1/trigger",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ args: { greeting: "hi" } }),
		});
		assert.equal(res.status, 202);
		// apiArgs should NOT be set since allowArgs:false drops them.
		assert.equal(runtime.apiArgs?.get("r1"), undefined);
	});

	it("accepts and stores args when allowArgs is true", async () => {
		const r = makeRoutine("r1", true);
		runtime.store.routines[r.id] = r;
		const token = await tokens.generateToken(r.id);
		const res = await request({
			pathname: "/routines/r1/trigger",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ args: { greeting: "hi" } }),
		});
		assert.equal(res.status, 202);
		const entry = runtime.queue[0];
		assert.deepEqual(typeof entry === "object" ? entry.apiArgs : undefined, { greeting: "hi" });
	});

	it("accepts Claude-style /fire body text when allowArgs is true", async () => {
		const r = makeRoutine("r1", true);
		runtime.store.routines[r.id] = r;
		const token = await tokens.generateToken(r.id);
		const res = await request({
			pathname: "/routines/r1/fire",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ text: "deploy finished" }),
		});
		assert.equal(res.status, 202);
		const entry = runtime.queue[0];
		assert.deepEqual(typeof entry === "object" ? entry.apiArgs : undefined, {
			text: "deploy finished",
		});
	});

	it("rejects deeply nested args with 400", async () => {
		const r = makeRoutine("r1", true);
		runtime.store.routines[r.id] = r;
		const token = await tokens.generateToken(r.id);
		const deep = { a: { b: { c: { d: 1 } } } }; // depth 5
		const res = await request({
			pathname: "/routines/r1/trigger",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ args: deep }),
		});
		assert.equal(res.status, 400);
	});
});

describe("server — paused routines", () => {
	it("returns 423 Locked when the routine is paused", async () => {
		const r = makeRoutine("r1");
		r.paused = true;
		runtime.store.routines[r.id] = r;
		const token = await tokens.generateToken(r.id);
		const res = await request({
			pathname: "/routines/r1/trigger",
			headers: { authorization: `Bearer ${token}` },
		});
		assert.equal(res.status, 423);
		// And, importantly, no enqueue happened.
		assert.equal(runtime.queue.length, 0);
		assert.equal(runtime.store.tickState.r1?.runs?.at(-1)?.status, "skipped");
		assert.equal(runtime.store.tickState.r1?.runs?.at(-1)?.skipReason, "paused");
	});

	it("returns 202 again after resume", async () => {
		const r = makeRoutine("r1");
		r.paused = true;
		runtime.store.routines[r.id] = r;
		const token = await tokens.generateToken(r.id);
		let res = await request({
			pathname: "/routines/r1/trigger",
			headers: { authorization: `Bearer ${token}` },
		});
		assert.equal(res.status, 423);
		delete r.paused;
		res = await request({
			pathname: "/routines/r1/trigger",
			headers: { authorization: `Bearer ${token}` },
		});
		assert.equal(res.status, 202);
	});
});
