import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { WORKSPACE_ROOT } from "../config.ts";
import { engineUnavailable } from "../src/server/study-jobs.ts";
import { fenced } from "../src/server/study-gemini.ts";
import { studyRoot } from "../src/server/study.ts";

describe("paper engine chain", () => {
	it("moves on when the engine can't serve the run", () => {
		for (const m of [
			"Claude AI usage limit reached|1793000000",
			"Not logged in · Please run /login",
			"authentication_failed",
			"Your credit balance is too low to access the Anthropic API.",
			"rate_limit",
			"Gemini isn't signed in on this computer. Open Settings → This computer, sign in with Google, then try again.",
			"RESOURCE_EXHAUSTED: quota exceeded",
		]) {
			assert.ok(engineUnavailable(m), m);
		}
	});

	it("stops on a skill that went wrong for any other reason", () => {
		for (const m of ["latexmk failed: ! Undefined control sequence", "Stopped: error_max_turns", "no module 9X9"]) {
			assert.ok(!engineUnavailable(m), m);
		}
	});
});

describe("the Gemini route's file fence", () => {
	it("allows study/ for reads and writes, and .claude/ for reads only", () => {
		const inStudy = path.relative(WORKSPACE_ROOT, path.join(studyRoot(), "modules", "X", "taxonomy.json"));
		assert.equal(typeof fenced(inStudy, "write"), "string");
		assert.equal(typeof fenced(".claude/skills/make-papers/SKILL.md", "read"), "string");
		assert.equal(typeof fenced(".claude/skills/make-papers/SKILL.md", "write"), "object");
	});

	it("refuses anything outside, including climbing out of study/", () => {
		for (const p of ["config.ts", "../outside.txt", path.join(studyRoot(), "..", "data", "settings.json"), ""]) {
			assert.equal(typeof fenced(p, "read"), "object", p);
		}
	});
});
