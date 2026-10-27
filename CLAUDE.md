@AGENTS.md

## Study tree (practice-paper pipeline)

The tutor app and the `.claude/` skills `/make-papers` and `/mark-attempts` share the files below. Treat their shapes as a contract: if one side writes a different shape, papers stop targeting the learner's weaknesses without any error. The app side lives in `src/core/study.ts` (shapes), `src/server/study.ts` (files), `src/agent/tools/study-log.ts` (session logging) and `components/papers/` (Practice papers section).

```
study/modules/<CODE>/                 CODE = module code, e.g. 1M1 (gitignored: personal materials)
  materials/past_papers/ mark_schemes/ lecture_notes/ spec/ problem_sheets/
  module.json                         optional { "name" }, shown in the sidebar's module grouping; written by the app (Modules page), never by a skill
  taxonomy.json                       topic and sub-skill ids; written by /make-papers, read by the tutor
  sessions/<session_id>.json          one per module-tagged tutor session (session_id = the app's chat id)
  papers/<PAIR_ID>/                   PDFs, questions.json, verification.md   (PAIR_ID = YYYY-MM-DD_<CODE>_<n>)
  attempts/<PAIR_ID>/Q<n>_p<page>.jpg uploaded photos
  marking/<PAIR_ID>/marking.json
```

Session log, appended entry by entry as the session runs (never only at the end):

```
{ "session_id", "module", "started", "ended",
  "topics_covered": [ { "topic_id", "sub_skill_id", "label" } ],
  "events": [ { "time", "sub_skill_id", "label", "prompt_ref",
                "outcome": "correct" | "method_gap" | "slip" | "needed_hint" | "skipped",
                "step", "hints_used", "confidence": 1-5 or null } ],
  "self_ratings": [ { "sub_skill_id", "label", "confidence": 1-5 } ] }
```

- Ids come from `taxonomy.json`. An id not in the taxonomy is written as `null` with the label kept: a guessed id misfiles evidence silently. `/make-papers` may add taxonomy ids but never renames or deletes one.
- `method_gap` = wrong principle or couldn't start; `slip` = right method, wrong algebra or arithmetic.
- `marking.json` is written by `/mark-attempts` with `"status": "proposed"`. Only the learner's approval in the app (`POST /api/study/<CODE>/pairs/<PAIR_ID>/marking/approve`) sets `"status": "approved"`; no skill, script or agent may set it. `/make-papers` reads approved markings only.
- In the desktop app this tree lives in the learner's synced workspace folder (Google Drive), not the repo: the shell sets `MT_WORKSPACE_DIR`, `MT_DATA_DIR` and `MT_STUDY_DIR` (`config.ts`) and copies the shipped `.claude/skills` and `.claude/agents` into `<workspace>/.claude` on launch. Per-machine state (sign-ins, the Antigravity download, `setup.json`) stays in `MT_LOCAL_DIR`.
- Headless runs (`src/server/study-jobs.ts`) go through the Agent SDK on the Claude login, with file tools fenced to `study/` (reads of `.claude/` allowed); marking runs without Bash.
- Paper questions join the knowledge graph (`src/server/study-graph.ts`): a node per question, chained to a node per taxonomy topic; approved results attach to the question node.
