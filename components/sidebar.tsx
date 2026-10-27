"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MenuShell } from "@/components/menu-shell";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { groupByModule, groupByTime, type ChatDeleteMode } from "@/src/core";
import { ChevronDownIcon, DumbbellIcon, FileTextIcon, LibraryIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, PlusIcon, SearchIcon, SettingsIcon, WaypointsIcon } from "lucide-react";
import { useSidebarPrefs } from "@/components/sidebar-prefs";
import { ActivitySection } from "@/components/activity-dock";
import { CoverageMenuBlock } from "@/components/extraction-coverage";
import { MtMark } from "@/components/mt-mark";
import { BrailleSpinner } from "@/components/braille-spinner";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { SettingsDialogProvider, useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { Hint } from "@/components/ui/hint";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fuzzyScore } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ChatListItem } from "@/src/core";
import { kbdEventForAction } from "@/src/core";

/**
 * Toggleable sidebar — NOT a modal drawer: no backdrop, no focus theft. It
 * sits inline next to the content and can stay open while working in a
 * session. Open state persists across pages (provider lives in the root
 * layout) and across reloads (localStorage).
 */

const STORAGE_KEY = "mt:sidebar-open";

/*
 * Narrow-window behavior (owner, 2026-09-17): below SIDEBAR_AUTOCLOSE the
 * sidebar would squeeze the page below the 640px window floor (the two
 * numbers compose: 640 + 288 sidebar = 928), so it auto-closes — and
 * auto-RESTORES when the window widens again (owner choice: the sidebar
 * pops back, not a manual re-open). The whole behavior is one expression:
 * rendered = pref && !narrow, where pref is the persisted user choice.
 * Manual closes persist and stay closed; auto-close does not touch the
 * preference. Opening the sidebar while narrow asks the Electron shell to
 * widen the window to the threshold (window.mt.expandWindow, IPC in
 * electron/main.cjs) — the resize listener flips `narrow` and the sidebar
 * appears. In the plain browser there is no window to widen and no
 * suppression — a narrow tab opens the sidebar if the user says so.
 *
 * Mirrors SIDEBAR_AUTOCLOSE in electron/main.cjs — keep in sync.
 */
const SIDEBAR_AUTOCLOSE = 928;

// Module scope, guarded for SSR (the server has no navigator).
const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

declare global {
	interface Window {
		/** Preload bridge (electron/preload.cjs) — Electron only, absent in the browser. */
		mt?: {
			/** Read-only host OS; determines the native-control gutter. */
			platform?: string;
			expandWindow: () => void;
			/** Tells the shell the theme so native window controls stay legible. */
			setTheme?: (mode: string) => void;
			/** The zoom truth (owner round 7): subscribes to "mt:zoom" pushes; returns unsubscribe. */
			onZoom?: (cb: (factor: number) => void) => () => void;
			getZoom?: () => Promise<number>;
			/** Auto-update channel (Wave C, 2026-10-10): "mt:update-status" pushes once a staged update exists. */
			onUpdateStatus?: (cb: (status: { status: string; version: string | null }) => void) => () => void;
			installUpdate?: () => void;
			/** The synced workspace folder (personal fork): pick another; the shell
			 *  restarts the server on it and reloads. Resolves false if cancelled. */
			changeWorkspace?: () => Promise<boolean>;
		};
	}
}

const SidebarContext = createContext<{ open: boolean; toggle: () => void }>({
	open: false,
	toggle: () => {},
});

export function useSidebar() {
	return useContext(SidebarContext);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
	// Start closed so server and client first-render agree (no hydration
	// mismatch); the stored value is applied after mount.
	const [open, setOpen] = useState(false);
	const [narrow, setNarrow] = useState(false);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		// Electron shell detection (merged chrome, 2026-09-17): keys the
		// .mt-electron CSS (app/globals.css) that turns the header bands
		// into the window's drag surface. Post-mount only — server HTML
		// and first client render must agree (no hydration mismatch),
		// and in the plain browser the class never appears.
		if (IS_ELECTRON) {
			document.documentElement.classList.add("mt-electron");
			document.documentElement.dataset.mtPlatform = window.mt?.platform ?? "";
		}

		// THE ZOOM TRUTH (owner round 7, 2026-10-05): ⌘±/⌘0 zoom the UI
		// (Electron zoomFactor) while the native traffic lights stay
		// physical-fixed — the CSS gutter lengths divide by this factor so
		// their RENDERED size never moves. getZoom covers the first-paint
		// race; every later change arrives as an mt:zoom push.
		const setZoomVar = (factor: number) =>
			document.documentElement.style.setProperty("--mt-zoom", String(factor));
		const off = window.mt?.onZoom?.(setZoomVar);
		void window.mt?.getZoom?.().then(setZoomVar);

		const stored = localStorage.getItem(STORAGE_KEY);
		// Default: open (first run introduces the sidebar).
		setOpen(stored === null ? true : stored === "1");
		setMounted(true);
		return () => off?.();
	}, []);

	// Narrow-window auto-close/auto-restore (see SIDEBAR_AUTOCLOSE note):
	// fires only on actual resizes — a boolean compare, no layout work.
	// Both this and the mount effect land before the first paint, so a
	// narrow window never flashes the open sidebar on load.
	useEffect(() => {
		if (!IS_ELECTRON) return; // plain-browser tabs open freely
		const onResize = () => setNarrow(window.innerWidth < SIDEBAR_AUTOCLOSE);
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const toggle = useCallback(() => {
		// Opening while narrow (auto-closed, or the user's own closed-at-
		// narrow): ask the shell to widen to the threshold — the resize
		// listener flips `narrow` and the sidebar appears. The preference
		// persists like any other open, so a restart at a narrow width
		// still auto-restores when widened.
		if (narrow && !open) {
			localStorage.setItem(STORAGE_KEY, "0");
			setOpen(true);
			window.mt?.expandWindow();
			return;
		}
		setOpen((v) => {
			localStorage.setItem(STORAGE_KEY, v ? "0" : "1");
			return !v;
		});
	}, [narrow, open]);

	// ⌘B: the global shortcut dispatches kbdEventForAction("toggle-sidebar")
	// and the context answers on exactly that name — the shared spelling
	// is the fix for the interlude bug (the listener sat on the pre-
	// convention name "mt:toggle-sidebar" while the dispatcher sent
	// "mt:kbd-toggle-sidebar", so ⌘B silently did nothing; owner
	// 2026-09-25).
	useEffect(() => {
		const event = kbdEventForAction("toggle-sidebar");
		const onToggle = () => toggle();
		window.addEventListener(event, onToggle);
		return () => window.removeEventListener(event, onToggle);
	}, [toggle]);

	return (
		<SidebarContext.Provider value={{ open: open && !narrow, toggle }}>
			{/* transitions gated on mount: no slide-in flash on page load */}
			<div className={cn("flex h-dvh", mounted && "[&_.sidebar-motion]:transition-[width,margin,opacity]")}>{children}</div>
		</SidebarContext.Provider>
	);
}

/** Hamburger for page headers — only visible when the sidebar is closed.
 *
 *  Owner, round 6c: the toggle is ALWAYS MOUNTED, owning a slot whose
 *  width+margin animate in LOCKSTEP with the sidebar's own width
 *  transition (same duration-200, same easing, both gated on mount) —
 *  before, it mounted/unmounted in one frame, so its 48px footprint
 *  (button + gap) popped and dragged the title and chips sideways while
 *  the sidebar was still mid-slide. When open the slot is exactly zero
 *  (w-0 -mr-3: width 0, the negative margin cancels the header's gap-3),
 *  so resting layouts are pixel-identical to the old conditional render.
 *  The icon fades with the slot and is clipped by it as it collapses —
 *  no popping in either direction. */
export function SidebarToggle() {
	const { open, toggle } = useSidebar();
	return (
		<span
			className={cn(
				"sidebar-motion mt-no-drag relative flex h-9 shrink-0 overflow-hidden duration-200",
				open ? "w-0 -mr-3" : "w-9 mr-0 mt-closed-toggle",
			)}
		>
			<Hint label="Open sidebar" action="toggle-sidebar">
			<Button
				variant="ghost"
				size="icon"
				aria-label="Open sidebar"
				aria-hidden={open}
				tabIndex={open ? -1 : 0}
				onClick={toggle}
				className={cn("sidebar-motion duration-200", open ? "pointer-events-none opacity-0" : "opacity-100")}
			>
				{/* Owner, round 6: size-4, SAME as the close glyph — the toggle
				    must not grow when the sidebar is closed (it did: size-5 here).
				    The small look is the standard, both directions. */}
				<PanelLeftOpenIcon className="size-4" />
			</Button>
			</Hint>
		</span>
	);
}

/**
 * The row's status indicator (owner, minimal-color round): the braille
 * spinner, ONLY while a teach turn is in flight — monochrome motion, the
 * terminal's own glyph, existing exactly as long as the work does and
 * vanishing the moment it ends. Every other state renders NOTHING:
 * phases only advance (all sessions end in Teaching — phase-as-signal was
 * decoration, now retired app-wide), and question-pending is the dominant
 * RESTING state of real sessions — a resting state has no scan value, so
 * the meta line's "Waiting for input" text carries it. Idle is the
 * absence of a signal, by design.
 */
function SessionStatus({ busy }: { busy: boolean }) {
	if (!busy) return null;
	return <BrailleSpinner />;
}

/** Compact "how long ago": "just now", "5m ago", "3h ago", "2d ago",
 *  then a plain date. How long a session has been WAITING matters more
 *  than an absolute timestamp. Beyond a week the date renders ISO
 *  (YYYY-MM-DD, zero-padded) — the international standard: unambiguous
 *  in any locale and it sorts (owner, typography round 5; the old
 *  M/D/YYYY was the US convention. A user-locale setting can come later
 *  — trivial, a format function swap). Pure — exported for tests. */
export function timeAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}

/** A question or a posed problem is waiting on the learner. */
function waitingForYou(chat: ChatListItem): boolean {
	return chat.pendingQuestion || ((chat.kind ?? "teach") === "practice" && chat.pendingProblem);
}

/** The row's second line (Hot Glass, SPEC §8): the state when a state
 *  exists (compacting / waiting for you / working), otherwise the kind and
 *  how long ago — "Teach · 2d". The message count stays dropped (owner,
 *  typography round 5). */
function sessionMeta(chat: ChatListItem): string {
	if (chat.compacting) return `Compacting context · ${timeAgo(chat.updatedAt)}`;
	if (waitingForYou(chat)) return `Waiting for you · ${timeAgo(chat.updatedAt)}`;
	if (chat.busy) return "Working…";
	return `${(chat.kind ?? "teach") === "practice" ? "Practice" : "Teach"} · ${timeAgo(chat.updatedAt)}`;
}

/**
 * One session row: the status spinner (only while working), then title +
 * state-aware meta — a softly pulsing dot while the session waits on the
 * learner, a small dumbbell on practice rows — and a "…" options button
 * that appears on hover. Exported for render tests — pure function of the
 * list item.
 */
export function SessionRow({
	chat,
	active,
	onOpen,
	kbdSelected = false,
	onContextMenu,
	onMore,
}: {
	chat: ChatListItem;
	active: boolean;
	onOpen: () => void;
	/** Keyboard-walk highlight (the search owns the walk) — visually
	 *  distinct from the active session, which stays filled. */
	kbdSelected?: boolean;
	/** Right-click opens the context menu (wave 6: Rename / Delete). */
	onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
	/** The hover "…" opens the same menu, anchored to itself. */
	onMore?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	const practice = (chat.kind ?? "teach") === "practice";
	const waiting = waitingForYou(chat) && !chat.compacting;
	return (
		<div className="group/row relative mb-0.5">
			<button
				type="button"
				onClick={onOpen}
				onContextMenu={onContextMenu}
				data-session-row
				data-testid={kbdSelected ? "session-row-kbd" : "session-row"}
				className={cn(
					"relative flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-[var(--mt-quiet-hover-bg)]",
					active && "bg-accent",
					kbdSelected && !active && "bg-accent/60 ring-1 ring-border",
				)}
			>
				<SessionStatus busy={chat.busy || chat.compacting} />
				<span className="min-w-0 flex-1">
					{/* Titles are the learner's/teacher's WORDS — Geist at 13.5px; the
					    meta line below is the quiet machine data. */}
					<span className="block truncate font-ui text-[13.5px] font-normal tracking-[-0.005em] text-foreground/90">{chat.title}</span>
					<span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
						{waiting && <span className="mt-wait size-1.5 shrink-0 rounded-full bg-foreground" aria-hidden="true" />}
						{practice && !waiting && <DumbbellIcon className="size-3 shrink-0" strokeWidth={1.5} aria-label="Practice session" />}
						<span className="truncate">{sessionMeta(chat)}</span>
					</span>
				</span>
			</button>
			{onMore && (
				<button
					type="button"
					aria-label="Session options"
					data-testid="session-more"
					onClick={onMore}
					className="mt-iri absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
				>
					…
				</button>
			)}
		</div>
	);
}

/** The inline-rename row (wave 6): same geometry as SessionRow, but the
 *  title line becomes a text input — select-all on entry (the click means
 *  "replace", the header rename's rule), Enter/blur commits, Esc discards.
 *  The meta line stays so the row never changes height mid-edit. */
export function RenameRow({ chat, onCommit, onCancel }: { chat: ChatListItem; onCommit: (next: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(chat.title);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	return (
		<div
			data-testid="session-rename-row"
			className="relative mb-0.5 flex w-full items-center rounded-lg bg-accent px-3 py-2"
		>
			{/* NOTHING MOVES (owner, polish round): an idle row renders no
			    status spacer (SessionStatus is null when not busy), so the
			    title starts at the row's own px-3 — 12px in. The old rename
			    row always carried a 14px spacer + gap + the input's border
			    and padding, landing the text ~41px in (and the meta with
			    it). The input here is borderless and padding-free at the
			    exact title x; the underline is the only editing cue. */}
			<span className="flex min-w-0 w-full flex-col">
				<input
					ref={inputRef}
					value={draft}
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => onCommit(draft)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							e.stopPropagation(); // discard, not also the sidebar/chat chains
							onCancel();
						}
					}}
					aria-label="Rename session"
					data-testid="session-rename-input"
					className="mt-input w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-foreground outline-none"
				/>
				<span className="block truncate text-xs text-muted-foreground">{sessionMeta(chat)}</span>
			</span>
		</div>
	);
}

/** The three-way kind filter (practice sessions, owner 2026-10-04):
 *  Teaching / All / Practice — a client-side filter over the same
 *  snapshot, persisted in localStorage, defaulting to All. */
export type SessionKindFilter = "teach" | "all" | "practice";

/** A nav row (Hot Glass, SPEC §8): the active page is a small glass pill,
 *  hover is a faint fill. */
function NavRow({
	testid,
	icon,
	label,
	active = false,
	onClick,
}: {
	testid: string;
	icon: React.ReactNode;
	label: string;
	active?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			data-testid={testid}
			onClick={onClick}
			aria-current={active ? "page" : undefined}
			className={cn(
				"flex h-9 w-full items-center gap-2.5 rounded-full px-3 text-[13.5px]",
				active ? "mt-btn text-foreground" : "text-muted-foreground transition-colors hover:bg-[var(--mt-quiet-hover-bg)] hover:text-foreground",
			)}
		>
			{icon}
			{label}
		</button>
	);
}

const GROUP_LABEL = "font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60";
/** "No module" folds under this key (an empty string can't be stored). */
const NO_MODULE_KEY = "__none__";

function SessionsSidebar() {
	const { open, toggle } = useSidebar();
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const [query, setQuery] = useState("");
	// Grouping, filter and folded modules sync through the settings file
	// (sidebar-prefs.ts). Module names come from /api/study.
	const { prefs, setGrouping, setKindFilter: setFilter, toggleModuleCollapsed } = useSidebarPrefs();
	const kindFilter = prefs.kindFilter;
	const [moduleNames, setModuleNames] = useState<Record<string, string | null>>({});
	// The shortcut hints read the platform after mount (SSR can't know it).
	const [mod, setMod] = useState("Ctrl ");
	useEffect(() => {
		if (/Mac/i.test(navigator.platform)) setMod("⌘");
	}, []);
	const pathname = usePathname();
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();

	/* New session (owner, 2026-09-13): NO POST — the button opens the
	   sessionless draft view; the session is created only when the first
	   message is sent (and that message becomes its title). Search: a
	   client-side filter over the poll snapshot — no server round trip. */
	const newSession = useCallback(() => {
		router.push("/chat/new");
	}, [router]);

	/* FUZZY (owner round 8, 2026-10-05): subsequence match ranked by
	 * fuzzyScore — prefix beats word-boundary beats scattered. While a query
	 * is typed the list is the flat ranked result; otherwise it is grouped
	 * (TIME or MODULE). `shown` is the rows in DISPLAY order — what the
	 * keyboard walk steps through (a folded module group is skipped). */
	const filtered = useMemo(() => {
		if (chats && kindFilter !== "all") return chats.filter((c) => (c.kind ?? "teach") === kindFilter);
		return chats;
	}, [chats, kindFilter]);
	const searching = query.trim().length > 0;
	const searchResults = useMemo(() => {
		const q = query.trim();
		if (!filtered || !q) return null;
		return filtered
			.map((c) => ({ c, score: fuzzyScore(q, c.title) }))
			.filter((r): r is { c: ChatListItem; score: number } => r.score !== null)
			.sort((a, b) => b.score - a.score)
			.map((r) => r.c);
	}, [filtered, query]);
	const groups = useMemo(() => {
		if (!filtered || searching) return null;
		return prefs.grouping === "module" ? groupByModule(filtered, moduleNames) : groupByTime(filtered);
	}, [filtered, searching, prefs.grouping, moduleNames]);
	const isCollapsed = useCallback(
		(key: string) => prefs.grouping === "module" && prefs.collapsedModules.includes(key || NO_MODULE_KEY),
		[prefs.grouping, prefs.collapsedModules],
	);
	const shown = useMemo<ChatListItem[] | null>(() => {
		if (!filtered) return null;
		if (searchResults) return searchResults;
		return (groups ?? []).flatMap((g) => (isCollapsed(g.key) ? [] : g.items));
	}, [filtered, searchResults, groups, isCollapsed]);
	const shownIndex = useMemo(() => new Map((shown ?? []).map((c, i) => [c.id, i])), [shown]);

	const refreshInFlightRef = useRef(false);
	const refresh = useCallback(async () => {
		// In-flight coalesce (S6): event bursts may land several refresh
		// calls at once — one fetch serves them all; anything newer arrives
		// with the next event's fetch.
		if (refreshInFlightRef.current) return;
		refreshInFlightRef.current = true;
		try {
			const res = await fetch("/api/chats", { cache: "no-store" });
			const d = (await res.json()) as { chats: ChatListItem[] };
			setChats(d.chats);
		} catch {
			// a transient failure keeps the last snapshot
			setChats((prev) => prev ?? []);
		} finally {
			refreshInFlightRef.current = false;
		}
	}, []);

	/* Instant rename propagation (2026-09-17): the chat header's rename
	   commits dispatch mt:chat-renamed; patch the snapshot in place instead
	   of waiting for the 2.5s poll. */
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, title } : c)) : prev));
		};
		window.addEventListener("mt:chat-renamed", onRenamed);
		return () => window.removeEventListener("mt:chat-renamed", onRenamed);
	}, []);

	/* INSTANT TURN-STATE (owner, sidebar round 2026-10-02): the open
	   session broadcasts mt:turn-state the instant its turn starts
	   (submitted — the optimistic machine's own flip) and at settle —
	   busy mirrors the server's own definition (isTurnRunning), so the
	   patch is exact: spinner up the moment the action happens, cleared
	   and refetched once at settle (title/order move with turns). The
	   events channel is the backstop for everything only the server
	   knows: other windows, wake turns in unopened sessions. A start on
	   a chat not yet in the snapshot (a brand-new session) = one
	   immediate refresh instead of a patch. */
	const chatsRef = useRef(chats);
	chatsRef.current = chats;
	useEffect(() => {
		const onTurnState = (e: Event) => {
			const { id, running } = (e as CustomEvent<{ id: string; running: boolean }>).detail;
			if (running) {
				if (chatsRef.current?.some((c) => c.id === id)) {
					setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: true } : c)) : prev));
				} else {
					void refresh(); // the brand-new session: it isn't in the snapshot yet
				}
				return;
			}
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: false } : c)) : prev));
			void refresh(); // settle: the server snapshot is now truthful — land it now
		};
		window.addEventListener("mt:turn-state", onTurnState);
		return () => window.removeEventListener("mt:turn-state", onTurnState);
	}, [refresh]);

	/* PUSH (architecture S6, 2026-10-02): the 2.5s poll is RETIRED — the
	   last standing network poll in the app. List truth arrives as
	   events: chats-changed (create/rename/delete — the list-SHAPE
	   writes), and turn-started/turn-settled for EVERY chat (unfiltered:
	   any chat's turn flips busy/order/phase in this list). Announced
	   fetches ride the 250ms trailing debounce (the S4/S5 law); resync
	   (reconnect / dev-restart) is immediate. mt:turn-state +
	   mt:chat-renamed stay for same-tab INSTANTS — local beats any
	   round-trip. */
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	const eventDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const scheduleEventRefresh = () => {
		if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		eventDebounceRef.current = setTimeout(() => {
			eventDebounceRef.current = undefined;
			void refreshRef.current();
		}, 250);
	};
	useServerEvent("chats-changed", scheduleEventRefresh);
	useServerEvent("turn-started", scheduleEventRefresh);
	useServerEvent("turn-settled", scheduleEventRefresh);
	useServerEvent("compaction-changed", scheduleEventRefresh);
	useServerResync(() => void refreshRef.current());
	useEffect(
		() => () => {
			if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		},
		[],
	);

	/* ── Keyboard seams (shortcut wave A, 2026-09-17; search-walk round
	   2026-10-10) ── ⌘⇧F focuses the search field — and THE SEARCH OWNS THE
	   WALK: ↑/↓ cycle the filtered list (wrap — "cycle"), Enter opens the
	   walked row, or the FIRST match when nothing is walked (owner,
	   2026-10-10 — the quick-open pattern: ⌘⇧F, type, Enter, done). The
	   Alt+↑/↓/↵ global cycle was RETIRED the same round: barely used,
	   felt laggy. The selection is a row index into `shown`, so the walk
	   follows whatever the query + kind filter leave. Mouse and keyboard
	   coexist: hovering doesn't claim, a click or an open clears the
	   selection. */
	const [kbdIndex, setKbdIndex] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	/* ── Wave 6 chunk A: context menu + inline rename + deletion ──
	   Right-click a session row → MenuShell: the two management actions
	   first (owner ruling), then — below a hairline — the extraction
	   coverage block (owner-locked redesign 2026-09-24, order refined
	   2026-09-24: Rename/Delete on top, the numbers + manual Extract
	   affordance at the bottom). The anchor is the row that was
	   right-clicked — assigned into a ref before the state flip so the
	   shell measures it on its first (hidden) pass. */
	const [ctxChatId, setCtxChatId] = useState<string | null>(null);
	const ctxAnchorRef = useRef<HTMLElement | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ChatListItem | null>(null);

	const openContext = (e: React.MouseEvent<HTMLButtonElement>, chat: ChatListItem) => {
		e.preventDefault(); // suppress the native menu
		ctxAnchorRef.current = e.currentTarget;
		setCtxChatId(chat.id);
	};

	// The menu contract (agent-section's): any pointerdown outside the menu
	// or its row closes it; Esc is CLAIMED so it never also aborts a turn
	// or folds the sidebar. Right-clicking another row re-anchors: its
	// pointerdown closes this menu, its contextmenu opens the next.
	useEffect(() => {
		if (ctxChatId === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-mt-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			setCtxChatId(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setCtxChatId(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [ctxChatId]);

	// Inline rename (owner ruling, wave 6): the row swaps to a text input;
	// commit rides the SAME plumbing as the header rename — PUT the title,
	// then mt:chat-renamed patches every listener (this sidebar's own
	// listener patches the snapshot instantly; an open chat header hears
	// it too). Esc discards; empty commit discards (the header's rules).
	const commitRename = useCallback(async (id: string, next: string) => {
		setRenamingId(null);
		const t = next.trim();
		if (t === "") return;
		try {
			const res = await fetch(`/api/chats/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: t }),
			});
			if (!res.ok) throw new Error(`rename failed: ${res.status}`);
			window.dispatchEvent(new CustomEvent("mt:chat-renamed", { detail: { id, title: t } }));
		} catch (err) {
			console.error("rename failed:", err); // keep the old title
		}
	}, []);

	// Pin / unpin (owner, 2026-10-27): optimistic, put back if the record
	// refuses it. The pin lives on the chat record, so it syncs.
	const togglePin = useCallback(async (chat: ChatListItem) => {
		const next = !chat.pinned;
		const patch = (pinned: boolean | undefined) =>
			setChats((prev) => (prev ? prev.map((c) => (c.id === chat.id ? { ...c, pinned } : c)) : prev));
		patch(next || undefined);
		try {
			const res = await fetch(`/api/chats/${chat.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pinned: next }),
			});
			if (!res.ok) throw new Error(`pin failed: ${res.status}`);
		} catch (err) {
			console.error("pin failed:", err);
			patch(chat.pinned);
		}
	}, []);

	// Delete success: patch the list instantly (the poll is the backstop),
	// navigate home if the open session died (the chat view unmounts —
	// drafts die with it, no orphan bubbles), and announce the graph
	// revision so the graph view refetches (deletion is the one writer
	// the status poll can't see — no run ever transitions some→none).
	const onDeleted = useCallback(
		(id: string, _mode: ChatDeleteMode, graphRevision: number) => {
			setDeleting(null);
			setChats((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
			if (pathname === `/chat/${id}`) router.push("/");
			window.dispatchEvent(new CustomEvent("mt:graph-revision", { detail: { revision: graphRevision } }));
		},
		[pathname, router],
	);

	useEffect(() => {
		const onFocusSearch = () => {
			if (!open) toggle();
			// A clipped (overflow-hidden) input still focuses — the sidebar's
			// slide-in doesn't gate the keystroke.
			requestAnimationFrame(() => searchRef.current?.focus());
		};
		window.addEventListener("mt:kbd-sessions-search", onFocusSearch);
		return () => window.removeEventListener("mt:kbd-sessions-search", onFocusSearch);
	}, [open, toggle]);

	// Keep the kbd-selected row in view (the rows are the container's only
	// buttons, so the index matches).
	useEffect(() => {
		if (kbdIndex === null) return;
		listRef.current?.querySelectorAll("[data-session-row]")[kbdIndex]?.scrollIntoView({ block: "nearest" });
	}, [kbdIndex]);

	useEffect(() => {
		if (!open || prefs.grouping !== "module") return;
		fetch("/api/study", { cache: "no-store" })
			.then((r) => r.json() as Promise<{ modules?: { code: string; name: string | null }[] }>)
			.then((b) => setModuleNames(Object.fromEntries((b.modules ?? []).map((m) => [m.code, m.name]))))
			.catch(() => {
				// names are decoration: the codes stand alone
			});
	}, [open, prefs.grouping, pathname]);

	useEffect(() => {
		if (!open) return;
		void refresh();
		// Opening + navigation refetch; while open, the events channel owns
		// freshness (S6) — no interval, nothing standing.
	}, [open, pathname, refresh]);

	// THE SEARCH OWNS THE WALK (owner, 2026-10-10 — the retired Alt+↑/↓/↵
	// cycle's successor): ↑/↓ cycle the filtered rows (wrap), Enter opens the
	// walked row — or the FIRST match when nothing is walked (the quick-open
	// pattern) — then blurs (focus returns to the app per the Enter law; the
	// query stays for re-searching). Esc leaves the search (owner, keyboard
	// wave): blur back to normal, and claim the key so the window Esc chain
	// (dictation / abort) doesn't also fire.
	const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			e.currentTarget.blur();
			return;
		}
		// Modified keys belong to the surface (⇧↵ etc.).
		if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
		const n = shown?.length ?? 0;
		if (n === 0) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			// The rows move, not the caret.
			e.preventDefault();
			const dir = e.key === "ArrowDown" ? 1 : -1;
			setKbdIndex((i) => (i === null || i >= n ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n));
			return;
		}
		if (e.key === "Enter") {
			const target = shown![kbdIndex !== null && kbdIndex < n ? kbdIndex : 0];
			if (!target) return;
			e.preventDefault();
			router.push(`/chat/${target.id}`);
			setKbdIndex(null);
			e.currentTarget.blur();
		}
	};

	const renderRow = (c: ChatListItem) =>
		renamingId === c.id ? (
			<RenameRow key={c.id} chat={c} onCommit={(next) => void commitRename(c.id, next)} onCancel={() => setRenamingId(null)} />
		) : (
			<SessionRow
				key={c.id}
				chat={c}
				active={pathname === `/chat/${c.id}`}
				kbdSelected={shownIndex.get(c.id) === kbdIndex}
				onOpen={() => {
					setKbdIndex(null);
					router.push(`/chat/${c.id}`);
				}}
				onContextMenu={(e) => openContext(e, c)}
				onMore={(e) => openContext(e, c)}
			/>
		);

	return (
		<aside
			className={cn("sidebar-motion shrink-0 overflow-hidden duration-200", open ? "w-[280px]" : "w-0")}
			aria-hidden={!open}
		>
			<div className="mt-glass-pane flex h-full w-[280px] flex-col">
				{/* The wordmark (Hot Glass, SPEC §8): the dragon mark + "Mental
				    Tuition" in Geist light — still the home link — and the collapse
				    button. In Electron this band is the window's drag surface and
				    starts after the traffic lights (.mt-lights-gutter). */}
				<div className="mt-drag mt-lights-gutter flex items-center justify-between px-4 py-3">
					<Hint
						// Kept to the RIGHT of the logo, carrying its real shortcut: ⌘G
						// jumps to the graph view (keyboard-shortcuts routes it to "/").
						label="Home"
						action="jump-graph"
						side="right"
					>
						<Link href="/" aria-label="Home" className="mt-no-drag flex items-center gap-2 rounded-full py-1.5 pl-1 pr-3 transition-colors hover:bg-[var(--mt-quiet-hover-bg)]">
							<MtMark className="size-5 shrink-0" />
							<span className="font-ui text-[15px] font-light tracking-[-0.01em]">Mental Tuition</span>
						</Link>
					</Hint>
					<Hint label="Close sidebar" action="toggle-sidebar">
						<Button variant="ghost" size="icon" aria-label="Close sidebar" onClick={toggle} className="mt-no-drag">
							<PanelLeftCloseIcon className="size-4" strokeWidth={1.5} />
						</Button>
					</Hint>
				</div>

				{/* New session (primary, with its shortcut) + the round practice
				    button. Teaching keeps the draft route; practice carries its mode. */}
				<div className="mx-3 mb-3 flex items-center gap-2">
					<button
						type="button"
						data-testid="new-session"
						onClick={() => void newSession()}
						className="mt-btn-primary flex h-10 flex-1 items-center justify-center gap-2 rounded-full text-[13.5px] font-medium"
					>
						<PlusIcon className="size-4" strokeWidth={1.75} />
						New session
						<span className="ml-1 font-mono text-[10.5px] font-normal tracking-[0.06em] opacity-50" aria-hidden="true">
							{mod === "⌘" ? "⌘N" : "Ctrl N"}
						</span>
						<span className="sr-only">create a new teaching session</span>
					</button>
					<Hint label="New practice session" side="bottom">
						<button
							type="button"
							data-testid="new-session-practice"
							aria-label="New practice session"
							onClick={() => router.push("/chat/new?mode=practice")}
							className="mt-btn flex size-10 shrink-0 items-center justify-center rounded-full"
						>
							<DumbbellIcon className="size-4" strokeWidth={1.5} />
						</button>
					</Hint>
				</div>

				{/* Search — session search, ⌘⇧F (owner, 2026-10-27). */}
				<div className="mx-3 mb-3">
					<Hint label="Search sessions" action="sessions-search" side="bottom">
						<span className="relative block">
							<Input
								ref={searchRef}
								data-testid="session-search"
								value={query}
								onChange={(e) => {
									setQuery(e.target.value);
									// The list reorders under the query every keystroke —
									// a stale walk index would point at the wrong row.
									setKbdIndex(null);
								}}
								onKeyDown={onSearchKeyDown}
								placeholder="Search sessions"
								aria-label="Search sessions"
								className="h-9 rounded-full border-transparent bg-[var(--mt-quiet-hover-bg)] pl-9 pr-16 text-[13px] placeholder:text-muted-foreground/60"
							/>
							<SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70" strokeWidth={1.5} />
							<span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10.5px] tracking-[0.06em] text-muted-foreground/60" aria-hidden="true">
								{mod === "⌘" ? "⌘⇧F" : "Ctrl ⇧F"}
							</span>
						</span>
					</Hint>
				</div>

				{/* Pages: no indents — the active one a small glass pill. */}
				<nav className="mx-3 mb-2 flex flex-col gap-0.5" aria-label="Pages">
					<NavRow
						testid="knowledge-graph"
						icon={<WaypointsIcon className="size-4" strokeWidth={1.5} />}
						label="Knowledge graph"
						active={pathname === "/"}
						onClick={() => router.push("/")}
					/>
					<NavRow
						testid="modules"
						icon={<LibraryIcon className="size-4" strokeWidth={1.5} />}
						label="Modules"
						active={pathname === "/modules"}
						onClick={() => router.push("/modules")}
					/>
					<NavRow
						testid="practice-papers"
						icon={<FileTextIcon className="size-4" strokeWidth={1.5} />}
						label="Practice papers"
						active={pathname === "/papers"}
						onClick={() => router.push("/papers")}
					/>
				</nav>

				{/* SESSIONS: the TIME / MODULE switch, then ALL · TEACH · PRACTICE.
				    Both choices are remembered in the settings file (synced). */}
				<div className="mx-3 mb-1.5 mt-3 flex items-center justify-between">
					<span className={GROUP_LABEL}>Sessions</span>
					<div role="group" aria-label="Group sessions by" data-testid="session-grouping" className="mt-tray flex items-center gap-0.5 rounded-full p-0.5">
						{(["time", "module"] as const).map((g) => (
							<button
								key={g}
								type="button"
								data-testid={`grouping-${g}`}
								aria-pressed={prefs.grouping === g}
								onClick={() => setGrouping(g)}
								className={cn(
									"rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em]",
									prefs.grouping === g ? "mt-btn text-foreground" : "text-muted-foreground transition-colors hover:text-foreground",
								)}
							>
								{g}
							</button>
						))}
					</div>
				</div>
				<div className="mx-3 mb-1 flex items-center gap-1" data-testid="session-kind-filter">
					{(["all", "teach", "practice"] as const).map((f) => (
						<button
							key={f}
							type="button"
							data-testid={`kind-filter-${f}`}
							aria-pressed={kindFilter === f}
							onClick={() => setFilter(f)}
							className={cn(
								"rounded-full px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.1em] transition-colors",
								kindFilter === f ? "bg-[var(--mt-quiet-hover-bg)] text-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{f}
						</button>
					))}
				</div>

				<div ref={listRef} className="flex-1 overflow-y-auto px-2 pb-2">
					{shown === null ? (
						<div className="px-3 py-4 text-xs text-muted-foreground">Loading…</div>
					) : searching ? (
						shown.length === 0 ? (
							<div className="px-3 py-4 text-xs text-muted-foreground">No sessions match.</div>
						) : (
							shown.map(renderRow)
						)
					) : (groups ?? []).length === 0 ? (
						<div className="px-3 py-4 text-xs text-muted-foreground">No sessions yet.</div>
					) : (
						(groups ?? []).map((g) => {
							const folded = isCollapsed(g.key);
							return (
								<div key={g.key || NO_MODULE_KEY} data-testid="session-group">
									{prefs.grouping === "module" ? (
										<button
											type="button"
											data-testid={`module-group-${g.key || "none"}`}
											aria-expanded={!folded}
											onClick={() => toggleModuleCollapsed(g.key || NO_MODULE_KEY)}
											className={cn(GROUP_LABEL, "flex w-full items-center gap-1.5 rounded-lg px-3 pb-1 pt-3 text-left transition-colors hover:text-foreground")}
										>
											<ChevronDownIcon className={cn("size-3 transition-transform", folded && "-rotate-90")} strokeWidth={1.75} />
											{g.label} · {g.items.length}
										</button>
									) : (
										<div className={cn(GROUP_LABEL, "px-3 pb-1 pt-3")}>{g.label}</div>
									)}
									{!folded && g.items.map(renderRow)}
								</div>
							);
						})
					)}
				</div>

				{/* RUNNING NOW: only the background agents running right now — the
				    block is absent when none are. Settings is a nav row beneath. */}
				<ActivitySection />
				<div className="px-3 pb-3 pt-1">
					<Hint label="Settings" action="open-settings" side="right">
						<NavRow
							testid="settings-entry"
							icon={<SettingsIcon className="size-4" strokeWidth={1.5} />}
							label="Settings"
							onClick={() => openSettings()}
						/>
					</Hint>
				</div>
			</div>

				{/* The context menu (wave 6 + the extraction-UX redesign): the
				    coverage block above, then exactly two management actions
				    (owner ruling — no more). MenuShell owns placement/focus/arrow
				    cycling; the dismissal effect above owns the contract. */}
				{ctxChatId !== null && (
					<MenuShell
						anchorRef={ctxAnchorRef}
						testid="session-context-menu"
						preferredSide="down"
						menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
					>
						{/* The two management actions first, then the extraction block
						    (owner refinement round, 2026-09-24): Rename/Delete stay at the
						    top, the coverage numbers + Extract affordance sit below the
						    hairline — the block is info + a stateful affordance, the
						    actions above it. Fetched on menu open (the block mounts WITH
						    the menu); 409 = benign. Renders nothing on a failed read. */}
						<button
							type="button"
							data-testid="ctx-pin"
							onClick={() => {
								const target = chats?.find((c) => c.id === ctxChatId);
								if (target) void togglePin(target);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							{chats?.find((c) => c.id === ctxChatId)?.pinned ? "Unpin" : "Pin"}
						</button>
						<button
							type="button"
							data-testid="ctx-rename"
							onClick={() => {
								setRenamingId(ctxChatId);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Rename
						</button>
						{/* Export as Markdown (owner, release polish 2026-10-06): the
					    session-markdown engine's user-facing debut — same-origin
						    anchor download; the route's Content-Disposition names the
						    file. Sits with the management actions, above Delete (the
						    destructive action stays last — the danger-fence law). */}
						<button
							type="button"
							data-testid="ctx-export-md"
							onClick={() => {
								const chatId = ctxChatId;
								setCtxChatId(null);
								const a = document.createElement("a");
								a.href = `/api/chats/${chatId}/markdown`;
								a.download = ""; // the route's filename wins
								document.body.appendChild(a);
								a.click();
								a.remove();
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Export as Markdown…
						</button>
						<button
							type="button"
							data-testid="ctx-delete"
							onClick={() => {
								const target = chats?.find((c) => c.id === ctxChatId);
								if (target) setDeleting(target);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
						>
							Delete…
						</button>
						<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
						<CoverageMenuBlock chatId={ctxChatId} />
					</MenuShell>
				)}

				{/* The two-option delete dialog (wave 6) — portaled to body
				    by the component itself, lives here for state locality. */}
				<DeleteSessionDialog
					chat={deleting}
					onClose={() => setDeleting(null)}
					onDeleted={onDeleted}
				/>
			</aside>
	);
}

/** The app frame: sidebar inline + content. Rendered once in the root layout. */
export function AppShell({ children }: { children: React.ReactNode }) {
	return (
		<SettingsDialogProvider>
			<SessionsSidebar />
			<main className="min-w-0 flex-1">{children}</main>
			{/* The single document-level keydown listener (keyboard wave A) —
			    after the content in the tree, but it's window-level so order only
			    matters for the events it dispatches, never for DOM priority. */}
			<KeyboardShortcuts />
		</SettingsDialogProvider>
	);
}
