import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";

// GEMINI_HOME holds the (fake) saved sign-in; MT_ANTIGRAVITY_ACP swaps the
// real server for a scripted fake that records what it saw on stderr.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "mt-agy-home-"));
process.env.GEMINI_HOME = HOME;
process.env.MT_ANTIGRAVITY_ACP = fileURLToPath(new URL("./fixtures/fake-antigravity-acp.mjs", import.meta.url));
const REPORT = path.join(HOME, "fake-report.json");
process.env.MT_FAKE_AGY_REPORT = REPORT;

const { ANTIGRAVITY_PROVIDER_ID, antigravitySignedIn, stopAntigravity } = await import("../src/agent/antigravity.ts");
after(() => stopAntigravity());
const { piModels } = await import("../src/agent/models.ts");

const quiz = {
	name: "quiz",
	description: "Pose a multiple-choice question.",
	parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }),
};

describe("the Gemini (Google sign-in, Antigravity) engine", () => {
	it("registers keyless, zero-cost Gemini models", () => {
		const models = piModels().getModels(ANTIGRAVITY_PROVIDER_ID);
		assert.ok(models.some((m) => m.id === "gemini-3.8-flash"));
		for (const m of models) assert.equal(m.cost.input + m.cost.output, 0);
	});

	it("knows whether the learner has signed in (the saved token)", () => {
		assert.equal(antigravitySignedIn(), false);
		fs.mkdirSync(path.join(HOME, "antigravity-acp"), { recursive: true });
		fs.writeFileSync(path.join(HOME, "antigravity-acp", "acp_token.json"), "{}");
		assert.equal(antigravitySignedIn(), true);
	});

	it("one step: streams text, appends the system prompt, sets the model, captures the tool call, denies built-ins, cancels the next response", async () => {
		const model = piModels().getModel(ANTIGRAVITY_PROVIDER_ID, "gemini-3.8-flash")!;
		const s = piModels().streamSimple(model, {
			systemPrompt: "You are a tutor.",
			messages: [{ role: "user", content: "Teach me limits.", timestamp: 0 }],
			tools: [quiz],
		});
		const events: string[] = [];
		for await (const e of s) events.push(e.type);
		const message = await s.result();
		assert.equal(message.stopReason, "toolUse", message.errorMessage);

		const text = message.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
		assert.equal(text, "Quick check first.", "nothing from the cancelled next response");
		const thinking = message.content.find((c) => c.type === "thinking") as { thinking: string };
		assert.equal(thinking.thinking, "Checking prior knowledge.");
		const call = message.content.find((c) => c.type === "toolCall") as unknown as { name: string; arguments: { question: string; options: string[] } };
		assert.equal(call.name, "quiz");
		assert.deepEqual(call.arguments.options, ["a", "b"]);
		assert.match(call.arguments.question, /Echo: <learner>\nTeach me limits\./, "the transcript reached Gemini as the prompt");
		assert.deepEqual(message.usage.input, 600, "input excludes cached reads");
		assert.equal(message.usage.cacheRead, 400);
		assert.equal(message.usage.output, 100, "output includes thinking");
		assert.equal((message.usage as { contextTokens?: number }).contextTokens, 820, "context = the latest usage_update, not the summed calls");
		assert.ok(events.includes("toolcall_end") && events.at(-1) === "done");
	});

	it("the server saw the appended teaching prompt, the chosen model, and the permission decisions", () => {
		const seen = JSON.parse(fs.readFileSync(REPORT, "utf-8")) as {
			appendedPrompt: string;
			model: string;
			permission: { builtin: string; ours: string };
		};
		assert.match(seen.appendedPrompt, /^You are the teacher in Mental Tuition/);
		assert.match(seen.appendedPrompt, /You are a tutor\./);
		assert.match(seen.appendedPrompt, /How this conversation reaches you/);
		assert.equal(seen.model, "gemini-3.8-flash");
		assert.equal(seen.permission.builtin, "deny", "Antigravity's built-in tools are denied");
		assert.equal(seen.permission.ours, "allow", "the app's own tools are allowed");
	});
});

describe("Gemini error messages", () => {
	it("names the models the plan has when the chat's model is not on it", async () => {
		const { geminiErrorText } = await import("../src/agent/antigravity.ts");
		const text = geminiErrorText(
			`Model 'gemini-3.1-pro-preview' is not available for the current authentication method.: {"modelId":"gemini-3.1-pro-preview","availableModels":["gemini-3.8-flash-high","gemini-3.8-flash-low","gemini-3.8-flash-medium"]}`,
		);
		assert.doesNotMatch(text, /sign in/i);
		assert.match(text, /gemini-3\.8-flash-high, gemini-3\.8-flash-low, gemini-3\.8-flash-medium/);
	});

	it("still gives the sign-in hint for a real sign-in failure", async () => {
		const { geminiErrorText } = await import("../src/agent/antigravity.ts");
		assert.match(geminiErrorText("Token expired, please log in"), /sign in with Google/);
	});
});
