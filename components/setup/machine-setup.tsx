"use client";
/**
 * "THIS COMPUTER" SETUP (personal fork, 2026-10-24): the per-machine steps
 * the desktop app needs: the synced workspace folder, the Claude sign-in,
 * Gemini (optional: Google's Antigravity server + Google sign-in) and the
 * paper tools (optional: Python, MiKTeX, Perl). One component, two homes:
 * the first-launch screen (/setup, with a Done button) and Settings →
 * This computer. Server side: app/api/setup/route.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CircleIcon, ExternalLinkIcon, FolderOpenIcon, Loader2Icon, XIcon } from "lucide-react";

// ─── wire shapes (GET /api/setup) ───────────────────────────────────────────

interface Job {
	status: "running" | "done" | "error";
	log: string[];
	error: string | null;
}

interface Login {
	url: string | null;
	status: "starting" | "waiting" | "done" | "error";
	error: string | null;
}

interface Live {
	claudeLogin: Login | null;
	geminiInstall: Job | null;
	geminiLogin: Login | null;
	paperToolsInstall: Job | null;
}

interface SetupStatus extends Live {
	needed: boolean;
	workspace: { folder: string; desktop: boolean };
	claude: { signedIn: boolean; email: string | null };
	gemini: { installed: boolean; version: string | null; signedIn: boolean };
	paperTools: { python: boolean; packages: boolean; latex: boolean; perl: boolean };
}

const card = "rounded-2xl border bg-card p-4";
const pill =
	"inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";
const primary =
	"inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
const label = "text-[11px] uppercase tracking-widest text-muted-foreground";

const busy = (l: Login | Job | null) => l !== null && (l.status === "running" || l.status === "starting" || l.status === "waiting");

async function post(action: string, extra: object = {}): Promise<void> {
	const res = await fetch("/api/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action, ...extra }),
	});
	if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
}

export function MachineSetup({ onFinish }: { onFinish?: () => void }) {
	const [status, setStatus] = useState<SetupStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const openedGemini = useRef<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/setup", { cache: "no-store" });
			setStatus((await res.json()) as SetupStatus);
		} catch (err) {
			setError(String(err));
		}
	}, []);
	useEffect(() => void refresh(), [refresh]);

	const running = status !== null && (busy(status.claudeLogin) || busy(status.geminiInstall) || busy(status.geminiLogin) || busy(status.paperToolsInstall));
	useEffect(() => {
		if (!running) return;
		const id = setInterval(async () => {
			const live = (await (await fetch("/api/setup?live=1", { cache: "no-store" })).json()) as Live;
			const finished =
				(busy(status.claudeLogin) && !busy(live.claudeLogin)) ||
				(busy(status.geminiInstall) && !busy(live.geminiInstall)) ||
				(busy(status.geminiLogin) && !busy(live.geminiLogin)) ||
				(busy(status.paperToolsInstall) && !busy(live.paperToolsInstall));
			if (finished) await refresh();
			else setStatus((s) => (s ? { ...s, ...live } : s));
		}, 1000);
		return () => clearInterval(id);
	}, [running, status, refresh]);

	// Antigravity prints its Google link instead of opening it: open it once.
	useEffect(() => {
		const url = status?.geminiLogin?.status === "waiting" ? status.geminiLogin.url : null;
		if (url && openedGemini.current !== url) {
			openedGemini.current = url;
			window.open(url, "_blank");
		}
	}, [status?.geminiLogin]);

	const act = async (action: string, extra: object = {}) => {
		setError(null);
		try {
			await post(action, extra);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	if (!status) return <Loader2Icon className="size-4 animate-spin text-muted-foreground" />;
	const tools = status.paperTools;
	const toolsReady = tools.python && tools.packages && tools.latex && tools.perl;

	return (
		<div className="flex flex-col gap-4" data-testid="machine-setup">
			{error && (
				<p className="rounded-xl border border-destructive/40 px-3 py-2 text-sm text-destructive">
					{error}
					<button type="button" onClick={() => setError(null)} className="ml-2 underline">
						dismiss
					</button>
				</p>
			)}

			<section className={card} data-testid="setup-folder">
				<h2 className={label}>Your folder</h2>
				<p className="mt-2 break-all font-mono text-xs">{status.workspace.folder}</p>
				<p className="mt-2 text-sm text-muted-foreground">
					Your chats, knowledge graph, settings and study modules live here. Keep it in Google Drive and both computers share them.
					Close the app on one computer before opening it on the other.
				</p>
				{window.mt?.changeWorkspace && (
					<button type="button" className={`${pill} mt-3`} onClick={() => void window.mt?.changeWorkspace?.()}>
						<FolderOpenIcon className="size-3.5" />
						Change folder…
					</button>
				)}
			</section>

			<section className={card} data-testid="setup-claude">
				<Heading done={status.claude.signedIn}>Claude</Heading>
				{status.claude.signedIn ? (
					<p className="mt-2 text-sm text-muted-foreground">Signed in{status.claude.email ? ` as ${status.claude.email}` : ""}. The tutor runs on this Claude subscription.</p>
				) : busy(status.claudeLogin) ? (
					<div className="mt-2 flex flex-col gap-2 text-sm">
						<p className="text-muted-foreground">Finish signing in in your browser.</p>
						{status.claudeLogin?.url && (
							<a href={status.claudeLogin.url} target="_blank" rel="noreferrer" className={`${pill} self-start`}>
								<ExternalLinkIcon className="size-3.5" />
								Open the sign-in page
							</a>
						)}
						<form
							className="flex flex-wrap items-center gap-2"
							onSubmit={(e) => {
								e.preventDefault();
								void act("claude-code", { code }).then(() => setCode(""));
							}}
						>
							<input
								value={code}
								onChange={(e) => setCode(e.target.value)}
								placeholder="If the page shows a code, paste it here"
								className="h-8 min-w-60 flex-1 rounded-full border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground"
							/>
							<button type="submit" className={primary} disabled={!code.trim()}>
								Submit
							</button>
						</form>
					</div>
				) : (
					<>
						<p className="mt-2 text-sm text-muted-foreground">Sign in with your Claude account. The tutor needs it.</p>
						{status.claudeLogin?.status === "error" && <p className="mt-2 text-sm text-destructive">{status.claudeLogin.error}</p>}
						<button type="button" className={`${primary} mt-3`} onClick={() => void act("claude-login")}>
							Sign in to Claude
						</button>
					</>
				)}
			</section>

			<section className={card} data-testid="setup-gemini">
				<Heading done={status.gemini.installed && status.gemini.signedIn} optional>
					Gemini
				</Heading>
				{!status.gemini.installed ? (
					<>
						<p className="mt-2 text-sm text-muted-foreground">
							Gemini runs through Google&apos;s own Antigravity server (about 130 MB). It&apos;s downloaded from the address in the official ACP registry and only
							installed if its SHA-256 matches and Google has signed it.
						</p>
						{busy(status.geminiInstall) ? (
							<JobLog job={status.geminiInstall} />
						) : (
							<>
								{status.geminiInstall?.status === "error" && <p className="mt-2 text-sm text-destructive">{status.geminiInstall.error}</p>}
								<button type="button" className={`${pill} mt-3`} onClick={() => void act("gemini-install")}>
									Install Gemini
								</button>
							</>
						)}
					</>
				) : status.gemini.signedIn ? (
					<>
						<p className="mt-2 text-sm text-muted-foreground">Installed (version {status.gemini.version}) and signed in with Google.</p>
						<button type="button" className={`${pill} mt-3`} onClick={() => void act("gemini-relogin")}>
							Sign in again
						</button>
					</>
				) : busy(status.geminiLogin) ? (
					<div className="mt-2 flex flex-col gap-2 text-sm">
						<p className="text-muted-foreground">
							{status.geminiLogin?.url ? "Finish signing in with Google in your browser." : "Starting Google's Antigravity server (about 15 seconds)…"}
						</p>
						{status.geminiLogin?.url && (
							<a href={status.geminiLogin.url} target="_blank" rel="noreferrer" className={`${pill} self-start`}>
								<ExternalLinkIcon className="size-3.5" />
								Open the sign-in page
							</a>
						)}
					</div>
				) : (
					<>
						<p className="mt-2 text-sm text-muted-foreground">Installed. Sign in with the Google account whose plan you want to use.</p>
						{status.geminiLogin?.status === "error" && <p className="mt-2 text-sm text-destructive">{status.geminiLogin.error}</p>}
						<button type="button" className={`${pill} mt-3`} onClick={() => void act("gemini-login")}>
							Sign in with Google
						</button>
					</>
				)}
			</section>

			<section className={card} data-testid="setup-paper-tools">
				<Heading done={toolsReady} optional>
					Paper tools
				</Heading>
				<p className="mt-2 text-sm text-muted-foreground">Generating practice papers needs these on this computer. Everything else works without them.</p>
				<ul className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
					<Tool ok={tools.python}>Python 3</Tool>
					<Tool ok={tools.packages}>sympy, numpy, PyMuPDF</Tool>
					<Tool ok={tools.latex}>MiKTeX (latexmk)</Tool>
					<Tool ok={tools.perl}>Strawberry Perl</Tool>
				</ul>
				{busy(status.paperToolsInstall) ? (
					<JobLog job={status.paperToolsInstall} />
				) : (
					!toolsReady && (
						<>
							{status.paperToolsInstall?.status === "error" && <p className="mt-2 text-sm text-destructive">{status.paperToolsInstall.error}</p>}
							<p className="mt-3 text-xs text-muted-foreground">Installs through winget and pip. Windows may ask for permission for MiKTeX and Perl.</p>
							<button type="button" className={`${pill} mt-2`} onClick={() => void act("paper-tools-install")}>
								Install what&apos;s missing
							</button>
						</>
					)
				)}
			</section>

			{onFinish && (
				<div className="flex items-center justify-end gap-3">
					{!status.claude.signedIn && <span className="text-xs text-muted-foreground">Sign in to Claude first.</span>}
					<button
						type="button"
						className={primary}
						disabled={!status.claude.signedIn || running}
						onClick={() => void act("finish").then(onFinish)}
						data-testid="setup-done"
					>
						Done
					</button>
				</div>
			)}
		</div>
	);
}

function Heading({ done, optional, children }: { done: boolean; optional?: boolean; children: React.ReactNode }) {
	return (
		<div className="flex items-center gap-2">
			{done ? <CheckIcon className="size-4 text-primary" /> : <CircleIcon className="size-3.5 text-muted-foreground" />}
			<h2 className="font-title text-xl">{children}</h2>
			{optional && <span className={label}>optional</span>}
		</div>
	);
}

function Tool({ ok, children }: { ok: boolean; children: React.ReactNode }) {
	return (
		<li className="flex items-center gap-2">
			{ok ? <CheckIcon className="size-3.5 text-primary" /> : <XIcon className="size-3.5 text-muted-foreground" />}
			<span className={ok ? "" : "text-muted-foreground"}>{children}</span>
		</li>
	);
}

function JobLog({ job }: { job: Job | null }) {
	if (!job) return null;
	return (
		<div className="mt-3 rounded-xl border px-3 py-2 text-xs">
			<div className="flex items-center gap-2 font-medium">
				<Loader2Icon className="size-3.5 animate-spin" />
				Working…
			</div>
			<pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-muted-foreground">{job.log.slice(-8).join("\n")}</pre>
		</div>
	);
}
