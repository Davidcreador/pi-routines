import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { emptyStore } from "../src/store.ts";

describe("emptyStore", () => {
	it("returns a fresh store with empty maps", () => {
		const s = emptyStore();
		assert.deepEqual(s.routines, {});
		assert.deepEqual(s.tickState, {});
	});
	it("returns a fresh object each call", () => {
		const a = emptyStore();
		const b = emptyStore();
		assert.notEqual(a, b);
	});
});
