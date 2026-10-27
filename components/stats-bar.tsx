"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { contextWindow, sessionCost, turnCost, type TurnUsage } from "@/src/core";
import { formatTokens, formatUsd, prettyModel } from "@/components/usage-format";
import { catalogLimits, useModelCatalog } from "@/components/model-picker";

/**
 * The session stats line (wave 4 observability; Hot Glass, owner
 * 2026-10-27): the session's money/context footprint as ONE faint mono line
 * centered under the composer slab — context window · session cost. Click
 * opens the per-turn detail popover. The model and thinking controls moved
 * into the slab's tray, and the dictation strip became the tray's Dictate
 * pill, so nothing else rides here.
 *
 * Sessions only: before the first turn (and on home and the draft) it
 * renders nothing — a "— · —" summary over an empty popover is noise.
 *
 * All folds come from core/prices.ts (sessionCost, contextWindow, turnCost)
 * — no cost math lives here. Absent data renders "—", never zero (the
 * doctrine); turns the price table can't price count as unpriced, shown in
 * the popover, never folded into a fake $0.
 */
export function SessionStats({ turns }: { turns: TurnUsage[] }) {
	const [open, setOpen] = useState(false);
	// Same dropdown discipline as the model control (owner, df4433f treatment,
	// stats round 1): close on any pointerdown outside the bar or on Escape.
	const barRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent) => {
			if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// THE ONE-ESC LAW (keyboard round 2026-10-06): claim — the
				// window chain must not also act under this popover.
				e.preventDefault();
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);
	// The live-limits join (context-meter amendment, owner 2026-09-23):
	// contextWindow's denominator resolves ONLY from pi's live catalog —
	// built client-side over the picker's cached /api/models fetch (the
	// same fetch ModelControl below rides; module-level dedupe). Catalog
	// pending or failed → undefined index → limit null → USAGE-ONLY (the
	// honest-render precedent, never a fake window); the usage-only render
	// IS the null path.
	const { catalog } = useModelCatalog();
	const limits = useMemo(() => (catalog ? catalogLimits(catalog) : undefined), [catalog]);
	const ctx = contextWindow({ turns }, limits);
	const { cost, unpriced } = sessionCost({ turns });
	// Honest cost: show dollars only when at least one turn priced;
	// otherwise "—" (never a fake $0.0000).
	const pricedCount = turns.length - unpriced;
	const costLabel = pricedCount > 0 ? formatUsd(cost) : "—";
	const lastModel = turns.at(-1)?.model;

	if (turns.length === 0) return null;
	return (
		<div
			data-testid="stats-bar"
			// pointer-events-auto: the dock wrapper is pointer-events-none (so its
			// transparent gradient never blocks scrolling) — this line must
			// re-enable events or the summary button is dead.
			className="pointer-events-auto relative flex justify-center pt-2 font-mono text-[10.5px] tracking-[0.06em] text-muted-foreground/70"
		>
			{/* The summary button + its popover, centered over the button. */}
			<div ref={barRef} className="relative">
				{/* No tooltip — the numbers describe themselves and the popover
			    speaks on click (owner, subtlety round 2026-09-25). */}
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				data-testid="stats-summary"
				className="flex items-center gap-1.5 tabular-nums transition-colors hover:text-foreground"
			>
				<span data-testid="stats-context">
					{ctx ? (ctx.limit !== null ? `${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.limit)}` : formatTokens(ctx.usedTokens)) : "—"}
				</span>
				<span aria-hidden>·</span>
				<span data-testid="stats-cost">{costLabel}</span>
			</button>
				{open && (
					<div
						data-testid="stats-detail"
						className="absolute bottom-full left-1/2 z-40 mb-1.5 w-72 -translate-x-1/2 rounded-xl border bg-card p-3 font-ui text-xs tracking-normal shadow-xl"
					>
						<div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Session stats
						</div>
						<div className="flex flex-col gap-1 text-muted-foreground">
							<div className="flex justify-between gap-2">
								<span>Context (last call)</span>
								<span className="tabular-nums text-card-foreground">
									{ctx ? (ctx.limit !== null ? `${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.limit)}` : formatTokens(ctx.usedTokens)) : "—"}
								</span>
							</div>
							<div className="flex justify-between gap-2">
								<span>Total cost</span>
								<span className="tabular-nums text-card-foreground">{costLabel}</span>
							</div>
							{unpriced > 0 && (
								<div className="flex justify-between gap-2">
									<span>Unpriced turns</span>
									<span className="tabular-nums text-card-foreground">{unpriced}</span>
								</div>
							)}
						</div>
						{turns.length > 0 && (
							<>
								<div className="mb-1 mt-2.5 border-t pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
									Turns
								</div>
								<ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
									{turns.map((turn, i) => {
										const c = turnCost(turn);
										return (
											<li key={`${turn.messageId}-${i}`} className="flex items-center justify-between gap-2">
												<span className="truncate text-muted-foreground">
													#{i + 1} · {prettyModel(turn.model, true)}
												</span>
												<span className="flex shrink-0 items-center gap-2 tabular-nums text-card-foreground">
													<span className="text-muted-foreground">{turn.steps.length} steps</span>
													<span>{c === null ? "—" : formatUsd(c)}</span>
												</span>
											</li>
										);
									})}
								</ul>
							</>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
