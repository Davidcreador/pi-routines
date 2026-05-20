/**
 * @file routine-install.ts — `/routine-install <template>` slash command.
 *
 * Reads `templates/<name>.json` (name sanitized against [a-z0-9-]+),
 * minimally validates it as a `RoutineTemplate`, runs `which <tool>` for
 * each `requiredTools` entry (warns only — does not block), and creates
 * the routine via `_mutate.createRoutine`. Provides tab-completion over
 * the templates directory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type {
	HookEvent,
	RoutineRuntimeState,
	RoutineTemplate,
} from "../types.ts";
import { TEMPLATES_DIR } from "../types.ts";
import { createRoutine } from "../tools/_mutate.ts";

const SYSTEM_MSG_TYPE = "pi-routines/system";
const NAME_RE = /^[a-z0-9-]+$/;

function send(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({
		customType: SYSTEM_MSG_TYPE,
		content: text,
		display: true,
	});
}

/** List available template names (filenames in TEMPLATES_DIR without .json). */
function listTemplateNames(): string[] {
	try {
		return fs
			.readdirSync(TEMPLATES_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -".json".length))
			.sort();
	} catch {
		return [];
	}
}

/** Minimal shape check; throws on missing required fields. */
function validateTemplate(raw: unknown): RoutineTemplate {
	if (!raw || typeof raw !== "object") throw new Error("not an object");
	const t = raw as Record<string, unknown>;
	if (typeof t.name !== "string" || !t.name) throw new Error("missing 'name'");
	if (typeof t.description !== "string")
		throw new Error("missing 'description'");
	if (typeof t.prompt !== "string" || !t.prompt)
		throw new Error("missing 'prompt'");
	if (typeof t.quiet !== "boolean") throw new Error("missing 'quiet'");
	const trig = t.trigger as Record<string, unknown> | undefined;
	if (!trig || typeof trig !== "object") throw new Error("missing 'trigger'");
	if (trig.kind === "pulse") {
		if (typeof trig.interval !== "string")
			throw new Error("pulse trigger missing 'interval'");
	} else if (trig.kind === "hook") {
		if (typeof trig.event !== "string")
			throw new Error("hook trigger missing 'event'");
	} else {
		throw new Error("trigger.kind must be 'pulse' or 'hook'");
	}
	return raw as RoutineTemplate;
}

/** Register `/routine-install`. */
export function registerRoutineInstallCommand(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
): void {
	pi.registerCommand("routine-install", {
		description: "Install a bundled routine template: /routine-install <name>",
		getArgumentCompletions(prefix: string): AutocompleteItem[] {
			const lower = (prefix ?? "").toLowerCase();
			return listTemplateNames()
				.filter((n) => n.toLowerCase().startsWith(lower))
				.map((name) => ({ value: name, label: name }));
		},
		async handler(args: string): Promise<void> {
			const name = args.trim();
			if (!name) {
				const available = listTemplateNames().join(", ") || "(none)";
				send(pi, `Usage: /routine-install <template>\nAvailable: ${available}`);
				return;
			}
			if (!NAME_RE.test(name)) {
				send(
					pi,
					`Invalid template name '${name}'. Use lowercase letters, digits, hyphens only.`,
				);
				return;
			}
			const file = path.join(TEMPLATES_DIR, `${name}.json`);
			if (!fs.existsSync(file)) {
				const available = listTemplateNames().join(", ") || "(none)";
				send(
					pi,
					`Template '${name}' not found in ${TEMPLATES_DIR}. Available: ${available}`,
				);
				return;
			}
			let template: RoutineTemplate;
			try {
				const raw = JSON.parse(fs.readFileSync(file, "utf8"));
				template = validateTemplate(raw);
			} catch (err) {
				send(
					pi,
					`Failed to load template '${name}': ${(err as Error).message}`,
				);
				return;
			}

			// requiredTools: warn (do not block) on missing.
			const warnings: string[] = [];
			for (const tool of template.requiredTools ?? []) {
				try {
					const res = await pi.exec("which", [tool]);
					if (res.code !== 0) {
						warnings.push(
							`tool '${tool}' not found on PATH; routine may fail until installed`,
						);
					}
				} catch {
					warnings.push(`could not check for tool '${tool}'`);
				}
			}

			const trigger =
				template.trigger.kind === "pulse"
					? ({ kind: "pulse", interval: template.trigger.interval } as const)
					: ({
							kind: "hook",
							event: template.trigger.event as HookEvent,
							...(template.trigger.once ? { once: template.trigger.once } : {}),
						} as const);

			const result = await createRoutine(
				{
					name: template.name,
					prompt: template.prompt,
					trigger,
					quiet: template.quiet,
					...(template.maxTicks !== undefined
						? { maxTicks: template.maxTicks }
						: {}),
				},
				runtime,
				pi,
				getCtx,
			);
			if ("error" in result) {
				send(pi, `Error: ${result.error}`);
				return;
			}
			const parts: string[] = [
				`Installed '${result.name}' — fires ${result.triggerDescription}.`,
			];
			if (result.nextFireIn) parts.push(`Next fire in ~${result.nextFireIn}.`);
			parts.push("Use `/routines` to inspect.");
			if (warnings.length > 0) {
				parts.push("\nWarnings:");
				for (const w of warnings) parts.push(`  - ${w}`);
			}
			send(pi, parts.join(" "));
		},
	});
}
