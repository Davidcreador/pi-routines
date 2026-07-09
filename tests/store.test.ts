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
const { beginStoreGeneration, emptyStore, migrateV1ToV2, loadStore, saveStore } =
	await import("../src/store.ts");
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
		assert.deepEqual(s.deferredHooks, []);
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

	it("quarantines malformed routines while retaining valid entries", async () => {
		await clearState();
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		await fs.writeFile(
			stateFile,
			JSON.stringify({
				schemaVersion: SCHEMA_VERSION,
				routines: {
					valid: {
						id: "valid",
						name: "valid",
						prompt: "run",
						triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
						context: "session",
						quiet: false,
						createdAt: 1,
					},
					broken: {
						id: "broken",
						name: "broken",
						prompt: "run",
						triggers: null,
						context: "session",
						quiet: false,
						createdAt: 1,
					},
				},
				tickState: {},
				deferredHooks: [],
			}),
			"utf8",
		);

		const loaded = await loadStore();
		assert.deepEqual(Object.keys(loaded.routines), ["valid"]);
		assert.ok(loaded.tickState.valid);
	});

	it("refuses unsupported future schema versions", async () => {
		await clearState();
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		await fs.writeFile(
			stateFile,
			JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, routines: { unsafe: {} } }),
			"utf8",
		);
		const loaded = await loadStore();
		assert.deepEqual(loaded.routines, {});
	});
});

describe("saveStore — concurrent writes", () => {
	it("10 concurrent saveStore calls all complete without ENOENT corruption", async () => {
		// Before the unique-tmp-filename fix this race was real:
		// two saveStore calls would share `${STATE_FILE}.tmp`, the first
		// would rename it to the target, the second's rename would fail
		// with ENOENT ("no such file or directory"). The fix gives each
		// saveStore its own random tmp suffix.
		await clearState();
		await fs.mkdir(path.dirname(stateFile), { recursive: true });

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));

		try {
			const stores = Array.from({ length: 10 }, (_, i) => {
				const s = emptyStore();
				// Distinct contents per call so we can identify the survivor.
				s.routines[`r${i}`] = {
					id: `r${i}`,
					name: `r${i}`,
					prompt: `p${i}`,
					triggers: [],
					context: "session",
					quiet: false,
					createdAt: 0,
				};
				return s;
			});
			await Promise.all(stores.map((s) => saveStore(s)));
			// All settled with no warning means no rename/ENOENT race.
			const enoent = warnings.filter((w) => w.includes("ENOENT") || w.includes("saveStore failed"));
			assert.deepEqual(enoent, [], "no saveStore should fail under concurrent writes");
		} finally {
			console.warn = origWarn;
		}

		// File on disk must be valid JSON (one of the 10 inputs); last writer wins.
		const written = JSON.parse(await fs.readFile(stateFile, "utf8"));
		assert.equal(written.schemaVersion, SCHEMA_VERSION);
		assert.ok(typeof written.routines === "object");
	});

	it("does not leave stray tmp files in the state directory after writes settle", async () => {
		await clearState();
		await fs.mkdir(path.dirname(stateFile), { recursive: true });
		await Promise.all(Array.from({ length: 5 }, () => saveStore(emptyStore())));
		const entries = await fs.readdir(path.dirname(stateFile));
		const stray = entries.filter((e) => e.includes(".tmp."));
		assert.deepEqual(
			stray,
			[],
			`no .tmp.* files should remain after writes settle; got: ${stray.join(",")}`,
		);
	});

	it("serializes writes in invocation order", async () => {
		await clearState();
		const first = emptyStore();
		first.routines.first = {
			id: "first",
			name: "first",
			prompt: "first",
			triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
			context: "session",
			quiet: false,
			createdAt: 1,
		};
		const second = emptyStore();
		second.routines.second = {
			id: "second",
			name: "second",
			prompt: "second",
			triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
			context: "session",
			quiet: false,
			createdAt: 2,
		};

		await Promise.all([saveStore(first), saveStore(second)]);
		const written = JSON.parse(await fs.readFile(stateFile, "utf8"));
		assert.deepEqual(Object.keys(written.routines), ["second"]);
	});

	it("discards queued writes from stale extension generations", async () => {
		await clearState();
		const staleGeneration = beginStoreGeneration();
		const stale = emptyStore();
		stale.routines.stale = {
			id: "stale",
			name: "stale",
			prompt: "stale",
			triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
			context: "session",
			quiet: false,
			createdAt: 1,
		};
		const staleWrite = saveStore(stale, staleGeneration);

		const currentGeneration = beginStoreGeneration();
		const current = emptyStore();
		current.routines.current = {
			id: "current",
			name: "current",
			prompt: "current",
			triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
			context: "session",
			quiet: false,
			createdAt: 2,
		};
		await Promise.all([staleWrite, saveStore(current, currentGeneration)]);

		const written = JSON.parse(await fs.readFile(stateFile, "utf8"));
		assert.deepEqual(Object.keys(written.routines), ["current"]);
	});

	it("writes state and backup with owner-only permissions", async () => {
		await clearState();
		await saveStore(emptyStore());
		assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
		assert.equal((await fs.stat(`${stateFile}.bak`)).mode & 0o777, 0o600);
	});
});
