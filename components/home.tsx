"use client";

import { Composer, SLAB, SLAB_COLUMN } from "@/components/composer";
import { stashFirstMessagePhotos, useChatPhotos } from "@/components/photo-utils";
import { ModulePicker, useStudyModule } from "@/components/module-picker";
import { ModelControl } from "@/components/model-picker";
import { MenuShell } from "@/components/menu-shell";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDownIcon, DumbbellIcon } from "lucide-react";
import { GraphView } from "@/components/graph-view";
import { MinimalHome } from "@/components/minimal-home";
import { SetupDialog } from "@/components/setup-dialog";
import { ComposerActions, NodePickerControl } from "@/components/composer-actions";
import { useStrongKeyless, useZeroKeys, ZeroKeysPill } from "@/components/setup-cta";
import { joinDictation, useDictation } from "@/components/dictation";
import { useFieldCycle } from "@/components/field-cycle";
import { SidebarToggle } from "@/components/sidebar";
import { MAX_CHAT_IMAGES } from "@/src/core";

/** The tray's Teach / Practice button (owner, 2026-10-27): a quiet text
 *  button like its neighbours, opening a two-item menu. Practice creates a
 *  kind:"practice" session. */
function ModeSwitch({ mode, onChange }: { mode: "teach" | "practice"; onChange: (m: "teach" | "practice") => void }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		// The menu is portaled (MenuShell): inside = the trigger or the menu.
		const onDown = (e: PointerEvent) => {
			const t = e.target as Element;
			if (!ref.current?.contains(t) && !t.closest?.('[data-testid="home-mode-menu"]')) setOpen(false);
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
	return (
		<div ref={ref} className="relative" data-testid="home-mode-switch">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				title="Teach or practice"
				className="mt-quiet flex h-8 items-center gap-1.5 rounded-full px-2.5"
			>
				<span>{mode === "practice" ? "Practice" : "Teach"}</span>
				<ChevronDownIcon aria-hidden="true" className="size-2.5" strokeWidth={2} />
			</button>
			{open && (
				<MenuShell
					anchorRef={ref}
					testid="home-mode-menu"
					preferredSide="up"
					menuClass="flex w-44 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					{(["teach", "practice"] as const).map((m) => (
						<button
							key={m}
							type="button"
							data-testid={`home-mode-${m}`}
							onClick={() => {
								onChange(m);
								setOpen(false);
							}}
							className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent ${mode === m ? "bg-accent text-foreground" : "text-muted-foreground"}`}
						>
							{m === "practice" ? <DumbbellIcon aria-hidden="true" className="size-3" /> : <span className="size-3" />}
							{m === "teach" ? "Teach" : "Practice"}
						</button>
					))}
				</MenuShell>
			)}
		</div>
	);
}

/**
 * Home — the knowledge graph is the main view, full-bleed edge to edge
 * (owner, graph-view round 1): the canvas owns the whole column, running
 * under the header and the new-session dock, both of which float over it
 * with no gradient scrims. Sessions live in the toggleable sidebar.
 */
export function Home({
	initialConfigured,
	rendering = true,
}: {
	initialConfigured: boolean;
	/** GRAPH RENDERING off (owner, 2026-10-06): the home's main view is
	 * the chains view, not the canvas. Read server-side per navigation —
	 * changing the setting applies on the next visit home. */
	rendering?: boolean;
}) {
	const router = useRouter();
	const [topic, setTopic] = useState("");
	/* The topic MIRROR ("nothing gets lost" round, 2026-10-01 — same
	 * mechanics as the chat composer, owner's consistency ruling): a
	 * dictation flush lands via setState, invisible to a closure that
	 * waited through `await finish()`. Kept current at every write. */
	const topicRef = useRef("");
	// First-run gate (model-slots wave, owner 2026-09-20): chats cannot
	// start until the user has picked all three slots — no defaults for
	// 33 providers. The dock shows the CTA while unconfigured; submitting
	// a topic opens the setup dialog WITH THE DRAFT PRESERVED (Save
	// stores the slots and the queued message sends).
	const [configured, setConfigured] = useState(initialConfigured);
	// The zero-keys truth (zero-keys wave): no provider key = the pill
	// takes precedence over the models CTA (keys come first in the chain).
	const zeroKeys = useZeroKeys();
	// The strong slot's keyless truth (pre-send key guards, owner interlude
	// 2026-09-25): keys may exist generally while the STRONG slot's pinned
	// provider has none — the same skip-everything treatment on send.
	const strongKeyless = useStrongKeyless();
	const [setupOpen, setSetupOpen] = useState(false);
	// Voice dictation (STT wave, 2026-09-17): finals append at the end of the
	// topic draft; the Dictate pill lives in the slab's tray.
	const dictation = useDictation({
		// Ref-first: the join reads the mirror so the send resuming after
		// `await finish()` sees the dictated tail.
		append: (t) => {
			const v = joinDictation(topicRef.current, t);
			topicRef.current = v;
			setTopic(v);
		},
	});
	const [busy, setBusy] = useState(false);
	/* Run end focuses the topic input (owner, 2026-10-01): the hands are on
	 * the keyboard from the stop. Falling edge only; this surface's only
	 * dictation target IS this textarea, so no case-split is needed. */
	const topicInputRef = useRef<HTMLTextAreaElement>(null);
	// Tab navigates INTO the topic composer (owner, keyboard round
	// 2026-10-06): the only text field on this surface — the chain is the
	// ref itself (the shared Composer's textarea, handed inputRef).
	const cycleTopicField = useCallback(
		(): readonly HTMLElement[] => (topicInputRef.current ? [topicInputRef.current] : []),
		[],
	);
	useFieldCycle(cycleTopicField);
	const dictationWasActiveRef = useRef(false);
	useEffect(() => {
		if (dictation.active) {
			dictationWasActiveRef.current = true;
		} else if (dictationWasActiveRef.current) {
			dictationWasActiveRef.current = false;
			topicInputRef.current?.focus();
		}
	}, [dictation.active]);

	/* PRACTICE MODE (owner, 2026-10-04): the graph composer's teach |
	 *  practice switch — practice creates a kind:"practice" session and
	 *  may carry proposition picks from the chain table (the chip above
	 *  the composer opens the picker; the picks seed the opening prompt).
	 *  Not enforcing any input format — the picks are a convenience. */
	const [mode, setMode] = useState<"teach" | "practice">("teach");
	const [studyModule, setStudyModule] = useStudyModule();
	const homePhotos = useChatPhotos(MAX_CHAT_IMAGES);
	const [practiceProps, setPracticeProps] = useState<{ id: string; name: string; statement: string }[]>([]);
	const [chainSelectOpen, setChainSelectOpen] = useState(false);
	// The chain table is CONTROLLED off this id set (the lifted pick).
	const pickedIds = useMemo(() => new Set(practiceProps.map((p) => p.id)), [practiceProps]);

	/* FINISH DICTATION FIRST (owner, 2026-10-01): Enter may arrive while a
	 * run is live with the topic still deferred in the run's buffer — stop
	 * the run, let the last finals land, THEN read the REF mirror (not the
	 * state closure) and run. Applies before the setup/key guards too, so
	 * an intercepted draft is the complete one. */
	const start = () => {
		if (!dictation.active) {
			void begin();
			return;
		}
		void dictation.finish().then(() => begin());
	};
	const begin = async () => {
		const t = topicRef.current.trim();
		if ((!t && homePhotos.photos.length === 0) || busy) return;
		// Unconfigured: the send INTERCEPTS into the setup flow (the draft
		// stays in the textarea; the learner sends it after Save).
		if (!configured) {
			setSetupOpen(true);
			return;
		}
		// The pre-send KEY guards (owner interlude, no-orphan-chats): the
		// models case guards BEFORE creation; the key cases must too — a
		// refused first send would otherwise leave an orphan error-shell
		// chat in the sidebar (the 503 lands only after POST /api/chats
		// already created the record). Same skip-everything-and-open-setup
		// treatment; the server's 503 gate remains the belt for /chat/[id]
		// sessions.
		if (zeroKeys || strongKeyless) {
			setSetupOpen(true);
			return;
		}
		setBusy(true);
		try {
			// The map context (owner, 2026-10-04): picks in EITHER mode ride
			// the CREATION as graphContext — the server writes a
			// graph-context marker as message[0] (a separate custom message
			// before the learner's first user message, propositions + the
			// chains among them); the prompt stays the learner's own words.
			const res = await fetch("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: t || "Photo question",
					...(mode === "practice" ? { kind: "practice" } : {}),
					...(studyModule ? { module: studyModule } : {}),
					...(practiceProps.length > 0 ? { graphContext: { propositions: practiceProps } } : {}),
				}),
			});
			const { id } = (await res.json()) as { id: string };
			// The opening message's photos wait for the chat page (photo-utils).
			stashFirstMessagePhotos(id, homePhotos.photos);
			// No settings PUT on create (per-session models, owner
			// 2026-09-28): the SERVER stamps the newborn from the strong
			// slot — the same default this surface's model control edits.
			router.push(`/chat/${id}?prompt=${encodeURIComponent(t)}`);
		} catch {
			setBusy(false);
		}
	};

	return (
		<div className="relative h-dvh">
			{/* Window-drag strip (merged chrome, owner 2026-09-17): a dedicated
			    mask element, deliberately FIRST in the DOM. Electron's app-region
			    mask resolves by DOM order — a no-drag element subtracts only drag
			    regions that came EARLIER in the tree — not by z-index, so the
			    header's old inline drag region (after <main>) re-added itself over
			    the graph chrome row's carve-out and the buttons dragged the window.
			    Placed first, every carved control (chrome row, node detail card,
			    the toggle) comes later and subtracts correctly. Pure mask: it
			    never needs to receive events — the mask routes the pixels. */}
			<div className="mt-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />

			{/* The main view — full-bleed (owner, graph-view round 1): no
			    padding on any side; it runs from the sidebar to the right edge
			    and from the bottom to the top, under everything else. With
			    rendering OFF (graph.rendering, owner 2026-10-06) it is the
			    MINIMAL HOME — a quiet knowledge-base summary + the graph
			    chrome's survivors; data, extraction, and the pick flow are
			    untouched, and the chain table stays behind its button. */}
			<main className="absolute inset-0">
				{rendering ? (
					<GraphView
						chainSelectOpen={chainSelectOpen}
						practiceSelection={pickedIds}
						onPracticeSelectionChange={setPracticeProps}
						onChainSelectClose={() => setChainSelectOpen(false)}
					/>
				) : (
					<MinimalHome
						chainSelectOpen={chainSelectOpen}
						practiceSelection={pickedIds}
						onPracticeSelectionChange={setPracticeProps}
						onChainSelectClose={() => setChainSelectOpen(false)}
					/>
				)}
			</main>

			{/* Header floats over the graph — pointer-events-none except the
			    toggle, so the canvas stays draggable/hoverable around it. Carries
			    no app-region of its own: the strip's drag comes from the mask
			    div above, and the toggle's mt-no-drag subtracts from it (it is
			    later in the tree, so the subtraction sticks). */}
			<header className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-3 py-2">
				<div className="pointer-events-auto">
					<SidebarToggle />
				</div>
			</header>

			{/* New session — the Hot Glass slab (SPEC §7), docked OVER the graph
			    bottom-centre (no gradient: the graph runs clean under it to the
			    bottom edge). The same 820px slab column as the session's dock,
			    so nothing shifts when a session starts (owner). */}
			<div className="pointer-events-none absolute inset-x-0 bottom-0 pb-9">
				<div className={`pointer-events-auto ${SLAB_COLUMN}`}>
					{/* The pick bar (owner vision, 2026-10-04): the chain
					    table's selection is PERSISTENT — picked
					    propositions show here as a count + Clear in EITHER
					    mode (it survives mode switches; only a practice
					    send consumes it). Practice mode with nothing picked
					    shows the pick HINT so the affordance is discoverable;
					    teaching mode with nothing picked renders nothing. */}
					<ComposerActions
						picker={(practiceProps.length > 0 || mode === "practice") && (
							<NodePickerControl
								count={practiceProps.length}
								onOpen={() => setChainSelectOpen(true)}
								onClear={() => setPracticeProps([])}
							/>
						)}
						setup={zeroKeys ? (
							<ZeroKeysPill inline onOpen={() => setSetupOpen(true)} />
						) : (
							!configured && (
								<button
									type="button"
									data-testid="setup-cta"
									onClick={() => setSetupOpen(true)}
									className="mt-btn rounded-full border px-3 py-1.5 font-ui text-xs cursor-pointer"
								>
									Set up your models
								</button>
							)
						)}
					/>
					<div className={SLAB}>
						<Composer
							// "busy" is a running turn (the stop square); home has none —
							// a session being created just disables the send.
							busy={false}
							value={topic}
							onChange={(v) => {
								topicRef.current = v;
								setTopic(v);
							}}
							onSend={start}
							onStop={() => {}}
							canSend={!busy && (topic.trim().length > 0 || dictation.active || homePhotos.photos.length > 0)}
							inputRef={topicInputRef}
							autoFocus
							onEscape={dictation.active ? dictation.cancel : undefined}
							placeholder={mode === "practice" ? "What do you want to practice?" : "What do you want to learn?"}
							photos={homePhotos.photos}
							onAddPhotos={homePhotos.add}
							onRemovePhoto={homePhotos.remove}
							photoError={homePhotos.error}
							dictation={dictation}
							sendLabel="Start session"
							tray={
								<>
									<ModeSwitch mode={mode} onChange={setMode} />
									<ModulePicker value={studyModule} onChange={setStudyModule} />
									{/* No chatId: the strong slot — the new-session default
									    (fix wave: the triggers write /api/settings/models). */}
									<ModelControl />
								</>
							}
						/>
					</div>
				</div>
			</div>

			{/* First-run setup (unconfigured): the CTA's target and the send
			    interception's landing surface — stage 1 is the self-contained
			    first-key screen (zero-keys wave); Save never sends — the
			    draft stays for the learner to send (owner 2026-10-09). */}
			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					setConfigured(true);
					setSetupOpen(false);
					// Save only saves: the draft waits in the composer.
				}}
				/>
		</div>
	);
}
