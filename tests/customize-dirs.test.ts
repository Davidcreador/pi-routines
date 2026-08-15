/**
 * @file customize-dirs.test.ts — `PI_ROUTINES_DIR` relocates the data files.
 *
 * `STATE_FILE`/`TOKEN_FILE` are captured at module load, so the env var must
 * be set before the first import. Node's test runner runs each test file in
 * its own process, which lets us pin `PI_ROUTINES_DIR` here without leaking
 * into other suites. We assert both paths derive from the same overridden
 * base and that tokens actually persist there.
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-customdir-"));
const routinesDir = path.join(tmpBase, "custom", "routines-data");
const origDir = process.env.PI_ROUTINES_DIR;
process.env.PI_ROUTINES_DIR = routinesDir;

const { ROUTINES_DIR, STATE_FILE } = await import("../src/types.ts");
const tokens = await import("../src/tokens.ts");

after(async () => {
	if (origDir === undefined) delete process.env.PI_ROUTINES_DIR;
	else process.env.PI_ROUTINES_DIR = origDir;
	await fs.rm(tmpBase, { recursive: true, force: true });
});

describe("PI_ROUTINES_DIR override", () => {
	before(() => {
		tokens._resetTokenCache();
	});

	it("resolves ROUTINES_DIR to the override", () => {
		assert.equal(ROUTINES_DIR, routinesDir);
	});

	it("places state.json and tokens.json in the overridden dir", () => {
		assert.equal(STATE_FILE, path.join(routinesDir, "state.json"));
		assert.equal(tokens.TOKEN_FILE, path.join(routinesDir, "tokens.json"));
	});

	it("persists a generated token under the overridden dir", async () => {
		const t = await tokens.generateToken("r1");
		assert.match(t, /^[0-9a-f]{64}$/);
		const raw = await fs.readFile(path.join(routinesDir, "tokens.json"), "utf8");
		assert.equal(JSON.parse(raw).tokens.r1, t);
	});
});
