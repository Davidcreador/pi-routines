import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-routines-commands-"));
const origHome = process.env.HOME;
process.env.HOME = tmpHome;

const { registerRoutineExportCronCommand } = await import(
	"../src/commands/routine-export-cron.ts"
);
const { registerRoutineInstallCommand } = await import("../src/commands/routine-install.ts");
const { registerRoutineTokenCommand } = await import("../src/commands/routine-token.ts");
const { stopScheduler } = await import("../src/scheduler.ts");
const { emptyStore, flushStoreWrites } = await import("../src/store.ts");

import type { RoutineRuntimeState } from "../src/types.ts";

interface CapturedCommand {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

after(async () => {
	await flushStoreWrites();
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

function capturePi(): {
	pi: ExtensionAPI;
	commands: Map<string, CapturedCommand>;
	messages: string[];
} {
	const commands = new Map<string, CapturedCommand>();
	const messages: string[] = [];
	const pi = {
		registerCommand(name: string, command: CapturedCommand) {
			commands.set(name, command);
		},
		sendMessage(message: { content: string }) {
			messages.push(message.content);
		},
	} as unknown as ExtensionAPI;
	return { pi, commands, messages };
}

const ctx = {} as ExtensionContext;

describe("slash command edge cases", () => {
	it("requires a repository override for the GitHub template", async () => {
		const runtime = makeRuntime();
		const captured = capturePi();
		registerRoutineInstallCommand(captured.pi, runtime, () => null);
		const command = captured.commands.get("routine-install");
		assert.ok(command);

		await command?.handler("github-pr-review", ctx);
		assert.match(captured.messages.at(-1) ?? "", /needs a repository/);

		await command?.handler("github-pr-review owner/repo", ctx);
		const routine = Object.values(runtime.store.routines)[0];
		assert.equal(
			routine?.triggers.find((trigger) => trigger.kind === "github")?.repo,
			"owner/repo",
		);
		stopScheduler(runtime);
	});

	it("refuses bearer-token generation for non-API routines", async () => {
		const runtime = makeRuntime();
		runtime.store.routines.pulse = {
			id: "pulse",
			name: "pulse",
			prompt: "run",
			triggers: [{ kind: "pulse", intervalMs: 60_000, intervalHuman: "1m" }],
			context: "session",
			quiet: false,
			createdAt: 1,
		};
		const captured = capturePi();
		registerRoutineTokenCommand(captured.pi, runtime);

		await captured.commands.get("routine-token")?.handler("generate pulse", ctx);

		assert.match(captured.messages.at(-1) ?? "", /has no api trigger/);
	});

	it("rejects pulse intervals cron cannot represent exactly", async () => {
		const runtime = makeRuntime();
		runtime.store.routines.uneven = {
			id: "uneven",
			name: "uneven",
			prompt: "run",
			triggers: [{ kind: "pulse", intervalMs: 7 * 60_000, intervalHuman: "7m" }],
			context: "session",
			quiet: false,
			createdAt: 1,
		};
		const captured = capturePi();
		registerRoutineExportCronCommand(captured.pi, runtime);

		await captured.commands.get("routine-export-cron")?.handler("uneven", ctx);

		assert.match(captured.messages.at(-1) ?? "", /cannot be represented exactly/);
	});
});
