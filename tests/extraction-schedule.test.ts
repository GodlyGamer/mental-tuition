/**
 * Session-end extraction (owner, 2026-10-28): src/server/extraction-schedule.ts,
 * driven with fake stores, a fake clock and hand-fired timers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExtractionSchedule, EXTRACTION_IDLE_MS } from "../src/server/extraction-schedule.ts";
import type { ChatStore, GraphStore } from "../src/core/ports.ts";
import type { ChatRecord, ChatSummary } from "../src/core/contracts/chat.ts";
import type { MtMessage } from "../src/core/native-messages.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");

/** A teacher reply of ~`tokens` tokens (chars/4) sent at `at` — coverage
 *  counts only the assistant's prose (core/coverage.ts). */
function said(tokens: number, at: number, n = 0): MtMessage {
	return {
		id: `m${at}_${n}`,
		role: "assistant",
		content: [{ type: "text", text: "word ".repeat(tokens * 0.8) }],
		stopReason: "stop",
		timestamp: at,
	} as unknown as MtMessage;
}

function harness(chats: Record<string, { messages: MtMessage[]; kind?: "teach" | "practice" }>) {
	const records = new Map<string, ChatRecord>(
		Object.entries(chats).map(([id, c]) => [
			id,
			{ id, title: id, createdAt: "", updatedAt: new Date(NOW).toISOString(), messages: c.messages, kind: c.kind } as ChatRecord,
		]),
	);
	const chatStore = {
		getChat: (id: string) => records.get(id) ?? null,
		listChats: () => [...records.values()].map((r) => ({ id: r.id, kind: r.kind ?? "teach" }) as ChatSummary),
	} as unknown as ChatStore;
	const graphStore = { readCoverage: () => [] } as unknown as GraphStore;
	const runs: string[] = [];
	const timers: { fn: () => void; ms: number; live: boolean }[] = [];
	const graph = { enabled: true, extractionChunkTokens: 32_768 };
	const running = new Set<string>();
	const schedule = createExtractionSchedule({
		chatStore,
		graphStore,
		extraction: { runExtraction: async (id: string) => (runs.push(id), { nodes: 0, chains: 0 }) },
		graph: () => graph,
		isTurnRunning: (id) => running.has(id),
		now: () => NOW,
		setTimer: (fn, ms) => {
			const t = { fn, ms, live: true };
			timers.push(t);
			return t;
		},
		clearTimer: (t) => {
			(t as { live: boolean }).live = false;
		},
	});
	const live = () => timers.filter((t) => t.live);
	const fireAll = () => {
		for (const t of live()) {
			t.live = false;
			t.fn();
		}
	};
	return { schedule, runs, live, fireAll, graph, running, records };
}

describe("session-end extraction", () => {
	it("a settled turn below the cap arms one 30-minute timer; the timer extracts", () => {
		const h = harness({ a: { messages: [said(2000, NOW)] } });
		h.schedule.afterTurn("a");
		h.schedule.afterTurn("a"); // a second turn re-arms, never stacks
		assert.equal(h.live().length, 1);
		assert.equal(h.live()[0]!.ms, EXTRACTION_IDLE_MS);
		assert.deepEqual(h.runs, []);
		h.fireAll();
		assert.deepEqual(h.runs, ["a"]);
		assert.deepEqual(h.schedule.pending(), []);
	});

	it("past the cap it extracts at once (the mid-session cap)", () => {
		const h = harness({ a: { messages: [said(20_000, NOW, 1), said(20_000, NOW, 2)] } });
		h.schedule.afterTurn("a");
		assert.deepEqual(h.runs, ["a"]);
		assert.equal(h.live().length, 0);
	});

	it("tails under the 500-token floor never run", () => {
		const h = harness({ a: { messages: [said(100, NOW)] } });
		h.schedule.afterTurn("a");
		assert.equal(h.live().length, 0);
		assert.deepEqual(h.runs, []);
	});

	it("the timer skips while a turn runs (its settle re-arms) and when the graph is switched off", () => {
		const h = harness({ a: { messages: [said(2000, NOW)] } });
		h.schedule.afterTurn("a");
		h.running.add("a");
		h.fireAll();
		assert.deepEqual(h.runs, []);
		h.running.delete("a");
		h.schedule.afterTurn("a");
		h.graph.enabled = false;
		h.fireAll();
		assert.deepEqual(h.runs, []);
	});

	it("practice sessions never extract", () => {
		const h = harness({ p: { messages: [said(40_000, NOW)], kind: "practice" } });
		h.schedule.afterTurn("p");
		h.schedule.catchUp();
		assert.deepEqual(h.runs, []);
		assert.equal(h.live().length, 0);
	});

	it("launch catch-up: idle chats extract now, recent ones wait out the rest of their 30 minutes", () => {
		const h = harness({
			old: { messages: [said(2000, NOW - 2 * EXTRACTION_IDLE_MS)] },
			recent: { messages: [said(2000, NOW - 10 * 60_000)] },
			tiny: { messages: [said(100, NOW - 2 * EXTRACTION_IDLE_MS)] },
			practice: { messages: [said(2000, NOW - 2 * EXTRACTION_IDLE_MS)], kind: "practice" },
		});
		h.schedule.catchUp();
		assert.deepEqual(h.runs, ["old"]);
		assert.deepEqual(h.schedule.pending(), ["recent"]);
		assert.equal(h.live()[0]!.ms, EXTRACTION_IDLE_MS - 10 * 60_000);
		h.fireAll();
		assert.deepEqual(h.runs, ["old", "recent"]);
	});
});
