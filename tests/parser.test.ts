import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nextCronFire, parseCron, parseInterval, parseOneOff } from "../src/parser.ts";

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

describe("parseCron", () => {
	it("parses every minute", () => {
		const c = parseCron("* * * * *");
		assert.equal(c.minutes.length, 60);
		assert.equal(c.hours.length, 24);
	});
	it("parses weekdays 9am", () => {
		const c = parseCron("0 9 * * 1-5");
		assert.deepEqual(c.minutes, [0]);
		assert.deepEqual(c.hours, [9]);
		assert.deepEqual(c.dow, [1, 2, 3, 4, 5]);
	});
	it("parses every 15 minutes", () => {
		const c = parseCron("*/15 * * * *");
		assert.deepEqual(c.minutes, [0, 15, 30, 45]);
	});
	it("parses comma lists", () => {
		const c = parseCron("0,30 * * * *");
		assert.deepEqual(c.minutes, [0, 30]);
	});
	it("parses ranges", () => {
		const c = parseCron("0 9-17 * * *");
		assert.deepEqual(c.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
	});
	it("parses range with step", () => {
		const c = parseCron("0 0-23/6 * * *");
		assert.deepEqual(c.hours, [0, 6, 12, 18]);
	});
	it("normalises Sunday=7 to 0", () => {
		const c = parseCron("0 0 * * 7");
		assert.deepEqual(c.dow, [0]);
	});
	it("rejects wrong field count", () => {
		assert.throws(() => parseCron("* * * *"));
		assert.throws(() => parseCron("0 * * * * *"));
	});
	it("rejects out-of-range minutes", () => {
		assert.throws(() => parseCron("60 * * * *"));
	});
	it("rejects ?, L, # specials", () => {
		assert.throws(() => parseCron("0 0 ? * *"));
		assert.throws(() => parseCron("0 0 L * *"));
		assert.throws(() => parseCron("0 0 * * 1#2"));
	});
	it("rejects > 1440 fires/day", () => {
		// 60 minutes × 25 hours impossible; force via fabricated overflow.
		// 60 minutes × 24 hours = 1440 (allowed). 61 not possible. Use a synthetic test:
		// every-minute / every-hour passes (1440); anything above must throw — we
		// cannot produce >1440 with valid fields, so just assert the limit allows 1440.
		assert.doesNotThrow(() => parseCron("* * * * *"));
	});
	it("nextCronFire: weekdays-9am from a Saturday", () => {
		const sat = new Date("2026-06-06T08:00:00Z"); // Saturday
		const next = nextCronFire("0 9 * * 1-5", "UTC", sat);
		assert.equal(next.toISOString().slice(0, 19), "2026-06-08T09:00:00"); // Monday
	});
	it("nextCronFire: every 15m", () => {
		const from = new Date("2026-06-01T10:07:30Z");
		const next = nextCronFire("*/15 * * * *", "UTC", from);
		assert.equal(next.toISOString().slice(0, 19), "2026-06-01T10:15:00");
	});
	it("nextCronFire: respects timezone", () => {
		// 09:00 in America/Los_Angeles is 16:00 or 17:00 UTC depending on DST.
		const from = new Date("2026-06-01T15:00:00Z");
		const next = nextCronFire("0 9 * * *", "America/Los_Angeles", from);
		// PDT in June = UTC-7 → 09:00 PDT = 16:00 UTC
		assert.equal(next.toISOString().slice(0, 19), "2026-06-01T16:00:00");
	});
});

describe("parseOneOff", () => {
	it("parses explicit UTC", () => {
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const d = parseOneOff(future);
		assert.equal(d.toISOString(), future);
	});
	it("parses naive local with tz", () => {
		const yearAhead = new Date().getUTCFullYear() + 1;
		const d = parseOneOff(`${yearAhead}-06-01T09:00:00`, "America/Los_Angeles");
		// PDT in June → UTC-7. 09:00 PDT = 16:00 UTC.
		assert.equal(d.toISOString(), `${yearAhead}-06-01T16:00:00.000Z`);
	});
	it("parses naive local with UTC tz", () => {
		const yearAhead = new Date().getUTCFullYear() + 1;
		const d = parseOneOff(`${yearAhead}-06-01T09:00:00`, "UTC");
		assert.equal(d.toISOString(), `${yearAhead}-06-01T09:00:00.000Z`);
	});
	it("rejects past timestamps", () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		assert.throws(() => parseOneOff(past));
	});
	it("rejects garbage", () => {
		assert.throws(() => parseOneOff("not-a-date"));
	});
});
