import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeContext, type AssistantMessage, type AssistantMessageEvent, type Message, type Tool } from "@earendil-works/pi-ai";
import {
	CLAUDE_CODE_PROVIDER_ID,
	claudeQuery,
	LEAKED_CALL_NOTE,
	parseLeakedCalls,
	streamClaudeCode,
	stripLeakedCalls,
	transcriptBlocks,
} from "../src/agent/claude-code.ts";
import { piModels } from "../src/agent/models.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const reply = (content: AssistantMessage["content"], n = 0): AssistantMessage => ({
	role: "assistant",
	content,
	api: "claude-agent-sdk",
	provider: CLAUDE_CODE_PROVIDER_ID,
	model: "claude-opus-5-5",
	usage,
	stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
	timestamp: n,
});

const texts = (messages: Message[]) => transcriptBlocks(messages).map((b) => (b.type === "text" ? b.text : "[image]"));

/** The leak of 2026-10-28 (chat_mvr8rxch msg 97), shortened: prose, then
 *  two calls in Claude's own syntax as plain text. */
const LEAKED_REPLY = [
	"Using $3$ for every step overcounts.",
	"",
	'<invoke name="mcp__mt__demo">',
	'<parameter name="title">Line integral as a sum of tiny steps</parameter>',
	'<parameter name="brief">Show that P changes along the path.</parameter>',
	"</invoke>",
	'<invoke name="mcp__mt__quiz">',
	'<parameter name="type">check</parameter>',
	'<parameter name="question">Find $\\int_C x^2 y\\,dx$.</parameter>',
	'<parameter name="options">[{"label":"$18$","value":"a"},{"label":"$54$","value":"b"}]</parameter>',
	'<parameter name="correctAnswer">a</parameter>',
	"</invoke>",
].join("\n");

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

	it("history replays one block per message, tool calls and results as prose with their ids", () => {
		const messages: Message[] = [
			{ role: "system", content: "ignored here", timestamp: 0 },
			{ role: "user", content: "Teach me limits.", timestamp: 1 },
			reply([
				{ type: "thinking", thinking: "not replayed" },
				{ type: "text", text: "Quick check first." },
				{ type: "toolCall", id: "t1", name: "quiz", arguments: { question: "1/x at 0?" } },
			]),
			{ role: "toolResult", toolCallId: "t1", toolName: "quiz", content: [{ type: "text", text: "Learner chose: undefined" }], isError: false, timestamp: 3 },
			{ role: "toolResult", toolCallId: "t2", toolName: "study_log", content: [{ type: "text", text: "bad kind" }], isError: true, timestamp: 4 },
		];
		const t = texts(messages);
		assert.equal(t[0], "<learner>\nTeach me limits.\n</learner>");
		assert.equal(t[1], '<you>\nQuick check first.\n(You used the quiz tool, call id t1, with {"question":"1/x at 0?"}.)\n</you>');
		assert.equal(t[2], "(The quiz tool, call id t1, returned: Learner chose: undefined)");
		assert.equal(t[3], "(The study_log tool, call id t2, failed and returned: bad kind)");
		assert.equal(t.length, 4);
		assert.doesNotMatch(t.join("\n"), /<tool_call|<tool_result|not replayed/);
	});

	// Prompt caching (2026-10-28): Claude Code's breakpoint sits on the
	// last block, so a request is only read back from the cache when the
	// next request starts with exactly its blocks. Nothing may trail the
	// newest message, every message must render the same way every time,
	// and a step must add fewer than the 20 blocks the cache looks back over.
	it("over a long chat, every step's blocks are an exact prefix of the next step's", () => {
		const img = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const steps: Message[][] = [];
		let history: Message[] = [{ role: "user", content: [{ type: "text", text: "Look at this." }, img], timestamp: 0 }];
		for (let n = 1; n <= 40; n++) {
			steps.push(history);
			const add: Message[] = [];
			if (n % 4 === 0) add.push({ role: "user", content: n % 8 === 0 ? [{ type: "text", text: `Answer ${n}` }, img] : `Answer ${n}`, timestamp: n });
			const leaked = n % 7 === 0;
			add.push(
				reply(
					[
						{ type: "thinking", thinking: `think ${n}` },
						{ type: "text", text: leaked ? `${LEAKED_REPLY}\n(${n})` : `Step ${n}.` },
						{ type: "toolCall", id: `a${n}`, name: "quiz", arguments: { n, question: `$x^${n}$ <b>` } },
						...(n % 3 === 0 ? [{ type: "toolCall" as const, id: `b${n}`, name: "study_log", arguments: { kind: "attempt" } }] : []),
					],
					n,
				),
			);
			add.push({ role: "toolResult", toolCallId: `a${n}`, toolName: "quiz", content: [{ type: "text", text: `answered ${n}` }, ...(n % 5 === 0 ? [img] : [])], isError: false, timestamp: n });
			if (n % 3 === 0) add.push({ role: "toolResult", toolCallId: `b${n}`, toolName: "study_log", content: [{ type: "text", text: "Logged." }], isError: n % 6 === 0, timestamp: n });
			history = [...history, ...add];
		}
		steps.push(history);
		for (let i = 1; i < steps.length; i++) {
			const before = transcriptBlocks(steps[i - 1]!);
			const after = transcriptBlocks(steps[i]!);
			assert.deepEqual(after.slice(0, before.length), before, `step ${i} extends step ${i - 1}`);
			assert.ok(after.length > before.length, `step ${i} adds blocks`);
			assert.ok(after.length - before.length < 20, `step ${i} adds ${after.length - before.length} blocks`);
		}
		// Same messages, freshly copied (a reload from disk): same blocks.
		assert.deepEqual(transcriptBlocks(structuredClone(history)), transcriptBlocks(history));
		const all = texts(history).join("\n");
		assert.doesNotMatch(all, /<invoke|<parameter/);
		assert.ok(all.includes(LEAKED_CALL_NOTE));
	});
});

describe("calls written as text, on replay", () => {
	it("each run of leaked markup becomes one note, and the prose around it stays", () => {
		const out = stripLeakedCalls(LEAKED_REPLY);
		assert.equal(out, `Using $3$ for every step overcounts.\n\n${LEAKED_CALL_NOTE}`);
	});

	it("covers wrapped, namespaced, tag-style and unclosed markup", () => {
		const cases: [string, string][] = [
			['A <ns:function_calls>\n<ns:invoke name="quiz">\n<ns:parameter name="q">x</ns:parameter>\n</ns:invoke>\n</ns:function_calls> B', `A ${LEAKED_CALL_NOTE} B`],
			['A <function_calls><invoke name="quiz"></invoke></function_calls>', `A ${LEAKED_CALL_NOTE}`],
			['A <tool_call id="t1" name="quiz">{"q":1}</tool_call>\n<tool_result id="t1">ok</tool_result> B', `A ${LEAKED_CALL_NOTE} B`],
			['A <invoke name="quiz">\n<parameter name="q">cut off', `A ${LEAKED_CALL_NOTE}`],
			['A <invoke name="qu', `A ${LEAKED_CALL_NOTE}`],
			['A <parameter name="q">x</parameter> B', `A ${LEAKED_CALL_NOTE} B`],
			['<invoke name="a"></invoke> middle <invoke name="b"></invoke>', `${LEAKED_CALL_NOTE} middle ${LEAKED_CALL_NOTE}`],
		];
		for (const [input, expected] of cases) assert.equal(stripLeakedCalls(input), expected, input);
	});

	it("leaves ordinary text alone", () => {
		for (const t of ["$a < b$ and $c > d$", "<b>bold</b> <learner>", "the parameters <p> of an invocation", "x<invoked"]) {
			assert.equal(stripLeakedCalls(t), t);
		}
	});

	it("is deterministic", () => {
		const once = stripLeakedCalls(LEAKED_REPLY);
		for (let i = 0; i < 5; i++) assert.equal(stripLeakedCalls(LEAKED_REPLY), once);
		assert.equal(stripLeakedCalls(once), once);
	});
});

// ─── the live guard, driven by a fake SDK query ──────────────────────────────

const TOOLS = [
	{
		name: "quiz",
		description: "",
		parameters: {
			type: "object",
			properties: {
				type: { anyOf: [{ const: "check", type: "string" }, { const: "predict", type: "string" }] },
				question: { type: "string" },
				options: { type: "array" },
				correctAnswer: { type: "string" },
				n: { type: "number" },
			},
		},
	},
	{
		name: "demo",
		description: "",
		parameters: { type: "object", properties: { title: { type: "string" }, brief: { type: "string" } } },
	},
	{
		name: "study_log",
		description: "",
		parameters: { type: "object", properties: { prompt_ref: { anyOf: [{ type: "string" }, { type: "null" }] }, hints_used: { type: "number" } } },
	},
] as unknown as Tool[];

type Raw = Record<string, unknown>;

/** One model call's stream events: one text block streamed in `chunk`-
 *  sized deltas, then the stop. */
function textCall(text: string, stop = "end_turn", chunk = 7, u = { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }): Raw[] {
	const events: Raw[] = [
		{ type: "message_start", message: { usage: u } },
		{ type: "content_block_start", index: 0, content_block: { type: "text" } },
	];
	for (let i = 0; i < text.length; i += chunk) events.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + chunk) } });
	events.push({ type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: "message_stop" });
	return events;
}

/** A stand-in for the SDK's query(): call k plays calls[k] ("throw" fails
 *  synchronously, as a bad option would). */
function fakeQuery(calls: (Raw[] | "throw")[]) {
	let k = 0;
	const fn = () => {
		const events = calls[k++] ?? [];
		if (events === "throw") throw new Error("bad option");
		return {
			async *[Symbol.asyncIterator]() {
				for (const event of events) {
					// Let the consumer read each event before the next mutates the message.
					await new Promise((r) => setImmediate(r));
					yield { type: "stream_event", parent_tool_use_id: null, event };
				}
				yield { type: "result", subtype: "success" };
			},
			close() {},
		};
	};
	return { fn: fn as unknown as typeof claudeQuery.current, count: () => k };
}

async function runGuard(calls: (Raw[] | "throw")[]) {
	const model = piModels().getModels(CLAUDE_CODE_PROVIDER_ID).find((m) => m.id === "claude-opus-5-5")!;
	const context = normalizeContext({ systemPrompt: "Teach.", tools: TOOLS, messages: [{ role: "user", content: "Go.", timestamp: 0 }] });
	const q = fakeQuery(calls);
	const shown: string[] = [];
	let final: AssistantMessage | undefined;
	const real = claudeQuery.current;
	claudeQuery.current = q.fn;
	try {
		for await (const e of streamClaudeCode(model, context) as AsyncIterable<AssistantMessageEvent>) {
			if ("partial" in e) shown.push(JSON.stringify(e.partial.content));
			if (e.type === "done") final = e.message;
			if (e.type === "error") final = e.error;
		}
	} finally {
		claudeQuery.current = real;
	}
	return { final: final!, shown, calls: q.count() };
}

describe("calls written as text, live", () => {
	it("never shows the markup, and turns well-formed calls into real ones", async () => {
		const { final, shown, calls } = await runGuard([textCall(LEAKED_REPLY, "tool_use")]);
		assert.equal(calls, 1);
		for (const s of shown) assert.doesNotMatch(s, /<invoke|<parameter|<inv/);
		assert.ok(shown.some((s) => s.includes("overcounts")), "the prose streams");
		assert.equal(final.stopReason, "toolUse");
		const [text, demo, quiz] = final.content;
		assert.deepEqual(text, { type: "text", text: "Using $3$ for every step overcounts." });
		assert.equal(demo?.type === "toolCall" && demo.name, "demo");
		assert.deepEqual(demo?.type === "toolCall" && demo.arguments, { title: "Line integral as a sum of tiny steps", brief: "Show that P changes along the path." });
		assert.ok(quiz?.type === "toolCall");
		assert.match(quiz.id, /^toolu_text_[0-9a-f]{12}$/);
		assert.deepEqual(quiz.arguments, {
			type: "check",
			question: "Find $\\int_C x^2 y\\,dx$.",
			options: [
				{ label: "$18$", value: "a" },
				{ label: "$54$", value: "b" },
			],
			correctAnswer: "a",
		});
	});

	it("reads values by schema: JSON for non-strings, text where a string is allowed", () => {
		const calls = parseLeakedCalls(['<invoke name="study_log"><parameter name="prompt_ref">toolu_abc</parameter><parameter name="hints_used">0</parameter></invoke>', '<invoke name="study_log"><parameter name="prompt_ref">null</parameter></invoke>'], TOOLS);
		assert.deepEqual(calls, [
			{ name: "study_log", arguments: { prompt_ref: "toolu_abc", hints_used: 0 } },
			{ name: "study_log", arguments: { prompt_ref: null } },
		]);
		assert.deepEqual(
			parseLeakedCalls(['<invoke name="study_log"><parameter name="prompt_ref">12</parameter></invoke><invoke name="quiz"><parameter name="question">true</parameter><parameter name="type">predict</parameter><parameter name="n">2.5</parameter></invoke>'], TOOLS),
			[
				{ name: "study_log", arguments: { prompt_ref: "12" } },
				{ name: "quiz", arguments: { question: "true", type: "predict", n: 2.5 } },
			],
		);
		assert.equal(parseLeakedCalls(['<invoke name="quiz"><parameter name="n">not json</parameter></invoke>'], TOOLS), undefined);
		assert.equal(parseLeakedCalls(['<invoke name="nope"></invoke>'], TOOLS), undefined);
		assert.equal(parseLeakedCalls(['<tool_call name="quiz">{}</tool_call>'], TOOLS), undefined);
		assert.equal(parseLeakedCalls(['<invoke name="quiz">stray text</invoke>'], TOOLS), undefined);
	});

	it("retries once when the markup does not parse, and sums both calls' usage", async () => {
		const bad = 'Look.\n\n<invoke name="unknown_tool"><parameter name="x">1</parameter></invoke>';
		const { final, shown, calls } = await runGuard([textCall(bad), textCall("A clean second try.")]);
		assert.equal(calls, 2);
		for (const s of shown) assert.doesNotMatch(s, /<invoke|<parameter/);
		assert.deepEqual(final.content, [{ type: "text", text: "A clean second try." }]);
		assert.equal(final.stopReason, "stop");
		assert.deepEqual([final.usage.input, final.usage.cacheRead, final.usage.cacheWrite, final.usage.output], [4, 200, 20, 10]);
		// Compaction reads the context ONE call carried, not the sum.
		assert.equal((final.usage as { contextTokens?: number }).contextTokens, 112);
	});

	it("falls back to the first try's prose when the retry itself fails", async () => {
		const bad = 'Worth keeping.\n<invoke name="unknown_tool"></invoke>';
		const { final, calls } = await runGuard([textCall(bad, "tool_use"), []]);
		assert.equal(calls, 2);
		assert.deepEqual(final.content, [{ type: "text", text: "Worth keeping." }]);
		assert.equal(final.stopReason, "stop");
		assert.equal((final.usage as { contextTokens?: number }).contextTokens, 112);
	});

	it("a query that throws at once ends the step with an error instead of hanging", async () => {
		const { final, calls } = await runGuard(["throw"]);
		assert.equal(calls, 1);
		assert.equal(final.stopReason, "error");
		assert.equal(final.errorMessage, "bad option");
	});

	it("keeps only the prose when the retry fails too", async () => {
		const bad = 'First.\n<invoke name="unknown_tool"></invoke>';
		const { final, shown, calls } = await runGuard([textCall(bad, "tool_use"), textCall(bad.replace("First", "Second"), "tool_use")]);
		assert.equal(calls, 2);
		for (const s of shown) assert.doesNotMatch(s, /<invoke/);
		assert.deepEqual(final.content, [{ type: "text", text: "Second." }]);
		assert.equal(final.stopReason, "stop");
	});

	it("passes ordinary text through untouched, even a '<' split across deltas", async () => {
		const text = "So $a<b$ and <b>bold</b>, x<invoked.";
		const { final, calls } = await runGuard([textCall(text, "end_turn", 1)]);
		assert.equal(calls, 1);
		assert.deepEqual(final.content, [{ type: "text", text }]);
	});
});

/** A reply a classifier stops mid-stream: some text, then a quiz call cut
 *  off inside its arguments (chat_mvu3w0p9, 2026-10-29). */
function refusedCall(category: string | null): Raw[] {
	return [
		{ type: "message_start", message: { usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "First a full calculation." } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_cut", name: "mcp__mt__quiz" } },
		{ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"question":"Find $\\\\int_C' } },
		{ type: "message_delta", delta: { stop_reason: "refusal", stop_details: category === null ? null : { type: "refusal", category } }, usage: { output_tokens: 40 } },
		{ type: "message_stop" },
	];
}

describe("refusals", () => {
	it("drop the partial reply and name the classifier", async () => {
		const { final, calls } = await runGuard([refusedCall("reasoning_extraction")]);
		assert.equal(calls, 1);
		assert.equal(final.stopReason, "error");
		assert.equal(final.errorMessage, "Claude declined this request (reasoning_extraction).");
		assert.deepEqual(final.content, []);
		assert.equal(final.usage.output, 40);
	});

	it("say only that Claude declined when no category comes back", async () => {
		const { final } = await runGuard([refusedCall(null)]);
		assert.equal(final.errorMessage, "Claude declined this request.");
		assert.deepEqual(final.content, []);
	});

	it("replay as nothing, so the next step's blocks still extend this one's", () => {
		const before: Message[] = [{ role: "user", content: "Go.", timestamp: 0 }];
		const refused = { role: "assistant", content: [], api: "claude-agent-sdk", provider: CLAUDE_CODE_PROVIDER_ID, model: "claude-opus-5-5", usage: {}, stopReason: "error", timestamp: 0 } as unknown as Message;
		assert.deepEqual(transcriptBlocks([...before, refused]), transcriptBlocks(before));
	});
});

describe("query options", () => {
	it("give the session a title, so the CLI makes no extra call to name it", async () => {
		const model = piModels().getModels(CLAUDE_CODE_PROVIDER_ID).find((m) => m.id === "claude-opus-5-5")!;
		const context = normalizeContext({ systemPrompt: "Teach.", tools: TOOLS, messages: [{ role: "user", content: "Go.", timestamp: 0 }] });
		const q = fakeQuery([textCall("Hi.")]);
		let options: { title?: string } | undefined;
		const real = claudeQuery.current;
		claudeQuery.current = ((params: { options: { title?: string } }) => {
			options = params.options;
			return q.fn(params as never);
		}) as unknown as typeof claudeQuery.current;
		try {
			for await (const _ of streamClaudeCode(model, context) as AsyncIterable<AssistantMessageEvent>);
		} finally {
			claudeQuery.current = real;
		}
		assert.equal(typeof options?.title, "string");
		assert.ok(options!.title!.length > 0);
	});
});
