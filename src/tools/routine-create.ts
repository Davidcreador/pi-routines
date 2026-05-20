/**
 * @file routine-create.ts — LLM-callable `RoutineCreate` tool.
 *
 * Thin schema-validation wrapper around {@link createRoutine} in
 * `_mutate.ts`. Upserts by name — calling with an existing name updates
 * the routine in place (preserving `id`, `createdAt`, `tickState`).
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { RoutineRuntimeState } from "../types.ts";
import { createRoutine } from "./_mutate.ts";

const ParamsSchema = Type.Object({
	name: Type.String({
		description:
			"Short identifier, lowercase letters/digits/hyphens, max 32 chars.",
	}),
	prompt: Type.String({
		description:
			"What to ask Pi on each tick. For quiet routines, end with instructions to output [~] if nothing changed.",
	}),
	trigger: Type.Union([
		Type.Object({
			kind: Type.Literal("pulse"),
			interval: Type.String({
				description: "Interval like '5m', '1h', '30s', '1h30m'.",
			}),
		}),
		Type.Object({
			kind: Type.Literal("hook"),
			event: Type.Union([
				Type.Literal("session_start"),
				Type.Literal("agent_end"),
				Type.Literal("session_shutdown"),
			]),
			once: Type.Optional(
				Type.Union([Type.Literal("daily"), Type.Literal("per_session")]),
			),
		}),
	]),
	quiet: Type.Optional(
		Type.Boolean({
			description:
				"Suppress [~] responses from chat (show only in footer). Default: false.",
		}),
	),
	maxTicks: Type.Optional(
		Type.Integer({
			minimum: 1,
			description: "Auto-delete after N fires. Omit for unlimited.",
		}),
	),
});

type Params = Static<typeof ParamsSchema>;

interface Details {
	id: string;
	name: string;
	triggerDescription: string;
	nextFireIn?: string;
}

function errorResult(message: string): AgentToolResult<Details | null> {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: null,
	};
}

/**
 * Register the `RoutineCreate` tool.
 *
 * The LLM calls this to schedule a new pulse or hook routine. Use it when
 * the user asks Pi to "check every N minutes", "run on session start",
 * or otherwise wants Pi to act autonomously on a schedule or event.
 */
export function registerRoutineCreateTool(
	pi: ExtensionAPI,
	runtime: RoutineRuntimeState,
	getCtx: () => ExtensionContext | null,
): void {
	pi.registerTool({
		name: "RoutineCreate",
		label: "Routine: Create",
		description:
			"Create or update a recurring (pulse) or event-driven (hook) routine. " +
			"Pulse routines fire on an interval (e.g. every 5m). Hook routines fire " +
			"on session lifecycle events (session_start, agent_end, session_shutdown). " +
			"Call with an existing name to update the routine in place.",
		parameters: ParamsSchema,

		async execute(
			_id,
			params: Params,
		): Promise<AgentToolResult<Details | null>> {
			const result = await createRoutine(
				{
					name: params.name,
					prompt: params.prompt,
					trigger: params.trigger,
					...(params.quiet !== undefined ? { quiet: params.quiet } : {}),
					...(params.maxTicks !== undefined
						? { maxTicks: params.maxTicks }
						: {}),
				},
				runtime,
				pi,
				getCtx,
			);

			if ("error" in result) return errorResult(result.error);

			const details: Details = {
				id: result.id,
				name: result.name,
				triggerDescription: result.triggerDescription,
			};
			if (result.nextFireIn) details.nextFireIn = result.nextFireIn;

			const verb = result.updated ? "Updated" : "Created";
			const kind = params.trigger.kind;
			const msg =
				kind === "pulse" && result.nextFireIn
					? `${verb} pulse routine '${result.name}' — fires ${result.triggerDescription}. Next fire in ~${result.nextFireIn}.`
					: `${verb} hook routine '${result.name}' — fires ${result.triggerDescription}.`;

			return { content: [{ type: "text", text: msg }], details };
		},

		renderCall(args) {
			const t = args.trigger;
			const trig = t.kind === "pulse" ? `every ${t.interval}` : `on ${t.event}`;
			return new Text(`RoutineCreate ${args.name} — ${trig}`, 0, 0);
		},

		renderResult(result) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}
