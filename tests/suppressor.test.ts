import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSuppressor } from "../src/suppressor.ts";
import { emptyStore } from "../src/store.ts";
import type { Routine, RoutineRuntimeState } from "../src/types.ts";

type MessageEndHandler = (event: {
	message: { role: string; content: unknown };
}) => unknown;

function makeRuntime(quiet: boolean): RoutineRuntimeState {
	const routine: Routine = {
		id: "r1",
		name: "watch",
		prompt: "go",
		triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
		context: "session",
		quiet,
		createdAt: 0,
	};
	const rt: RoutineRuntimeState = {
		store: emptyStore(),
		timers: new Map(),
		queue: [],
		isRoutineTurnActive: true,
		activeRoutineName: routine.name,
		lastUiCtx: null,
		triggerOrigin: new Map(),
		pendingRun: {
			routineId: routine.id,
			runId: "run-1",
			triggerIndex: 0,
			triggerKind: "pulse",
			startedAt: 0,
			snippet: "",
			status: "success",
		},
	};
	rt.store.routines[routine.id] = routine;
	rt.store.tickState[routine.id] = {
		tickCount: 1,
		lastFiredAt: 0,
		lastFiredDateLocal: "",
		userState: {},
	};
	return rt;
}

function captureHandler(runtime: RoutineRuntimeState): MessageEndHandler {
	let handler: MessageEndHandler | undefined;
	const pi = {
		on(eventName: string, cb: MessageEndHandler) {
			if (eventName === "message_end") handler = cb;
		},
	} as unknown as ExtensionAPI;
	registerSuppressor(pi, runtime);
	assert.ok(handler);
	return handler;
}

describe("suppressor", () => {
	it("collapses exact silent token for quiet routines", () => {
		const rt = makeRuntime(true);
		const handler = captureHandler(rt);
		const result = handler({ message: { role: "assistant", content: " [~]\n" } });

		assert.equal(rt.pendingRun?.status, "silent");
		assert.equal(rt.pendingRun?.snippet, "[~]");
		assert.match(JSON.stringify(result), /quiet/);
	});

	it("leaves verbose routines' silent token visible", () => {
		const rt = makeRuntime(false);
		const handler = captureHandler(rt);
		const result = handler({ message: { role: "assistant", content: "[~]" } });

		assert.equal(result, undefined);
		assert.equal(rt.pendingRun?.status, "success");
		assert.equal(rt.pendingRun?.snippet, "[~]");
	});

	it("captures snippets from text blocks", () => {
		const rt = makeRuntime(true);
		const handler = captureHandler(rt);
		const result = handler({
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "text", text: "world" },
				],
			},
		});

		assert.equal(result, undefined);
		assert.equal(rt.pendingRun?.status, "success");
		assert.equal(rt.pendingRun?.snippet, "hello world");
	});
});
