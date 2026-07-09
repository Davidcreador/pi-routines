import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	commitHookFire,
	hookFireKey,
	resetSessionHookFires,
	shouldFireHook,
} from "../src/guard.ts";
import { emptyStore } from "../src/store.ts";
import type { HookTrigger, RoutineRuntimeState, RoutineTickState } from "../src/types.ts";

function runtime(): RoutineRuntimeState {
	return {
		store: emptyStore(),
		timers: new Map(),
		queue: [],
		isRoutineTurnActive: false,
		activeRoutineName: null,
		lastUiCtx: null,
		sessionHookFires: new Set(),
		triggerOrigin: new Map(),
		pendingRun: null,
	};
}

function tickState(): RoutineTickState {
	return {
		tickCount: 0,
		lastFiredAt: 0,
		lastFiredDateLocal: "",
		userState: {},
	};
}

describe("hook once guards", () => {
	it("fails closed when per-session state is unavailable", () => {
		const trigger: HookTrigger = {
			kind: "hook",
			event: "session_start",
			once: "per_session",
		};
		assert.equal(shouldFireHook(trigger, undefined), false);
	});

	it("commits and resets a per-session marker", () => {
		const rt = runtime();
		const state = tickState();
		const trigger: HookTrigger = {
			kind: "hook",
			event: "session_start",
			once: "per_session",
		};
		const key = hookFireKey("r1", trigger.event, 0);

		assert.equal(shouldFireHook(trigger, state, rt, key), true);
		commitHookFire(trigger, state, rt, key);
		assert.equal(shouldFireHook(trigger, state, rt, key), false);
		resetSessionHookFires(rt);
		assert.equal(shouldFireHook(trigger, state, rt, key), true);
	});

	it("tracks daily markers independently by trigger key", () => {
		const rt = runtime();
		const state = tickState();
		const trigger: HookTrigger = {
			kind: "hook",
			event: "agent_end",
			once: "daily",
		};
		const first = hookFireKey("r1", trigger.event, 0);
		const second = hookFireKey("r1", trigger.event, 1);

		commitHookFire(trigger, state, rt, first);

		assert.equal(shouldFireHook(trigger, state, rt, first), false);
		assert.equal(shouldFireHook(trigger, state, rt, second), true);
	});
});
