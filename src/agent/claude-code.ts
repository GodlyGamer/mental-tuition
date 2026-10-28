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
import os from "node:os";

export const CLAUDE_CODE_PROVIDER_ID = "claude-code";
export const CLAUDE_CODE_API = "claude-agent-sdk";

/** The models offered through the subscription, cloned from pi's Anthropic
 *  catalog (context window, thinking map, modalities stay authoritative). */
const SUBSCRIPTION_MODEL_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

/** MCP server name; tool names arrive as mcp__mt__<name> (or bare, when
 *  the host sets CLAUDE_AGENT_SDK_MCP_NO_PREFIX). */
const MCP_SERVER = "mt";
const MCP_PREFIX = `mcp__${MCP_SERVER}__`;

/** Appended to every system prompt: how the replayed transcript reads. */
export const TRANSCRIPT_NOTE = `

# How this conversation reaches you
The conversation so far arrives as one message of tagged blocks, oldest first. <learner> blocks are the learner's messages, <you> blocks are your own earlier replies, <tool_call> blocks are tools you called, and <tool_result> blocks are what those calls returned. The last block is the newest; write your next reply from there. To use a tool, call it through the tool interface; never write <tool_call> or <tool_result> tags yourself.`;

/** Gemini's note. Its history shows earlier tool calls as plain sentences,
 *  never as tags: a model that sees tag-shaped calls in its own history
 *  starts writing them as text, which the learner then sees (2026-10-25). */
export const TRANSCRIPT_NOTE_PROSE = `

# How this conversation reaches you
The conversation so far arrives as one message of tagged blocks, oldest first. <learner> blocks are the learner's messages, <you> blocks are your own earlier replies. Tool use and its results appear as plain sentences between them ("You used the quiz tool with …", "The quiz tool returned …"). The last block is the newest; write your next reply from there. To use a tool, call it through the tool interface only; never write tool calls or results as text.`;

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
 * The transcript as prompt blocks, one per message in the tag notation
 * TRANSCRIPT_NOTE explains (a lone first message too), and nothing after
 * the newest message: call N's blocks are then an exact prefix of call
 * N+1's, which is what lets the prompt cache carry the history forward.
 * One step adds a few blocks (a reply, its tool results, at most a few
 * images), well inside the cache's 20-block lookback. Thinking from
 * earlier turns is not replayed (its signatures only bind to native
 * history).
 */
export function transcriptBlocks(messages: readonly Message[], style: "tags" | "prose" = "tags"): PromptBlock[] {
	const blocks: PromptBlock[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			blocks.push({ type: "text", text: `<learner>\n${textOf(m.content)}\n</learner>` });
			if (typeof m.content !== "string") for (const c of m.content) if (c.type === "image") blocks.push(imageBlock(c));
		} else if (m.role === "assistant") {
			const parts: string[] = [];
			for (const c of m.content) {
				if (c.type === "text" && c.text.trim()) parts.push(c.text);
				else if (c.type === "toolCall")
					parts.push(
						style === "prose"
							? `(You used the ${c.name} tool with ${JSON.stringify(c.arguments)}.)`
							: `<tool_call id="${c.id}" name="${c.name}">${JSON.stringify(c.arguments)}</tool_call>`,
					);
			}
			if (parts.length) blocks.push({ type: "text", text: `<you>\n${parts.join("\n")}\n</you>` });
		} else if (m.role === "toolResult") {
			const status = m.isError ? ' error="true"' : "";
			blocks.push({
				type: "text",
				text:
					style === "prose"
						? `(The ${m.toolName} tool ${m.isError ? "failed and returned" : "returned"}: ${textOf(m.content)})`
						: `<tool_result id="${m.toolCallId}" name="${m.toolName}"${status}>\n${textOf(m.content)}\n</tool_result>`,
			});
			for (const c of m.content) if (c.type === "image") blocks.push(imageBlock(c));
		}
	}
	return blocks;
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

	// Anthropic block index → index in output.content, plus the raw JSON
	// accumulating for each tool call.
	const slot = new Map<number, number>();
	const toolJson = new Map<number, string>();
	let started = false;
	let finished = false;
	let refused = false;
	let stopReason: ReturnType<typeof mapStop> = "stop";
	let fallbackError: string | undefined;

	const start = () => {
		if (started) return;
		started = true;
		stream.push({ type: "start", partial: output });
	};

	const q = query({
		prompt: (async function* () {
			yield {
				type: "user" as const,
				message: { role: "user" as const, content: transcriptBlocks(context.messages) },
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

	try {
		for await (const msg of q as AsyncIterable<SDKMessage>) {
			if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
				handleEvent(msg.event as RawEvent);
				if (finished) break;
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
				if (!finished && msg.subtype !== "success" && msg.subtype !== "error_max_turns") {
					fallbackError ??= `Claude Code stopped: ${msg.subtype}`;
				}
				break;
			}
		}
	} catch (err) {
		if (!abort.signal.aborted) fallbackError ??= err instanceof Error ? err.message : String(err);
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		q.close();
	}

	if (abort.signal.aborted && !finished) {
		output.stopReason = "aborted";
		start();
		stream.push({ type: "error", reason: "aborted", error: output });
		return;
	}
	if (!finished || refused) {
		output.stopReason = "error";
		output.errorMessage = refused ? "Claude declined this request." : (fallbackError ?? "Claude Code returned no response");
		start();
		stream.push({ type: "error", reason: "error", error: output });
		return;
	}
	output.stopReason = stopReason;
	stream.push({ type: "done", reason: stopReason, message: output });

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
					toolJson.set(e.index, "");
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
					block.text += d.text;
					stream.push({ type: "text_delta", contentIndex: index, delta: d.text, partial: output });
				} else if (d.type === "thinking_delta" && block.type === "thinking") {
					block.thinking += d.thinking;
					stream.push({ type: "thinking_delta", contentIndex: index, delta: d.thinking, partial: output });
				} else if (d.type === "signature_delta" && block.type === "thinking") {
					block.thinkingSignature = (block.thinkingSignature ?? "") + d.signature;
				} else if (d.type === "input_json_delta" && block.type === "toolCall") {
					toolJson.set(e.index, (toolJson.get(e.index) ?? "") + d.partial_json);
					stream.push({ type: "toolcall_delta", contentIndex: index, delta: d.partial_json, partial: output });
				}
				break;
			}
			case "content_block_stop": {
				const index = slot.get(e.index);
				const block = index === undefined ? undefined : output.content[index];
				if (index === undefined || !block) break;
				if (block.type === "text") {
					stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
				} else if (block.type === "thinking") {
					stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
				} else if (block.type === "toolCall") {
					const raw = toolJson.get(e.index) ?? "";
					try {
						const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
						if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) block.arguments = parsed as JsonObject;
						else block.argumentsError = `Tool arguments were not a JSON object: ${raw}`;
					} catch {
						block.argumentsError = `Tool arguments were not valid JSON: ${raw}`;
					}
					stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
				}
				break;
			}
			case "message_delta": {
				if (e.usage) applyUsage(e.usage);
				stopReason = mapStop(e.delta?.stop_reason);
				if (e.delta?.stop_reason === "refusal") refused = true;
				break;
			}
			case "message_stop":
				finished = true;
				break;
		}
	}

	function applyUsage(u: RawUsage) {
		if (u.input_tokens != null) output.usage.input = u.input_tokens;
		if (u.output_tokens != null) output.usage.output = u.output_tokens;
		if (u.cache_read_input_tokens != null) output.usage.cacheRead = u.cache_read_input_tokens;
		if (u.cache_creation_input_tokens != null) output.usage.cacheWrite = u.cache_creation_input_tokens;
		output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
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
