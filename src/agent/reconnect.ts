import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type StreamFunction,
} from "@earendil-works/pi-ai";

/**
 * Quiet reconnect (owner, 2026-10-27 — the false "Connection error." bug):
 * a provider connection that drops partway through a reply ends the step
 * with stopReason "error" and the SDK's "Connection error.", although
 * nothing is wrong and sending again works. This wrapper redoes the step
 * instead, up to RECONNECT_ATTEMPTS times with a short backoff, and only a
 * step that fails every attempt reaches the learner as an error.
 *
 * How it stays invisible to pi's loop: the first attempt's `start` is the
 * one the loop sees (it pushes the placeholder message); a retry's own
 * `start` is swallowed, and every later event carries its attempt's FULL
 * partial, which the loop (and every view) uses to REPLACE the message — so
 * the half-written reply is simply overwritten by the fresh one. While it
 * waits, the wrapper sends one update whose partial is empty and flagged
 * `reconnecting: true`; the views read the flag (isReconnecting, core) to
 * show "Reconnecting…".
 * The final message never carries the flag (it is the retry's own).
 *
 * Request-level failures before any text (connect refused, 5xx, 429) are
 * the SDK retry's job — models.ts passes maxRetries; this covers the drops
 * that happen after the stream started, which no SDK retries.
 */

export const RECONNECT_ATTEMPTS = 2;

/** Messages of a dropped connection or an overloaded provider: worth a
 *  redo. Anything else (a refusal, a bad request, a missing key) is real. */
const TRANSIENT = /connection error|terminated|econnreset|econnrefused|etimedout|epipe|socket hang up|other side closed|fetch failed|network ?error|overloaded|\b529\b|\b50[234]\b/i;

export function isTransientStreamError(message: string | undefined): boolean {
	return !!message && TRANSIENT.test(message);
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});

export function withReconnect(
	streamFn: StreamFunction,
	{ attempts = RECONNECT_ATTEMPTS, backoffMs = (n: number) => 1000 * 2 ** n } = {},
): StreamFunction {
	return (model, context, options) => {
		const out = createAssistantMessageEventStream();
		void (async () => {
			let started = false;
			for (let attempt = 0; ; attempt++) {
				const inner = streamFn(model, context, options);
				let failed: AssistantMessage | undefined;
				for await (const event of inner as AsyncIterable<AssistantMessageEvent>) {
					if (event.type === "start") {
						if (!started) {
							started = true;
							out.push(event);
						}
						continue;
					}
					if (
						event.type === "error" &&
						event.reason === "error" &&
						attempt < attempts &&
						!options?.signal?.aborted &&
						isTransientStreamError(event.error.errorMessage)
					) {
						failed = event.error;
						break;
					}
					if (!started && event.type !== "done" && event.type !== "error") {
						// A provider that skipped `start`: the loop needs one first.
						started = true;
						out.push({ type: "start", partial: event.partial });
					}
					out.push(event);
				}
				if (!failed) return;
				if (started) {
					const placeholder = { ...failed, content: [], stopReason: "stop", errorMessage: undefined, reconnecting: true } as AssistantMessage;
					out.push({ type: "text_start", contentIndex: 0, partial: placeholder });
				}
				console.warn(`[turn] ${failed.errorMessage} — reconnecting (attempt ${attempt + 1} of ${attempts})`);
				await sleep(backoffMs(attempt), options?.signal);
			}
		})().catch((err) => {
			// The inner stream threw outside its own event protocol: end the
			// step as an error rather than leave the loop waiting forever.
			out.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "error",
					errorMessage: err instanceof Error ? err.message : String(err),
					timestamp: Date.now(),
				} as AssistantMessage,
			});
		});
		return out;
	};
}
