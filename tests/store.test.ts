import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// IMPORTANT: STATE_FILE is captured at module-load time from $HOME. We set
// HOME to a fresh tmp dir BEFORE importing src/types.ts (transitively via
// src/store.ts) so the loader picks up the test path.
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-test-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const stateFile = path.join(tmpHome, ".pi/agent/extensions/routines/state.json");
const { emptyStore, migrateV1ToV2, loadStore, saveStore } = await import("../src/store.ts");
const { SCHEMA_VERSION } = await import("../src/types.ts");

after(async () => {
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	await fs.rm(tmpHome, { recursive: true, force: true });
});

async function clearState() {
	await fs.rm(path.dirname(stateFile), { recursive: true, force: true });
}

describe("emptyStore", () => {
	it("returns a fresh store with empty maps", () => {
		const s = emptyStore();
		assert.deepEqual(s.routines, {});
		assert.deepEqual(s.tickState, {});
		assert.equal(s.schemaVersion, SCHEMA_VERSION);
	});
	it("returns a fresh object each call", () => {
		const a = emptyStore();
		const b = emptyStore();
		assert.notEqual(a, b);
	});
});

describe("migrateV1ToV2 (pure)", () => {
	it("wraps singular trigger into triggers[]", () => {
		const v1 = {
			routines: {
				abc: {
					id: "abc",
					name: "x",
					prompt: "hi",
					trigger: { kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" },
					context: "session",
					quiet: false,
					createdAt: 1,
				},
			},
			tickState: { abc: { tickCount: 0, lastFiredAt: 0, lastFiredDateLocal: "", userState: {} } },
		};
		const out = migrateV1ToV2(v1);
		assert.equal(out.schemaVersion, SCHEMA_VERSION);
		const r = out.routines.abc as unknown as { triggers: unknown[]; trigger?: unknown };
		assert.ok(Array.isArray(r.triggers));
		assert.equal(r.triggers.length, 1);
		assert.equal(r.trigger, undefined);
	});
	it("is idempotent on v2 input", () => {
		const v2 = {
			schemaVersion: SCHEMA_VERSION,
			routines: {
				abc: {
					id: "abc",
					name: "x",
					prompt: "hi",
					triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
					context: "session",
					quiet: false,
					createdAt: 1,
				},
			},
			tickState: {},
		};
		const out = migrateV1ToV2(v2);
		const r = out.routines.abc as unknown as { triggers: unknown[] };
		assert.equal(r.triggers.length, 1);
	});
	it("returns empty store on garbage input", () => {
		assert.deepEqual(migrateV1ToV2(null).routines, {});
		assert.deepEqual(migrateV1ToV2("x").routines, {});
	});
});

describe("loadStore (filesystem)", () => {
	before(async () => {
		await clearState();
	});

	it("missing file: returns emptyStore", async () => {
		await clearState();
		const s = await loadStore();
		assert.equal(s.schemaVersion, SCHEMA_VERSION);
		assert.deepEqual(s.routines, {});
	});

	it("v1 file: migrates, writes .v1.bak, keeps original content backed up", async () => {
		await clearState();
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		const v1 = {
			routines: {
				abc: {
					id: "abc",
					name: "x",
					prompt: "hi",
					trigger: { kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" },
					context: "session",
					quiet: false,
					createdAt: 1,
				},
			},
			tickState: {},
		};
		await fs.writeFile(stateFile, JSON.stringify(v1), "utf8");

		const loaded = await loadStore();
		assert.equal(loaded.schemaVersion, SCHEMA_VERSION);
		const r = loaded.routines.abc as unknown as { triggers: unknown[] };
		assert.equal(r.triggers.length, 1);

		const bak = JSON.parse(await fs.readFile(`${stateFile}.v1.bak`, "utf8"));
		assert.equal(bak.routines.abc.trigger.kind, "pulse");

		// File on disk is now v2.
		const written = JSON.parse(await fs.readFile(stateFile, "utf8"));
		assert.equal(written.schemaVersion, SCHEMA_VERSION);
	});

	it("v2 file: no migration, no .v1.bak written", async () => {
		await clearState();
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		await saveStore(emptyStore()); // produces a clean v2 file
		// Remove any pre-existing .v1.bak from previous test.
		await fs.rm(`${stateFile}.v1.bak`, { force: true });

		await loadStore();
		await assert.rejects(fs.access(`${stateFile}.v1.bak`));
	});

	it("corrupt file: falls back to emptyStore", async () => {
		await clearState();
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		await fs.writeFile(stateFile, "{not json", "utf8");
		const s = await loadStore();
		assert.deepEqual(s.routines, {});
	});
});
