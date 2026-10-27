import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The study tree is fixed at import time: point it at a scratch dir first.
const STUDY = fs.mkdtempSync(path.join(os.tmpdir(), "mt-study-"));
process.env.MT_STUDY_DIR = STUDY;

const study = await import("../src/server/study.ts");
const { syncPairToGraph, questionNodeId, topicNodeId } = await import("../src/server/study-graph.ts");
const { studyFence } = await import("../src/server/study-jobs.ts");
const { studyLogTool, studyLogPrompt } = await import("../src/agent/tools/study-log.ts");
const { confidenceToFive, taxonomyEntries } = await import("../src/core/study.ts");
const { ROOT } = await import("../config.ts");

const CODE = "1M1";
const PAIR = "2026-10-24_1M1_1";
const mod = (...p: string[]) => path.join(STUDY, "modules", CODE, ...p);
const writeJson = (file: string, v: unknown) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(v));
};
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8"));

describe("the study tree", () => {
	it("a module gets the full SETUP_PROMPT layout", () => {
		study.ensureModule(CODE);
		for (const d of ["materials/past_papers", "materials/mark_schemes", "materials/lecture_notes", "materials/spec", "materials/problem_sheets", "sessions", "papers", "attempts", "marking"]) {
			assert.ok(fs.existsSync(mod(d)), d);
		}
		assert.deepEqual(study.listModuleCodes(), [CODE]);
	});

	it("rejects unsafe module codes and pair ids", () => {
		assert.throws(() => study.moduleDir("../etc"));
		assert.throws(() => study.pairInfo(CODE, "../../x"));
	});

	it("serves only files inside the study tree", () => {
		fs.writeFileSync(mod("materials", "spec", "spec.pdf"), "%PDF");
		assert.ok(study.resolveStudyFile(`modules/${CODE}/materials/spec/spec.pdf`));
		assert.equal(study.resolveStudyFile("../outside.txt"), null);
		assert.equal(study.resolveStudyFile(`modules/${CODE}/../../../etc`), null);
	});
});

describe("session logs (the tutor → /make-papers contract)", () => {
	it("appends entries as they happen, in the exact shape", () => {
		const t0 = "2026-10-24T10:00:00.000Z";
		study.appendStudyLog(CODE, "chat_a", { kind: "topic", topic: { topic_id: "beams", sub_skill_id: null, label: "Beam bending" } }, t0);
		study.appendStudyLog(CODE, "chat_a", { kind: "topic", topic: { topic_id: "beams", sub_skill_id: null, label: "Beam bending" } }, t0);
		study.appendStudyLog(
			CODE,
			"chat_a",
			{
				kind: "event",
				event: { sub_skill_id: null, label: "moment at fixed end", prompt_ref: "chat_a#t1", outcome: "slip", step: "multiply load by lever arm", hints_used: 0, confidence: 4 },
			},
			"2026-10-24T10:05:00.000Z",
		);
		const log = readJson(mod("sessions", "chat_a.json"));
		assert.deepEqual(Object.keys(log), ["session_id", "module", "started", "ended", "topics_covered", "events", "self_ratings"]);
		assert.equal(log.session_id, "chat_a");
		assert.equal(log.module, CODE);
		assert.equal(log.started, t0);
		assert.equal(log.ended, "2026-10-24T10:05:00.000Z");
		assert.equal(log.topics_covered.length, 1, "repeat topics dedupe");
		assert.deepEqual(Object.keys(log.events[0]), ["time", "sub_skill_id", "label", "prompt_ref", "outcome", "step", "hints_used", "confidence"]);
		assert.equal(log.events[0].outcome, "slip");
	});

	it("the tool keeps only taxonomy ids — an unknown id becomes null, the label stays", async () => {
		const written: unknown[] = [];
		const tool = studyLogTool({
			module: CODE,
			chatId: "chat_b",
			taxonomy: [{ id: "int-region-limits", label: "Set the limits", topic_id: "integration" }],
			append: (e) => written.push(e),
		});
		await tool.execute("call_1", { kind: "attempt", label: "limits", sub_skill_id: "made-up-id", outcome: "method_gap", step: "inner limits", confidence: 5 });
		await tool.execute("call_2", { kind: "attempt", label: "limits", sub_skill_id: "int-region-limits", outcome: "correct", step: "inner limits", prompt_ref: "q9" });
		const [first, second] = written as { event: { sub_skill_id: string | null; label: string; prompt_ref: string | null } }[];
		assert.equal(first!.event.sub_skill_id, null);
		assert.equal(first!.event.label, "limits");
		assert.equal(second!.event.sub_skill_id, "int-region-limits");
		assert.equal(second!.event.prompt_ref, "chat_b#q9");
	});

	it("an attempt without an outcome or step is refused (the loop turns the throw into a retryable error)", async () => {
		const tool = studyLogTool({ module: CODE, chatId: "c", taxonomy: [], append: () => {} });
		await assert.rejects(tool.execute("x", { kind: "attempt", label: "y" }), /needs an outcome/);
		await assert.rejects(tool.execute("x", { kind: "attempt", label: "y", outcome: "slip", step: " " }), /specific step/);
	});

	it("the prompt lists the taxonomy, or says to pass null ids when there is none", () => {
		assert.match(studyLogPrompt({ module: CODE, taxonomy: [] }), /no taxonomy yet/);
		assert.match(studyLogPrompt({ module: CODE, taxonomy: [{ id: "a-b", label: "Step", topic_id: "t" }] }), /- a-b: Step \(topic t\)/);
	});

	it("the tool's outcome literals are exactly the contract's", async () => {
		const { studyLogInputSchema } = await import("../src/agent/tools/study-log.ts");
		const { STUDY_OUTCOMES } = await import("../src/core/study.ts");
		const literals = (studyLogInputSchema().properties.outcome as unknown as { anyOf: { const: string }[] }).anyOf.map((l) => l.const);
		assert.deepEqual(literals, [...STUDY_OUTCOMES]);
	});

	it("points the agent at the module's own materials, with absolute paths", () => {
		const prompt = studyLogPrompt({
			module: CODE,
			taxonomy: [],
			materials: { dir: "D:/study/modules/1M1/materials", files: { lecture_notes: ["notes.pdf"], spec: [], past_papers: ["2024.pdf"] } },
		});
		assert.match(prompt, /materials are in D:\/study\/modules\/1M1\/materials/);
		assert.match(prompt, /- lecture_notes\/ \(1\): notes\.pdf/);
		assert.match(prompt, /- past_papers\/ \(1\): 2024\.pdf/);
		assert.doesNotMatch(prompt, /- spec\//, "empty folders are left out");
		assert.match(studyLogPrompt({ module: CODE, taxonomy: [], materials: { dir: "D:/m", files: { spec: [] } } }), /still empty/);
	});

	it("maps the app's confidence rail onto 1-5", () => {
		assert.deepEqual([0, 30, 50, 70, 90, 100].map(confidenceToFive), [1, 2, 3, 4, 5, 5]);
	});

	it("reads sub-skills from a nested taxonomy", () => {
		const entries = taxonomyEntries({ topics: [{ id: "beams", label: "Beams", sub_skills: [{ id: "beam-moment", label: "Moment at a support" }] }] });
		assert.deepEqual(entries, [
			{ id: "beams", label: "Beams", topic_id: null },
			{ id: "beam-moment", label: "Moment at a support", topic_id: "beams" },
		]);
	});
});

describe("hand-in and marking (only the learner approves)", () => {
	const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

	it("photos save as Q<n>_p<page>.jpg and must be JPEG", () => {
		assert.equal(study.saveAttempt(CODE, PAIR, "3", 1, jpeg), "Q3_p1.jpg");
		assert.ok(fs.existsSync(mod("attempts", PAIR, "Q3_p1.jpg")));
		assert.throws(() => study.saveAttempt(CODE, PAIR, "3", 2, Buffer.from("PNG...")));
		assert.throws(() => study.saveAttempt(CODE, PAIR, "../3", 1, jpeg));
	});

	it("edits keep the proposed status; approval is the only way to approved; approved is final", () => {
		writeJson(mod("marking", PAIR, "marking.json"), {
			pair_id: PAIR,
			status: "proposed",
			marked_at: "2026-10-24T12:00:00Z",
			parts: [{ paper: 1, number: "3a", sub_skill_id: "beam-moment", marks_available: 4, marks_awarded: 2, lost: [{ code: "M1", type: "M", step: "lever arm", evidence: "M = F", common_error: null }], attempted: true, unreadable: false, note: "" }],
		});
		const edited = study.updateMarkingParts(CODE, PAIR, [{ ...study.readMarking(CODE, PAIR)!.parts[0]!, marks_awarded: 3 }]);
		assert.equal(edited.status, "proposed");
		const approved = study.approveMarking(CODE, PAIR, "2026-10-25T09:00:00.000Z");
		assert.equal(approved.status, "approved");
		assert.equal(readJson(mod("marking", PAIR, "marking.json")).status, "approved");
		assert.throws(() => study.updateMarkingParts(CODE, PAIR, []), /already approved/);
	});
});

describe("paper questions into the knowledge graph", () => {
	it("imports each question once, chained to its topic, then attaches the approved marking once", () => {
		writeJson(mod("taxonomy.json"), { topics: [{ id: "beams", label: "Beams", sub_skills: [{ id: "beam-moment", label: "Moment at a support" }] }] });
		writeJson(mod("papers", PAIR, "questions.json"), {
			pair_id: PAIR,
			module: CODE,
			parts: [
				{ paper: 1, number: "3a", block: "beam-moment/d", topic_id: "beams", sub_skill_id: "beam-moment", marks: 4 },
				{ paper: 2, number: "1", topic_id: "beams", sub_skill_id: "beam-moment", marks: 6 },
			],
		});
		const nodes: { id: string; aliases: string[] }[] = [];
		const chains: { premises: string[]; conclusion: string }[] = [];
		const graph = {
			appendNode: (n: { id: string; aliases: string[] }) => void nodes.push(n),
			appendChain: (c: { premises: string[]; conclusion: string }) => void chains.push(c),
			upsertSource: () => {},
			readNodes: () => nodes as never,
		};
		const first = syncPairToGraph(graph as never, CODE, PAIR);
		assert.deepEqual(first, { questions: 2, marked: 1 }, "approved marking from the previous test attaches too");
		const topic = topicNodeId(CODE, "beams");
		assert.equal(nodes.filter((n) => n.id === topic).length, 1, "one topic node for both questions");
		assert.equal(chains.length, 2);
		assert.ok(chains.every((c) => c.conclusion === topic));
		const marked = nodes.find((n) => n.id === questionNodeId(CODE, PAIR, "1", "3a") && n.aliases.length);
		assert.match(marked!.aliases[0]!, /^Marked 2026-10-25: 3\/4; lost M1 at "lever arm"$/);
		assert.deepEqual(syncPairToGraph(graph as never, CODE, PAIR), { questions: 0, marked: 0 }, "idempotent");
	});
});

describe("the headless runs' fence", () => {
	const call = (tool_name: string, tool_input: Record<string, unknown>) =>
		studyFence({ hook_event_name: "PreToolUse", tool_name, tool_input } as never, undefined, { signal: new AbortController().signal });
	const decision = (out: unknown) => (out as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision;

	it("allows the study tree, denies everything else", async () => {
		assert.equal(decision(await call("Read", { file_path: path.join(STUDY, "modules", CODE, "taxonomy.json") })), undefined);
		assert.equal(decision(await call("Write", { file_path: path.join(ROOT, "src", "evil.ts") })), "deny");
		assert.equal(decision(await call("Read", { file_path: "C:\\Windows\\win.ini" })), "deny");
	});

	it("reads of .claude/ are allowed, writes are not", async () => {
		assert.equal(decision(await call("Read", { file_path: path.join(ROOT, ".claude", "skills", "make-papers", "SKILL.md") })), undefined);
		assert.equal(decision(await call("Edit", { file_path: path.join(ROOT, ".claude", "skills", "make-papers", "SKILL.md") })), "deny");
	});

	it("a path-less search is pointed at the study tree", async () => {
		const out = (await call("Glob", { pattern: "**/*.pdf" })) as unknown as { hookSpecificOutput: { updatedInput: { path: string } } };
		assert.equal(out.hookSpecificOutput.updatedInput.path, STUDY);
	});

	it("non-file tools pass through", async () => {
		assert.equal(decision(await call("Bash", { command: "python -V" })), undefined);
	});
});
