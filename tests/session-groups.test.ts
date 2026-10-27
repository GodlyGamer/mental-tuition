import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { groupByModule, groupByTime, moduleLabel, timeBucket } from "../src/core/session-groups.ts";

// Noon, Wednesday 14 Oct 2026 (local time): the clock every case reads against.
const NOW = new Date(2026, 9, 14, 12, 0, 0);
const at = (y: number, m: number, d: number, h = 9) => new Date(y, m, d, h).toISOString();
const s = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({ id, updatedAt, ...extra });

describe("timeBucket", () => {
	it("pinned beats the clock", () => {
		assert.equal(timeBucket(s("a", at(2020, 0, 1), { pinned: true }), NOW), "pinned");
	});

	it("walks today → yesterday → this week → this month → older by local calendar day", () => {
		assert.equal(timeBucket(s("a", at(2026, 9, 14, 0)), NOW), "today");
		assert.equal(timeBucket(s("a", at(2026, 9, 13, 23)), NOW), "yesterday");
		assert.equal(timeBucket(s("a", at(2026, 9, 12)), NOW), "this-week");
		assert.equal(timeBucket(s("a", at(2026, 9, 8)), NOW), "this-week");
		assert.equal(timeBucket(s("a", at(2026, 9, 7)), NOW), "this-month", "7 days back leaves the week");
		assert.equal(timeBucket(s("a", at(2026, 9, 1)), NOW), "this-month");
		assert.equal(timeBucket(s("a", at(2026, 8, 30)), NOW), "older");
		assert.equal(timeBucket(s("a", at(2025, 9, 14)), NOW), "older", "same month, a year ago");
	});
});

describe("groupByTime", () => {
	it("orders the buckets, drops empty ones and keeps the caller's order inside", () => {
		const groups = groupByTime(
			[s("1", at(2026, 9, 14)), s("2", at(2026, 9, 13)), s("3", at(2024, 0, 1)), s("4", at(2026, 9, 14, 8), { pinned: true }), s("5", at(2026, 9, 14, 7))],
			NOW,
		);
		assert.deepEqual(
			groups.map((g) => [g.label, g.items.map((c) => c.id)]),
			[
				["Pinned", ["4"]],
				["Today", ["1", "5"]],
				["Yesterday", ["2"]],
				["Older", ["3"]],
			],
		);
	});

	it("no sessions, no groups", () => {
		assert.deepEqual(groupByTime([], NOW), []);
	});
});

describe("groupByModule", () => {
	const chats = [
		s("1", at(2026, 9, 14), { module: "2P3" }),
		s("2", at(2026, 9, 13)),
		s("3", at(2026, 9, 12), { module: "1M1" }),
		s("4", at(2026, 9, 11), { module: "1M1", pinned: true }),
	];

	it("modules by code, 'No module' last, pinned first inside a group", () => {
		const groups = groupByModule(chats, { "1M1": "Mechanics" });
		assert.deepEqual(
			groups.map((g) => [g.key, g.label, g.items.map((c) => c.id)]),
			[
				["1M1", "1M1 · Mechanics", ["4", "3"]],
				["2P3", "2P3", ["1"]],
				["", "No module", ["2"]],
			],
		);
	});

	it("the heading shows the name only when there is one", () => {
		assert.equal(moduleLabel("1M1", "Mechanics"), "1M1 · Mechanics");
		assert.equal(moduleLabel("1M1", null), "1M1");
		assert.equal(moduleLabel("1M1", undefined), "1M1");
	});
});
