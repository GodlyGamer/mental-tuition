import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEvent,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { isTransientStreamError, withReconnect } from "../src/agent/reconnect.ts";
import { isReconnecting } from "../src/core/native-messages.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage,
		stopReason: "stop",
		timestamp: 0,
		...extra,
	} as AssistantMessage;
}

/** One scripted attempt: "ok:<text>" streams and finishes; "drop:<text>"
 *  streams the text then dies with the given error message. */
type Attempt = { text: string; error?: string };

function scripted(attempts: Attempt[]): { fn: StreamFunction; calls: () => number } {
	let calls = 0;
	const fn: StreamFunction = () => {
		const attempt = attempts[calls++]!;
		const out = createAssistantMessageEventStream();
		queueMicrotask(() => {
			out.push({ type: "start", partial: message("") });
			out.push({ type: "text_start", contentIndex: 0, partial: message("") });
			out.push({ type: "text_delta", contentIndex: 0, delta: attempt.text, partial: message(attempt.text) });
			if (attempt.error) {
				out.push({ type: "error", reason: "error", error: message(attempt.text, { stopReason: "error", errorMessage: attempt.error }) });
			} else {
				out.push({ type: "done", reason: "stop", message: message(attempt.text) });
			}
		});
		return out;
	};
	return { fn, calls: () => calls };
}

async function drain(fn: StreamFunction): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	const stream = fn({ api: "anthropic-messages", provider: "anthropic", id: "claude-opus-5-5" } as never, { messages: [] } as never, {});
	for await (const e of stream as AsyncIterable<AssistantMessageEvent>) events.push(e);
	return events;
}

describe("quiet reconnect", () => {
	it("knows a dropped connection from a real failure", () => {
		for (const m of ["Connection error.", "terminated", "read ECONNRESET", "socket hang up", "Overloaded", "529 overloaded_error"]) {
			assert.ok(isTransientStreamError(m), m);
		}
		for (const m of ["invalid x-api-key", "prompt is too long", "Claude declined this request.", undefined]) {
			assert.ok(!isTransientStreamError(m), String(m));
		}
	});

	it("redoes a reply that dropped mid-stream: one start, a reconnecting placeholder, then the fresh reply", async () => {
		const { fn, calls } = scripted([{ text: "Half a rep", error: "Connection error." }, { text: "The whole reply." }]);
		const events = await drain(withReconnect(fn, { backoffMs: () => 0 }));
		assert.equal(calls(), 2);
		assert.equal(events.filter((e) => e.type === "start").length, 1);
		assert.ok(!events.some((e) => e.type === "error"));
		const placeholder = events.find((e) => "partial" in e && isReconnecting(e.partial));
		assert.ok(placeholder, "a reconnecting placeholder update");
		assert.deepEqual((placeholder as { partial: AssistantMessage }).partial.content, []);
		const done = events.at(-1)!;
		assert.equal(done.type, "done");
		const final = (done as { message: AssistantMessage }).message;
		assert.deepEqual(final.content, [{ type: "text", text: "The whole reply." }]);
		assert.ok(!isReconnecting(final));
	});

	it("gives up after the last attempt and passes the error through", async () => {
		const { fn, calls } = scripted([
			{ text: "a", error: "Connection error." },
			{ text: "b", error: "Connection error." },
			{ text: "c", error: "Connection error." },
		]);
		const events = await drain(withReconnect(fn, { attempts: 2, backoffMs: () => 0 }));
		assert.equal(calls(), 3);
		const last = events.at(-1)!;
		assert.equal(last.type, "error");
		assert.equal((last as { error: AssistantMessage }).error.errorMessage, "Connection error.");
	});

	it("never retries a real error", async () => {
		const { fn, calls } = scripted([{ text: "", error: "invalid x-api-key" }]);
		const events = await drain(withReconnect(fn, { backoffMs: () => 0 }));
		assert.equal(calls(), 1);
		assert.equal(events.at(-1)!.type, "error");
	});
});
