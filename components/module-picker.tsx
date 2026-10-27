"use client";
/**
 * The study-module pill on the new-session composer (personal fork,
 * 2026-10-24): which module a new teaching or practice session logs to
 * (study/modules/<CODE>/sessions/). "No module" = no study logging. The
 * last pick is remembered per browser, so a run of sessions on one
 * module needs no re-picking.
 */

import { useEffect, useRef, useState } from "react";
import { BookOpenIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { isModuleCode } from "@/src/core";

const STORAGE_KEY = "mt-study-module";

export function useStudyModule(): [string | null, (code: string | null) => void] {
	const [module, setModule] = useState<string | null>(null);
	useEffect(() => {
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			if (saved && isModuleCode(saved)) setModule(saved);
		} catch {
			// Storage blocked: start untagged.
		}
	}, []);
	const set = (code: string | null) => {
		setModule(code);
		try {
			if (code) localStorage.setItem(STORAGE_KEY, code);
			else localStorage.removeItem(STORAGE_KEY);
		} catch {
			// Storage blocked: the pick still holds for this page.
		}
	};
	return [module, set];
}

export function ModulePicker({ value, onChange }: { value: string | null; onChange: (code: string | null) => void }) {
	const [open, setOpen] = useState(false);
	const [codes, setCodes] = useState<string[]>([]);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		fetch("/api/study")
			.then((r) => r.json())
			.then((body: { modules?: { code: string }[] }) => setCodes((body.modules ?? []).map((m) => m.code)))
			.catch(() => {});
		const onDown = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [open]);

	const create = async () => {
		const code = draft.trim();
		if (!isModuleCode(code)) {
			setError("Letters, digits, - or _ (e.g. 1M1)");
			return;
		}
		const res = await fetch("/api/study", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code }),
		});
		if (!res.ok) {
			setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not create it");
			return;
		}
		setDraft("");
		setError(null);
		onChange(code);
		setOpen(false);
	};

	return (
		<div ref={ref} className="relative" data-testid="module-picker">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				title="Study module this session logs to"
				className="flex items-center gap-1 rounded-full border bg-card/85 px-2.5 py-1 text-[11px] uppercase tracking-wider shadow-lg backdrop-blur transition-colors hover:bg-muted"
			>
				<BookOpenIcon aria-hidden="true" className="size-3" />
				<span className={value ? "text-foreground" : "text-muted-foreground"}>{value ?? "No module"}</span>
				<ChevronDownIcon aria-hidden="true" className="size-3 text-muted-foreground" />
			</button>
			{open && (
				<div className="absolute bottom-full left-0 z-40 mb-1.5 flex w-56 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl">
					<button
						type="button"
						onClick={() => {
							onChange(null);
							setOpen(false);
						}}
						className="rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						No module (no study log)
					</button>
					{codes.map((c) => (
						<button
							key={c}
							type="button"
							onClick={() => {
								onChange(c);
								setOpen(false);
							}}
							className={`rounded-md px-2 py-1.5 text-left hover:bg-accent ${c === value ? "bg-accent text-foreground" : ""}`}
						>
							{c}
						</button>
					))}
					<form
						className="mt-1 flex items-center gap-1 border-t border-border/60 pt-2"
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
							className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none"
						/>
						<button type="submit" aria-label="Create module" className="flex size-7 items-center justify-center rounded-md hover:bg-accent">
							<PlusIcon className="size-3.5" />
						</button>
					</form>
					{error && <p className="px-1 text-[11px] text-destructive">{error}</p>}
				</div>
			)}
		</div>
	);
}
