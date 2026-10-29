/**
 * The Gemini (Google login) engine (personal fork, 2026-10-24): a pi-ai
 * provider whose stream runs ONE model step through Google's official
 * Antigravity ACP server (agy_acp_server, from the ACP registry; SHA-256
 * verified, Google-signed, kept in .tools/). ACP = Agent Client Protocol,
 * JSON-RPC over stdio — the protocol IDEs use to drive Antigravity.
 * Requests ride the learner's Google sign-in (src/server/antigravity-setup.ts); no key.
 * (Gemini CLI's personal sign-in was shut off by Google — Antigravity is
 * its supported successor.)
 *
 * Same shape as the Claude engine (src/agent/claude-code.ts), so every
 * agent and the UI bridge work unchanged:
 *   - pi-agent-core owns the loop; each pi model call is one ACP session +
 *     prompt on a server process kept alive across steps (it cold-starts in
 *     ~10s, too slow to pay per step);
 *   - the app's tools are served by an in-process MCP server (streamable
 *     HTTP on 127.0.0.1); calls are captured in the handler and acknowledged;
 *   - permission requests: the app's own MCP tools are allowed, Antigravity's
 *     built-in tools (files, terminal, browser) are denied;
 *   - once this response's tool calls are in and Antigravity starts its next
 *     response, the prompt is cancelled and the calls go back to pi;
 *   - the app's system prompt is APPENDED to Antigravity's own
 *     (_meta.antigravity.systemPrompt.append — the only form it offers);
 *   - the transcript is replayed as one tagged prompt (transcriptBlocks);
 *   - one step can run several internal model calls, and the prompt's
 *     usage SUMS them (a single probing step read 184.9k): the token fields
 *     keep that sum (the real spend), while contextTokens carries the latest
 *     usage_update "used" — the context one call actually carried.
 */

import {
	createAssistantMessageEventStream,
	createProvider,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type Tool,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { LOCAL_ROOT } from "../../config.ts";
import { TRANSCRIPT_NOTE, transcriptBlocks } from "./claude-code.ts";
import type { ReportedUsage } from "../core/compaction.ts";

export const ANTIGRAVITY_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_API = "antigravity-acp";
export const ANTIGRAVITY_VERSION = "1.4.3";

/** What the learner reads when a Gemini turn fails. A model the Google plan
 *  doesn't include is NOT a sign-in problem (the server's refusal mentions
 *  "authentication method"), so it gets its own message naming the models
 *  the account has. Real sign-in trouble still gets the sign-in hint. */
export function geminiErrorText(message: string): string {
	const refused = /is not available for the current authentication method/.exec(message);
	if (refused) {
		const list = /"availableModels":\[([^\]]*)\]/.exec(message)?.[1];
		const models = list ? list.split(",").map((m) => m.trim().replace(/"/g, "")).filter(Boolean) : [];
		const choice = models.length ? ` Your Google plan has: ${models.join(", ")}.` : "";
		return `That Gemini model isn't on your Google plan.${choice} Pick one of those in the model menu for this chat, then send again.`;
	}
	return /auth|login|credential|sign.?in|token/i.test(message) ? `${LOGIN_HINT} (${message})` : message;
}


/** Antigravity's own system prompt is written for a coding assistant, and
 *  the server only lets us APPEND to it. This opens the append with the
 *  teacher's role and the tool reality, so Gemini doesn't drift into a
 *  coding-assistant voice or try its built-in file/terminal tools (those
 *  requests are refused here, and the fallback was writing text instead of
 *  calling the app's picture and demo jobs). */
export const ANTIGRAVITY_TEACHER_PREAMBLE = `You are the teacher in Mental Tuition, a tutoring app. You are not a coding assistant: do not write code unless the learner asks for code, and do not describe yourself as an assistant or an AI model.

Your own built-in tools (reading and writing files, the terminal, the browser) are NOT available in this app and will be refused. Use only the tools listed for you here. For a picture or a diagram, call the app's drawing or visual tool as instructed below; never write a picture as text, ASCII art or a code block in place of calling it.

`;

/** What Antigravity offers on a Google sign-in. A Google AI Plus account
 *  gets Gemini 3.8 Flash; other tiers may list more (session/new reports
 *  them), and a model the tier lacks fails with the server's own message. */
export const ANTIGRAVITY_MODEL_IDS = ["gemini-3.8-flash", "gemini-3.1-pro-preview"];

const LOGIN_HINT =
	"Gemini isn't signed in on this computer. Open Settings → This computer, sign in with Google, then try again.";

export function antigravityProvider(googleModels: readonly Model<Api>[]): Provider {
	const models = ANTIGRAVITY_MODEL_IDS.flatMap((id) => {
		const found = googleModels.find((m) => m.id === id);
		if (!found) return [];
		const { compat: _compat, ...base } = found;
		return [
			{
				...base,
				name: `${base.name} (Google login)`,
				provider: ANTIGRAVITY_PROVIDER_ID,
				api: ANTIGRAVITY_API,
				baseUrl: "",
				// Plan usage, not metered tokens: the cost meter reads zero.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} satisfies Model<Api>,
		];
	});
	return createProvider({
		id: ANTIGRAVITY_PROVIDER_ID,
		name: "Gemini (Google login)",
		auth: {
			apiKey: {
				name: "Google sign-in (Antigravity)",
				resolve: async () => ({ auth: {}, source: "Google sign-in" }),
			},
		},
		models,
		api: { stream: streamAntigravity, streamSimple: streamAntigravity },
	});
}

// ─── the server binary and the learner's sign-in ────────────────────────────

/** The server executable (MT_ANTIGRAVITY_ACP points at a test fake). */
function serverCommand(): { cmd: string; args: string[]; cwd: string } {
	const override = process.env.MT_ANTIGRAVITY_ACP;
	if (override) return override.endsWith(".mjs") ? { cmd: process.execPath, args: [override], cwd: path.dirname(override) } : { cmd: override, args: [], cwd: path.dirname(override) };
	const { cmd, args } = installedAntigravity();
	return { cmd, args, cwd: path.dirname(cmd) };
}

/** Where this machine keeps the downloaded server (never synced). */
export function antigravityDir(): string {
	return path.join(LOCAL_ROOT, "antigravity-acp");
}

/** The server the installer recorded in installed.json; without that
 *  record, the version this engine was built against. */
export function installedAntigravity(): { version: string; cmd: string; args: string[] } {
	let installed: { version?: string; cmd?: string; args?: string[] } = {};
	try {
		installed = JSON.parse(fs.readFileSync(path.join(antigravityDir(), "installed.json"), "utf-8"));
	} catch {}
	const version = installed.version ?? ANTIGRAVITY_VERSION;
	const file = installed.cmd ?? (process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par");
	return { version, cmd: path.join(antigravityDir(), version, file), args: installed.args ?? [] };
}

export function antigravityInstalled(): boolean {
	const { cmd } = serverCommand();
	return cmd === process.execPath || fs.existsSync(cmd);
}

/** The saved Google sign-in (written by the server after login). */
export function antigravitySignedIn(): boolean {
	const home = process.env.GEMINI_HOME ?? path.join(os.homedir(), ".gemini");
	return fs.existsSync(path.join(home, "antigravity-acp", "acp_token.json"));
}

// ─── the in-process tool server ─────────────────────────────────────────────

interface CapturedCall {
	name: string;
	args: Record<string, unknown>;
}

async function startToolServer(tools: readonly Tool[], onCall: (c: CapturedCall) => void) {
	const httpServer = http.createServer(async (req, res) => {
		const server = new McpServer({ name: "mt", version: "1.0.0" }, { capabilities: { tools: {} } });
		server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.parameters as { type: "object"; [k: string]: unknown },
			})),
		}));
		server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			onCall({ name: request.params.name, args: (request.params.arguments ?? {}) as Record<string, unknown> });
			return { content: [{ type: "text" as const, text: "Received." }] };
		});
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		res.on("close", () => {
			void transport.close();
			void server.close();
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res);
		} catch {
			if (!res.headersSent) res.writeHead(500).end();
		}
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const port = (httpServer.address() as { port: number }).port;
	return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((r) => httpServer.close(() => r())) };
}

// ─── one long-lived ACP connection (newline-delimited JSON-RPC 2.0) ─────────

type Json = Record<string, unknown>;

interface SessionHandlers {
	onUpdate: (update: Json) => void;
}

class AcpServer {
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
	private sessions = new Map<string, SessionHandlers>();
	private stderr = "";
	readonly ready: Promise<void>;
	dead = false;

	constructor(private child: ChildProcessWithoutNullStreams) {
		createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
		child.stderr.on("data", (d: Buffer) => {
			this.stderr = (this.stderr + d.toString()).slice(-4000);
		});
		child.on("exit", (code) => {
			this.dead = true;
			const err = new Error(`Antigravity server exited (${code ?? "signal"})`);
			for (const p of this.pending.values()) p.reject(err);
			this.pending.clear();
		});
		this.ready = (async () => {
			const init = (await this.request("initialize", {
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
			})) as { authMethods?: { id: string }[] };
			if (init.authMethods && !init.authMethods.some((m) => m.id === "oauth-personal")) {
				throw new Error("this Antigravity server offers no Google sign-in");
			}
			await this.request("authenticate", { methodId: "oauth-personal" });
		})();
	}

	register(sessionId: string, handlers: SessionHandlers): void {
		this.sessions.set(sessionId, handlers);
	}

	unregister(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	/** End the server AND its children: on Windows the server re-launches
	 *  itself (and a localharness helper), so killing only the first process
	 *  leaked the rest — taskkill /T ends the whole tree. */
	kill(): void {
		this.dead = true;
		if (process.platform === "win32" && this.child.pid) {
			spawnSync("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		} else this.child.kill();
	}

	request(method: string, params: Json): Promise<Json> {
		const id = this.nextId++;
		this.write({ jsonrpc: "2.0", id, method, params });
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	notify(method: string, params: Json): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private write(msg: Json): void {
		if (!this.dead && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	private receive(line: string): void {
		let msg: Json;
		try {
			msg = JSON.parse(line) as Json;
		} catch {
			return; // stray non-protocol output
		}
		if (typeof msg.method === "string" && msg.id !== undefined) {
			this.answer(msg.id as number | string, msg.method, (msg.params ?? {}) as Json);
		} else if (msg.method === "session/update") {
			const params = (msg.params ?? {}) as { sessionId?: string; update?: Json };
			if (params.sessionId) this.sessions.get(params.sessionId)?.onUpdate(params.update ?? {});
		} else if (typeof msg.id === "number") {
			const p = this.pending.get(msg.id);
			if (!p) return;
			this.pending.delete(msg.id);
			if (msg.error) {
				const e = msg.error as { message?: string; data?: unknown };
				const detail = typeof e.data === "string" ? e.data : e.data ? JSON.stringify(e.data) : "";
				p.reject(new Error([e.message ?? "Antigravity request failed", detail].filter(Boolean).join(": ")));
			} else p.resolve((msg.result ?? {}) as Json);
		}
	}

	/** Requests FROM the agent: the app's own MCP tools are allowed;
	 *  Antigravity's built-ins (files, terminal, browser) are denied; file
	 *  and terminal proxy calls are refused (the client offers neither). */
	private answer(id: number | string, method: string, params: Json): void {
		if (method === "session/request_permission") {
			const toolCall = (params.toolCall ?? {}) as { _meta?: { mcp?: { server?: string } } };
			const ours = toolCall._meta?.mcp?.server === "mt";
			const options = (params.options ?? []) as { optionId: string; kind?: string }[];
			const pick = ours
				? (options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind?.startsWith("allow")))
				: (options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind?.startsWith("reject")));
			this.write({
				jsonrpc: "2.0",
				id,
				result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } },
			});
			return;
		}
		this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not available` } });
	}
}

let shared: AcpServer | null = null;

/** The running server, started on first use and after a crash. */
function acpServer(): AcpServer {
	if (shared && !shared.dead) return shared;
	const { cmd, args, cwd } = serverCommand();
	const env: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_CLOUD_PROJECT)$/.test(k)) continue;
		env[k] = v;
	}
	const child = spawn(cmd, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	shared = new AcpServer(child);
	const server = shared;
	server.ready.catch(() => server.kill());
	return server;
}

process.once("exit", () => shared?.kill());

/** Stop the shared server (tests; the app keeps it for its lifetime). */
export function stopAntigravity(): void {
	shared?.kill();
	shared = null;
}

/** pi thinking level → Antigravity's thinking_level config option. */
function thinkingFor(level: SimpleStreamOptions["reasoning"]): "low" | "medium" | "high" | null {
	if (level === undefined) return null;
	if (level === "minimal" || level === "low") return "low";
	if (level === "medium") return "medium";
	return "high";
}

// ─── the stream ─────────────────────────────────────────────────────────────

export function streamAntigravity(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
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
	let started = false;
	const start = () => {
		if (started) return;
		started = true;
		stream.push({ type: "start", partial: output });
	};
	let open: { kind: "text" | "thinking"; index: number } | null = null;
	const closeOpenBlock = () => {
		if (!open) return;
		const block = output.content[open.index];
		if (block?.type === "text") stream.push({ type: "text_end", contentIndex: open.index, content: block.text, partial: output });
		if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: open.index, content: block.thinking, partial: output });
		open = null;
	};
	const appendChunk = (kind: "text" | "thinking", delta: string) => {
		if (!delta) return;
		start();
		if (open?.kind !== kind) {
			closeOpenBlock();
			const index = output.content.length;
			output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
			open = { kind, index };
			stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: index, partial: output });
		}
		const block = output.content[open.index]!;
		if (block.type === "text") {
			block.text += delta;
			stream.push({ type: "text_delta", contentIndex: open.index, delta, partial: output });
		} else if (block.type === "thinking") {
			block.thinking += delta;
			stream.push({ type: "thinking_delta", contentIndex: open.index, delta, partial: output });
		}
	};
	const fail = (reason: "error" | "aborted", message?: string) => {
		closeOpenBlock();
		output.stopReason = reason;
		if (message) output.errorMessage = message;
		start();
		stream.push({ type: "error", reason, error: output });
	};

	if (!antigravityInstalled()) {
		fail("error", "Gemini isn't installed on this computer. Open Settings → This computer and install it.");
		return;
	}
	if (!process.env.MT_ANTIGRAVITY_ACP && !antigravitySignedIn()) {
		fail("error", LOGIN_HINT);
		return;
	}

	const tools = getCurrentTools(context.messages);
	const calls: CapturedCall[] = [];
	let toolPhase = false;
	let finishing = false;
	let sessionId: string | null = null;
	/** The latest usage_update "used": the context of the newest internal call. */
	let contextUsed = 0;
	let server: AcpServer | null = null;
	let toolServer: Awaited<ReturnType<typeof startToolServer>> | null = null;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mt-agy-"));
	const onAbort = () => {
		if (server && sessionId) server.notify("session/cancel", { sessionId });
	};
	options?.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		server = acpServer();
		await server.ready;
		toolServer = await startToolServer(tools, (c) => {
			calls.push(c);
			toolPhase = true;
		});
		const session = (await server.request("session/new", {
			cwd,
			mcpServers: tools.length ? [{ type: "http", name: "mt", url: toolServer.url, headers: [] }] : [],
			_meta: { antigravity: { systemPrompt: { append: ANTIGRAVITY_TEACHER_PREAMBLE + getCurrentSystemPrompt(context.messages) + TRANSCRIPT_NOTE } } },
		})) as { sessionId?: string };
		if (!session.sessionId) throw new Error("Antigravity did not start a session");
		const sid = session.sessionId;
		sessionId = sid;
		const live = server;
		live.register(sid, {
			onUpdate: (update) => {
				const kind = update.sessionUpdate;
				if (kind === "usage_update") {
					if (typeof update.used === "number" && update.used > 0) contextUsed = update.used;
					return;
				}
				if (finishing) return;
				if (kind === "tool_call") {
					toolPhase = true;
					return;
				}
				if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return;
				// Output after this response's tool calls is Antigravity's NEXT
				// response: the step is over — cancel and hand the calls to pi.
				if (toolPhase && calls.length > 0) {
					finishing = true;
					live.notify("session/cancel", { sessionId: sid });
					return;
				}
				const content = update.content as { type?: string; text?: string } | undefined;
				appendChunk(kind === "agent_message_chunk" ? "text" : "thinking", content?.type === "text" ? (content.text ?? "") : "");
			},
		});
		await live.request("session/set_config_option", { sessionId: sid, configId: "model", value: model.id });
		const thinking = thinkingFor(options?.reasoning);
		if (thinking) await live.request("session/set_config_option", { sessionId: sid, configId: "thinking_level", value: thinking }).catch(() => {});

		const prompt = transcriptBlocks(context.messages).map((b) =>
			b.type === "text" ? { type: "text", text: b.text } : { type: "image", data: b.source.data, mimeType: b.source.media_type },
		);
		const result = (await live.request("session/prompt", { sessionId: sid, prompt })) as {
			stopReason?: string;
			usage?: { inputTokens?: number; outputTokens?: number; thoughtTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number };
		};
		if (result.usage) {
			const u = result.usage;
			output.usage.input = Math.max(0, (u.inputTokens ?? 0) - (u.cachedReadTokens ?? 0));
			output.usage.output = (u.outputTokens ?? 0) + (u.thoughtTokens ?? 0);
			output.usage.reasoning = u.thoughtTokens ?? 0;
			output.usage.cacheRead = u.cachedReadTokens ?? 0;
			output.usage.cacheWrite = u.cachedWriteTokens ?? 0;
			output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
		}
		if (contextUsed > 0) (output.usage as ReportedUsage).contextTokens = contextUsed;
		if (options?.signal?.aborted) {
			fail("aborted");
			return;
		}
		closeOpenBlock();
		start();
		if (calls.length > 0) {
			for (const call of calls) {
				const index = output.content.length;
				const toolCall = { type: "toolCall" as const, id: `agcall_${randomUUID().slice(0, 12)}`, name: call.name, arguments: call.args as never };
				output.content.push(toolCall);
				stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
			}
			output.stopReason = "toolUse";
			stream.push({ type: "done", reason: "toolUse", message: output });
			return;
		}
		if (result.stopReason === "refusal") {
			fail("error", "Gemini declined this request.");
			return;
		}
		output.stopReason = result.stopReason === "max_tokens" ? "length" : "stop";
		stream.push({ type: "done", reason: output.stopReason, message: output });
	} catch (err) {
		if (options?.signal?.aborted) fail("aborted");
		else {
			const message = err instanceof Error ? err.message : String(err);
			fail("error", geminiErrorText(message));
		}
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		if (server && sessionId) {
			server.unregister(sessionId);
			void server.request("session/close", { sessionId }).catch(() => {});
		}
		await toolServer?.close();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

// ─── a whole agent run (the paper pipeline, 2026-10-27) ─────────────────────

/** What one full Antigravity run is given: unlike the teaching stream above
 *  (one model step, tool calls captured and handed to pi), Antigravity runs
 *  its OWN loop here, calling the app's tools at `mcpUrl` (an MCP server
 *  named "mt" — the only tools the permission rule allows) until it is done. */
export interface AntigravityRun {
	model: string;
	/** Appended to Antigravity's own system prompt. */
	systemAppend: string;
	prompt: string;
	mcpUrl: string;
	thinking?: "low" | "medium" | "high";
	signal?: AbortSignal;
	/** The run's reply text as it streams (progress lines). */
	onText?: (chunk: string) => void;
	/** True while one of the app's tools is working for this run (a long
	 *  build, a subagent): that silence is not the run stalling. */
	busy?: () => boolean;
}

/** How long a run may go silent, with none of its tools working. */
const RUN_IDLE_LIMIT_MS = 15 * 60_000;

/** A spent Google plan doesn't fail the request: Antigravity REPLIES with
 *  a short notice ("Usage Limit Reached", live 2026-10-27) — and then may
 *  never end the turn. */
const isLimitNotice = (text: string) => text.trim().length < 300 && /usage limit|rate limit|quota|resource.?exhausted/i.test(text);

/** Run one Antigravity session to completion; returns its reply text.
 *  Throws (with the sign-in hint where it applies) when the run fails. */
export async function runAntigravityAgent(run: AntigravityRun): Promise<{ text: string; stopReason: string }> {
	if (!antigravityInstalled()) throw new Error("Gemini isn't installed on this computer.");
	if (!process.env.MT_ANTIGRAVITY_ACP && !antigravitySignedIn()) throw new Error(LOGIN_HINT);
	const server = acpServer();
	await server.ready;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mt-agy-run-"));
	let sessionId: string | null = null;
	let text = "";
	let lastActivity = Date.now();
	let watchdog: ReturnType<typeof setInterval> | undefined;
	const onAbort = () => {
		if (sessionId) server.notify("session/cancel", { sessionId });
	};
	run.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const session = (await server.request("session/new", {
			cwd,
			mcpServers: [{ type: "http", name: "mt", url: run.mcpUrl, headers: [] }],
			_meta: { antigravity: { systemPrompt: { append: run.systemAppend } } },
		})) as { sessionId?: string };
		if (!session.sessionId) throw new Error("Antigravity did not start a session");
		const sid = session.sessionId;
		sessionId = sid;
		server.register(sid, {
			onUpdate: (update) => {
				lastActivity = Date.now();
				if (update.sessionUpdate !== "agent_message_chunk") return;
				const content = update.content as { type?: string; text?: string } | undefined;
				if (content?.type !== "text" || !content.text) return;
				text += content.text;
				run.onText?.(content.text);
			},
		});
		await server.request("session/set_config_option", { sessionId: sid, configId: "model", value: run.model });
		if (run.thinking) await server.request("session/set_config_option", { sessionId: sid, configId: "thinking_level", value: run.thinking }).catch(() => {});
		const limitError = () => new Error(`Gemini's usage limit is reached on your Google plan (${text.trim()}).`);
		// The watchdog: a lone limit notice followed by silence, or a run
		// silent for RUN_IDLE_LIMIT_MS with none of its tools working, is
		// over — cancel it rather than leave the job running forever.
		const stalled = new Promise<never>((_, reject) => {
			watchdog = setInterval(() => {
				if (run.busy?.()) lastActivity = Date.now();
				const idle = Date.now() - lastActivity;
				const limited = isLimitNotice(text) && idle > 15_000;
				if (!limited && idle < RUN_IDLE_LIMIT_MS) return;
				clearInterval(watchdog);
				server.notify("session/cancel", { sessionId: sid });
				reject(limited ? limitError() : new Error("Gemini stopped responding (nothing for 15 minutes)."));
			}, 5_000);
		});
		const result = (await Promise.race([server.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: run.prompt }] }), stalled])) as { stopReason?: string };
		if (run.signal?.aborted) throw new Error("Cancelled.");
		if (result.stopReason === "refusal") throw new Error("Gemini declined this request.");
		// The notice can also end the turn normally: still no result.
		if (isLimitNotice(text)) throw limitError();
		return { text, stopReason: result.stopReason ?? "end_turn" };
	} catch (err) {
		if (run.signal?.aborted) throw new Error("Cancelled.");
		throw new Error(geminiErrorText(err instanceof Error ? err.message : String(err)));
	} finally {
		clearInterval(watchdog);
		run.signal?.removeEventListener("abort", onAbort);
		if (sessionId) {
			server.unregister(sessionId);
			void server.request("session/close", { sessionId }).catch(() => {});
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}
