import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { parseSidebarSettingsBody, SETTINGS_SECTIONS } from "../src/server/settings-body.ts";

describe("the sidebar settings section (synced, Hot Glass)", () => {
	it("is a known section", () => {
		assert.ok("sidebar" in SETTINGS_SECTIONS);
	});

	it("accepts grouping, filter and folded modules; dedupes the folded list", () => {
		const r = parseSidebarSettingsBody({ grouping: "module", kindFilter: "practice", collapsedModules: ["1M1", "1M1", "__none__"] });
		assert.ok(r.ok);
		if (r.ok) assert.deepEqual(r.settings, { grouping: "module", kindFilter: "practice", collapsedModules: ["1M1", "__none__"] });
	});

	it("rejects an unknown grouping, filter, or a bad folded list", () => {
		assert.equal(parseSidebarSettingsBody({ grouping: "week" }).ok, false);
		assert.equal(parseSidebarSettingsBody({ kindFilter: "everything" }).ok, false);
		assert.equal(parseSidebarSettingsBody({ collapsedModules: ["", "x"] }).ok, false);
		assert.equal(parseSidebarSettingsBody({ collapsedModules: "1M1" }).ok, false);
		assert.equal(parseSidebarSettingsBody([]).ok, false);
	});

	it("the record's sanitizer drops junk and keeps the rest (read from disk)", () => {
		const out = sanitizeUserSettings({ version: 1, sidebar: { grouping: "bogus", kindFilter: "teach", collapsedModules: ["a", 3, "", "a"] } });
		assert.deepEqual(out?.sidebar, { kindFilter: "teach", collapsedModules: ["a"] });
	});
});
