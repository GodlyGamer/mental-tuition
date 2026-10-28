/**
 * Tests for the resolution layer (settings-storage wave, 2026-09-19;
 * model-slots wave 2026-09-20; BYOK all-the-way-down wave 2026-09-22):
 * core/settings-resolution.ts — the delta→concrete projection. There are
 * NO factory pins anymore: a model chain that ends empty resolves to
 * null/undefined, and the per-need refusal gates (turn, job spawn,
 * extraction) fire on exactly that.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractionEnabled,
	graphToolsEnabled,
	renderingEnabled,
	resolveConversationSpec,
	resolveModelSpec,
	resolveRoleSpec,
	resolveSettings,
	resolveSlot,
} from "../src/core/settings-resolution.ts";
import {
	BACKGROUND_MODEL_ROLES,
	BACKGROUND_THINKING_DEFAULTS,
	ROLE_SLOT,
	SUBSCRIPTION_SLOTS,
	type UserSettings,
} from "../src/core/settings.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** The subscription factory pin of one tier, in resolved form. */
const sub = (tier: "strong" | "cheap" | "vision", thinkingLevel?: ThinkingLevel) => ({
	provider: "claude-code",
	id: SUBSCRIPTION_SLOTS[tier].model!.id,
	thinkingLevel,
});

describe("resolveSettings", () => {
	it("null record (first boot): non-model knobs land on factory defaults; every model view is EMPTY", () => {
		const eff = resolveSettings(null);
		assert.deepEqual(eff.general, { autoUpdate: true });
		assert.deepEqual(eff.agent.tools, {});
		assert.deepEqual(eff.agent.prompts, {});
		assert.deepEqual(eff.agent.search, {});
		// Personal fork: the factory floor is the Claude subscription — every
		// role and slot resolves to its tier's subscription pin.
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.deepEqual(eff.agent.models[role], sub(ROLE_SLOT[role], BACKGROUND_THINKING_DEFAULTS[role]), role);
		}
		assert.deepEqual(eff.models.strong, sub("strong"));
		assert.deepEqual(eff.models.cheap, sub("cheap"));
		assert.deepEqual(eff.models.vision, sub("vision"));
		assert.equal(eff.appearance.mode, "dark");
		assert.equal(eff.appearance.background, null);
		assert.equal(eff.appearance.fontFamily, null);
		assert.equal(eff.appearance.proseFontSize, 16);
		assert.equal(eff.appearance.sessionNameSerif, false);
		assert.equal(eff.appearance.mdRendering.headingWeight, 700);
		// wave 7 collapse: the master switch ONLY + the redesign's chunk
		// budget — absent record resolves the factory 32768 (session-end
		// extraction's mid-session cap, owner, 2026-10-28)
		assert.deepEqual(eff.graph, { enabled: true, rendering: true, extractionChunkTokens: 32_768 });
		assert.deepEqual(eff.compaction, { thresholdTokens: 80_000 });
	});

	it("explicit record values win over every factory default", () => {
		const record: UserSettings = {
			version: 1,
			general: { autoUpdate: false },
			agent: {
				models: { researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } } },
				tools: { research: false },
				prompts: { "system-prompt.md": true },
				search: { engine: "tavily" },
			},
			appearance: { mode: "light", proseFontSize: 20, mdRendering: { headingWeight: 600 } },
			graph: { enabled: false },
		};
		const eff = resolveSettings(record);
		assert.equal(eff.general.autoUpdate, false);
		assert.deepEqual(eff.agent.models.researcher, {
			provider: "openrouter",
			id: "qwen/qwen3.8-flash",
			// thinking NOT overridden → the role's own factory level.
			thinkingLevel: "medium",
		});
		assert.deepEqual(eff.agent.search, { engine: "tavily" });
		assert.deepEqual(eff.agent.tools, { research: false });
		assert.deepEqual(eff.agent.prompts, { "system-prompt.md": true });
		assert.equal(eff.appearance.mode, "light");
		assert.equal(eff.appearance.proseFontSize, 20);
		assert.equal(eff.appearance.mdRendering.headingWeight, 600);
		// wave 7 collapse: the section IS the master switch (absent budget
		// field = the factory budget — a pre-redesign record resolves cleanly).
		assert.deepEqual(eff.graph, { enabled: false, rendering: true, extractionChunkTokens: 32_768 });
		// The DISPLAY split (owner, 2026-10-06): extraction off leaves the
		// rendering switch ON — the data channel and the view are separate.
		assert.equal(renderingEnabled(eff.graph), true);
		// The chunk budget rides the same resolution: stored value wins.
		const budgeted = resolveSettings({ version: 1, graph: { extractionChunkTokens: 2000 } });
		assert.deepEqual(budgeted.graph, { enabled: true, rendering: true, extractionChunkTokens: 2000 });
	});

	it("graph rendering (2026-10-06): display-only — off resolves off, extraction untouched", () => {
		const eff = resolveSettings({ version: 1, graph: { rendering: false } });
		assert.equal(eff.graph.rendering, false, "stored off wins");
		assert.equal(eff.graph.enabled, true, "the data channel is untouched");
		assert.equal(renderingEnabled(eff.graph), false);
		assert.equal(extractionEnabled(eff.graph), true);
		// absent = factory ON (the home defaults to the canvas)
		assert.equal(resolveSettings({ version: 1, graph: {} }).graph.rendering, true);
	});

	it("partial role override: thinkingLevel alone borrows the SLOT's model (or nothing, without one)", () => {
		const eff = resolveSettings({
			version: 1,
			models: { cheap: { model: { provider: "zai", id: "glm-5.3-flash" } } },
			agent: { models: { extractor: { thinkingLevel: "medium" } } },
		});
		assert.deepEqual(eff.agent.models.extractor, {
			provider: "zai",
			id: "glm-5.3-flash",
			thinkingLevel: "medium",
		});
		const bare = resolveSettings({ version: 1, agent: { models: { extractor: { thinkingLevel: "medium" } } } });
		assert.deepEqual(bare.agent.models.extractor, sub("cheap", "medium")); // no pinned model → the subscription floor
	});

	it("resolveModelSpec is field-independent per override aspect", () => {
		const slots = {
			cheap: { model: { provider: "zai", id: "slot-model" }, thinkingLevel: "high" as const },
			vision: { model: { provider: "zai", id: "v-model" }, thinkingLevel: "high" as const },
		};
		assert.deepEqual(
			resolveModelSpec("visualMaker", { model: { provider: "other", id: "x" } }, slots),
			{ provider: "other", id: "x", thinkingLevel: "high" }, // override model + slot level
		);
		assert.deepEqual(resolveModelSpec("auditor", { thinkingLevel: "max" }, slots), {
			provider: "zai",
			id: "slot-model",
			thinkingLevel: "max", // override level + slot model
		});
		assert.equal(resolveModelSpec("auditor", undefined, {}), undefined);
	});
});

describe("the slot tier (BYOK, owner 2026-09-22)", () => {
	it("slot alone re-tiers every role of its tier (no role overrides present)", () => {
		const eff = resolveSettings({ version: 1, models: { cheap: { model: { provider: "zai", id: "glm-5.3-flash" } } } });
		for (const role of ["researcher", "demoBuilder", "extractor", "auditor"] as const) {
			assert.deepEqual(
				eff.agent.models[role],
				{ provider: "zai", id: "glm-5.3-flash", thinkingLevel: BACKGROUND_THINKING_DEFAULTS[role] }, // the role's own level
				role,
			);
		}
		// other tiers untouched (subscription floor)
		assert.deepEqual(eff.agent.models.visualMaker, sub("vision"));
	});

	it("role override still beats the slot; each field independent", () => {
		const eff = resolveSettings({
			version: 1,
			agent: { models: { researcher: { model: { provider: "groq", id: "r-override" } } } },
			models: { cheap: { model: { provider: "zai", id: "r-slot" }, thinkingLevel: "high" } },
		});
		assert.deepEqual(eff.agent.models.researcher, {
			provider: "groq",
			id: "r-override",
			thinkingLevel: "medium", // the role's own level beats the slot's
		});
		assert.deepEqual(eff.agent.models.auditor, { provider: "zai", id: "r-slot", thinkingLevel: "medium" });
	});

	it("the cheap roles start from their own factory levels (owner, 2026-10-28)", () => {
		assert.deepEqual(BACKGROUND_THINKING_DEFAULTS, {
			researcher: "medium",
			demoBuilder: "medium",
			extractor: "low",
			auditor: "medium",
		});
		const eff = resolveSettings({
			version: 1,
			models: { cheap: { model: { provider: "zai", id: "c" }, thinkingLevel: "high" } },
			agent: { models: { auditor: { thinkingLevel: "xhigh" } } },
		});
		assert.equal(eff.agent.models.extractor?.thinkingLevel, "low", "the cheap slot's level never reaches a defaulted role");
		assert.equal(eff.agent.models.auditor?.thinkingLevel, "xhigh", "an explicit override still wins");
		assert.equal(eff.models.cheap?.thinkingLevel, "high", "the stored slot level stays on disk");
		assert.equal(eff.agent.models.visualMaker?.thinkingLevel, undefined, "visualMaker has no role default");
	});

	it("vision slot covers visualMaker AND pdfReader; level-only slots resolve as NULL", () => {
		const eff = resolveSettings({ version: 1, models: { vision: { model: { provider: "zai", id: "v-model" }, thinkingLevel: "max" } } });
		assert.deepEqual(eff.agent.models.visualMaker, { provider: "zai", id: "v-model", thinkingLevel: "max" });
		assert.deepEqual(eff.models.vision, { provider: "zai", id: "v-model", thinkingLevel: "max" });
		// a stored level WITHOUT a model rides the subscription floor's model
		const levelOnly = resolveSettings({ version: 1, models: { strong: { thinkingLevel: "medium" } } });
		assert.deepEqual(levelOnly.models.strong, sub("strong", "medium"));
		assert.deepEqual(levelOnly.agent.models.researcher, sub("cheap", "medium")); // strong's level must not leak into other tiers
	});

	it("resolveSlot: configured iff the model is present", () => {
		assert.deepEqual(resolveSlot({ model: { provider: "zai", id: "m" }, thinkingLevel: "medium" }), {
			provider: "zai",
			id: "m",
			thinkingLevel: "medium",
		});
		assert.deepEqual(resolveSlot({ model: { provider: "zai", id: "m" } }), {
			provider: "zai",
			id: "m",
			thinkingLevel: undefined, // unset → resolved from the default order at build
		});
		assert.equal(resolveSlot({ thinkingLevel: "medium" }), null);
		assert.equal(resolveSlot(undefined), null);
	});

	it("resolveRoleSpec: background roles and the conversation pair share the chain", () => {
		const record: UserSettings = {
			version: 1,
			models: { strong: { model: { provider: "zai", id: "strong-model" } } },
		};
		// conversation pair: slot only (their override is chat-controlled)
		assert.deepEqual(resolveRoleSpec("prober", record), {
			provider: "zai",
			id: "strong-model",
			thinkingLevel: undefined, // level unset → default order at build
		});
		// background role override beats the slot
		const withOverride: UserSettings = {
			...record,
			agent: { models: { researcher: { model: { provider: "groq", id: "r" } } } },
		};
		assert.deepEqual(resolveRoleSpec("researcher", withOverride), { provider: "groq", id: "r", thinkingLevel: "medium" });
		// pdfReader rides the vision slot (never a background override)
		const visionRecord: UserSettings = {
			version: 1,
			models: { vision: { model: { provider: "zai", id: "v" }, thinkingLevel: "low" } },
		};
		assert.deepEqual(resolveRoleSpec("pdfReader", visionRecord), { provider: "zai", id: "v", thinkingLevel: "low" });
		assert.deepEqual(resolveRoleSpec("teacher", null), sub("strong"));
	});
});

describe("resolveConversationSpec (the turn gate's chain)", () => {
	it("chat.model over the strong slot; null when both empty", () => {
		assert.equal(resolveConversationSpec(undefined, null), null);
		assert.deepEqual(
			resolveConversationSpec(undefined, { provider: "zai", id: "s" }),
			{ provider: "zai", id: "s", thinkingLevel: undefined },
		);
		assert.deepEqual(
			resolveConversationSpec({ model: { provider: "groq", id: "c" } }, null),
			{ provider: "groq", id: "c", thinkingLevel: undefined },
		);
	});

	it("bare chat thinking level rides the strong slot's model", () => {
		assert.deepEqual(
			resolveConversationSpec({ thinkingLevel: "high" }, { provider: "zai", id: "s", thinkingLevel: "low" }),
			{ provider: "zai", id: "s", thinkingLevel: "high" },
		);
		// chat.model present, strong unset: level may still ride the chat alone
		assert.deepEqual(
			resolveConversationSpec({ model: { provider: "groq", id: "c" }, thinkingLevel: "max" }, null),
			{ provider: "groq", id: "c", thinkingLevel: "max" },
		);
		// nothing set anywhere: unset level, not a phantom one
		assert.deepEqual(resolveConversationSpec({ model: { provider: "groq", id: "c" } }, null), {
			provider: "groq",
			id: "c",
			thinkingLevel: undefined,
		});
	});
});

describe("the graph channel gates (the wave's seam honoring)", () => {
	it("WRITE channel (extraction): dies with the master switch — the ONLY graph setting since wave 7", () => {
		assert.equal(extractionEnabled({ enabled: true }), true);
		assert.equal(extractionEnabled({ enabled: false }), false);
	});

	it("the write gate rides resolveSettings' factory defaults (all on → open)", () => {
		const eff = resolveSettings(null);
		assert.equal(extractionEnabled(eff.graph), true);
		const off = resolveSettings({ version: 1, graph: { enabled: false } });
		assert.equal(extractionEnabled(off.graph), false);
	});

	it("PROBER GRAPH TOOLS gate (wave 7, owner ruling 2026-09-23): the agent toggle AND the graph master switch compose", () => {
		const graph = { enabled: true };
		assert.equal(graphToolsEnabled({ graph, agent: { graphTools: {} } }), true, "absent subsection = ON");
		assert.equal(graphToolsEnabled({ graph, agent: { graphTools: { enabled: true } } }), true);
		assert.equal(graphToolsEnabled({ graph, agent: { graphTools: { enabled: false } } }), false);
		const dead = { ...graph, enabled: false };
		assert.equal(graphToolsEnabled({ graph: dead, agent: { graphTools: { enabled: true } } }), false, "graph off kills the tools regardless of the toggle");
	});

	it("graphTools rides resolveSettings: absent record → the empty subsection (ON); a record's delta passes through", () => {
		const eff = resolveSettings(null);
		assert.deepEqual(eff.agent.graphTools, {});
		const off = resolveSettings({ version: 1, agent: { graphTools: { enabled: false } } });
		assert.deepEqual(off.agent.graphTools, { enabled: false });
	});
});