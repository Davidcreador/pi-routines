import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-server-security-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { isServerRunning, startServer, stopServer } = await import("../src/server.ts");
const { emptyStore } = await import("../src/store.ts");
const tokens = await import("../src/tokens.ts");

import type { RoutineRuntimeState } from "../src/types.ts";

function runtime(): RoutineRuntimeState {
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

after(async () => {
	await stopServer(runtime());
	if (origHome === undefined) delete process.env.HOME;
	else process.env.HOME = origHome;
	await fs.rm(tmpHome, { recursive: true, force: true });
});

describe("server token-store safety", () => {
	it("refuses to bind when tokens.json permissions are unsafe", async () => {
		const rt = runtime();
		await tokens.generateToken("r1");
		await fs.chmod(tokens.TOKEN_FILE, 0o644);
		tokens._resetTokenCache();

		await assert.rejects(
			() => startServer(rt, 0, { pi: {} as never, getCtx: () => null }),
			/wider than 600/,
		);
		assert.equal(isServerRunning(), false);
	});
});
