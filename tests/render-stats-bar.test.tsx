import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionStats } from "../components/stats-bar.tsx";
import { catalogLimits, ModelControl } from "../components/model-picker.tsx";
import type { ModelCatalogEntry, ModelCatalogResponse } from "../src/core/contracts.ts";
import { prettyModel } from "../components/usage-format.ts";
import type { ChatSettings, TurnUsage } from "../src/core/contracts.ts";

// The session stats line: folds only (no cost math in the component), the
// "—" doctrine for absent data, honest cost (never a fake $0). The model +
// thinking control (components/model-picker.tsx — pi-ai catalog backed)
// moved into the composer slab's tray as quiet buttons (Hot Glass).

function step(inputTokens: number, outputTokens: number, over: Record<string, number | undefined> = {}) {
	return { inputTokens, outputTokens, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined, ...over };
}

function turn(over: Partial<TurnUsage> = {}): TurnUsage {
	return {
		id: "t1",
		messageId: "m1",
		at: "2026-09-09T12:00:00Z",
		model: "openrouter:z-ai/glm-5.3-flash",
		steps: [step(10_000, 1_000)],
		...over,
	};
}

describe("session stats line", () => {
	it("renders NOTHING before the first turn (owner, wave 7 sweep; Hot Glass)", () => {
		const html = renderToStaticMarkup(<SessionStats turns={[]} />);
		// pre-chat: no line at all — no "—" theater
		assert.equal(html, "");
	});

	it("the model + thinking control reads as two quiet tray buttons", () => {
		const html = renderToStaticMarkup(<ModelControl />);
		// no settings, catalog not loaded → the model label shows the
		// subscription floor's strong model (personal fork), the thinking
		// label "—" (no catalog entry yet to read levels from) — just the
		// name / level, no prefix
		assert.match(html, /data-testid="stats-model"[^>]*>\s*<span>[^<—]+<\/span>/);
		assert.match(html, /data-testid="stats-thinking"[^>]*>\s*<span>—<\/span>/);
		// the quiet text button: mono caps (mt-quiet), round, a chevron
		assert.match(html, /data-testid="stats-model"[^>]*mt-quiet[^>]*rounded-full|class="mt-quiet[^"]*rounded-full[^"]*"[^>]*data-testid="stats-model"/);
		assert.match(html, /lucide-chevron-down/);
	});

	it("folds context + cost from the turns log (core/prices, no local math)", () => {
		const html = renderToStaticMarkup(<SessionStats turns={[turn(), turn()]} />);
		// last turn's last call: 10k in + 1k out = 11k. The LIMIT is the
		// live catalog's — and the bar doesn't hold the index yet (the
		// catalog join lands with the UI chunk), so the meter renders
		// USAGE-ONLY (owner amendment: never a fallback window).
		assert.match(html, /data-testid="stats-context">11k</);
		// pi catalog price 0.15/0.5 per 1M (drifted in pi-ai 0.87.1):
		// each turn 10k×0.15 + 1k×0.5 = $0.002 → two = $0.0040
		assert.match(html, /data-testid="stats-cost">\$0\.0040</);
		// one centered mono line under the slab
		assert.match(html, /data-testid="stats-bar"[^>]*class="[^"]*justify-center[^"]*font-mono|class="[^"]*justify-center[^"]*font-mono[^"]*"[^>]*data-testid="stats-bar"/);
	});

	it("shows — for cost when every turn is unpriceable, never a fake $0", () => {
		const html = renderToStaticMarkup(<SessionStats turns={[turn({ model: "nope/unknown" })]} />);
		assert.match(html, /data-testid="stats-cost">—</);
		// unknown model: no catalog limit exists, but the footprint is
		// still an honest reading — usage-only (never "—" theater over
		// real data, never a fake window)
		assert.match(html, /data-testid="stats-context">11k</);
	});

	it("prettyModel strips vendor + date suffix, keeps dashes", () => {
		assert.equal(prettyModel("z-ai/glm-5.3-flash"), "glm-5.3-flash"); // dashes kept (owner round 5)
		assert.equal(prettyModel("qwen/qwen3.8-max-0902"), "qwen3.8-max");
	});

	it("provider-qualified stamps (usage contract, model-slots wave)", () => {
		// qualified: the provider rides as a quiet suffix — federation makes
		// the same model via two providers different bookkeeping
		assert.equal(prettyModel("openrouter:z-ai/glm-5.3-flash", true), "glm-5.3-flash · openrouter");
		assert.equal(prettyModel("openai:gpt-5.2", true), "gpt-5.2 · openai");
		// unqualified on a qualified stamp: provider silently dropped (old shape)
		assert.equal(prettyModel("openrouter:z-ai/glm-5.3-flash"), "glm-5.3-flash");
		// qualified on a bare id: no suffix invented
		assert.equal(prettyModel("z-ai/glm-5.3-flash", true), "glm-5.3-flash");
	});
});

describe("catalogLimits (the stats-bar live-limits join, pure)", () => {
	// The client-side twin of the server's catalogContextLimits join:
	// provider:id → contextWindow straight from the cached /api/models
	// payload. A static render holds no catalog (the fetch is a live
	// concern — Playwright verifies the wiring), so the pure index shape
	// is pinned here: one entry per model, the exact key contextWindow()
	// looks up, missing models absent (→ limit null → usage-only).
	const entry = (over: Pick<ModelCatalogEntry, "id" | "provider" | "contextWindow">): ModelCatalogEntry => ({
		name: over.id,
		reasoning: false,
		input: ["text"],
		supportedLevels: [],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 32_768,
		...over,
	});
	const catalog: Pick<ModelCatalogResponse, "models"> = {
		models: [
			entry({ id: "z-ai/glm-5.3-flash", provider: "openrouter", contextWindow: 1_048_576 }),
			entry({ id: "gpt-x", provider: "openai", contextWindow: 400_000 }),
		],
	};

	it("builds provider:id → contextWindow over every catalog model", () => {
		const limits = catalogLimits(catalog);
		assert.equal(limits.get("openrouter:z-ai/glm-5.3-flash"), 1_048_576);
		assert.equal(limits.get("openai:gpt-x"), 400_000);
		assert.equal(limits.size, 2);
	});

	it("a model missing from the index is absent — limit null, usage-only (never a fallback)", () => {
		const limits = catalogLimits(catalog);
		assert.equal(limits.has("nope/unknown"), false);
	});

	it("same provider+model on different providers keys apart", () => {
		const twin: Pick<ModelCatalogResponse, "models"> = {
			models: [...catalog.models, entry({ id: "z-ai/glm-5.3-flash", provider: "zai", contextWindow: 200_000 })],
		};
		const limits = catalogLimits(twin);
		assert.equal(limits.get("openrouter:z-ai/glm-5.3-flash"), 1_048_576);
		assert.equal(limits.get("zai:z-ai/glm-5.3-flash"), 200_000);
	});
});
