import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseInterval } from "../src/parser.ts";

describe("parseInterval", () => {
	it("parses seconds", () => {
		assert.equal(parseInterval("30s").ms, 30_000);
	});
	it("parses minutes", () => {
		assert.equal(parseInterval("5m").ms, 300_000);
	});
	it("parses hours", () => {
		assert.equal(parseInterval("1h").ms, 3_600_000);
	});
	it("parses compound h+m", () => {
		assert.equal(parseInterval("1h30m").ms, 5_400_000);
	});
	it("parses spaced compound", () => {
		assert.equal(parseInterval("2h 15m").ms, 8_100_000);
	});
	it("parses long-form units", () => {
		assert.equal(parseInterval("25 minutes").ms, 1_500_000);
		assert.equal(parseInterval("1 hour").ms, 3_600_000);
	});
	it("tolerates 'every' prefix", () => {
		assert.equal(parseInterval("every 5m").ms, 300_000);
	});
	it("rejects zero", () => {
		assert.throws(() => parseInterval("0s"));
	});
	it("rejects bare numbers", () => {
		assert.throws(() => parseInterval("5"));
	});
	it("rejects unsupported units", () => {
		assert.throws(() => parseInterval("2d"));
	});
	it("rejects absurd values", () => {
		assert.throws(() => parseInterval("9999h"));
	});
	it("rejects nonsense", () => {
		assert.throws(() => parseInterval("banana"));
	});
	it("returns normalized .human", () => {
		const r = parseInterval("90 minutes");
		assert.equal(typeof r.human, "string");
		assert.ok(r.human.length > 0);
	});
});
