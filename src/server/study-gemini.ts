/**
 * The practice-paper skills on Gemini (owner, 2026-10-27): when the Claude
 * login can't run /make-papers or /mark-attempts, the same skills run on
 * the learner's Google sign-in through Antigravity (src/agent/antigravity.ts
 * runAntigravityAgent).
 *
 * Claude Code gives the skills Read/Write/Edit/Glob/Grep/Bash and the Agent
 * tool; Antigravity's own file and terminal tools stay refused (the app's
 * permission rule), so this module serves the equivalents as the app's MCP
 * tools, behind the same fence as the Claude route (study-jobs.ts
 * studyFence): every path resolves from the workspace and must sit inside
 * study/, with reads of .claude/ allowed. Marking gets no run_command, as
 * the Claude route gets no Bash.
 *
 * Subagents: make-papers runs its stages "with the Agent tool, giving each
 * subagent only the inputs listed" — the blind solvers must never see the
 * intended answer. run_subagent keeps that: each call is a FRESH Antigravity
 * session with the agent's own instructions (.claude/agents/<name>.md) and
 * only the task text it was handed. The skill's model choice per solver
 * (opus / sonnet) has no Gemini equivalent: both solvers run on the same
 * model, so their agreement is weaker evidence than on Claude.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { WORKSPACE_ROOT } from "../../config.ts";
import { runAntigravityAgent } from "../agent/antigravity.ts";
import { findPython, withToolPath } from "./machine-setup.ts";
import { insideStudy, studyRoot } from "./study.ts";

export type StudySkill = "make-papers" | "mark-attempts";

const MAX_OUTPUT = 30_000;
const COMMAND_TIMEOUT_MS = 10 * 60_000;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };
interface ToolDef {
	name: string;
	description: string;
	inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
	run: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t.length > MAX_OUTPUT ? `${t.slice(0, MAX_OUTPUT)}\n[… cut at ${MAX_OUTPUT} characters]` : t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

// ─── the fence ──────────────────────────────────────────────────────────────

/** Resolve a tool path from the workspace (as Claude's cwd is) and check it
 *  against the fence: the absolute path, or the refusal. */
export function fenced(raw: unknown, mode: "read" | "write"): string | { refused: string } {
	if (typeof raw !== "string" || !raw.trim()) return { refused: "A path is required." };
	const abs = path.resolve(WORKSPACE_ROOT, raw);
	const inClaude = abs.startsWith(path.join(WORKSPACE_ROOT, ".claude") + path.sep);
	if (insideStudy(abs) || (mode === "read" && inClaude)) return abs;
	return { refused: `File access is limited to ${studyRoot()} (asked for ${abs}).` };
}

function walk(dir: string): string[] {
	try {
		return (fs.readdirSync(dir, { recursive: true }) as string[]).map((f) => path.join(dir, f));
	} catch {
		return [];
	}
}

const relative = (abs: string) => path.relative(WORKSPACE_ROOT, abs).split(path.sep).join("/");

// ─── the tools ──────────────────────────────────────────────────────────────

function python(script: string, args: string[]): Promise<{ ok: boolean; out: string }> {
	const py = findPython();
	if (!py) return Promise.resolve({ ok: false, out: "Python isn't installed (Settings → This computer installs the paper tools)." });
	return runProcess(py[0], [...py.slice(1), "-c", script, ...args], WORKSPACE_ROOT, 120_000);
}

function runProcess(cmd: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; out: string }> {
	return new Promise((resolve) => {
		let out = "";
		const child = spawn(cmd, args, { cwd, env: withToolPath({ ...process.env }) as NodeJS.ProcessEnv, windowsHide: true });
		const add = (d: Buffer) => {
			if (out.length < MAX_OUTPUT * 2) out += d.toString();
		};
		child.stdout.on("data", add);
		child.stderr.on("data", add);
		const timer = setTimeout(() => {
			out += `\n[stopped after ${Math.round(timeoutMs / 1000)}s]`;
			child.kill();
		}, timeoutMs);
		const onAbort = () => child.kill();
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (err) => {
			clearTimeout(timer);
			resolve({ ok: false, out: err.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ ok: code === 0, out: `${out}${code === 0 ? "" : `\n[exit code ${code}]`}` });
		});
	});
}

/** The shell run_command uses: bash (Git Bash on Windows, as Claude Code
 *  uses), else cmd.exe — named in the tool description so commands fit. */
function shell(): { cmd: string; args: (c: string) => string[]; name: string } {
	if (process.platform !== "win32") return { cmd: "bash", args: (c) => ["-lc", c], name: "bash" };
	const gitBash = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find((p) => fs.existsSync(p));
	return gitBash ? { cmd: gitBash, args: (c) => ["-lc", c], name: "bash (Git Bash on Windows)" } : { cmd: "cmd.exe", args: (c) => ["/d", "/s", "/c", c], name: "cmd.exe" };
}

const PDF_TEXT = `import fitz, sys
d = fitz.open(sys.argv[1])
for i, p in enumerate(d, 1):
    print(f"--- page {i} of {d.page_count} ---")
    print(p.get_text())`;

const PDF_PAGE_PNG = `import fitz, sys, base64
d = fitz.open(sys.argv[1])
p = d[int(sys.argv[2]) - 1]
print(base64.b64encode(p.get_pixmap(dpi=110).tobytes("png")).decode())`;

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

function fileTools(skill: StudySkill, signal: AbortSignal | undefined): ToolDef[] {
	const tools: ToolDef[] = [
		{
			name: "read_file",
			description: "Read a text file (paths are relative to the workspace, e.g. study/modules/1M1/taxonomy.json). A PDF returns its text page by page; to SEE a page (diagrams, handwriting) use read_image.",
			inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "number", description: "First line, 1-based (optional)" }, limit: { type: "number", description: "Number of lines (optional)" } }, required: ["path"] },
			run: async (a) => {
				const abs = fenced(a.path, "read");
				if (typeof abs !== "string") return fail(abs.refused);
				if (!fs.existsSync(abs)) return fail(`No such file: ${relative(abs)}`);
				if (abs.toLowerCase().endsWith(".pdf")) {
					const r = await python(PDF_TEXT, [abs]);
					return r.ok ? text(r.out) : fail(r.out);
				}
				const lines = fs.readFileSync(abs, "utf-8").split(/\r?\n/);
				const from = Math.max(1, Number(a.offset) || 1);
				const count = Number(a.limit) || lines.length;
				return text(lines.slice(from - 1, from - 1 + count).join("\n"));
			},
		},
		{
			name: "read_image",
			description: "Look at an image file (png, jpg), or one page of a PDF rendered as an image (give page, 1-based).",
			inputSchema: { type: "object", properties: { path: { type: "string" }, page: { type: "number" } }, required: ["path"] },
			run: async (a) => {
				const abs = fenced(a.path, "read");
				if (typeof abs !== "string") return fail(abs.refused);
				if (!fs.existsSync(abs)) return fail(`No such file: ${relative(abs)}`);
				const ext = path.extname(abs).toLowerCase();
				if (ext === ".pdf") {
					const r = await python(PDF_PAGE_PNG, [abs, String(Number(a.page) || 1)]);
					return r.ok ? { content: [{ type: "image", data: r.out.trim(), mimeType: "image/png" }] } : fail(r.out);
				}
				const mimeType = IMAGE_TYPES[ext];
				if (!mimeType) return fail(`Not an image: ${relative(abs)}`);
				return { content: [{ type: "image", data: fs.readFileSync(abs).toString("base64"), mimeType }] };
			},
		},
		{
			name: "list_files",
			description: "List files under a folder, optionally filtered by a glob (e.g. **/*.pdf).",
			inputSchema: { type: "object", properties: { path: { type: "string" }, glob: { type: "string" } }, required: ["path"] },
			run: (a) => {
				const abs = fenced(a.path, "read");
				if (typeof abs !== "string") return fail(abs.refused);
				const glob = typeof a.glob === "string" && a.glob ? a.glob : null;
				const files = walk(abs)
					.filter((f) => fs.statSync(f).isFile())
					.map(relative)
					.filter((f) => !glob || path.matchesGlob(f, glob) || path.matchesGlob(path.basename(f), glob));
				return text(files.length ? files.join("\n") : "(no files)");
			},
		},
		{
			name: "search_files",
			description: "Search text files under a folder for a regular expression; returns path:line: text.",
			inputSchema: { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"] },
			run: (a) => {
				const abs = fenced(a.path, "read");
				if (typeof abs !== "string") return fail(abs.refused);
				let re: RegExp;
				try {
					re = new RegExp(String(a.pattern), "i");
				} catch (err) {
					return fail(`Bad pattern: ${(err as Error).message}`);
				}
				const hits: string[] = [];
				for (const f of walk(abs)) {
					if (hits.length >= 300) break;
					if (!/\.(md|json|tex|txt|py|csv|log)$/i.test(f) || !fs.statSync(f).isFile()) continue;
					fs.readFileSync(f, "utf-8").split(/\r?\n/).forEach((line, i) => {
						if (re.test(line) && hits.length < 300) hits.push(`${relative(f)}:${i + 1}: ${line.trim()}`);
					});
				}
				return text(hits.length ? hits.join("\n") : "(no matches)");
			},
		},
		{
			name: "write_file",
			description: "Write a whole file (creates folders as needed; overwrites).",
			inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
			run: (a) => {
				const abs = fenced(a.path, "write");
				if (typeof abs !== "string") return fail(abs.refused);
				fs.mkdirSync(path.dirname(abs), { recursive: true });
				fs.writeFileSync(abs, String(a.content ?? ""), "utf-8");
				return text(`Wrote ${relative(abs)}`);
			},
		},
		{
			name: "edit_file",
			description: "Replace one exact, unique piece of text in a file.",
			inputSchema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] },
			run: (a) => {
				const abs = fenced(a.path, "write");
				if (typeof abs !== "string") return fail(abs.refused);
				if (!fs.existsSync(abs)) return fail(`No such file: ${relative(abs)}`);
				const src = fs.readFileSync(abs, "utf-8");
				const old = String(a.old_text ?? "");
				const at = src.indexOf(old);
				if (!old || at < 0) return fail("old_text was not found in the file.");
				if (src.indexOf(old, at + 1) >= 0) return fail("old_text appears more than once; include more context.");
				fs.writeFileSync(abs, src.slice(0, at) + String(a.new_text ?? "") + src.slice(at + old.length), "utf-8");
				return text(`Edited ${relative(abs)}`);
			},
		},
	];
	if (skill === "make-papers") {
		const sh = shell();
		tools.push({
			name: "run_command",
			description: `Run a shell command (${sh.name}) from the workspace folder, for Python (sympy, numpy, PyMuPDF) and latexmk. Keep file work inside study/. Output is cut at ${MAX_OUTPUT} characters; a command stops after 10 minutes.`,
			inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
			run: async (a) => {
				const r = await runProcess(sh.cmd, sh.args(String(a.command ?? "")), WORKSPACE_ROOT, COMMAND_TIMEOUT_MS, signal);
				return r.ok ? text(r.out || "(no output)") : fail(r.out);
			},
		});
	}
	return tools;
}

// ─── the MCP server ─────────────────────────────────────────────────────────

/** Tool calls in flight for one run (main session and its subagents):
 *  the run's watchdog doesn't count their time as silence. */
interface InFlight {
	n: number;
}

async function serveTools(tools: readonly ToolDef[], inFlight: InFlight) {
	const byName = new Map(tools.map((t) => [t.name, t]));
	const httpServer = http.createServer(async (req, res) => {
		const server = new McpServer({ name: "mt", version: "1.0.0" }, { capabilities: { tools: {} } });
		server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
		}));
		server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const tool = byName.get(request.params.name);
			if (!tool) return fail(`Unknown tool ${request.params.name}`);
			inFlight.n++;
			try {
				return await tool.run((request.params.arguments ?? {}) as Record<string, unknown>);
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			} finally {
				inFlight.n--;
			}
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

// ─── the run ────────────────────────────────────────────────────────────────

/** A skill or agent file's body, frontmatter dropped. */
function body(file: string): string {
	return fs.readFileSync(file, "utf-8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
}

const PREAMBLE = `You are running a study task headless inside a tutoring app, for one student. Nobody is watching to answer questions: decide, and record anything unclear in the files as the instructions say.

Your own built-in tools (files, terminal, browser) are NOT available and will be refused. Use only the tools listed for you here. Paths are relative to the workspace folder, and every file you read or write must be inside study/ (reading .claude/ is also allowed).

The instructions below were written for a different assistant. Translate its tool names: Read = read_file (read_image to look at an image or a PDF page), Write = write_file, Edit = edit_file, Glob = list_files, Grep = search_files, Bash = run_command, and the Agent tool / subagents = run_subagent.`;

export interface GeminiStudyRun {
	skill: StudySkill;
	/** The skill's $ARGUMENTS ("<CODE> [topics]" or "<CODE> <PAIR_ID>"). */
	args: string;
	model: string;
	signal?: AbortSignal;
	/** A progress line (the run's own reply text, a subagent starting). */
	onProgress: (line: string) => void;
}

/** Run one paper skill on Gemini; resolves with its closing reply. */
export async function runStudySkillOnGemini(run: GeminiStudyRun): Promise<string> {
	const claudeDir = path.join(WORKSPACE_ROOT, ".claude");
	const skillFile = path.join(claudeDir, "skills", run.skill, "SKILL.md");
	if (!fs.existsSync(skillFile)) throw new Error(`The ${run.skill} skill is missing from ${claudeDir}.`);
	const layout = path.join(WORKSPACE_ROOT, "CLAUDE.md");
	const context = fs.existsSync(layout) ? `\n\nThe project's notes (CLAUDE.md), including the study folder layout:\n\n${fs.readFileSync(layout, "utf-8")}` : "";

	const tools = fileTools(run.skill, run.signal);
	const agentsDir = path.join(claudeDir, "agents");
	const agents = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)) : [];

	const inFlight: InFlight = { n: 0 };
	const busy = () => inFlight.n > 0;
	// Subagents get the file tools only (no nesting), on a server of their own.
	const subServer = await serveTools(tools, inFlight);
	const subagentTool: ToolDef = {
		name: "run_subagent",
		description: `Run one subagent in a fresh session that sees ONLY the task text you give it plus its own instructions — never your conversation. Give it exactly the inputs the instructions list (file paths it should read, the output folder). Several calls may run at once. Agents: ${agents.join(", ")}.`,
		inputSchema: { type: "object", properties: { agent: { type: "string", enum: agents }, task: { type: "string" } }, required: ["agent", "task"] },
		run: async (a) => {
			const name = String(a.agent ?? "");
			if (!agents.includes(name)) return fail(`No agent named ${name}.`);
			run.onProgress(`Subagent ${name} started.`);
			const reply = await runAntigravityAgent({
				model: run.model,
				systemAppend: `${PREAMBLE}\n\nYou are the ${name} subagent. Your instructions:\n\n${body(path.join(agentsDir, `${name}.md`))}`,
				prompt: String(a.task ?? ""),
				mcpUrl: subServer.url,
				thinking: "high",
				signal: run.signal,
				busy,
			});
			run.onProgress(`Subagent ${name} finished.`);
			return text(reply.text || "(the subagent returned no text)");
		},
	};
	const mainServer = await serveTools(run.skill === "make-papers" ? [...tools, subagentTool] : tools, inFlight);
	try {
		let line = "";
		const reply = await runAntigravityAgent({
			model: run.model,
			systemAppend: `${PREAMBLE}${context}`,
			prompt: body(skillFile).replaceAll("$ARGUMENTS", run.args),
			mcpUrl: mainServer.url,
			thinking: "high",
			signal: run.signal,
			busy,
			onText: (chunk) => {
				line += chunk;
				const parts = line.split(/\n+/);
				line = parts.pop() ?? "";
				for (const p of parts) if (p.trim()) run.onProgress(p.trim());
			},
		});
		return reply.text.trim() || "Done.";
	} finally {
		await mainServer.close();
		await subServer.close();
	}
}
