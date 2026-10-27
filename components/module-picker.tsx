"use client";
/**
 * The study-module button in the composer's tray (personal fork,
 * 2026-10-24; a quiet text button since Hot Glass): which module a session
 * logs to (study/modules/<CODE>/sessions/). "No module" = no study logging.
 * On home and the draft it picks the NEW session's module, and the last
 * pick is remembered per browser. In a running session (owner, 2026-10-27)
 * it changes the session's own module — logging moves from the next turn.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
import { isModuleCode } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";

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
		// The menu is portaled (MenuShell), so "inside" is the trigger OR
		// the menu body.
		const onDown = (e: PointerEvent) => {
			const t = e.target as Element;
			if (!ref.current?.contains(t) && !t.closest?.('[data-testid="module-menu"]')) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey, true);
		};
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
				className="mt-quiet flex h-8 items-center gap-1.5 rounded-full px-2.5"
			>
				<span>{value ?? "No module"}</span>
				<ChevronDownIcon aria-hidden="true" className="size-2.5" strokeWidth={2} />
			</button>
			{open && (
				<MenuShell
					anchorRef={ref}
					testid="module-menu"
					preferredSide="up"
					menuClass="flex w-56 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
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
						<button type="submit" aria-label="Create module" className="mt-iri flex size-7 items-center justify-center rounded-md hover:bg-accent">
							<PlusIcon className="size-3.5" />
						</button>
					</form>
					{error && <p className="px-1 text-[11px] text-destructive">{error}</p>}
				</MenuShell>
			)}
		</div>
	);
}
