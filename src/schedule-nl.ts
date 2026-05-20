/**
 * @file schedule-nl.ts — natural-language → `RoutineCreate` meta-prompt.
 *
 * The `/schedule` slash command (see `commands/schedule.ts`) is a thin
 * wrapper that:
 *   1. Builds a meta-prompt (this file) describing the `RoutineCreate`
 *      tool surface and current local time.
 *   2. Submits it via `pi.sendUserMessage` so the active session's LLM
 *      processes it in-band, calling `RoutineCreate` as its only useful tool.
 *
 * Splitting prompt construction out of the command keeps the moving parts
 * unit-testable: `schedule-nl.test.ts` asserts the meta-prompt mentions the
 * tool name, current timezone, and the user's request verbatim, then feeds
 * a synthetic LLM JSON response into the same TypeBox schema the tool uses
 * at runtime, proving the contract round-trips.
 *
 * No LLM call lives here — the command file owns side effects.
 */

/** Inputs to the meta-prompt builder. */
export interface ScheduleNLInputs {
	/** User's free-text request, exactly as typed after `/schedule `. */
	userRequest: string;
	/** Reference time (epoch ms). Defaults to now; injected for tests. */
	now?: number;
	/** IANA timezone label to anchor relative phrases ("tomorrow", "9am"). */
	timezone?: string;
}

const TOOL_SURFACE = `
RoutineCreate parameters (TypeBox schema, summarised):
  name:    string — lowercase letters/digits/hyphens, max 32 chars.
  prompt:  string — what to ask Pi when the routine fires.
  trigger: one of:
            { kind: "pulse", interval: "5m" | "1h" | "1h30m" | ... }
            { kind: "hook",  event: "session_start"|"agent_end"|"session_shutdown", once?: "daily"|"per_session" }
  quiet:    optional boolean — suppress [~] in chat.
  maxTicks: optional integer ≥1 — auto-delete after N fires.
`.trim();

/**
 * Build the meta-prompt sent to the LLM. Must:
 *   - Name the only tool the LLM should invoke (`RoutineCreate`).
 *   - Describe the schema concisely enough that the LLM can pick valid args.
 *   - Anchor relative time phrases by stating the current local time + tz.
 *   - Include the user's literal request so the LLM sees what to parse.
 *
 * Format is fixed across calls so tests can assert key substrings.
 */
export function buildSchedulePrompt(inputs: ScheduleNLInputs): string {
	const now = inputs.now ?? Date.now();
	const tz =
		inputs.timezone ??
		(typeof Intl !== "undefined"
			? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
			: "UTC");
	const localNow = new Date(now).toLocaleString("en-US", {
		timeZone: tz,
		hour12: false,
	});

	return [
		`The user asked to schedule a routine using natural language.`,
		`Current local time: ${localNow} (${tz}).`,
		``,
		`Use ONLY the RoutineCreate tool to create exactly one routine.`,
		`Pick a short kebab-case name derived from the request.`,
		`Translate the user's timing into the closest matching trigger:`,
		`  - "every N minutes/hours" → pulse with that interval.`,
		`  - "daily at 9am", "every weekday at 9am" → pulse with the closest`,
		`    sensible interval (e.g. 24h). Note: cron triggers are out of scope`,
		`    for this command; prefer pulse + a prompt that handles the day-of-week check.`,
		`  - "on session start" / "when the session ends" → hook with the`,
		`    matching event and once: "daily" if the user wants once-per-day.`,
		`If the request is ambiguous, ask one clarifying question instead of guessing.`,
		``,
		TOOL_SURFACE,
		``,
		`User request: ${inputs.userRequest.trim()}`,
	].join("\n");
}

/** Short help blurb shown when `/schedule` is called with no args. */
export const SCHEDULE_HELP = [
	"Usage: /schedule <natural language>",
	"Examples:",
	"  /schedule every 10 minutes check CI",
	"  /schedule on session start summarise yesterday's PRs",
	"  /schedule every weekday at 9am list my open pull requests",
	"",
	"The active LLM parses your request and calls RoutineCreate.",
	"Use /routine-stop <name> to cancel a routine.",
].join("\n");
