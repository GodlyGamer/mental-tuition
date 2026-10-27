/**
 * Headless runs of the practice-paper skills (personal fork, 2026-10-24):
 * /make-papers <CODE> [topics] and /mark-attempts <CODE> <PAIR_ID>. The
 * skills and their subagents load from the workspace's .claude/ — the repo
 * in dev, the learner's synced folder in the desktop app.
 *
 * Engines, in order (owner, 2026-10-27): the Claude login (a Claude Code
 * session through the Agent SDK, no key), then Gemini on the Google login
 * (study-gemini.ts), then Claude Code on the Anthropic API key. A run moves
 * down the chain when its engine isn't set up, or fails because it can't
 * serve the learner right now (signed out, a usage limit, no credit) — a
 * skill that goes wrong for any other reason stops there. The job names
 * the engine that ran it.
 *
 * The fence (SETUP_PROMPT.md §4, "limit file access to study/"): a
 * PreToolUse hook denies every file tool aimed outside study/ (reading
 * .claude/ is allowed — that's where the skills and agents live) and
 * points path-less Glob/Grep at study/. Marking also gets no Bash at all;
 * paper generation needs Bash for Python (sympy/PyMuPDF) and latexmk.
 *
 * Jobs live in memory (one per module at a time) with a log file under
 * study/modules/<CODE>/.jobs/ for anything worth reading afterwards.
 */

import fs from "node:fs";
import path from "node:path";
import { query, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { WORKSPACE_ROOT } from "../../config.ts";
import { ANTIGRAVITY_MODEL_IDS, ANTIGRAVITY_PROVIDER_ID, antigravityInstalled, antigravitySignedIn } from "../agent/antigravity.ts";
import { childEnv } from "../agent/claude-code.ts";
import { withToolPath } from "./machine-setup.ts";
import { runStudySkillOnGemini } from "./study-gemini.ts";
import { insideStudy, listModuleCodes, moduleDir, moduleInfo, studyRoot } from "./study.ts";
import { syncPairToGraph } from "./study-graph.ts";
import { effectiveSettings, stores } from "./stores.ts";

export type StudyJobKind = "make-papers" | "mark-attempts";
export type StudyEngine = "claude" | "gemini" | "anthropic-key";

export const STUDY_ENGINE_LABEL: Record<StudyEngine, string> = {
	claude: "Claude (your login)",
	gemini: "Gemini (your Google login)",
	"anthropic-key": "Claude (Anthropic API key)",
};
const ENGINE_ORDER: StudyEngine[] = ["claude", "gemini", "anthropic-key"];

/** Failures that mean the ENGINE can't serve this run — move down the chain. */
const ENGINE_UNAVAILABLE =
	/usage limit|hit your limit|rate.?limit|\b429\b|overloaded|not logged in|\/login|signed in|sign in|authenticat|credential|invalid.{0,10}api.?key|x-api-key|credit balance|billing|quota|resource.?exhausted|isn't installed|isn't on your Google plan/i;

/** Should a failed run move down the engine chain? */
export function engineUnavailable(message: string): boolean {
	return ENGINE_UNAVAILABLE.test(message);
}

/** Whether an engine is set up at all (cheap checks; the Claude login is
 *  learned from its run — "Not logged in" falls through like a limit). */
function engineReady(engine: StudyEngine): boolean {
	if (engine === "gemini") return antigravityInstalled() && antigravitySignedIn();
	if (engine === "anthropic-key") return !!process.env.ANTHROPIC_API_KEY;
	return true;
}

/** Gemini runs the teaching model when that is a Gemini one, else the
 *  first Gemini model the app offers. */
function geminiModel(): string {
	const strong = effectiveSettings().models.strong;
	return strong?.provider === ANTIGRAVITY_PROVIDER_ID ? strong.id : ANTIGRAVITY_MODEL_IDS[0]!;
}

export interface StudyJob {
	id: string;
	kind: StudyJobKind;
	module: string;
	pair: string | null;
	status: "running" | "done" | "error";
	/** The engine running (or that ran) the job; null before one starts. */
	engine: StudyEngine | null;
	startedAt: string;
	endedAt: string | null;
	/** The latest progress lines (assistant text), newest last. */
	progress: string[];
	/** The skill's closing reply (its summary), or the error. */
	result: string | null;
}

const jobs = new Map<string, StudyJob>();
const controllers = new Map<string, AbortController>();

export function listStudyJobs(): StudyJob[] {
	return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep"]);

/** The PreToolUse fence: file tools stay inside study/ (reads of .claude/
 *  allowed); Glob/Grep without a path search study/. */
export const studyFence: HookCallback = async (input) => {
	if (input.hook_event_name !== "PreToolUse" || !FILE_TOOLS.has(input.tool_name)) return {};
	const args = (input.tool_input ?? {}) as Record<string, unknown>;
	const raw = (args.file_path ?? args.notebook_path ?? args.path) as string | undefined;
	if (raw === undefined) {
		return {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: { ...args, path: studyRoot() },
			},
		};
	}
	const abs = path.resolve(WORKSPACE_ROOT, raw);
	const readOnly = input.tool_name === "Read" || input.tool_name === "Glob" || input.tool_name === "Grep";
	const inClaude = abs.startsWith(path.join(WORKSPACE_ROOT, ".claude") + path.sep);
	if (insideStudy(abs) || (readOnly && inClaude)) return {};
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: `File access is limited to ${studyRoot()} (asked for ${abs}).`,
		},
	};
};

/** PATH for the run: the paper tools' install folders go in front, in case
 *  they were installed after the app started (machine-setup.ts). */
function jobEnv(): Record<string, string | undefined> {
	return withToolPath(childEnv());
}

function textOf(msg: SDKMessage): string | null {
	if (msg.type !== "assistant" || msg.parent_tool_use_id !== null) return null;
	const text = msg.message.content
		.map((c) => (c.type === "text" ? c.text : ""))
		.join("")
		.trim();
	return text || null;
}

export function startStudyJob(kind: StudyJobKind, code: string, args: { pair?: string; topics?: string }): StudyJob {
	if (!listModuleCodes().includes(code)) throw new Error(`no module ${code}`);
	const busy = [...jobs.values()].find((j) => j.module === code && j.status === "running");
	if (busy) throw new Error(`a ${busy.kind} run is already going for ${code}`);
	if (kind === "mark-attempts" && !args.pair) throw new Error("marking needs a paper pair");

	const now = new Date();
	const job: StudyJob = {
		id: `job_${now.getTime().toString(36)}`,
		kind,
		module: code,
		pair: args.pair ?? null,
		status: "running",
		engine: null,
		startedAt: now.toISOString(),
		endedAt: null,
		progress: [],
		result: null,
	};
	jobs.set(job.id, job);
	const prompt =
		kind === "make-papers"
			? `/make-papers ${code}${args.topics?.trim() ? ` ${args.topics.trim()}` : ""}`
			: `/mark-attempts ${code} ${args.pair}`;
	void run(job, prompt);
	return job;
}

export function cancelStudyJob(id: string): void {
	controllers.get(id)?.abort();
}

/** One run on Claude Code: the Claude login, or the Anthropic API key. */
async function runOnClaude(
	job: StudyJob,
	prompt: string,
	engine: "claude" | "anthropic-key",
	abort: AbortController,
	progress: (line: string) => void,
): Promise<{ ok: boolean; result: string }> {
	const env = engine === "anthropic-key" ? withToolPath({ ...childEnv(), ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }) : jobEnv();
	// Why a run failed, for the engine chain: the SDK's error code, or the
	// synthetic reply text (the not-logged-in notice) when nothing streamed.
	let reason = "";
	try {
		const q = query({
			prompt,
			options: {
				cwd: WORKSPACE_ROOT,
				model: "claude-opus-5-5",
				settingSources: ["project"],
				skills: [job.kind],
				tools:
					job.kind === "make-papers"
						? ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Agent", "TodoWrite"]
						: ["Read", "Write", "Edit", "Glob", "Grep", "TodoWrite"],
				disallowedTools: ["WebFetch", "WebSearch"],
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				hooks: { PreToolUse: [{ hooks: [studyFence] }] },
				persistSession: false,
				env,
				abortController: abort,
			},
		});
		for await (const msg of q) {
			if (msg.type === "assistant" && msg.parent_tool_use_id === null && msg.error) reason = `${reason} ${msg.error}`.trim();
			const text = textOf(msg);
			if (text) progress(text);
			if (msg.type === "result") {
				const result = "result" in msg && typeof msg.result === "string" ? msg.result : `Stopped: ${msg.subtype}`;
				const ok = msg.subtype === "success" && !msg.is_error;
				return { ok, result: ok ? result : [result, reason].filter(Boolean).join(" ") };
			}
		}
		return { ok: true, result: "Done." };
	} catch (err) {
		return { ok: false, result: [abort.signal.aborted ? "Cancelled." : err instanceof Error ? err.message : String(err), reason].filter(Boolean).join(" ") };
	}
}

/** One run on Gemini (the Google login) — study-gemini.ts. */
async function runOnGemini(job: StudyJob, prompt: string, signal: AbortSignal, progress: (line: string) => void): Promise<{ ok: boolean; result: string }> {
	try {
		const model = geminiModel();
		progress(`Running on ${model}.`);
		const result = await runStudySkillOnGemini({ skill: job.kind, args: prompt.replace(/^\/\S+\s*/, ""), model, signal, onProgress: progress });
		return { ok: true, result };
	} catch (err) {
		return { ok: false, result: signal.aborted ? "Cancelled." : err instanceof Error ? err.message : String(err) };
	}
}

async function run(job: StudyJob, prompt: string): Promise<void> {
	const logDir = path.join(moduleDir(job.module), ".jobs");
	fs.mkdirSync(logDir, { recursive: true });
	const log = (line: string) => fs.appendFileSync(path.join(logDir, `${job.id}.log`), `${line}\n`, "utf-8");
	log(`${job.startedAt} ${prompt}`);
	const abort = new AbortController();
	controllers.set(job.id, abort);
	const before = new Set(moduleInfo(job.module).pairs.map((p) => p.id));
	const progress = (line: string) => {
		job.progress = [...job.progress, line].slice(-12);
		log(line);
	};

	try {
		const skipped: string[] = [];
		let outcome: { ok: boolean; result: string } | null = null;
		for (const engine of ENGINE_ORDER) {
			if (!engineReady(engine)) {
				skipped.push(`${STUDY_ENGINE_LABEL[engine]}: not set up on this computer`);
				continue;
			}
			if (job.engine) progress(`${STUDY_ENGINE_LABEL[job.engine]} couldn't run this. Switching to ${STUDY_ENGINE_LABEL[engine]}.`);
			job.engine = engine;
			log(`engine: ${engine}`);
			outcome =
				engine === "gemini"
					? await runOnGemini(job, prompt, abort.signal, progress)
					: await runOnClaude(job, prompt, engine, abort, progress);
			if (outcome.ok || abort.signal.aborted || !engineUnavailable(outcome.result)) break;
			skipped.push(`${STUDY_ENGINE_LABEL[engine]}: ${outcome.result}`);
			outcome = null;
		}
		if (outcome) {
			job.status = outcome.ok ? "done" : "error";
			job.result = abort.signal.aborted ? "Cancelled." : outcome.result;
		} else {
			job.status = "error";
			job.result = `No engine could run this.\n${skipped.join("\n")}`;
		}
	} finally {
		controllers.delete(job.id);
		job.endedAt = new Date().toISOString();
		log(`${job.endedAt} ${job.status}: ${job.result ?? ""}`);
	}

	// New pairs join the knowledge graph as soon as they exist.
	if (job.kind === "make-papers") {
		for (const pair of moduleInfo(job.module).pairs) {
			if (before.has(pair.id)) continue;
			try {
				syncPairToGraph(stores.graphStore, job.module, pair.id);
			} catch (err) {
				log(`graph import failed for ${pair.id}: ${String(err)}`);
			}
		}
	}
}
