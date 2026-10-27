"use client";

import type { ReactNode } from "react";
import { DumbbellIcon } from "lucide-react";

/** Home and the draft share one wrapping action row. Picker controls lead;
 * setup is centered only when it is the sole action. */
export function ComposerActions({ picker, setup }: { picker?: ReactNode; setup?: ReactNode }) {
	if (!picker && !setup) return null;
	return (
		<div
			data-testid="composer-actions"
			className={`pointer-events-auto mb-2 flex flex-wrap items-center gap-2 ${picker ? "justify-start" : "justify-center"}`}
		>
			{picker}
			{setup}
		</div>
	);
}

/** Count and Clear stay together if the setup action wraps onto another line.
 * These are node counts, even when a whole chain supplied the selection. */
export function NodePickerControl({ count, onOpen, onClear }: {
	count: number;
	onOpen?: () => void;
	onClear?: () => void;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="practice-props-chip"
				onClick={onOpen}
				// Glass chips above the slab (Hot Glass, owner 2026-10-27): picked
				// is the glass chip; the empty "Pick nodes" invitation stays
				// dashed and quiet, with the rim.
				className={
					"flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 font-ui text-xs " +
					(count > 0
						? "mt-btn border"
						: "mt-iri border border-dashed border-border/80 bg-transparent text-muted-foreground transition-colors hover:text-foreground")
				}
			>
				<DumbbellIcon aria-hidden="true" className="size-3.5" />
				{count > 0 ? `${count} ${count === 1 ? "node" : "nodes"} selected` : "Pick nodes"}
			</button>
			{count > 0 && (
				<button
					type="button"
					data-testid="practice-props-clear"
					onClick={onClear}
					className="mt-iri h-8 cursor-pointer rounded-full px-3 font-ui text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Clear
				</button>
			)}
		</div>
	);
}
