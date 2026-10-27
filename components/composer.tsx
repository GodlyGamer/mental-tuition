"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRightIcon, CornerDownLeftIcon, ImageIcon, PlusIcon, SquareIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/hint";
import type { ChatPhoto } from "@/components/photo-utils";

/**
 * The chat composer — content row ONLY (the persistent rounded shell lives in
 * the chat view's overlay, so the shell can later morph chat → question
 * without remounting).
 *
 * Corner-radius math (concentric with the shell): shell rounded-2xl (16px) −
 * row padding p-1.5 (6px) = button rounded-[10px] = 25% of the 40px button.
 */
/** What one Enter press does, in precedence order: stop a busy stream,
 *  otherwise send the message, otherwise — practice sessions only — fire
 *  the next-problem signal while the between-problems pause is live
 *  (owner round 16: Enter on an EMPTY composer is the go-ahead; typing
 *  anything makes Enter a send again). Pure so the static-render harness
 *  can pin the decision (key events can't be simulated in
 *  renderToStaticMarkup). */
export function enterAction(state: {
	busy: boolean;
	canSend: boolean;
	/** The between-problems pause is live: practice session, nothing
	 *  active, no turn/compaction in flight (the caller's fold). */
	nextProblem?: boolean;
}): "stop" | "send" | "next" | "none" {
	// Composer steering (owner arc 2026-10-03): while a turn runs, typed
	// text makes Enter a STEER (the queue-and-redirect send); Enter with
	// an empty composer stays the stop shortcut. The button itself keeps
	// the square — Stop stays one click away at all times.
	if (state.busy) return state.canSend ? "send" : "stop";
	if (state.canSend) return "send";
	if (state.nextProblem) return "next";
	return "none";
}

export function Composer({
	busy,
	value,
	onChange,
	onSend,
	onStop,
	canSend,
	autoFocus,
	inputRef,
	onEscape,
	placeholder = "Ask, answer, or steer the lesson…",
	nextProblem = false,
	onNext,
	photos,
	onAddPhotos,
	onRemovePhoto,
	photoError,
}: {
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
	autoFocus?: boolean;
	/** The page's handle to the textarea — the dictation-end focus (owner,
	 *  2026-10-01): a run ending hands the cursor to the bare composer. */
	inputRef?: React.RefObject<HTMLTextAreaElement | null>;
	/** Escape while a dictation runs stops it (STT wave, 2026-09-17). No-op
	 *  when absent — Esc otherwise means nothing in the composer. */
	onEscape?: () => void;
	/** The textarea's placeholder (owner refinement round, 2026-09-24):
	 *  active sessions read "Ask, answer, or steer the lesson…"; the fresh
	 *  new-session page asks the graph view's opening question instead. */
	placeholder?: string;
	/** The practice pause is live (owner round 16): Enter on the empty
	 *  composer fires the next-problem signal instead of doing nothing —
	 *  the keyboard-first move-on. */
	nextProblem?: boolean;
	/** The signal's dispatcher (send({type:"next"})) — the chip and the
	 *  empty-Enter share it. */
	onNext?: () => void;
	/** Attached photos (personal fork, 2026-10-24) — the + button, paste
	 *  and drop add them; absent onAddPhotos = no + button (draft views). */
	photos?: readonly ChatPhoto[];
	onAddPhotos?: (files: File[]) => void;
	onRemovePhoto?: (id: string) => void;
	/** Why the last photo couldn't be attached (e.g. a format the browser
	 *  can't decode, such as HEIC). */
	photoError?: string | null;
}) {
	const act = () => {
		const action = enterAction({ busy, canSend, nextProblem });
		if (action === "stop") onStop();
		else if (action === "send") onSend();
		else if (action === "next") onNext?.();
	};
	const [dragging, setDragging] = useState(false);
	const imageFiles = (list: FileList | null | undefined) => Array.from(list ?? []).filter((f) => f.type.startsWith("image/"));
	return (
		<form
			data-testid="composer"
			className={cn("flex flex-col p-1.5", dragging && "rounded-2xl ring-2 ring-ring/60")}
			onSubmit={(e) => {
				e.preventDefault();
				act();
			}}
			onDragOver={(e) => {
				if (!onAddPhotos || !Array.from(e.dataTransfer.items).some((i) => i.type.startsWith("image/"))) return;
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={(e) => {
				setDragging(false);
				const files = imageFiles(e.dataTransfer.files);
				if (!onAddPhotos || files.length === 0) return;
				e.preventDefault();
				onAddPhotos(files);
			}}
		>
			{photos && photos.length > 0 && <PhotoStrip photos={photos} onRemove={onRemovePhoto} testid="composer-photos" />}
			{photoError && (
				<p className="px-2 pb-1 text-xs text-destructive" data-testid="composer-photo-error">
					Couldn&apos;t attach that photo ({photoError}). Try a JPEG or PNG.
				</p>
			)}
			<div className="flex items-end gap-1.5">
			{onAddPhotos && <PlusMenu onAddPhotos={onAddPhotos} />}
			<textarea
				ref={inputRef}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					// Esc ends dictation before anything else Esc might someday mean
					// here (the dictate decisions: click-again or Esc to stop).
					// stopPropagation claims the Esc (keyboard wave A): the
					// window-level chain must not also abort a turn under us.
					if (e.key === "Escape" && onEscape) {
						e.preventDefault();
						e.stopPropagation();
						onEscape();
						return;
					}
					// Chat convention: Enter sends, Shift+Enter is a newline.
					// ⌘/Ctrl+Enter also sends — the universal submit shortcut
					// across every input in the app (thinking field, answers).
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
						e.preventDefault();
						act();
					}
				}}
				onPaste={(e) => {
					// A pasted screenshot attaches; pasted text stays text.
					const files = imageFiles(e.clipboardData.files);
					if (!onAddPhotos || files.length === 0) return;
					e.preventDefault();
					onAddPhotos(files);
				}}
				placeholder={placeholder}
				autoFocus={autoFocus}
				rows={1}
				className="field-sizing-content mt-input max-h-48 min-h-10 flex-1 resize-none bg-transparent px-2.5 py-2 outline-none placeholder:text-muted-foreground"
			/>
			{/* The button follows the text (owner report 2026-10-03): while
				 a turn runs WITH text typed it stays the SEND affordance
				 (click = steer — steering must be clickable, not Enter-only);
				 only an empty composer morphs it to Stop. ESC keeps its
				 confirm-popup abort in every state, so stop is never
				 unreachable. No tooltip — the ↵ glyph is the affordance
				 (owner, subtlety round 2026-09-25).

				 THE NEXT MORPH (owner round 16 refinement, 2026-10-06): an
				 empty composer in the practice pause morphs the button into
				 a wide green NEXT PROBLEM — the affordance IS the button
				 (click and Enter share one lane), and typing anything
				 returns the regular send. The green is the app's correct-
				 answer register (answered-card's green-500/600). */}
				{nextProblem && !busy && !canSend ? (
					<button
						type="submit"
						data-testid="next-problem-button"
						aria-label="Next problem"
						className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-[10px] bg-green-600 px-4 font-ui text-xs font-medium uppercase tracking-wide text-white transition-colors hover:bg-green-500"
					>
						Next problem
						<ArrowRightIcon className="size-4" />
					</button>
				) : (
					<button
						type="submit"
						aria-label={busy && !canSend ? "Stop" : "Send"}
						disabled={!busy && !canSend}
						className={cn(
							"flex size-10 shrink-0 items-center justify-center rounded-[10px] transition-colors",
							busy && !canSend
								? "bg-secondary text-foreground hover:bg-accent"
								: "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40",
						)}
					>
						{busy && !canSend ? <SquareIcon className="size-4" /> : <CornerDownLeftIcon className="size-5" />}
					</button>
				)}
			</div>
		</form>
	);
}

/** Attached-photo thumbnails with a hover remove control (the composer
 *  and the question dock share it). */
export function PhotoStrip({
	photos,
	onRemove,
	testid,
}: {
	photos: readonly ChatPhoto[];
	onRemove?: (id: string) => void;
	testid?: string;
}) {
	return (
		<div className="flex flex-wrap gap-2 px-1 pb-1.5 pt-1" data-testid={testid}>
			{photos.map((p) => (
				<div key={p.id} className="group relative size-16 overflow-hidden rounded-xl border">
					{/* eslint-disable-next-line @next/next/no-img-element -- a local data URL preview */}
					<img src={p.previewUrl} alt="Attached photo" className="size-full object-cover" />
					<button
						type="button"
						aria-label="Remove photo"
						onClick={() => onRemove?.(p.id)}
						className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-background/85 text-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
					>
						<XIcon className="size-3" />
					</button>
				</div>
			))}
		</div>
	);
}

/** The + button (Claude-style): a round ghost button left of the text
 *  field; its menu opens upward with "Add photos". The file picker takes
 *  several at once; paste and drag-and-drop work without the menu.
 *  `size` "sm" fits the question dock's footer row. */
export function PlusMenu({ onAddPhotos, size = "md" }: { onAddPhotos: (files: File[]) => void; size?: "md" | "sm" }) {
	const [open, setOpen] = useState(false);
	/* The menu renders in a portal at the page root, fixed above the
	 * button: the composer shells clip their overflow (the dock's height
	 * morph needs overflow-hidden), so an in-place popover was cut off and
	 * the + seemed to open nothing. */
	const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!open) return;
		const place = () => {
			const r = buttonRef.current?.getBoundingClientRect();
			if (r) setAnchor({ left: r.left, bottom: window.innerHeight - r.top + 8 });
		};
		place();
		const close = (e: PointerEvent) => {
			const t = e.target as Node;
			if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
		};
		const esc = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", esc, true);
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", esc, true);
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);
	return (
		<div ref={ref} className="relative shrink-0">
			<input
				ref={input}
				type="file"
				accept="image/*"
				multiple
				hidden
				data-testid="composer-photo-input"
				onChange={(e) => {
					const files = Array.from(e.target.files ?? []);
					e.target.value = "";
					if (files.length) onAddPhotos(files);
				}}
			/>
			<Hint label="Add photos" side="top">
				<button
					ref={buttonRef}
					type="button"
					aria-label="Add photos and more"
					aria-expanded={open}
					data-testid="composer-plus"
					onClick={() => setOpen((o) => !o)}
					className={cn(
						"flex items-center justify-center rounded-full border border-border/70 text-muted-foreground transition-all hover:bg-accent hover:text-foreground",
						size === "sm" ? "size-8" : "size-10",
						open && "bg-accent text-foreground",
					)}
				>
					<PlusIcon className={cn("transition-transform duration-200", size === "sm" ? "size-4" : "size-5", open && "rotate-45")} />
				</button>
			</Hint>
			{open &&
				anchor &&
				createPortal(
				<div
					ref={menuRef}
					role="menu"
					data-testid="composer-plus-menu"
					style={{ left: anchor.left, bottom: anchor.bottom }}
					className="fixed z-[60] flex w-56 flex-col gap-0.5 rounded-xl border bg-card p-1.5 text-sm shadow-xl"
				>
					<button
						type="button"
						role="menuitem"
						data-testid="composer-add-photos"
						onClick={() => {
							setOpen(false);
							input.current?.click();
						}}
						className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-accent"
					>
						<ImageIcon className="size-4 text-muted-foreground" />
						<span className="flex flex-col">
							<span>Add photos</span>
							<span className="text-[11px] text-muted-foreground">Or paste / drop them in</span>
						</span>
					</button>
				</div>,
				document.body,
			)}
		</div>
	);
}
