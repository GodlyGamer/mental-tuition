/**
 * The Claude subscription engine (personal fork, 2026-10-24): a pi-ai
 * provider whose stream runs ONE model step through the Claude Agent SDK —
 * i.e. the locally logged-in Claude Code — instead of a provider HTTP API.
 * No API key: requests ride the user's Claude plan.
 *
 * Why one step per call: pi-agent-core owns the agent loop (tool execution,
 * question-tool pauses, steering, usage). The SDK owns a loop too, so each
 * pi model call becomes a `query()` capped at one turn:
 *   - the app's tools are exposed through an in-process MCP server whose
 *     handlers never do real work (pi executes the calls it gets back);
 *   - Claude Code's own built-in tools, settings, CLAUDE.md, hooks and
 *     plugins are all switched off, so the app's system prompt is the
 *     whole instruction set;
 *   - the transcript so far is replayed as one user message (the SDK takes
 *     no prior assistant turns), with each earlier message in its own
 *     content block. Nothing follows the newest message, so every request
 *     extends the previous one and Claude Code's cache breakpoint on the
 *     last block is read back on the next call (2026-10-28: a closing
 *     trailer block used to end each request, so only the system prompt
 *     and tools ever hit the cache).
 * Stream events (text, thinking, tool calls) are mapped onto pi's
 * AssistantMessageEvent protocol, so every agent and the UI bridge work
 * unchanged.
 *
 * Calls written as text (2026-10-29): in long chats Claude sometimes ends a
 * reply with its own <invoke>/<parameter> call syntax as plain text. The
 * mapper never shows or saves that markup: it parses it into real tool
 * calls, or retries the step once, or keeps only the prose. Earlier calls
 * replay as prose rather than tags (the tag-shaped calls in its own past
 * replies taught it to write calls as text), and markup already saved in
 * older chats is replaced by LEAKED_CALL_NOTE on replay.
 */

import {
	createAssistantMessageEventStream,
	createProvider,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type ImageContent,
	type JsonObject,
	type Message,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type Tool,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { query, type EffortLevel, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { healEncodedArguments } from "../core/argument-heal.ts";
import type { ReportedUsage } from "../core/compaction.ts";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const CLAUDE_CODE_API = "claude-agent-sdk";

/** The models offered through the subscription, cloned from pi's Anthropic
 *  catalog (context window, thinking map, modalities stay authoritative). */
const SUBSCRIPTION_MODEL_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

/** MCP server name; tool names arrive as mcp__mt__<name> (or bare, when
 *  the host sets CLAUDE_AGENT_SDK_MCP_NO_PREFIX). */
const MCP_SERVER = "mt";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

/** What replaces a call written as text in a replayed earlier reply. */
export const LEAKED_CALL_NOTE =
	"(A tool call was written here as text instead of through the tool interface. It never ran and the learner did not see it.)";

/** Appended to every system prompt (both engines): how the replayed
 *  transcript reads (calls as sentences, never tags: see the header). */
export const TRANSCRIPT_NOTE = `

# How this conversation reaches you
The conversation so far arrives as one message of tagged blocks, oldest first. <learner> blocks are the learner's messages, <you> blocks are your own earlier replies. Tool use and its results appear as plain sentences between them ("You used the quiz tool, call id …, with …", "The quiz tool, call id …, returned …"). A reply that shows the note "${LEAKED_CALL_NOTE}" asked for something the learner never saw. The last block is the newest; write your next reply from there. To use a tool, call it through the tool interface only; never write tool calls or results as text.`;

export function claudeCodeProvider(anthropicModels: readonly Model<Api>[]): Provider {
	const models = SUBSCRIPTION_MODEL_IDS.flatMap((id) => {
		const found = anthropicModels.find((m) => m.id === id);
		if (!found) return [];
		// compat is typed per API; the SDK path reads none of it.
		const { compat: _compat, ...base } = found;
		return [
			{
				...base,
				name: `${base.name} (subscription)`,
				provider: CLAUDE_CODE_PROVIDER_ID,
				api: CLAUDE_CODE_API,
				baseUrl: "",
				// Plan usage, not metered tokens: the cost meter reads zero.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} satisfies Model<Api>,
		];
	});
	return createProvider({
		id: CLAUDE_CODE_PROVIDER_ID,
		name: "Claude (subscription)",
		auth: {
			apiKey: {
				name: "Claude Code login",
				// Auth lives in Claude Code's own credential store; a missing
				// login surfaces as a stream error naming the fix.
				resolve: async () => ({ auth: {}, source: "Claude Code login" }),
			},
		},
		models,
		api: { stream: streamClaudeCode, streamSimple: streamClaudeCode },
	});
}

/** pi thinking level → SDK effort (pi sends no level for "off"; current
 *  models cannot turn thinking off, so "minimal" lands on the lowest). */
function effortFor(level: SimpleStreamOptions["reasoning"]): EffortLevel | undefined {
	switch (level) {
		case undefined:
			return undefined;
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		default:
			return "max";
	}
}

/** Variables that would route requests away from the subscription login. */
const NON_SUBSCRIPTION_AUTH = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]);

/** The child process environment: the parent's, minus anything that would
 *  route the request away from the subscription login (a key, a token, a
 *  proxy) or make the child think it is nested inside another Claude Code
 *  session. */
export function childEnv(): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (NON_SUBSCRIPTION_AUTH.has(k) || k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
		env[k] = v;
	}
	env.CLAUDE_AGENT_SDK_CLIENT_APP = "mentaltuition";
	return env;
}

function textOf(content: string | (TextContent | ImageContent)[]): string {
	return typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
}

type PromptBlock =
	| { type: "text"; text: string }
	| { type: "image"; source: { type: "base64"; media_type: ImageMime; data: string } };
type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function imageBlock(img: ImageContent): PromptBlock {
	return { type: "image", source: { type: "base64", media_type: img.mimeType as ImageMime, data: img.data } };
}

/**
 * The transcript as prompt blocks, one per message in the notation
 * TRANSCRIPT_NOTE explains (a lone first message too), and nothing
 * after the newest message: call N's blocks are then an exact prefix of
 * call N+1's, which is what lets the prompt cache carry the history
 * forward. Every message renders the same way every time (leaked markup
 * is stripped deterministically), so the prefix holds. One step adds a few
 * blocks (a reply, its tool results, at most a few images), well inside
 * the cache's 20-block lookback. Thinking from earlier turns is not
 * replayed (its signatures only bind to native history).
 */
export function transcriptBlocks(messages: readonly Message[]): PromptBlock[] {
	const blocks: PromptBlock[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			blocks.push({ type: "text", text: `<learner>\n${textOf(m.content)}\n</learner>` });
			if (typeof m.content !== "string") for (const c of m.content) if (c.type === "image") blocks.push(imageBlock(c));
		} else if (m.role === "assistant") {
			const parts: string[] = [];
			for (const c of m.content) {
				if (c.type === "text" && c.text.trim()) parts.push(stripLeakedCalls(c.text));
				else if (c.type === "toolCall") parts.push(`(You used the ${c.name} tool, call id ${c.id}, with ${JSON.stringify(c.arguments)}.)`);
			}
			if (parts.length) blocks.push({ type: "text", text: `<you>\n${parts.join("\n")}\n</you>` });
		} else if (m.role === "toolResult") {
			const verb = m.isError ? "failed and returned" : "returned";
			blocks.push({ type: "text", text: `(The ${m.toolName} tool, call id ${m.toolCallId}, ${verb}: ${textOf(m.content)})` });
			for (const c of m.content) if (c.type === "image") blocks.push(imageBlock(c));
		}
	}
	return blocks;
}

// ─── calls written as text ──────────────────────────────────────────────────

/** An optional namespace prefix, and the tag names of call-shaped markup
 *  (tool_call/tool_result: the tag replay older chats saved). */
const NS = String.raw`(?:[A-Za-z_][\w.-]*:)?`;
const TAGS = "(?:invoke|parameter|function_calls|tool_call|tool_result)";
/** One tag of that markup: group 1 is "/" on a closing tag. An opener cut
 *  off at the end of the text counts. */
const LEAK_TAG = new RegExp(String.raw`<(\/?)${NS}${TAGS}\b[^>]*(?:>|$)`, "g");
/** The start of an opening tag, for the live hold-back. */
const LEAK_OPEN = new RegExp(String.raw`<${NS}${TAGS}\b`);
/** A trailing "<…" that could still grow into an opener. */
const MAYBE_OPEN = /<[\w.:-]{0,40}$/;

interface Span {
	start: number;
	end: number;
}

/** The runs of leaked markup in a text. A run starts at a tag, lasts until
 *  its elements close, and takes in further tags that follow with only
 *  whitespace between; an element left open runs to the end of the text. */
function leakSpans(text: string): Span[] {
	const tags = [...text.matchAll(LEAK_TAG)];
	const spans: Span[] = [];
	let i = 0;
	while (i < tags.length) {
		const start = tags[i]!.index;
		let depth = 0;
		let end = start;
		for (; i < tags.length; i++) {
			const t = tags[i]!;
			if (depth === 0 && t.index > start && text.slice(end, t.index).trim()) break;
			if (t[1]) depth = Math.max(0, depth - 1);
			else if (!t[0].endsWith("/>")) depth++;
			end = t.index + t[0].length;
		}
		spans.push({ start, end: depth > 0 ? text.length : end });
	}
	return spans;
}

function replaceSpans(text: string, spans: readonly Span[], by: string): string {
	let out = "";
	let at = 0;
	for (const s of spans) {
		out += text.slice(at, s.start) + by;
		at = s.end;
	}
	return out + text.slice(at);
}

/** An earlier reply's text for replay: each run of leaked call markup
 *  becomes LEAKED_CALL_NOTE. Pure, so replayed history never changes. */
export function stripLeakedCalls(text: string): string {
	return replaceSpans(text, leakSpans(text), LEAKED_CALL_NOTE);
}

/** What of a streaming text may show, given that `raw.slice(0, from)` is
 *  already showing: everything before the first opener, minus a trailing
 *  "<…" that could still become one. Only the new part is scanned (a shown
 *  prefix never holds an opener or a held-back "<…"). */
function shownText(raw: string, from: number): { shown: string; opened: boolean } {
	const rest = raw.slice(from);
	const open = rest.search(LEAK_OPEN);
	if (open >= 0) return { shown: raw.slice(0, from + open), opened: true };
	const maybe = MAYBE_OPEN.exec(rest);
	return { shown: maybe ? raw.slice(0, from + maybe.index) : raw, opened: false };
}

/** One element, in sticky mode: group 1 is its name attribute, group 2 its body. */
const element = (tag: string) => new RegExp(String.raw`\s*<${NS}${tag}\s+name="([^"]+)"\s*>([\s\S]*?)</${NS}${tag}>`, "y");
const INVOKE = element("invoke");
const PARAMETER = element("parameter");
const WRAPPER = new RegExp(String.raw`</?${NS}function_calls>`, "g");

/** Back-to-back matches of a sticky `re` covering all of `s` but
 *  whitespace, or undefined when anything else is left over. */
function stickyAll(re: RegExp, s: string): RegExpExecArray[] | undefined {
	const out: RegExpExecArray[] = [];
	let at = 0;
	for (;;) {
		re.lastIndex = at;
		const m = re.exec(s);
		if (!m) break;
		out.push(m);
		at = re.lastIndex;
	}
	return s.slice(at).trim() ? undefined : out;
}

/** Leaked runs as tool calls, or undefined unless every run is one or more
 *  well-formed <invoke> elements naming one of `tools`, with every value
 *  fitting its field. Values arrive as text and are decoded the way the
 *  agent boundary heals a JSON-encoded argument (healEncodedArguments). */
export function parseLeakedCalls(runs: readonly string[], tools: readonly Tool[]): { name: string; arguments: JsonObject }[] | undefined {
	const calls: { name: string; arguments: JsonObject }[] = [];
	for (const run of runs) {
		const invokes = stickyAll(INVOKE, run.replace(WRAPPER, ""));
		if (!invokes?.length) return undefined;
		for (const [, name, body] of invokes) {
			const tool = tools.find((t) => t.name === stripPrefix(name!));
			const params = stickyAll(PARAMETER, body!);
			if (!tool || !params) return undefined;
			const schema = tool.parameters as { properties?: Record<string, TSchema> };
			const args = healEncodedArguments(Object.fromEntries(params.map(([, key, value]) => [key, value])), schema) as JsonObject;
			for (const [key, value] of Object.entries(args)) {
				const field = schema.properties?.[key];
				if (field && !Value.Check(field, value)) return undefined;
			}
			calls.push({ name: tool.name, arguments: args });
		}
	}
	return calls.length ? calls : undefined;
}

/** An in-process MCP server listing the app's tools with their JSON
 *  schemas verbatim. Calls are acknowledged and ignored: the one-turn cap
 *  ends the query, and pi runs the real execution. */
function toolServer(tools: readonly Tool[]) {
	const server = new McpServer({ name: MCP_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
	server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.parameters as { type: "object"; [k: string]: unknown },
		})),
	}));
	server.server.setRequestHandler(CallToolRequestSchema, async () => ({
		content: [{ type: "text" as const, text: "Received." }],
	}));
	return { type: "sdk" as const, name: MCP_SERVER, instance: server };
}

function stripPrefix(name: string): string {
	return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

function mapStop(reason: string | null | undefined): Extract<StopReason, "stop" | "length" | "toolUse"> {
	if (reason === "tool_use") return "toolUse";
	if (reason === "max_tokens") return "length";
	return "stop";
}

const AUTH_HINT =
	"Claude Code is not logged in on this computer. Open a terminal, run `claude`, type /login, then try again.";

/** Test seam (the toolTimeoutMs idiom): the SDK's query(). */
export const claudeQuery = { current: query };

export function streamClaudeCode(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	void run(model, context, options, stream, output);
	return stream;
}

interface CallTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** How one model call ended (its content lands on the step's output). */
interface CallResult {
	finished: boolean;
	refused: boolean;
	stopReason: ReturnType<typeof mapStop>;
	/** Runs of call markup taken out of its text blocks. */
	leaked: string[];
	tokens: CallTokens;
}

const ok = (r: CallResult) => r.finished && !r.refused;
const contextOf = (t: CallTokens) => t.input + t.cacheRead + t.cacheWrite;

async function run(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
): Promise<void> {
	const abort = new AbortController();
	const onAbort = () => abort.abort();
	options?.signal?.addEventListener("abort", onAbort, { once: true });

	const tools = getCurrentTools(context.messages);
	const systemPrompt = getCurrentSystemPrompt(context.messages) + TRANSCRIPT_NOTE;
	const effort = effortFor(options?.reasoning);
	const prompt = transcriptBlocks(context.messages);

	let started = false;
	let fallbackError: string | undefined;
	// A retried step reports both calls' tokens (`spent` is the first's) and,
	// as contextTokens, the context of the call whose reply it keeps.
	let spent: CallTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	const start = () => {
		if (started) return;
		started = true;
		stream.push({ type: "start", partial: output });
	};

	let result = await callOnce();
	if (ok(result) && result.leaked.length && !useLeakedCalls(result)) {
		// Retry once: the next call's first event replaces the reply on screen.
		const first = { result, content: output.content };
		spent = result.tokens;
		output.content = [];
		result = await callOnce();
		if (!ok(result) && !abort.signal.aborted) {
			// The retry failed outright: keep the first try's prose.
			result = first.result;
			output.content = first.content;
		} else if (ok(result) && result.leaked.length) useLeakedCalls(result);
		(output.usage as ReportedUsage).contextTokens = contextOf(result.tokens);
		// Prose only: the API may still say tool_use for the dropped markup.
		if (result.stopReason === "toolUse" && !output.content.some((c) => c.type === "toolCall")) result.stopReason = "stop";
	}
	options?.signal?.removeEventListener("abort", onAbort);

	if (abort.signal.aborted && !result.finished) {
		output.stopReason = "aborted";
		start();
		stream.push({ type: "error", reason: "aborted", error: output });
		return;
	}
	if (!ok(result)) {
		output.stopReason = "error";
		output.errorMessage = result.refused ? "Claude declined this request." : (fallbackError ?? "Claude Code returned no response");
		start();
		stream.push({ type: "error", reason: "error", error: output });
		return;
	}
	output.stopReason = result.stopReason;
	stream.push({ type: "done", reason: result.stopReason, message: output });

	/** The call's leaked markup as real tool calls, when every run parses. */
	function useLeakedCalls(r: CallResult): boolean {
		const calls = parseLeakedCalls(r.leaked, tools);
		if (!calls) return false;
		for (const c of calls) {
			const index = output.content.length;
			const toolCall = { type: "toolCall" as const, id: `toolu_text_${randomUUID().replace(/-/g, "").slice(0, 12)}`, ...c };
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
		}
		r.stopReason = "toolUse";
		return true;
	}

	/** One model call through the SDK; its events land on `output`. */
	async function callOnce(): Promise<CallResult> {
		const r: CallResult = { finished: false, refused: false, stopReason: "stop", leaked: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		// Anthropic block index → index in output.content, and the raw text
		// accumulating per block: a text block's (the block itself holds only
		// what may show) or a tool call's JSON.
		const slot = new Map<number, number>();
		const raw = new Map<number, string>();
		/** Text blocks that reached an opener: nothing more shows until they end. */
		const held = new Set<number>();
		let q: ReturnType<typeof query> | undefined;
		try {
			q = claudeQuery.current({
				prompt: (async function* () {
					yield {
						type: "user" as const,
						message: { role: "user" as const, content: prompt },
						parent_tool_use_id: null,
					};
				})(),
				options: {
					model: model.id,
					systemPrompt,
					tools: [],
					mcpServers: tools.length ? { [MCP_SERVER]: toolServer(tools) } : {},
					allowedTools: tools.map((t) => MCP_PREFIX + t.name),
					strictMcpConfig: true,
					settingSources: [],
					persistSession: false,
					maxTurns: 1,
					includePartialMessages: true,
					thinking: { type: "adaptive", display: "summarized" },
					...(effort ? { effort } : {}),
					cwd: os.tmpdir(),
					env: childEnv(),
					abortController: abort,
				},
			});
			for await (const msg of q as AsyncIterable<SDKMessage>) {
				if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
					handleEvent(msg.event as RawEvent);
					if (r.finished) break;
				} else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
					if (msg.error) {
						fallbackError =
							msg.error === "authentication_failed" ? AUTH_HINT : `Claude Code error (${msg.error})`;
					}
					// A synthetic reply (no stream events at all), e.g. the
					// not-logged-in notice: keep its text for the error path.
					if (!started) {
						const text = msg.message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
						if (/not logged in|\/login/i.test(text)) fallbackError = AUTH_HINT;
						else if (text) fallbackError ??= text;
					}
				} else if (msg.type === "result") {
					if (!r.finished && msg.subtype !== "success" && msg.subtype !== "error_max_turns") {
						fallbackError ??= `Claude Code stopped: ${msg.subtype}`;
					}
					break;
				}
			}
		} catch (err) {
			if (!abort.signal.aborted) fallbackError ??= err instanceof Error ? err.message : String(err);
		} finally {
			q?.close();
		}
		return r;

		function handleEvent(e: RawEvent) {
			switch (e.type) {
				case "message_start": {
					const u = e.message?.usage;
					if (u) applyUsage(u);
					start();
					break;
				}
				case "content_block_start": {
					start();
					const b = e.content_block as { type: string; id?: string; name?: string; data?: string };
					const index = output.content.length;
					if (b.type === "text") {
						output.content.push({ type: "text", text: "" });
						slot.set(e.index, index);
						stream.push({ type: "text_start", contentIndex: index, partial: output });
					} else if (b.type === "thinking" || b.type === "redacted_thinking") {
						output.content.push({
							type: "thinking",
							thinking: "",
							...(b.type === "redacted_thinking" ? { redacted: true, thinkingSignature: b.data } : {}),
						});
						slot.set(e.index, index);
						stream.push({ type: "thinking_start", contentIndex: index, partial: output });
					} else if (b.type === "tool_use") {
						output.content.push({ type: "toolCall", id: b.id ?? "", name: stripPrefix(b.name ?? ""), arguments: {} });
						slot.set(e.index, index);
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
					}
					break;
				}
				case "content_block_delta": {
					const index = slot.get(e.index);
					const block = index === undefined ? undefined : output.content[index];
					if (index === undefined || !block) break;
					const d = e.delta;
					if (d.type === "text_delta" && block.type === "text") {
						const text = (raw.get(e.index) ?? "") + d.text;
						raw.set(e.index, text);
						if (held.has(e.index)) break;
						const { shown, opened } = shownText(text, block.text.length);
						if (opened) held.add(e.index);
						if (shown.length > block.text.length) {
							const delta = shown.slice(block.text.length);
							block.text = shown;
							stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
						}
					} else if (d.type === "thinking_delta" && block.type === "thinking") {
						block.thinking += d.thinking;
						stream.push({ type: "thinking_delta", contentIndex: index, delta: d.thinking, partial: output });
					} else if (d.type === "signature_delta" && block.type === "thinking") {
						block.thinkingSignature = (block.thinkingSignature ?? "") + d.signature;
					} else if (d.type === "input_json_delta" && block.type === "toolCall") {
						raw.set(e.index, (raw.get(e.index) ?? "") + d.partial_json);
						stream.push({ type: "toolcall_delta", contentIndex: index, delta: d.partial_json, partial: output });
					}
					break;
				}
				case "content_block_stop": {
					const index = slot.get(e.index);
					const block = index === undefined ? undefined : output.content[index];
					if (index === undefined || !block) break;
					const text = raw.get(e.index) ?? "";
					if (block.type === "text") {
						const spans = leakSpans(text);
						r.leaked.push(...spans.map((s) => text.slice(s.start, s.end)));
						block.text = spans.length ? replaceSpans(text, spans, "").trimEnd() : text;
						stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
					} else if (block.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
					} else if (block.type === "toolCall") {
						try {
							const parsed: unknown = text.trim() ? JSON.parse(text) : {};
							if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) block.arguments = parsed as JsonObject;
							else block.argumentsError = `Tool arguments were not a JSON object: ${text}`;
						} catch {
							block.argumentsError = `Tool arguments were not valid JSON: ${text}`;
						}
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
					}
					break;
				}
				case "message_delta": {
					if (e.usage) applyUsage(e.usage);
					r.stopReason = mapStop(e.delta?.stop_reason);
					if (e.delta?.stop_reason === "refusal") r.refused = true;
					break;
				}
				case "message_stop":
					r.finished = true;
					break;
			}
		}

		function applyUsage(u: RawUsage) {
			const t = r.tokens;
			if (u.input_tokens != null) t.input = u.input_tokens;
			if (u.output_tokens != null) t.output = u.output_tokens;
			if (u.cache_read_input_tokens != null) t.cacheRead = u.cache_read_input_tokens;
			if (u.cache_creation_input_tokens != null) t.cacheWrite = u.cache_creation_input_tokens;
			const usage = output.usage;
			usage.input = spent.input + t.input;
			usage.output = spent.output + t.output;
			usage.cacheRead = spent.cacheRead + t.cacheRead;
			usage.cacheWrite = spent.cacheWrite + t.cacheWrite;
			usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		}
	}
}

// The slice of the Messages API stream-event shape this mapper reads.
interface RawUsage {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
}
type RawEvent =
	| { type: "message_start"; message?: { usage?: RawUsage } }
	| { type: "content_block_start"; index: number; content_block: { type: string } }
	| {
			type: "content_block_delta";
			index: number;
			delta:
				| { type: "text_delta"; text: string }
				| { type: "thinking_delta"; thinking: string }
				| { type: "signature_delta"; signature: string }
				| { type: "input_json_delta"; partial_json: string };
	  }
	| { type: "content_block_stop"; index: number }
	| { type: "message_delta"; delta?: { stop_reason?: string | null }; usage?: RawUsage }
	| { type: "message_stop" };
