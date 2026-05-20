import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseInterval } from "../src/parser.ts";
import type { RoutineTemplate } from "../src/types.ts";

const TEMPLATES_DIR = join(process.cwd(), "templates");

describe("bundled templates", () => {
	const files = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".json"));

	it("ships exactly 7 templates", () => {
		assert.equal(files.length, 7);
	});

	for (const file of files) {
		describe(file, () => {
			const raw = readFileSync(join(TEMPLATES_DIR, file), "utf8");
			const t = JSON.parse(raw) as RoutineTemplate;

			it("has required fields", () => {
				assert.ok(t.name, "name");
				assert.ok(t.description, "description");
				assert.ok(t.trigger, "trigger");
				assert.ok(t.trigger.kind, "trigger.kind");
				assert.ok(typeof t.prompt === "string" && t.prompt.length > 0, "prompt");
				assert.equal(typeof t.quiet, "boolean", "quiet must be boolean");
			});

			it("filename matches name", () => {
				assert.equal(file, `${t.name}.json`);
			});

			it("pulse trigger has parseable interval", () => {
				if (t.trigger.kind === "pulse") {
					assert.doesNotThrow(() =>
						parseInterval(t.trigger.kind === "pulse" ? t.trigger.interval : ""),
					);
				}
			});

			it("hook trigger has valid event", () => {
				if (t.trigger.kind === "hook") {
					const ev = t.trigger.event;
					assert.ok(
						["session_start", "agent_end", "session_shutdown"].includes(ev),
						`unknown event: ${ev}`,
					);
				}
			});
		});
	}
});
