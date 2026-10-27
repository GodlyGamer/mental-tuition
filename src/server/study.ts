/**
 * The study tree on disk (personal fork, 2026-10-24) — the plumbing the
 * practice-paper pipeline (.claude/skills/make-papers, mark-attempts)
 * reads from and writes to. Layout (CLAUDE.md, "Study tree"):
 *
 *   study/modules/<CODE>/
 *     materials/{past_papers,mark_schemes,lecture_notes,spec,problem_sheets}/
 *     taxonomy.json        written by /make-papers, read by the tutor
 *     sessions/            one JSON file per module-tagged tutor session
 *     papers/<PAIR_ID>/    PDFs, questions.json, verification.md
 *     attempts/<PAIR_ID>/  uploaded photos, Q<n>_p<page>.jpg
 *     marking/<PAIR_ID>/marking.json
 *
 * Every write is atomic (temp file + rename) so a crash never leaves a
 * torn JSON file the skills would then misread.
 */

import fs from "node:fs";
import path from "node:path";
import { STUDY_ROOT } from "../../config.ts";
import {
	isModuleCode,
	isPairId,
	markingTotals,
	taxonomyEntries,
	type Marking,
	type MarkingPart,
	type StudyEvent,
	type StudySelfRating,
	type StudySessionLog,
	type StudyTopic,
	type TaxonomySubSkill,
} from "../core/study.ts";

export const MATERIAL_FOLDERS = ["past_papers", "mark_schemes", "lecture_notes", "spec", "problem_sheets"] as const;

export function studyRoot(): string {
	return STUDY_ROOT;
}

function modulesDir(): string {
	return path.join(STUDY_ROOT, "modules");
}

export function moduleDir(code: string): string {
	if (!isModuleCode(code)) throw new Error(`invalid module code "${code}"`);
	return path.join(modulesDir(), code);
}

function pairPath(code: string, area: "papers" | "attempts" | "marking", pair: string): string {
	if (!isPairId(pair)) throw new Error(`invalid paper pair "${pair}"`);
	return path.join(moduleDir(code), area, pair);
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
}

function writeJsonAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
	fs.renameSync(tmp, file);
}

function listDirs(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return [];
	}
}

function listFiles(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isFile())
			.map((d) => d.name);
	} catch {
		return [];
	}
}

// ─── modules ────────────────────────────────────────────────────────────────

/** Create a module's folder tree (idempotent). */
export function ensureModule(code: string): void {
	const root = moduleDir(code);
	for (const f of MATERIAL_FOLDERS) fs.mkdirSync(path.join(root, "materials", f), { recursive: true });
	for (const f of ["sessions", "papers", "attempts", "marking"]) fs.mkdirSync(path.join(root, f), { recursive: true });
}

/** The module's optional display name (Hot Glass, owner 2026-10-27):
 *  study/modules/<CODE>/module.json { "name" } — shown in the sidebar's
 *  MODULE grouping ("1M1 · Mechanics · 4"). Absent = the code alone. */
export function moduleName(code: string): string | null {
	const raw = readJson<{ name?: unknown }>(path.join(moduleDir(code), "module.json"));
	return typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : null;
}

/** Set (or, with an empty name, clear) the module's display name. */
export function setModuleName(code: string, name: string | null): void {
	const file = path.join(moduleDir(code), "module.json");
	const trimmed = name?.trim() ?? "";
	if (!trimmed) {
		fs.rmSync(file, { force: true });
		return;
	}
	writeJsonAtomic(file, { name: trimmed });
}

export function listModuleCodes(): string[] {
	return listDirs(modulesDir()).filter(isModuleCode).sort();
}

export function moduleExists(code: string): boolean {
	return isModuleCode(code) && fs.existsSync(moduleDir(code));
}

/** The module's materials, folder by folder (absolute dir + file names). */
export function listMaterials(code: string): { dir: string; files: Record<(typeof MATERIAL_FOLDERS)[number], string[]> } {
	const dir = path.join(moduleDir(code), "materials");
	const files = Object.fromEntries(
		MATERIAL_FOLDERS.map((f) => [f, listFiles(path.join(dir, f)).sort()]),
	) as Record<(typeof MATERIAL_FOLDERS)[number], string[]>;
	return { dir, files };
}

export function readTaxonomy(code: string): TaxonomySubSkill[] {
	return taxonomyEntries(readJson(path.join(moduleDir(code), "taxonomy.json")));
}

// ─── session logs (SETUP_PROMPT.md §3) ──────────────────────────────────────

export function sessionFile(code: string, sessionId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error(`invalid session id "${sessionId}"`);
	return path.join(moduleDir(code), "sessions", `${sessionId}.json`);
}

function readSession(code: string, sessionId: string, now: string): StudySessionLog {
	return (
		readJson<StudySessionLog>(sessionFile(code, sessionId)) ?? {
			session_id: sessionId,
			module: code,
			started: now,
			ended: now,
			topics_covered: [],
			events: [],
			self_ratings: [],
		}
	);
}

export type StudyLogEntry =
	| { kind: "topic"; topic: StudyTopic }
	| { kind: "event"; event: Omit<StudyEvent, "time"> }
	| { kind: "self_rating"; rating: StudySelfRating };

/** Append one entry to a session's log the moment it happens (a crash
 *  keeps everything logged so far); `ended` moves with every write. */
export function appendStudyLog(code: string, sessionId: string, entry: StudyLogEntry, now = new Date().toISOString()): StudySessionLog {
	ensureModule(code);
	const log = readSession(code, sessionId, now);
	log.ended = now;
	if (entry.kind === "topic") {
		const t = entry.topic;
		const dup = log.topics_covered.some(
			(x) => x.label === t.label && x.topic_id === t.topic_id && x.sub_skill_id === t.sub_skill_id,
		);
		if (!dup) log.topics_covered.push(t);
	} else if (entry.kind === "event") {
		log.events.push({ time: now, ...entry.event });
	} else {
		log.self_ratings.push(entry.rating);
	}
	writeJsonAtomic(sessionFile(code, sessionId), log);
	return log;
}

// ─── paper pairs, attempts, marking ─────────────────────────────────────────

export interface PairQuestion {
	paper: number | string;
	number: string;
	marks: number | null;
	topic_id: string | null;
	sub_skill_id: string | null;
	block: string | null;
}

export interface PairInfo {
	id: string;
	/** Study-root-relative paths of the four PDFs (null = not built). */
	pdfs: { paper1: string | null; paper1Scheme: string | null; paper2: string | null; paper2Scheme: string | null };
	questions: PairQuestion[];
	attempts: string[];
	marking: { status: Marking["status"]; awarded: number; available: number } | null;
	hasVerification: boolean;
}

export interface ModuleInfo {
	code: string;
	/** The display name from module.json, or null. */
	name: string | null;
	materials: Record<(typeof MATERIAL_FOLDERS)[number], number>;
	sessions: number;
	hasTaxonomy: boolean;
	pairs: PairInfo[];
}

function rel(abs: string): string {
	return path.relative(STUDY_ROOT, abs).split(path.sep).join("/");
}

/** The parts listed in a pair's questions.json, read defensively (the
 *  file is model-written: parts may sit at the top level or nested). */
export function readPairQuestions(code: string, pair: string): PairQuestion[] {
	const raw = readJson<Record<string, unknown>>(path.join(pairPath(code, "papers", pair), "questions.json"));
	if (!raw) return [];
	const parts: unknown[] = Array.isArray(raw.parts)
		? raw.parts
		: Array.isArray(raw.questions)
			? raw.questions
			: Array.isArray(raw)
				? (raw as unknown[])
				: [];
	return parts.flatMap((p) => {
		if (!p || typeof p !== "object") return [];
		const r = p as Record<string, unknown>;
		const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
		const number = str(r.number);
		if (!number) return [];
		return [
			{
				paper: (r.paper as number | string) ?? "",
				number,
				marks: typeof r.marks === "number" ? r.marks : null,
				topic_id: str(r.topic_id),
				sub_skill_id: str(r.sub_skill_id),
				block: str(r.block),
			},
		];
	});
}

export function pairInfo(code: string, pair: string): PairInfo {
	const papers = pairPath(code, "papers", pair);
	const pdf = (name: string) => {
		const file = path.join(papers, name);
		return fs.existsSync(file) ? rel(file) : null;
	};
	const marking = readMarking(code, pair);
	return {
		id: pair,
		pdfs: {
			paper1: pdf(`${code}_Paper1.pdf`),
			paper1Scheme: pdf(`${code}_Paper1_MarkScheme.pdf`),
			paper2: pdf(`${code}_Paper2.pdf`),
			paper2Scheme: pdf(`${code}_Paper2_MarkScheme.pdf`),
		},
		questions: readPairQuestions(code, pair),
		attempts: listFiles(pairPath(code, "attempts", pair)).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort(),
		marking: marking ? { status: marking.status, ...markingTotals(marking) } : null,
		hasVerification: fs.existsSync(path.join(papers, "verification.md")),
	};
}

export function moduleInfo(code: string): ModuleInfo {
	const root = moduleDir(code);
	const materials = Object.fromEntries(
		MATERIAL_FOLDERS.map((f) => [f, listFiles(path.join(root, "materials", f)).length]),
	) as ModuleInfo["materials"];
	return {
		code,
		name: moduleName(code),
		materials,
		sessions: listFiles(path.join(root, "sessions")).filter((f) => f.endsWith(".json")).length,
		hasTaxonomy: fs.existsSync(path.join(root, "taxonomy.json")),
		pairs: listDirs(path.join(root, "papers"))
			.filter(isPairId)
			.sort()
			.reverse()
			.map((p) => pairInfo(code, p)),
	};
}

/** Save one photo of an attempt as attempts/<PAIR>/Q<n>_p<page>.jpg. The
 *  client converts every upload to JPEG first, so the name never lies. */
export function saveAttempt(code: string, pair: string, question: string, page: number, jpeg: Buffer): string {
	if (!/^[0-9]+[a-z]?$/i.test(question)) throw new Error(`invalid question "${question}"`);
	if (!Number.isInteger(page) || page < 1 || page > 99) throw new Error(`invalid page ${page}`);
	if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("attempt photos must be JPEG");
	const dir = pairPath(code, "attempts", pair);
	fs.mkdirSync(dir, { recursive: true });
	const name = `Q${question}_p${page}.jpg`;
	fs.writeFileSync(path.join(dir, name), jpeg);
	return name;
}

export function deleteAttempt(code: string, pair: string, name: string): void {
	if (!/^Q[0-9]+[a-z]?_p[0-9]+\.jpg$/i.test(name)) throw new Error(`invalid attempt file "${name}"`);
	fs.rmSync(path.join(pairPath(code, "attempts", pair), name), { force: true });
}

function markingFile(code: string, pair: string): string {
	return path.join(pairPath(code, "marking", pair), "marking.json");
}

export function readMarking(code: string, pair: string): Marking | null {
	const m = readJson<Marking>(markingFile(code, pair));
	return m && Array.isArray(m.parts) ? m : null;
}

/** The learner's edits to a PROPOSED marking. Status never changes here. */
export function updateMarkingParts(code: string, pair: string, parts: MarkingPart[]): Marking {
	const m = readMarking(code, pair);
	if (!m) throw new Error("no marking to edit");
	if (m.status === "approved") throw new Error("this marking is already approved");
	const next: Marking = { ...m, parts };
	writeJsonAtomic(markingFile(code, pair), next);
	return next;
}

/** THE ONLY place "approved" is ever written (SETUP_PROMPT.md §4). */
export function approveMarking(code: string, pair: string, now = new Date().toISOString()): Marking {
	const m = readMarking(code, pair);
	if (!m) throw new Error("no marking to approve");
	const next: Marking = { ...m, status: "approved", approved_at: now };
	writeJsonAtomic(markingFile(code, pair), next);
	return next;
}

/** Resolve a study-root-relative path for serving, refusing anything
 *  outside the study tree. */
export function resolveStudyFile(relPath: string): string | null {
	const abs = path.resolve(STUDY_ROOT, relPath);
	const root = path.resolve(STUDY_ROOT) + path.sep;
	if (!abs.startsWith(root)) return null;
	return fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : null;
}

/** Is an absolute path inside the study tree? (the headless jobs' fence) */
export function insideStudy(absPath: string): boolean {
	const root = path.resolve(STUDY_ROOT);
	const abs = path.resolve(absPath);
	return abs === root || abs.startsWith(root + path.sep);
}
