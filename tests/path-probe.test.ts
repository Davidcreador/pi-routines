/**
 * @file path-probe.test.ts — cross-platform tool probe.
 *
 * Stages a temp directory with a fake executable and asserts:
 *   - isToolOnPath finds it when its dir is in PATH.
 *   - Returns false for a name that isn't anywhere on PATH.
 *   - Rejects names containing separators (callers must use bare names).
 *   - Empty PATH → false.
 *   - On POSIX, refuses files without the executable bit.
 */

import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { isToolOnPath } from "../src/path-probe.ts";

const IS_WIN = process.platform === "win32";

let tmp: string;
let toolName: string;
let toolPath: string;

before(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-probe-"));
	toolName = IS_WIN ? "fakecli.cmd" : "fakecli";
	toolPath = path.join(tmp, toolName);
	await fs.writeFile(toolPath, IS_WIN ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
	if (!IS_WIN) await fs.chmod(toolPath, 0o755);
});

after(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

describe("isToolOnPath", () => {
	it("finds a bare-name tool that lives in PATH", async () => {
		const env = { PATH: `${tmp}${path.delimiter}/nope`, PATHEXT: ".CMD" };
		const found = await isToolOnPath(IS_WIN ? "fakecli" : "fakecli", env);
		assert.equal(found, true);
	});

	it("returns false when the tool is not on PATH", async () => {
		const env = { PATH: "/nowhere/at/all", PATHEXT: ".CMD" };
		const found = await isToolOnPath("definitelynotinstalledxyz", env);
		assert.equal(found, false);
	});

	it("rejects names with path separators (callers must pass bare names)", async () => {
		const env = { PATH: tmp };
		assert.equal(await isToolOnPath("foo/bar", env), false);
		assert.equal(await isToolOnPath("..\\evil.exe", env), false);
	});

	it("returns false when PATH is empty / unset", async () => {
		assert.equal(await isToolOnPath("ls", { PATH: "" }), false);
		assert.equal(await isToolOnPath("ls", {}), false);
	});

	if (!IS_WIN) {
		it("on POSIX, ignores files without the executable bit", async () => {
			const noExec = path.join(tmp, "noexec");
			await fs.writeFile(noExec, "#!/bin/sh\nexit 0\n");
			await fs.chmod(noExec, 0o644);
			const env = { PATH: tmp };
			assert.equal(await isToolOnPath("noexec", env), false);
		});
	}
});
