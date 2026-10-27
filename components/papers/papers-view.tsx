"use client";
/**
 * PRACTICE PAPERS (personal fork, 2026-10-24) — the app side of the
 * practice-paper pipeline (SETUP_PROMPT.md, .claude/skills/make-papers and
 * mark-attempts). One module at a time:
 *   - materials: the five folders /make-papers reads, opened in the file
 *     manager to drop files in;
 *   - generate: runs /make-papers headless on the subscription;
 *   - each paper pair: its four PDFs, the photo hand-in (saved as
 *     Q<n>_p<page>.jpg), headless marking, and the marking review where
 *     every line can be edited before the learner approves it. Approval is
 *     the only thing that ever sets a marking to "approved".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	CheckIcon,
	FileTextIcon,
	FolderOpenIcon,
	Loader2Icon,
	PlusIcon,
	SparklesIcon,
	Trash2Icon,
	UploadIcon,
	XIcon,
} from "lucide-react";
import { isModuleCode, type Marking, type MarkingPart } from "@/src/core";
import { SidebarToggle, useSidebar } from "@/components/sidebar";
import { toJpeg } from "@/components/photo-utils";

// ─── wire shapes (GET /api/study) ───────────────────────────────────────────

interface PairQuestion {
	paper: number | string;
	number: string;
	marks: number | null;
	sub_skill_id: string | null;
	block: string | null;
}

interface PairInfo {
	id: string;
	pdfs: { paper1: string | null; paper1Scheme: string | null; paper2: string | null; paper2Scheme: string | null };
	questions: PairQuestion[];
	attempts: string[];
	marking: { status: "proposed" | "approved"; awarded: number; available: number } | null;
	hasVerification: boolean;
}

interface ModuleInfo {
	code: string;
	materials: Record<string, number>;
	sessions: number;
	hasTaxonomy: boolean;
	pairs: PairInfo[];
}

interface StudyJob {
	id: string;
	kind: "make-papers" | "mark-attempts";
	module: string;
	pair: string | null;
	status: "running" | "done" | "error";
	/** The engine running (or that ran) it (src/server/study-jobs.ts). */
	engine: "claude" | "gemini" | "anthropic-key" | null;
	startedAt: string;
	endedAt: string | null;
	progress: string[];
	result: string | null;
}

const ENGINE_LABEL: Record<NonNullable<StudyJob["engine"]>, string> = {
	claude: "on Claude",
	gemini: "on Gemini",
	"anthropic-key": "on the Anthropic API key",
};

const MATERIAL_LABELS: Record<string, string> = {
	past_papers: "Past papers",
	mark_schemes: "Mark schemes",
	lecture_notes: "Lecture notes",
	spec: "Spec",
	problem_sheets: "Problem sheets",
};

const fileUrl = (rel: string) => `/api/study/file?path=${encodeURIComponent(rel)}`;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
	return body;
}

const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

// Shared chrome — the Mentaljineer glass vocabulary.
const card = "rounded-2xl border bg-card p-4";
const pill =
	"inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40";
const primary =
	"inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
const label = "text-[11px] uppercase tracking-widest text-muted-foreground";

// ─── the view ───────────────────────────────────────────────────────────────

export function PapersView({ initialModule }: { initialModule: string | null }) {
	const [modules, setModules] = useState<ModuleInfo[] | null>(null);
	const [jobs, setJobs] = useState<StudyJob[]>([]);
	const [root, setRoot] = useState("");
	const [selected, setSelected] = useState<string | null>(initialModule);
	const [error, setError] = useState<string | null>(null);
	const { open: sidebarOpen } = useSidebar();

	const refresh = useCallback(async () => {
		try {
			const body = await api<{ root: string; modules: ModuleInfo[]; jobs: StudyJob[] }>("/api/study");
			setModules(body.modules);
			setJobs(body.jobs);
			setRoot(body.root);
			setSelected((s) => (s && body.modules.some((m) => m.code === s) ? s : (body.modules[0]?.code ?? null)));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Poll while a job runs, and on window focus (files may have been
	// dropped into the materials folders meanwhile).
	const running = jobs.some((j) => j.status === "running");
	useEffect(() => {
		if (!running) return;
		const id = setInterval(() => void refresh(), 3000);
		return () => clearInterval(id);
	}, [running, refresh]);
	useEffect(() => {
		const onFocus = () => void refresh();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	const mod = modules?.find((m) => m.code === selected) ?? null;

	return (
		<div className="relative flex h-dvh flex-col overflow-hidden">
			<div className="mt-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />
			<header className="mt-wco-gutter flex h-15 shrink-0 items-center gap-3 border-b border-border px-3">
				{!sidebarOpen && (
					<div className="mt-closed-toggle">
						<SidebarToggle />
					</div>
				)}
				<h1 className="font-title truncate text-2xl">Practice papers</h1>
			</header>
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-4xl flex-col gap-5 px-5 py-6">
					{error && (
						<p className="rounded-xl border border-destructive/40 px-3 py-2 text-sm text-destructive">
							{error}
							<button type="button" onClick={() => setError(null)} className="ml-2 underline">
								dismiss
							</button>
						</p>
					)}
					<ModuleBar modules={modules} selected={selected} onSelect={setSelected} onCreated={(c) => void refresh().then(() => setSelected(c))} onError={setError} />
					{modules && modules.length === 0 && <EmptyState root={root} />}
					{mod && (
						<ModulePanel
							key={mod.code}
							mod={mod}
							jobs={jobs.filter((j) => j.module === mod.code)}
							onChange={() => void refresh()}
							onError={setError}
						/>
					)}
				</div>
			</main>
		</div>
	);
}

function EmptyState({ root }: { root: string }) {
	return (
		<div className={`${card} text-sm leading-relaxed text-muted-foreground`}>
			<p className="text-foreground">No modules yet.</p>
			<p className="mt-2">
				Add one above (its code, e.g. 1M1). The app creates its folders under <span className="font-mono text-xs">{root}</span>. Put
				the module&apos;s past papers, mark schemes, lecture notes, spec and problem sheets in them, run a few teaching sessions
				tagged with the module, then generate papers here.
			</p>
		</div>
	);
}

function ModuleBar({
	modules,
	selected,
	onSelect,
	onCreated,
	onError,
}: {
	modules: ModuleInfo[] | null;
	selected: string | null;
	onSelect: (code: string) => void;
	onCreated: (code: string) => void;
	onError: (e: string) => void;
}) {
	const [draft, setDraft] = useState("");
	const create = async () => {
		const code = draft.trim();
		if (!isModuleCode(code)) {
			onError("Module codes are letters, digits, - or _, e.g. 1M1.");
			return;
		}
		try {
			await api("/api/study", json("POST", { code }));
			setDraft("");
			onCreated(code);
		} catch (e) {
			onError(e instanceof Error ? e.message : String(e));
		}
	};
	return (
		<div className="flex flex-wrap items-center gap-2" data-testid="module-bar">
			{modules === null && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
			{modules?.map((m) => (
				<button
					key={m.code}
					type="button"
					aria-pressed={m.code === selected}
					onClick={() => onSelect(m.code)}
					className={`rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
						m.code === selected ? "bg-primary text-primary-foreground" : "hover:bg-accent"
					}`}
				>
					{m.code}
				</button>
			))}
			<form
				className="flex items-center gap-1 rounded-full border bg-card/85 py-0.5 pl-3 pr-0.5 shadow-lg"
				onSubmit={(e) => {
					e.preventDefault();
					void create();
				}}
			>
				<input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="New module code"
					aria-label="New module code"
					className="h-7 w-32 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
				/>
				<button type="submit" aria-label="Add module" className="flex size-7 items-center justify-center rounded-full hover:bg-accent">
					<PlusIcon className="size-4" />
				</button>
			</form>
		</div>
	);
}

// ─── one module ─────────────────────────────────────────────────────────────

function ModulePanel({
	mod,
	jobs,
	onChange,
	onError,
}: {
	mod: ModuleInfo;
	jobs: StudyJob[];
	onChange: () => void;
	onError: (e: string) => void;
}) {
	const open = (sub: string) => void api(`/api/study/${mod.code}/open`, json("POST", { sub })).catch((e) => onError(String(e)));
	const genJob = jobs.find((j) => j.kind === "make-papers");
	const busy = jobs.some((j) => j.status === "running");
	const totalMaterials = Object.values(mod.materials).reduce((a, b) => a + b, 0);

	return (
		<div className="flex flex-col gap-5">
			<section className={card}>
				<div className="flex items-center justify-between gap-3">
					<h2 className={label}>Materials</h2>
					<button type="button" className={pill} onClick={() => open("materials")}>
						<FolderOpenIcon className="size-3.5" />
						Open folder
					</button>
				</div>
				<div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
					{Object.entries(MATERIAL_LABELS).map(([key, name]) => (
						<button
							key={key}
							type="button"
							onClick={() => open(`materials/${key}`)}
							className="rounded-xl border px-3 py-2 text-left transition-colors hover:bg-accent"
							title={`Open materials/${key}`}
						>
							<div className="text-lg font-light tabular-nums">{mod.materials[key] ?? 0}</div>
							<div className="text-xs text-muted-foreground">{name}</div>
						</button>
					))}
				</div>
				<p className="mt-3 text-xs text-muted-foreground">
					{mod.sessions} logged session{mod.sessions === 1 ? "" : "s"} · taxonomy {mod.hasTaxonomy ? "built" : "not built yet (the first run builds it)"}
				</p>
			</section>

			<GeneratePanel code={mod.code} job={genJob} busy={busy} ready={totalMaterials > 0} sessions={mod.sessions} onChange={onChange} onError={onError} />

			{mod.pairs.length === 0 ? (
				<p className="px-1 text-sm text-muted-foreground">No paper pairs yet.</p>
			) : (
				mod.pairs.map((pair) => (
					<PairCard
						key={pair.id}
						code={mod.code}
						pair={pair}
						markJob={jobs.find((j) => j.kind === "mark-attempts" && j.pair === pair.id)}
						busy={busy}
						onChange={onChange}
						onError={onError}
					/>
				))
			)}
		</div>
	);
}

function JobStatus({ job, onCancel }: { job: StudyJob; onCancel: () => void }) {
	const elapsed = Math.round(((job.endedAt ? Date.parse(job.endedAt) : Date.now()) - Date.parse(job.startedAt)) / 60000);
	return (
		<div className="mt-3 rounded-xl border px-3 py-2 text-xs" data-testid="study-job">
			<div className="flex items-center gap-2">
				{job.status === "running" ? (
					<Loader2Icon className="size-3.5 animate-spin" />
				) : job.status === "done" ? (
					<CheckIcon className="size-3.5" />
				) : (
					<XIcon className="size-3.5 text-destructive" />
				)}
				<span className="font-medium">
					{job.kind === "make-papers" ? "Generating papers" : "Marking"}
					{job.engine ? ` ${ENGINE_LABEL[job.engine]}` : ""} · {job.status === "running" ? `${elapsed} min so far` : job.status}
				</span>
				{job.status === "running" && (
					<button type="button" onClick={onCancel} className="ml-auto text-muted-foreground underline hover:text-foreground">
						Cancel
					</button>
				)}
			</div>
			{job.status === "running" && job.progress.length > 0 && (
				<p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-muted-foreground">{job.progress[job.progress.length - 1]}</p>
			)}
			{job.status !== "running" && job.result && (
				<p className={`mt-1.5 whitespace-pre-wrap ${job.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>{job.result}</p>
			)}
		</div>
	);
}

function GeneratePanel({
	code,
	job,
	busy,
	ready,
	sessions,
	onChange,
	onError,
}: {
	code: string;
	job: StudyJob | undefined;
	busy: boolean;
	ready: boolean;
	sessions: number;
	onChange: () => void;
	onError: (e: string) => void;
}) {
	const [topics, setTopics] = useState("");
	const start = async () => {
		try {
			await api(`/api/study/${code}/generate`, json("POST", { topics }));
			onChange();
		} catch (e) {
			onError(e instanceof Error ? e.message : String(e));
		}
	};
	const cancel = () => void api(`/api/study/jobs?id=${job?.id ?? ""}`, { method: "DELETE" }).then(onChange);
	return (
		<section className={card}>
			<h2 className={label}>New paper pair</h2>
			<p className="mt-2 text-sm text-muted-foreground">
				Paper 1 drills what your sessions and markings show you get wrong; Paper 2 is a mock in the style of the past papers. Each
				comes with a mark scheme. A run takes a while and uses a good share of your Claude plan&apos;s limits; if Claude
				can&apos;t run it, it moves to Gemini on your Google login, then to your Anthropic API key.
			</p>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<input
					value={topics}
					onChange={(e) => setTopics(e.target.value)}
					placeholder={sessions > 0 ? "Topics (optional — default: what you've covered)" : "Topics to cover (needed: no sessions logged yet)"}
					aria-label="Topics"
					className="h-8 min-w-60 flex-1 rounded-full border bg-background px-3 text-sm outline-none placeholder:text-muted-foreground"
				/>
				<button type="button" className={primary} disabled={busy || !ready || (sessions === 0 && !topics.trim())} onClick={() => void start()}>
					<SparklesIcon className="size-3.5" />
					Generate papers
				</button>
			</div>
			{!ready && <p className="mt-2 text-xs text-muted-foreground">Add the module&apos;s materials first.</p>}
			{job && <JobStatus job={job} onCancel={cancel} />}
		</section>
	);
}

// ─── one paper pair ─────────────────────────────────────────────────────────

function PairCard({
	code,
	pair,
	markJob,
	busy,
	onChange,
	onError,
}: {
	code: string;
	pair: PairInfo;
	markJob: StudyJob | undefined;
	busy: boolean;
	onChange: () => void;
	onError: (e: string) => void;
}) {
	const base = `/api/study/${code}/pairs/${encodeURIComponent(pair.id)}`;
	const totalMarks = pair.questions.reduce((a, q) => a + (q.marks ?? 0), 0);
	const docs: [string, string | null][] = [
		["Paper 1", pair.pdfs.paper1],
		["Paper 2", pair.pdfs.paper2],
		["Mark scheme 1", pair.pdfs.paper1Scheme],
		["Mark scheme 2", pair.pdfs.paper2Scheme],
	];
	const mark = async () => {
		try {
			await api(`${base}/mark`, { method: "POST" });
			onChange();
		} catch (e) {
			onError(e instanceof Error ? e.message : String(e));
		}
	};
	const cancel = () => void api(`/api/study/jobs?id=${markJob?.id ?? ""}`, { method: "DELETE" }).then(onChange);

	return (
		<section className={card} data-testid="pair-card">
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h2 className="font-title text-xl">{pair.id}</h2>
				<span className="text-xs text-muted-foreground">
					{pair.questions.length} parts{totalMarks ? ` · ${totalMarks} marks` : ""}
					{pair.marking &&
						` · ${pair.marking.status === "approved" ? "marked" : "marking to review"}: ${pair.marking.awarded}/${pair.marking.available}`}
				</span>
			</div>
			<div className="mt-3 flex flex-wrap gap-2">
				{docs.map(([name, rel]) =>
					rel ? (
						<a key={name} href={fileUrl(rel)} target="_blank" rel="noreferrer" className={pill}>
							<FileTextIcon className="size-3.5" />
							{name}
						</a>
					) : (
						<span key={name} className={`${pill} opacity-40`}>
							{name} (missing)
						</span>
					),
				)}
				{pair.hasVerification && (
					<a href={fileUrl(`modules/${code}/papers/${pair.id}/verification.md`)} target="_blank" rel="noreferrer" className={pill}>
						Verification
					</a>
				)}
			</div>
			<p className="mt-2 text-xs text-muted-foreground">
				Work Paper 1 block by block, marking each before the next; sit Paper 2 timed in one go, ideally a day later.
			</p>

			<HandIn code={code} pair={pair} base={base} onChange={onChange} onError={onError} />

			<div className="mt-3 flex items-center gap-2">
				<button type="button" className={primary} disabled={busy || pair.attempts.length === 0} onClick={() => void mark()}>
					Mark my attempts
				</button>
				<span className="text-xs text-muted-foreground">Marking proposes; nothing counts until you approve it.</span>
			</div>
			{markJob && <JobStatus job={markJob} onCancel={cancel} />}

			{pair.marking && <MarkingReview base={base} onChange={onChange} onError={onError} />}
		</section>
	);
}

function HandIn({ code, pair, base, onChange, onError }: { code: string; pair: PairInfo; base: string; onChange: () => void; onError: (e: string) => void }) {
	const numbers = useMemo(() => {
		const seen = new Set<string>();
		for (const q of pair.questions) {
			const n = /^\d+/.exec(q.number)?.[0];
			if (n) seen.add(n);
		}
		return [...seen].sort((a, b) => Number(a) - Number(b));
	}, [pair.questions]);
	const [question, setQuestion] = useState(numbers[0] ?? "1");
	const [uploading, setUploading] = useState(false);
	const input = useRef<HTMLInputElement>(null);

	const nextPage = (q: string) => {
		const pages = pair.attempts
			.map((f) => new RegExp(`^Q${q}_p(\\d+)\\.jpg$`, "i").exec(f)?.[1])
			.filter((p): p is string => p !== undefined)
			.map(Number);
		return pages.length ? Math.max(...pages) + 1 : 1;
	};

	const upload = async (files: FileList | null) => {
		if (!files?.length || !/^\d+[a-z]?$/i.test(question)) return;
		setUploading(true);
		try {
			let page = nextPage(question);
			for (const file of Array.from(files)) {
				const form = new FormData();
				form.set("question", question);
				form.set("page", String(page++));
				form.set("file", await toJpeg(file), "photo.jpg");
				await api(`${base}/attempts`, { method: "POST", body: form });
			}
			onChange();
		} catch (e) {
			onError(e instanceof Error ? e.message : String(e));
		} finally {
			setUploading(false);
			if (input.current) input.current.value = "";
		}
	};

	const remove = (name: string) =>
		void api(`${base}/attempts?name=${encodeURIComponent(name)}`, { method: "DELETE" }).then(onChange, (e) => onError(String(e)));

	return (
		<div className="mt-4 border-t border-border/60 pt-4">
			<h3 className={label}>Hand in</h3>
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<span className="text-sm">Question</span>
				<input
					list={`q-${code}-${pair.id}`}
					value={question}
					onChange={(e) => setQuestion(e.target.value.trim())}
					aria-label="Question number"
					className="h-8 w-16 rounded-full border bg-background px-3 text-sm outline-none"
				/>
				<datalist id={`q-${code}-${pair.id}`}>
					{numbers.map((n) => (
						<option key={n} value={n} />
					))}
				</datalist>
				<input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => void upload(e.target.files)} />
				<button type="button" className={pill} disabled={uploading} onClick={() => input.current?.click()}>
					{uploading ? <Loader2Icon className="size-3.5 animate-spin" /> : <UploadIcon className="size-3.5" />}
					Add photos (from page {nextPage(question)})
				</button>
			</div>
			{pair.attempts.length > 0 && (
				<div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
					{pair.attempts.map((name) => (
						<figure key={name} className="group relative overflow-hidden rounded-xl border">
							<a href={fileUrl(`modules/${code}/attempts/${pair.id}/${name}`)} target="_blank" rel="noreferrer">
								{/* eslint-disable-next-line @next/next/no-img-element -- local study file, no optimization pipeline */}
								<img src={fileUrl(`modules/${code}/attempts/${pair.id}/${name}`)} alt={name} className="aspect-[3/4] w-full object-cover" />
							</a>
							<figcaption className="px-1.5 py-1 text-[11px] text-muted-foreground">{name.replace(".jpg", "")}</figcaption>
							<button
								type="button"
								aria-label={`Remove ${name}`}
								onClick={() => remove(name)}
								className="absolute right-1 top-1 hidden rounded-full bg-background/80 p-1 group-hover:block"
							>
								<Trash2Icon className="size-3" />
							</button>
						</figure>
					))}
				</div>
			)}
		</div>
	);
}

// ─── marking review ─────────────────────────────────────────────────────────

function MarkingReview({ base, onChange, onError }: { base: string; onChange: () => void; onError: (e: string) => void }) {
	const [marking, setMarking] = useState<Marking | null>(null);
	const [parts, setParts] = useState<MarkingPart[]>([]);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		const body = await api<{ marking: Marking | null }>(`${base}/marking`);
		setMarking(body.marking);
		setParts(body.marking?.parts ?? []);
		setDirty(false);
	}, [base]);

	useEffect(() => {
		void load().catch((e) => onError(String(e)));
	}, [load, onError]);

	if (!marking) return null;
	const approved = marking.status === "approved";
	const edit = (i: number, patch: Partial<MarkingPart>) => {
		setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
		setDirty(true);
	};
	const awarded = parts.reduce((a, p) => a + (Number(p.marks_awarded) || 0), 0);
	const available = parts.reduce((a, p) => a + (Number(p.marks_available) || 0), 0);

	const save = async () => {
		setSaving(true);
		try {
			await api(`${base}/marking`, json("PUT", { parts }));
			await load();
			onChange();
		} catch (e) {
			onError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};
	const approve = async () => {
		setSaving(true);
		try {
			if (dirty) await api(`${base}/marking`, json("PUT", { parts }));
			await api(`${base}/marking/approve`, { method: "POST" });
			await load();
			onChange();
		} catch (e) {
			onError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="mt-4 border-t border-border/60 pt-4" data-testid="marking-review">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className={label}>
					Marking · {approved ? `approved ${marking.approved_at?.slice(0, 10) ?? ""}` : "proposed, check every line"}
				</h3>
				<span className="text-sm tabular-nums">
					{awarded}/{available}
				</span>
			</div>
			<div className="mt-3 flex flex-col gap-2">
				{parts.map((part, i) => (
					<div key={`${part.paper}-${part.number}`} className="rounded-xl border px-3 py-2.5 text-sm">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-medium">
								P{part.paper} Q{part.number}
							</span>
							{part.sub_skill_id && <span className="font-mono text-[11px] text-muted-foreground">{part.sub_skill_id}</span>}
							{part.unreadable && <span className="rounded-full border border-destructive/50 px-2 text-[11px] text-destructive">unreadable</span>}
							{part.attempted === false && <span className="rounded-full border px-2 text-[11px] text-muted-foreground">not attempted</span>}
							<span className="ml-auto flex items-center gap-1 tabular-nums">
								<input
									type="number"
									min={0}
									max={part.marks_available}
									value={part.marks_awarded}
									disabled={approved}
									onChange={(e) => edit(i, { marks_awarded: Math.max(0, Math.min(part.marks_available, Number(e.target.value) || 0)) })}
									aria-label={`Marks awarded for P${part.paper} Q${part.number}`}
									className="h-7 w-14 rounded-md border bg-background px-1.5 text-right outline-none disabled:opacity-70"
								/>
								/ {part.marks_available}
							</span>
						</div>
						{part.lost.length > 0 && (
							<ul className="mt-2 flex flex-col gap-1.5">
								{part.lost.map((l, k) => (
									<li key={k} className="flex items-start gap-2 text-xs">
										<span className="mt-1 shrink-0 rounded-md border px-1.5 font-mono">{l.code}</span>
										<div className="min-w-0 flex-1">
											<input
												value={l.step}
												disabled={approved}
												onChange={(e) => edit(i, { lost: part.lost.map((x, m) => (m === k ? { ...x, step: e.target.value } : x)) })}
												aria-label="Step where the mark was lost"
												className="w-full bg-transparent outline-none disabled:opacity-90"
											/>
											{l.evidence && <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">“{l.evidence}”</p>}
											{l.common_error && <p className="mt-0.5 text-[11px] text-muted-foreground">{l.common_error}</p>}
										</div>
										{!approved && (
											<button
												type="button"
												aria-label={`Drop lost mark ${l.code}`}
												title="This mark wasn't actually lost"
												onClick={() => edit(i, { lost: part.lost.filter((_, m) => m !== k) })}
												className="mt-0.5 rounded-full p-0.5 hover:bg-accent"
											>
												<XIcon className="size-3" />
											</button>
										)}
									</li>
								))}
							</ul>
						)}
						{(part.note || !approved) && (
							<input
								value={part.note ?? ""}
								disabled={approved}
								placeholder="Note"
								onChange={(e) => edit(i, { note: e.target.value })}
								aria-label="Note"
								className="mt-2 w-full bg-transparent text-xs text-muted-foreground outline-none placeholder:text-muted-foreground/50"
							/>
						)}
					</div>
				))}
			</div>
			{!approved && (
				<div className="mt-3 flex items-center gap-2">
					<button type="button" className={pill} disabled={!dirty || saving} onClick={() => void save()}>
						Save edits
					</button>
					<button type="button" className={primary} disabled={saving} onClick={() => void approve()}>
						{saving ? <Loader2Icon className="size-3.5 animate-spin" /> : <CheckIcon className="size-3.5" />}
						Approve marking
					</button>
					<span className="text-xs text-muted-foreground">Approved markings steer the next papers.</span>
				</div>
			)}
		</div>
	);
}
