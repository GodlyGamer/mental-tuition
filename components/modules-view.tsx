"use client";
/**
 * MODULES (personal fork, 2026-10-24): every study module at a glance, with
 * adding one a click away. A module is a folder tree under the workspace's
 * study/modules/<CODE>/ (CLAUDE.md); this page lists them with their
 * materials, logged sessions and paper pairs, opens the materials folder,
 * and hands off to Practice papers for generating and marking.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileTextIcon, FolderOpenIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { isModuleCode } from "@/src/core";
import { SidebarToggle, useSidebar } from "@/components/sidebar";

interface ModuleInfo {
	code: string;
	name: string | null;
	materials: Record<string, number>;
	sessions: number;
	hasTaxonomy: boolean;
	pairs: unknown[];
}

const card = "rounded-2xl border bg-card p-4";
const pill =
	"mt-btn inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40";
const label = "text-[11px] uppercase tracking-widest text-muted-foreground";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
	const res = await fetch(url, init);
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
	return body;
}

export function ModulesView() {
	const router = useRouter();
	const { open: sidebarOpen } = useSidebar();
	const [modules, setModules] = useState<ModuleInfo[] | null>(null);
	const [root, setRoot] = useState("");
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const data = await api<{ root: string; modules: ModuleInfo[] }>("/api/study");
			setModules(data.modules);
			setRoot(data.root);
		} catch (e) {
			setError(String(e));
		}
	}, []);
	useEffect(() => void refresh(), [refresh]);
	useEffect(() => {
		const onFocus = () => void refresh();
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [refresh]);

	const add = async () => {
		const code = draft.trim();
		if (!isModuleCode(code)) {
			setError("Module codes are letters, digits, - or _, e.g. 1M1.");
			return;
		}
		setError(null);
		try {
			await api("/api/study", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
			setDraft("");
			await refresh();
		} catch (e) {
			setError(String(e));
		}
	};

	// The module's display name (Hot Glass, owner 2026-10-27): shown in the
	// sidebar's MODULE grouping; empty clears it.
	const saveName = async (code: string, name: string) => {
		try {
			await api(`/api/study/${code}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim() || null }) });
			await refresh();
		} catch (e) {
			setError(String(e));
		}
	};

	const openFolder = (code: string) =>
		void api(`/api/study/${code}/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sub: "materials" }) }).catch((e) =>
			setError(String(e)),
		);

	return (
		<div className="relative flex h-dvh flex-col overflow-hidden">
			<div className="mt-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />
			<header className="mt-wco-gutter flex h-15 shrink-0 items-center gap-3 border-b border-border px-3">
				{!sidebarOpen && (
					<div className="mt-closed-toggle">
						<SidebarToggle />
					</div>
				)}
				<h1 className="font-title truncate text-2xl">Modules</h1>
			</header>
			<main className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex max-w-4xl flex-col gap-5 px-5 py-6">
					<form
						className={`${card} flex flex-wrap items-center gap-2`}
						onSubmit={(e) => {
							e.preventDefault();
							void add();
						}}
						data-testid="add-module"
					>
						<input
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							placeholder="Module code, e.g. 1M1"
							aria-label="New module code"
							autoFocus
							className="h-9 min-w-60 flex-1 rounded-full border bg-background px-4 text-sm outline-none placeholder:text-muted-foreground"
						/>
						<button
							type="submit"
							disabled={!draft.trim()}
							className="mt-btn-primary inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40"
						>
							<PlusIcon className="size-3.5" />
							Add module
						</button>
						{root && <p className="w-full text-xs text-muted-foreground">Each module gets its own folders under <span className="font-mono">{root}</span>.</p>}
					</form>

					{error && (
						<p className="rounded-xl border border-destructive/40 px-3 py-2 text-sm text-destructive">
							{error}
							<button type="button" onClick={() => setError(null)} className="ml-2 underline">
								dismiss
							</button>
						</p>
					)}

					{modules === null ? (
						<Loader2Icon className="size-4 animate-spin text-muted-foreground" />
					) : modules.length === 0 ? (
						<p className="px-1 text-sm text-muted-foreground">No modules yet. Add one above, then drop its past papers, mark schemes and notes into its folders.</p>
					) : (
						<div className="grid gap-3 sm:grid-cols-2" data-testid="module-list">
							{modules.map((m) => {
								const materials = Object.values(m.materials).reduce((a, b) => a + b, 0);
								return (
									<section key={m.code} className={card} data-testid="module-card">
										<h2 className="font-title text-2xl">{m.code}</h2>
										<input
											key={`${m.code}:${m.name ?? ""}`}
											defaultValue={m.name ?? ""}
											placeholder="Name (shown in the sidebar)"
											aria-label={`Name for ${m.code}`}
											data-testid="module-name"
											maxLength={80}
											onBlur={(e) => {
												if (e.target.value.trim() !== (m.name ?? "")) void saveName(m.code, e.target.value);
											}}
											onKeyDown={(e) => {
												if (e.key === "Enter") e.currentTarget.blur();
											}}
											className="mt-2 h-8 w-full rounded-full border bg-background px-3 text-xs outline-none placeholder:text-muted-foreground"
										/>
										<dl className="mt-3 grid grid-cols-3 gap-2">
											<Stat value={materials} name="materials" />
											<Stat value={m.sessions} name="sessions" />
											<Stat value={m.pairs.length} name="paper pairs" />
										</dl>
										{!m.hasTaxonomy && <p className={`${label} mt-3`}>Topic map is made on the first paper run</p>}
										<div className="mt-3 flex flex-wrap gap-2">
											<button type="button" className={pill} onClick={() => openFolder(m.code)}>
												<FolderOpenIcon className="size-3.5" />
												Materials folder
											</button>
											<button type="button" className={pill} onClick={() => router.push(`/papers?module=${encodeURIComponent(m.code)}`)}>
												<FileTextIcon className="size-3.5" />
												Practice papers
											</button>
										</div>
									</section>
								);
							})}
						</div>
					)}
				</div>
			</main>
		</div>
	);
}

function Stat({ value, name }: { value: number; name: string }) {
	return (
		<div className="rounded-xl border px-3 py-2">
			<dd className="text-lg font-light tabular-nums">{value}</dd>
			<dt className="text-xs text-muted-foreground">{name}</dt>
		</div>
	);
}
