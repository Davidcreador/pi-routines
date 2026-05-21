import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseCron, parseInterval, parseOneOff } from "../src/parser.ts";
import type { RoutineTemplate } from "../src/types.ts";

const TEMPLATES_DIR = join(process.cwd(), "templates");

describe("bundled templates", () => {
	const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));

	it("ships at least the original 7 templates", () => {
		// Phase 2 added cron, oneoff, api, and github trigger templates so
		// the user-facing surface mirrors what RoutineCreate exposes. Lower
		// bound covers the historical contract; upper bound is open.
		assert.ok(files.length >= 7, `expected ≥ 7 templates, got ${files.length}`);
	});

	for (const file of files) {
		describe(file, () => {
			const raw = readFileSync(join(TEMPLATES_DIR, file), "utf8");
			const t = JSON.parse(raw) as RoutineTemplate;
			const triggers = [...(t.trigger ? [t.trigger] : []), ...(t.triggers ?? [])];

			it("has required fields", () => {
				assert.ok(t.name, "name");
				assert.ok(t.description, "description");
				assert.ok(triggers.length > 0, "trigger or triggers");
				assert.ok(typeof t.prompt === "string" && t.prompt.length > 0, "prompt");
				assert.equal(typeof t.quiet, "boolean", "quiet must be boolean");
			});

			it("filename matches name", () => {
				assert.equal(file, `${t.name}.json`);
			});

			it("every trigger has a known kind + required fields", () => {
				for (const trig of triggers) {
					assert.ok(
						["pulse", "cron", "oneoff", "hook", "api", "github"].includes(trig.kind),
						`unknown trigger kind: ${trig.kind}`,
					);
					if (trig.kind === "pulse") {
						assert.doesNotThrow(() => parseInterval(trig.interval));
					}
					if (trig.kind === "cron") {
						assert.doesNotThrow(() => parseCron(trig.expr));
					}
					if (trig.kind === "oneoff") {
						// `parseOneOff` rejects past timestamps. Templates may ship with
						// a future placeholder (e.g. 2099), so allow that to validate;
						// the user edits before installing.
						assert.doesNotThrow(() => parseOneOff(trig.fireAtIso));
					}
					if (trig.kind === "hook") {
						assert.ok(
							["session_start", "agent_end", "session_shutdown"].includes(trig.event),
							`unknown hook event: ${trig.event}`,
						);
					}
					if (trig.kind === "github") {
						assert.match(trig.repo, /^[^/]+\/[^/]+$/, "github repo must be owner/name");
						assert.ok(
							["pull_request.opened", "pull_request.closed", "issues.opened", "push"].includes(
								trig.event,
							),
							`unknown github event: ${trig.event}`,
						);
					}
				}
			});
		});
	}
});
