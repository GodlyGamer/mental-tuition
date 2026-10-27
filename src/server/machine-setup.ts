/**
 * "This computer" setup (personal fork, 2026-10-24): the per-machine steps
 * the desktop app walks through on first launch, and keeps in Settings →
 * This computer. None of it syncs; it's about the machine, not the learner:
 *   - the Claude sign-in (the Agent SDK's bundled Claude Code binary,
 *     `claude auth login` — opens the browser; a code the page shows can
 *     be pasted back in);
 *   - the paper tools /make-papers needs: Python with sympy, numpy and
 *     PyMuPDF, MiKTeX (latexmk) and Strawberry Perl (latexmk's Perl under
 *     MiKTeX) — checked, and installable through winget + pip;
 *   - the setup record (LOCAL_ROOT/setup.json): once it exists, the first-
 *     launch screen stops appearing.
 * The Gemini steps live in antigravity-setup.ts.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { LOCAL_ROOT, WORKSPACE_ROOT } from "../../config.ts";
import { childEnv } from "../agent/claude-code.ts";

// ─── the setup record ───────────────────────────────────────────────────────

const SETUP_FILE = () => path.join(LOCAL_ROOT, "setup.json");

/** The desktop app sets MT_WORKSPACE_DIR; only there does the first-launch
 *  screen appear (repo work reaches /setup by hand). */
export function machineSetupNeeded(): boolean {
	return Boolean(process.env.MT_WORKSPACE_DIR) && !fs.existsSync(SETUP_FILE());
}

export function finishMachineSetup(): void {
	fs.mkdirSync(LOCAL_ROOT, { recursive: true });
	fs.writeFileSync(SETUP_FILE(), `${JSON.stringify({ completedAt: new Date().toISOString() }, null, "\t")}\n`);
}

export function workspaceInfo(): { folder: string; desktop: boolean } {
	return { folder: WORKSPACE_ROOT, desktop: Boolean(process.env.MT_WORKSPACE_DIR) };
}

// ─── Claude ─────────────────────────────────────────────────────────────────

/** The Claude Code binary the Agent SDK ships for this platform. Resolved
 *  from the server's working directory (the standalone dir when packaged,
 *  the repo in dev), where node_modules lives. */
function claudeBinary(): string {
	const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
	const req = createRequire(path.join(process.cwd(), "package.json"));
	return path.join(path.dirname(req.resolve(`${pkg}/package.json`)), process.platform === "win32" ? "claude.exe" : "claude");
}

export function claudeStatus(): { signedIn: boolean; email: string | null } {
	try {
		const r = spawnSync(claudeBinary(), ["auth", "status", "--json"], { env: childEnv() as NodeJS.ProcessEnv, encoding: "utf-8", windowsHide: true, timeout: 30_000 });
		const status = JSON.parse(r.stdout) as { loggedIn?: boolean; email?: string };
		return { signedIn: status.loggedIn === true, email: status.email ?? null };
	} catch {
		return { signedIn: false, email: null };
	}
}

export interface ClaudeLogin {
	/** The sign-in link (null until the binary prints it). */
	url: string | null;
	status: "starting" | "waiting" | "done" | "error";
	error: string | null;
}

let claudeLogin: { state: ClaudeLogin; child: ChildProcessWithoutNullStreams } | null = null;

/** Start `claude auth login` (or return the one in progress). It opens the
 *  browser itself; the link is also handed to the screen as a fallback. */
export function startClaudeLogin(): ClaudeLogin {
	if (claudeLogin && (claudeLogin.state.status === "starting" || claudeLogin.state.status === "waiting")) return claudeLogin.state;
	const child = spawn(claudeBinary(), ["auth", "login"], { env: childEnv() as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const state: ClaudeLogin = { url: null, status: "starting", error: null };
	claudeLogin = { state, child };
	let output = "";
	const read = (d: Buffer) => {
		output = (output + d.toString()).slice(-4000);
		const url = /https:\/\/\S+oauth\S+/.exec(output)?.[0];
		if (url && !state.url) {
			state.url = url;
			state.status = "waiting";
		}
	};
	child.stdout.on("data", read);
	child.stderr.on("data", read);
	child.on("error", (err) => {
		state.status = "error";
		state.error = err.message;
	});
	child.on("exit", (code) => {
		if (state.status === "error") return;
		const ok = code === 0 && claudeStatus().signedIn;
		state.status = ok ? "done" : "error";
		state.error = ok ? null : output.trim().split("\n").at(-1) || "the sign-in stopped before it finished";
	});
	setTimeout(() => {
		if (claudeLogin?.state === state && state.status !== "done" && child.exitCode === null) child.kill();
	}, 10 * 60_000).unref();
	return state;
}

/** The code the sign-in page shows, when the browser can't hand it back itself. */
export function submitClaudeCode(code: string): void {
	const live = claudeLogin;
	if (!live || live.child.exitCode !== null) throw new Error("no Claude sign-in is waiting");
	live.child.stdin.write(`${code.trim()}\n`);
}

export function claudeLoginState(): ClaudeLogin | null {
	return claudeLogin?.state ?? null;
}

// ─── paper tools ────────────────────────────────────────────────────────────

const PYTHON_PACKAGES = ["sympy", "numpy", "pymupdf"];

/** Folders a fresh install lands in. A running app keeps the PATH it started
 *  with, so tools installed after launch are found here instead. */
export function toolDirs(): string[] {
	if (process.platform !== "win32") return [];
	const dirs: string[] = [];
	const local = process.env.LOCALAPPDATA;
	const pf = process.env.ProgramFiles ?? "C:\\Program Files";
	dirs.push("C:\\Strawberry\\perl\\bin", "C:\\Strawberry\\c\\bin");
	dirs.push(path.join(pf, "MiKTeX", "miktex", "bin", "x64"));
	if (local) dirs.push(path.join(local, "Programs", "MiKTeX", "miktex", "bin", "x64"));
	const pythonParents = ["C:\\", ...(local ? [path.join(local, "Programs", "Python")] : [])];
	for (const parent of pythonParents) {
		try {
			for (const d of fs.readdirSync(parent).filter((n) => /^Python3\d+$/i.test(n)).sort().reverse()) {
				dirs.push(path.join(parent, d), path.join(parent, d, "Scripts"));
			}
		} catch {}
	}
	return dirs.filter((d) => fs.existsSync(d));
}

/** The environment's PATH with toolDirs() in front. */
export function withToolPath(env: Record<string, string | undefined>): Record<string, string | undefined> {
	const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
	return { ...env, [key]: [...toolDirs(), env[key] ?? ""].join(path.delimiter) };
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
	const r = spawnSync(cmd, args, { env: withToolPath({ ...process.env }) as NodeJS.ProcessEnv, encoding: "utf-8", windowsHide: true, timeout: 60_000 });
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** A working Python 3: the py launcher first (the bare `python` on Windows
 *  can be the Microsoft Store stub). */
export function findPython(): [string, ...string[]] | null {
	const candidates: [string, ...string[]][] = process.platform === "win32" ? [["py", "-3"], ["python"]] : [["python3"], ["python"]];
	for (const cmd of candidates) {
		const r = run(cmd[0], [...cmd.slice(1), "-c", "import sys; print(sys.version_info[0])"]);
		if (r.ok && r.out.trim().endsWith("3")) return cmd;
	}
	return null;
}

export interface PaperToolsStatus {
	python: boolean;
	packages: boolean;
	latex: boolean;
	perl: boolean;
}

export function paperToolsStatus(): PaperToolsStatus {
	const py = findPython();
	return {
		python: py !== null,
		packages: py !== null && run(py[0], [...py.slice(1), "-c", "import sympy, numpy, fitz"]).ok,
		latex: run("latexmk", ["--version"]).ok,
		perl: process.platform !== "win32" || run("perl", ["--version"]).ok,
	};
}

export interface PaperToolsInstall {
	status: "running" | "done" | "error";
	log: string[];
	error: string | null;
}

let toolsInstall: PaperToolsInstall | null = null;

export function paperToolsInstallState(): PaperToolsInstall | null {
	return toolsInstall;
}

/** Install whatever paper tools are missing, one after another. winget may
 *  show Windows' own permission prompt for MiKTeX and Perl. */
export function installPaperTools(): PaperToolsInstall {
	if (toolsInstall?.status === "running") return toolsInstall;
	if (process.platform !== "win32") throw new Error("the installer only knows Windows; install Python, a TeX distribution and Perl yourself");
	const state: PaperToolsInstall = { status: "running", log: [], error: null };
	toolsInstall = state;
	const say = (line: string) => {
		state.log = [...state.log, line].slice(-40);
	};
	const step = (label: string, cmd: string, args: string[]) =>
		new Promise<void>((resolve, reject) => {
			say(label);
			const child = spawn(cmd, args, { env: withToolPath({ ...process.env }) as NodeJS.ProcessEnv, windowsHide: true });
			const onData = (d: Buffer) => {
				for (const line of d.toString().split(/\r?\n/)) {
					const clean = line.replace(/[^\x20-\x7e]/g, "").trim();
					// winget draws progress bars; keep the readable lines only.
					if (clean.length > 3 && !/^[-\\|/ █▒]+$/.test(clean)) say(`  ${clean}`);
				}
			};
			child.stdout.on("data", onData);
			child.stderr.on("data", onData);
			child.on("error", reject);
			child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`))));
		});
	const winget = (id: string, extra: string[] = []) => [
		"install",
		"--id",
		id,
		"-e",
		"--silent",
		"--accept-package-agreements",
		"--accept-source-agreements",
		...extra,
	];

	void (async () => {
		try {
			let have = paperToolsStatus();
			if (!have.python) await step("Installing Python 3.12…", "winget", winget("Python.Python.3.12", ["--scope", "user"]));
			if (!have.latex) {
				await step("Installing MiKTeX…", "winget", winget("MiKTeX.MiKTeX"));
				// Missing LaTeX packages (exam, siunitx, tikz…) install on first use
				// instead of MiKTeX stopping a headless build to ask.
				await step("Letting MiKTeX fetch missing packages itself…", "initexmf", ["--set-config-value=[MPM]AutoInstall=1"]).catch(() =>
					say("  (couldn't change MiKTeX's setting; it may ask before fetching packages)"),
				);
			}
			if (!have.perl) await step("Installing Strawberry Perl…", "winget", winget("StrawberryPerl.StrawberryPerl"));
			have = paperToolsStatus();
			const py = findPython();
			if (!py) throw new Error("Python still isn't found after installing it; restart the app and try again");
			if (!have.packages) await step("Installing sympy, numpy and PyMuPDF…", py[0], [...py.slice(1), "-m", "pip", "install", "--user", ...PYTHON_PACKAGES]);
			have = paperToolsStatus();
			const missing = Object.entries(have)
				.filter(([, ok]) => !ok)
				.map(([name]) => name);
			if (missing.length) throw new Error(`still missing after install: ${missing.join(", ")} (restarting the app often fixes this)`);
			say("All paper tools are ready.");
			state.status = "done";
		} catch (err) {
			state.status = "error";
			state.error = err instanceof Error ? err.message : String(err);
			say(state.error);
		}
	})();
	return state;
}
