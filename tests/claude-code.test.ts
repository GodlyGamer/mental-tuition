import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "@earendil-works/pi-ai";
import { CLAUDE_CODE_PROVIDER_ID, transcriptBlocks } from "../src/agent/claude-code.ts";
import { piModels } from "../src/agent/models.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("the Claude subscription engine", () => {
	it("registers keyless, zero-cost clones of the current Claude models", () => {
		const models = piModels().getModels(CLAUDE_CODE_PROVIDER_ID);
		const ids = models.map((m) => m.id);
		for (const id of ["claude-opus-5-5", "claude-sonnet-5-5"]) assert.ok(ids.includes(id), id);
		for (const m of models) {
			assert.equal(m.provider, CLAUDE_CODE_PROVIDER_ID);
			assert.equal(m.cost.input + m.cost.output, 0);
		}
	});

	it("a lone user message uses the same notation as any later call", () => {
		const blocks = transcriptBlocks([{ role: "user", content: "Research photosynthesis.", timestamp: 0 }]);
		assert.deepEqual(blocks, [{ type: "text", text: "<learner>\nResearch photosynthesis.\n</learner>" }]);
	});

	it("history replays as one tagged block per message, tool calls and results included", () => {
		const messages: Message[] = [
			{ role: "system", content: "ignored here", timestamp: 0 },
			{ role: "user", content: "Teach me limits.", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "not replayed" },
					{ type: "text", text: "Quick check first." },
					{ type: "toolCall", id: "t1", name: "quiz", arguments: { question: "1/x at 0?" } },
				],
				api: "claude-agent-sdk",
				provider: CLAUDE_CODE_PROVIDER_ID,
				model: "claude-opus-5-5",
				usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "quiz",
				content: [{ type: "text", text: "Learner chose: undefined" }],
				isError: false,
				timestamp: 3,
			},
		];
		const texts = transcriptBlocks(messages).map((b) => (b.type === "text" ? b.text : "[image]"));
		assert.match(texts[0]!, /^<learner>\nTeach me limits\.\n<\/learner>$/);
		assert.match(texts[1]!, /Quick check first\./);
		assert.match(texts[1]!, /<tool_call id="t1" name="quiz">\{"question":"1\/x at 0\?"\}<\/tool_call>/);
		assert.ok(!texts[1]!.includes("not replayed"));
		assert.match(texts[2]!, /^<tool_result id="t1" name="quiz">\nLearner chose: undefined\n<\/tool_result>$/);
		assert.equal(texts.length, 3);
	});

	// Prompt caching (2026-10-28): Claude Code's breakpoint sits on the
	// last block, so a request is only read back from the cache when the
	// next request starts with exactly its blocks — nothing may trail the
	// newest message, and a step must add fewer than the 20 blocks the
	// cache looks back over.
	it("every call's blocks are an exact prefix of the next call's", () => {
		const img = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const step = (n: number): Message[] => [
			{
				role: "assistant",
				content: [
					{ type: "text", text: `Step ${n}.` },
					{ type: "toolCall", id: `a${n}`, name: "quiz", arguments: { n } },
					{ type: "toolCall", id: `b${n}`, name: "research", arguments: { n } },
				],
				api: "claude-agent-sdk",
				provider: CLAUDE_CODE_PROVIDER_ID,
				model: "claude-opus-5-5",
				usage,
				stopReason: "toolUse",
				timestamp: n,
			},
			{ role: "toolResult", toolCallId: `a${n}`, toolName: "quiz", content: [{ type: "text", text: "a" }], isError: false, timestamp: n },
			{ role: "toolResult", toolCallId: `b${n}`, toolName: "research", content: [{ type: "text", text: "b" }, img], isError: false, timestamp: n },
		];
		const calls: Message[][] = [];
		let history: Message[] = [{ role: "user", content: [{ type: "text", text: "Look at this." }, img], timestamp: 0 }];
		for (let n = 1; n <= 4; n++) {
			calls.push(history);
			history = [...history, ...step(n)];
			if (n === 2) history = [...history, { role: "user", content: "Next please.", timestamp: n }];
		}
		calls.push(history);
		for (const style of ["tags", "prose"] as const) {
			for (let i = 1; i < calls.length; i++) {
				const before = transcriptBlocks(calls[i - 1]!, style);
				const after = transcriptBlocks(calls[i]!, style);
				assert.deepEqual(after.slice(0, before.length), before, `${style} call ${i} extends call ${i - 1}`);
				assert.ok(after.length - before.length < 20, `${style} call ${i} adds ${after.length - before.length} blocks`);
			}
		}
	});
});

describe("transcript styles", () => {
	const history = [
		{ role: "user", content: "Quiz me.", timestamp: 0 },
		{
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "quiz", arguments: { question: "2+2?" } }],
			timestamp: 1,
		},
		{ role: "toolResult", toolCallId: "c1", toolName: "quiz", content: [{ type: "text", text: "answered a" }], isError: false, timestamp: 2 },
	] as unknown as Parameters<typeof transcriptBlocks>[0];

	it("Claude's tag style is unchanged", () => {
		const text = transcriptBlocks(history).map((b) => (b.type === "text" ? b.text : "")).join("\n");
		assert.match(text, /<tool_call id="c1" name="quiz">/);
		assert.match(text, /<tool_result id="c1" name="quiz">/);
	});

	it("the prose style writes no tags at all", () => {
		const text = transcriptBlocks(history, "prose").map((b) => (b.type === "text" ? b.text : "")).join("\n");
		assert.doesNotMatch(text, /<tool_call|<tool_result/);
		assert.match(text, /You used the quiz tool with/);
		assert.match(text, /The quiz tool returned: answered a/);
	});
});
