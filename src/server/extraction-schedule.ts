/**
 * SESSION-END EXTRACTION (owner, 2026-10-28): a chat's graph extraction
 * waits until the session is over instead of firing every few thousand
 * tokens — each run pays a fixed overhead (the graph so far in the
 * extractor prompt, the multi-step auditor), so one run per session is
 * the cheap shape.
 *
 *   - After every turn: uncovered tokens at or past the chunk budget (the
 *     mid-session cap, 32k factory) run now, as before; anything less
 *     re-arms a 30-minute idle timer for the chat.
 *   - The timer fires: a turn in flight skips it (that turn's end re-arms
 *     it); otherwise whatever is uncovered extracts — if it is at least
 *     the chunk floor (500): a smaller tail would cost more in overhead
 *     than it holds, so it waits for the chat to grow (or the manual
 *     extract).
 *   - Next launch catch-up: timers die with the process, so the first
 *     server start re-reads every chat — idle 30 minutes or more extracts
 *     now, younger chats get a timer for the remainder.
 *
 * Timers and the once-per-process catch-up flag live on globalThis: Next
 * evaluates server modules once per route bundle (and again on HMR), and
 * a chat must never hold two timers. Every dependency is injected, so the
 * tests drive it with a fake clock.
 */

import { coverageOf } from "../core/coverage.ts";
import type { MtMessage } from "../core/native-messages.ts";
import type { ChatStore, GraphStore } from "../core/ports.ts";
import { EXTRACTION_CHUNK_TOKENS_FLOOR, ModelsNotConfiguredError, ProviderKeyMissingError } from "../core/settings.ts";
import type { ExtractionPipeline } from "../agent/subagents/extraction.ts";

/** How long a chat sits idle before its session counts as over. */
export const EXTRACTION_IDLE_MS = 30 * 60_000;

type Timer = unknown;

export interface ExtractionScheduleDeps {
	chatStore: ChatStore;
	graphStore: GraphStore;
	extraction: Pick<ExtractionPipeline, "runExtraction">;
	/** The graph section, read fresh at every decision (a settings PUT
	 *  during the idle wait lands). */
	graph: () => { enabled: boolean; extractionChunkTokens: number };
	isTurnRunning: (chatId: string) => boolean;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => Timer;
	clearTimer?: (timer: Timer) => void;
	/** The per-chat timers; production shares one map process-wide. */
	timers?: Map<string, Timer>;
}

export interface ExtractionSchedule {
	/** A turn just settled: run now past the cap, else (re)arm the idle timer. */
	afterTurn(chatId: string): void;
	/** Launch catch-up: extract idle chats, arm timers for the rest. */
	catchUp(): void;
	/** Chats with an armed timer (tests, diagnostics). */
	pending(): string[];
}

function defaultSetTimer(fn: () => void, ms: number): Timer {
	const t = setTimeout(fn, ms);
	// A pending extraction never keeps the process alive.
	(t as { unref?: () => void }).unref?.();
	return t;
}

/** When the chat last moved: its newest message, else the record's updatedAt. */
function lastActivity(record: { updatedAt: string; messages: readonly MtMessage[] }): number {
	for (let i = record.messages.length - 1; i >= 0; i--) {
		const ts = (record.messages[i] as { timestamp?: unknown }).timestamp;
		if (typeof ts === "number" && ts > 0) return ts;
	}
	return Date.parse(record.updatedAt) || 0;
}

export function createExtractionSchedule(deps: ExtractionScheduleDeps): ExtractionSchedule {
	const now = deps.now ?? Date.now;
	const setTimer = deps.setTimer ?? defaultSetTimer;
	const clearTimer = deps.clearTimer ?? ((t: Timer) => clearTimeout(t as ReturnType<typeof setTimeout>));
	const timers = deps.timers ?? new Map<string, Timer>();

	function disarm(chatId: string): void {
		const t = timers.get(chatId);
		if (t === undefined) return;
		clearTimer(t);
		timers.delete(chatId);
	}

	function arm(chatId: string, ms: number): void {
		disarm(chatId);
		timers.set(
			chatId,
			setTimer(() => {
				timers.delete(chatId);
				fire(chatId);
			}, ms),
		);
	}

	/** Uncovered tokens for an extractable chat, or null when it never extracts. */
	function uncoveredOf(chatId: string): { tokens: number; record: NonNullable<ReturnType<ChatStore["getChat"]>> } | null {
		const record = deps.chatStore.getChat(chatId);
		if (!record || record.kind === "practice") return null;
		const covered = coverageOf(record.messages, deps.graphStore.readCoverage(), chatId);
		return { tokens: covered.uncoveredTokens, record };
	}

	function run(chatId: string): void {
		disarm(chatId);
		void deps.extraction.runExtraction(chatId).catch((err) => {
			// BYOK (owner, 2026-09-22) + key presence (provider-key interlude,
			// 2026-09-25): an unconfigured OR keyless write channel SKIPS (the
			// coverage ledger keeps the messages uncovered — the next trigger
			// retries once slots/keys are set); only real failures log.
			if (err instanceof ModelsNotConfiguredError) {
				console.info(`[chat ${chatId}] extraction skipped — ${err.envelope.error} (missing: ${err.envelope.missing.join(", ")})`);
				return;
			}
			if (err instanceof ProviderKeyMissingError) {
				console.info(`[chat ${chatId}] extraction skipped — ${err.envelope.error} (provider: ${err.envelope.provider})`);
				return;
			}
			console.error(`[chat ${chatId}] extraction pipeline failed:`, err);
		});
	}

	function fire(chatId: string): void {
		try {
			if (deps.isTurnRunning(chatId)) return; // its settle re-arms
			if (!deps.graph().enabled) return;
			const u = uncoveredOf(chatId);
			if (u && u.tokens >= EXTRACTION_CHUNK_TOKENS_FLOOR) run(chatId);
		} catch (err) {
			console.error(`[chat ${chatId}] idle extraction failed:`, err);
		}
	}

	return {
		afterTurn(chatId) {
			try {
				const graph = deps.graph();
				if (!graph.enabled) return;
				const u = uncoveredOf(chatId);
				if (!u || u.tokens < EXTRACTION_CHUNK_TOKENS_FLOOR) return disarm(chatId);
				if (u.tokens >= graph.extractionChunkTokens) run(chatId);
				else arm(chatId, EXTRACTION_IDLE_MS);
			} catch (err) {
				console.error(`[chat ${chatId}] extraction trigger failed:`, err);
			}
		},
		catchUp() {
			try {
				if (!deps.graph().enabled) return;
				let started = 0;
				let later = 0;
				for (const chat of deps.chatStore.listChats()) {
					if (chat.kind === "practice" || timers.has(chat.id)) continue;
					const u = uncoveredOf(chat.id);
					if (!u || u.tokens < EXTRACTION_CHUNK_TOKENS_FLOOR) continue;
					const idle = now() - lastActivity(u.record);
					if (idle >= EXTRACTION_IDLE_MS) {
						run(chat.id);
						started++;
					} else {
						arm(chat.id, EXTRACTION_IDLE_MS - idle);
						later++;
					}
				}
				console.info(`[extraction] launch catch-up: ${started} chat(s) extracting now, ${later} waiting for idle`);
			} catch (err) {
				console.error("[extraction] launch catch-up failed:", err);
			}
		},
		pending: () => [...timers.keys()],
	};
}
