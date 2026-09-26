# C02-07: Agent contract and docs, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-09-26),** after review round 1 (`H:/lethal-coord/reviews/C02-07-plan/review-r1.md`). Every pin now EXECUTES what the documents tell an agent to run (verify examples go through `parseVerifyRequest`; the explain-to-verify recipe and the mark-key recipe are extracted from the document and run; a mark built from the recipe is loaded and matched), rather than checking that a string is present. The flag-ownership test no longer uses `FLAG_OWNERS` as its own oracle: an accepted flag must CHANGE the parsed config. Q1 is a yes/no with measured per-subcommand lists and a caller audit. The R230 limit, the README "does not even publish it" contradiction and the al-runner claim are in scope. See "Review responses" at the end.

**Revision 3 (2026-09-26),** after review round 2 (`H:/lethal-coord/reviews/C02-07-plan/review-r2.md`) and the owner's answer to Q1 (YES). The "no" path is gone; Q1 lists the exact newly refused flags per subcommand. C10 now pins the recipe's `--db` and `--tests`. The ownership tests gain an independent spec (the help text's usage lines and per-subcommand option sections, which name exactly the owners), a non-empty-owners check, and a named, pinned list of flags whose parsed value a precedence rule can override. The caller audit is split into a prose/literal-command audit and an enumerated list of programmatic spawns and CLI entry calls, and the no-live-gate waiver is tied to that list.

**Goal:** An outside agent can run the whole hardening loop (`lethal run`, `lethal explain`, write a test, `lethal verify`) from `docs/using-lethal-from-an-agent.md` and `skills/lethal-mutation-testing/SKILL.md` alone, and every command, recipe, flag, exit code, schema version, refusal reason and value set those two documents promise is checked by `packages/runner/tests/agent-contract.test.ts` by RUNNING it against the real code.

**Architecture:** No new module. Three changes. (1) `FLAG_OWNERS` in `cli.ts` becomes total, and a test proves, independently of that table, that no invocation accepts a flag without the flag changing what it parsed (measured on master: `lethal explain r.json --out x.json` is accepted and writes nothing). (2) `agent-contract.test.ts` extracts every command, recipe and value table from the two documents and executes or compares it against the code. (3) The two documents gain the hardening loop, a verify refusal table, and a `(checked)` or `(guidance)` tag on every heading.

**Tech Stack:** Bun + TypeScript, `bun test`. No server, no live gate (see Global Constraints for why, and for when that would change).

**Spec:** GitHub issue #17 (child 7 of epic #10, c02): "`docs/using-lethal-from-an-agent.md`, `SKILL.md`, `agent-contract.test.ts`, `FLAG_OWNERS`. Depends on: 6. Slice." The epic's readiness spike (comment on #10, section 2 line 3): "Shared strict `parseArgs` table and `FLAG_OWNERS` must register `--survivors`, `--tests`; `agent-contract.test.ts` fails if the docs name a flag not in `RUN_FLAGS`." The verify surface is specified by `docs/superpowers/plans/2026-09-26-C02-06-lethal-verify.md` (decisions 1, 2, 6, 7; Tasks 5 to 7), on branch `lethal/lane-code` until C02-06b is accepted.

**Line numbers:** none are load-bearing. Anchor on names.

---

## Open questions for the orchestrator or owner

Q2 to Q4 have a default this plan follows if nobody answers. Q1 is decided.

### Q1: DECIDED, yes (owner, 2026-09-26)

Every subcommand refuses every flag it does not read. `run --dry-run` keeps an exact, shrink-only exemption list for the execution flags it ignores (filed in Task 5, not fixed here). There is no "no" path.

**Newly refused: accepted by `parseCliConfig` today, refused after this task.** Measured on master `eb9744f` (44 flags): each flag added to the invocation named, with a placeholder value; a flag counts only if the parse returns today AND the flag is not owned under the Task 1 Step 3 table. Flags already refused today (by `FLAG_OWNERS` or a verb or value check) are not listed.

| Invocation | Newly refused |
|---|---|
| `run` (normal and `--dry-run`) | `--server`, `--instance`, `--file` (3) |
| `init` | `--tests`, `--backend`, `--db`, `--config`, `--skip-known-survivors`, `--dry-run`, `--workers`, `--compile-concurrency`, `--server`, `--instance`, `--file`, `--keep-env`, `--allow-expiring-env`, `--selector-id`, `--control-id`, `--table-id`, `--only`, `--exclude`, `--operator`, `--lines`, `--changed-since`, `--tests-only`, `--max-guards-per-batch`, `--mutant-timeout-ms`, `--max-methods-per-call`, `--request-ceiling-ms`, `--no-group-runs`, `--resume`, `--resume-run`, `--retry-stranded`, `--stop-hung-sessions`, `--allow-large-run`, `--progress-out` (33) |
| `clear-quarantine` | `--project`, `--tests`, `--backend`, `--db`, `--out`, `--config`, `--skip-known-survivors`, `--dry-run`, `--workers`, `--compile-concurrency`, `--file`, `--keep-env`, `--allow-expiring-env`, `--selector-id`, `--control-id`, `--table-id`, `--only`, `--exclude`, `--operator`, `--lines`, `--changed-since`, `--tests-only`, `--max-guards-per-batch`, `--mutant-timeout-ms`, `--max-methods-per-call`, `--request-ceiling-ms`, `--no-group-runs`, `--resume`, `--resume-run`, `--retry-stranded`, `--stop-hung-sessions`, `--allow-large-run`, `--progress-out` (33) |
| `clear-ceiling` | `--tests`, `--backend`, `--out`, `--skip-known-survivors`, `--dry-run`, `--workers`, `--compile-concurrency`, `--keep-env`, `--allow-expiring-env`, `--selector-id`, `--control-id`, `--table-id`, `--only`, `--exclude`, `--operator`, `--lines`, `--changed-since`, `--tests-only`, `--max-guards-per-batch`, `--mutant-timeout-ms`, `--max-methods-per-call`, `--request-ceiling-ms`, `--no-group-runs`, `--resume`, `--resume-run`, `--retry-stranded`, `--stop-hung-sessions`, `--allow-large-run`, `--progress-out` (29) |
| `force-reset-lease` | `--tests`, `--backend`, `--db`, `--out`, `--skip-known-survivors`, `--dry-run`, `--workers`, `--compile-concurrency`, `--file`, `--keep-env`, `--allow-expiring-env`, `--selector-id`, `--control-id`, `--table-id`, `--only`, `--exclude`, `--operator`, `--lines`, `--changed-since`, `--tests-only`, `--max-guards-per-batch`, `--mutant-timeout-ms`, `--max-methods-per-call`, `--request-ceiling-ms`, `--no-group-runs`, `--resume`, `--resume-run`, `--retry-stranded`, `--stop-hung-sessions`, `--allow-large-run`, `--progress-out` (31) |
| `doctor` | `--backend`, `--db`, `--out`, `--skip-known-survivors`, `--dry-run`, `--workers`, `--compile-concurrency`, `--server`, `--instance`, `--file`, `--keep-env`, `--allow-expiring-env`, `--selector-id`, `--control-id`, `--table-id`, `--only`, `--exclude`, `--operator`, `--lines`, `--changed-since`, `--tests-only`, `--max-guards-per-batch`, `--mutant-timeout-ms`, `--max-methods-per-call`, `--request-ceiling-ms`, `--no-group-runs`, `--resume`, `--resume-run`, `--retry-stranded`, `--stop-hung-sessions`, `--allow-large-run`, `--progress-out` (32) |
| `explain` | `--project`, `--tests`, `--backend`, `--db`, `--out`, `--config`, `--skip-known-survivors`, `--dry-run`, `--workers`, `--compile-concurrency`, `--server`, `--instance`, `--file`, `--keep-env`, `--allow-expiring-env`, `--selector-id`, `--control-id`, `--table-id`, `--only`, `--exclude`, `--operator`, `--lines`, `--changed-since`, `--tests-only`, `--max-guards-per-batch`, `--mutant-timeout-ms`, `--max-methods-per-call`, `--request-ceiling-ms`, `--no-group-runs`, `--resume`, `--resume-run`, `--retry-stranded`, `--stop-hung-sessions`, `--allow-large-run`, `--progress-out` (35) |
| `export` | `--tests`, `--backend`, `--db`, `--config`, `--skip-known-survivors`, `--dry-run`, `--workers`, `--compile-concurrency`, `--server`, `--instance`, `--file`, `--keep-env`, `--allow-expiring-env`, `--selector-id`, `--control-id`, `--table-id`, `--only`, `--exclude`, `--operator`, `--lines`, `--changed-since`, `--tests-only`, `--max-guards-per-batch`, `--mutant-timeout-ms`, `--max-methods-per-call`, `--request-ceiling-ms`, `--no-group-runs`, `--resume`, `--resume-run`, `--retry-stranded`, `--stop-hung-sessions`, `--allow-large-run`, `--progress-out` (33) |
| `campaign freeze`, `anchors`, `compare` (same list for each verb) | `--tests`, `--backend`, `--db`, `--out`, `--config`, `--skip-known-survivors`, `--dry-run`, `--workers`, `--compile-concurrency`, `--server`, `--instance`, `--file`, `--keep-env`, `--allow-expiring-env`, `--selector-id`, `--control-id`, `--table-id`, `--only`, `--exclude`, `--operator`, `--lines`, `--changed-since`, `--tests-only`, `--max-guards-per-batch`, `--mutant-timeout-ms`, `--max-methods-per-call`, `--request-ceiling-ms`, `--no-group-runs`, `--resume`, `--resume-run`, `--retry-stranded`, `--stop-hung-sessions`, `--allow-large-run`, `--progress-out` (34) |
| `verify` | none (C02-06b's `VERIFY_FLAGS` already refuses everything else) |

`run --dry-run` still ignores 19 flags after this task, the exemption: `--tests`, `--backend`, `--out`, `--progress-out`, `--workers`, `--compile-concurrency`, `--keep-env`, `--allow-expiring-env`, `--selector-id`, `--control-id`, `--table-id`, `--skip-known-survivors`, `--max-guards-per-batch`, `--max-methods-per-call`, `--request-ceiling-ms`, `--no-group-runs`, `--retry-stranded`, `--stop-hung-sessions`, `--allow-large-run`.

These lists, the Task 1 Step 3 owners table and the dry-run exemption were all reproduced on `lethal/lane-code` `ca6eef2` (46 flags; `--artifact` and `--survivors` are already refused outside `verify`) by a prototype of Task 1's oracle: the set of subcommands that READ each flag (the parsed config changes) equals the owners table exactly. Task 1 recomputes them after merge; a difference is recorded, not argued.

**What in this repo uses a newly refused flag: nothing found.** Two separate audits (Task 1 Step 6 repeats both after merge):
- *Prose and literal-command audit.* Every `lethal <sub> ...` / `cli.ts <sub> ...` line in the 1,011 tracked text files (600 lines, one match per line, literal text only) run through the new parser: four hits, all prose QUOTING a trap (`CHANGELOG.md`'s R176 entry, two `cli.ts` comment/help lines, a `cli.test.ts` comment). This audit cannot see argv assembled in code.
- *Programmatic callers.* Every `Bun.spawn`, `Bun.spawnSync`, `spawn`, `spawnSync`, `execSync`, `execFile`, and every call of `parseCliConfig`, `runFromCli` and the other `*FromCli` entry points in tracked non-test TypeScript (the enumeration and its result are in Task 1 Step 6). Exactly ONE builds a LethAL CLI argv: `scripts/demo-reset.ts` (`clear-quarantine --server --instance`, `clear-ceiling --project --config`, `doctor --config`), all unaffected. The only in-process caller is `main()` in `cli.ts`. Two places hold `lethal ...` strings as DATA for a hook to inspect, not to execute: `fixtures/do-campaign/preflight.ts` (a `lethal run --project --only --tests-only --allow-large-run` probe, all run-owned) and `packages/runner/tests/campaign-fence.test.ts` (run-owned flags). The itests build no argv.

An outside user's own scripts cannot be known from this repo; the refusal names the owning subcommand, so such a script fails loudly on its first run.

### Q2: one skill or two?

Default: extend `skills/lethal-mutation-testing/SKILL.md` with a "5. Harden a survivor" section. The contract test already reads that file, and a second skill would duplicate the safety rules.

### Q3: the equivalence-mark key

`lethal explain` prints `readerMark.key` only for a survivor that is ALREADY marked. Default: the reference gives the recipe from `report.json` fields, Task 3 builds a marks file from the extracted recipe and proves it loads and matches; the R230 limit (a twin after the first cannot be marked) is stated prominently and pinned so the doc must change when R230 is fixed; Task 5 files printing the key in `explain`. Fixing R230 is NOT done here (separate, scoped change).

### Q4: prose outside the two documents

Default: fix and pin here. Found stale on master: `README.md`'s agent section (exit codes `0`/`1`/`3`, "three output surfaces", "the four rules" while the guide has five); `README.md` line "Your test project is never touched at all: LethAL does not even publish it." (false once `lethal verify` publishes it); `helpText`'s EXIT CODES footer omits `4`; the reference's gift card numbers (43/25/11/7 quoted, 60/34/15/11 committed); the skill's categorical "`al-runner` ... under-reports kills" (the reference and CLAUDE.md say coverage is CONDITIONAL); the R176 comment in `cli.test.ts` claiming its fixed list catches any unowned flag.

## Facts taken from the C02-06b branch

C02-06b is on `lethal/lane-code` (worktree `U:/Git/LethAL-wt/lane-code`). At the first draft of this plan the branch stopped at `1429ef0` (Tasks 5 and 6). At this revision it is at `ca6eef2` and Task 7 (the CLI) has landed there: `420c110 feat(cli): lethal verify (C02-06)`, `ca6eef2 fix(cli): verify refuses a project without app.json before building the backend`. Rows marked **[06b-code]** were read from that branch's code; **[06b-plan]** from its plan only. **Task 0 re-checks every row against master after C02-06b is accepted and merged.**

| Fact | Source | Value at `ca6eef2` |
|---|---|---|
| Subcommand | [06b-code] `VALID_SUBCOMMANDS`, `main` dispatch `parsed.mode === "verify"` to `verifyFromCli` | `verify` |
| Argv | [06b-code] verify branch of `parseCliConfig`, help line | `lethal verify --db <path> --artifact <id> --tests <dir> --survivors <ids> [--config <path>]`; `--db`, `--artifact`, `--tests`, `--survivors` required (each missing one throws `missing required --<flag>`) |
| Flag refusal | [06b-code] `VERIFY_FLAGS` allowlist inside the verify branch, after `refuseFlagsThisSubcommandDoesNotOwn`; message `--<flag> is not accepted by \`lethal verify\` ... Its JSON goes to stdout.`; `FLAG_OWNERS` rows `artifact` and `survivors` with `owners: ["verify"]` | as stated |
| Where ids are validated | [06b-code] NOT in `parseCliConfig`: `verifyFromCli` calls `parseVerifyRequest` before opening the store | a malformed `--artifact` or `--survivors M0004` PARSES as argv and is refused later as `malformed-request`, exit 6 |
| Output | [06b-code] `verifyFromCli` prints `JSON.stringify(output, null, 2)` on stdout, progress on stderr | as stated |
| envTool | [06b-code] `verifyFromCli` | refused `unsupported-config` |
| `VERIFY_SCHEMA_VERSION` | [06b-code] `verify.ts` | `1`; `schemas/verify-v1.schema.json`; row in `schemas/README.md` |
| `VERIFY_VERDICTS` | [06b-code] | `killed`, `survived`, `error`, `skipped` |
| `NEW_TEST_STATES` | [06b-code] | `stable`, `flaky`, `red`, `flaky-unknown` |
| `KILLED_BY` | [06b-code] | `assertion`, `runtime-error`, `other`; `verifyExitCode` takes no `killedBy` |
| `VERIFY_EXIT` | [06b-code] `verify.ts` | `ok 0`, `quarantined 3`, `nothingMeasured 4`, `notAllKilled 5`, `refused 6`; `1` has no constant |
| cli.ts exit constants | [06b-code] | `VERIFY_NOT_ALL_KILLED_EXIT_CODE = VERIFY_EXIT.notAllKilled`, `VERIFY_REFUSED_EXIT_CODE = VERIFY_EXIT.refused` |
| Precedence | [06b-code] `verifyExitCode` | `3`, `6`, `4`, `5`, `0`; all survivors `skipped` gives `0` |
| `VERIFY_REFUSALS` | [06b-code] | 23 values: `malformed-request`, `unknown-artifact`, `batch-not-installed`, `wrong-batch`, `unknown-mutant`, `not-a-survivor`, `carried`, `source-predates-verify`, `source-changed`, `covering-test-unmatched`, `no-tests-to-run`, `unsupported-config`, `project-unreadable`, `equivalence-marks-unreadable`, `stale-artifact`, `artifact-files-unusable`, `artifact-identity-unavailable`, `test-app-manifest-unreadable`, `test-app-symbols-unreadable`, `test-app-compile-failed`, `test-app-version-below-resident`, `test-app-publish-failed`, `test-app-resident-unreadable` |
| Quarantine, not refusal | [06b-code] `TEST_APP_REFUSALS` | `publish-indeterminate`, `publish-anomalous` exit `3` |
| Help | [06b-code] `helpText` | a `VERIFY` block with its own `Exit codes: 0 ... 3 ... 4 ...` line; the EXIT CODES footer still says `0 ok   1 error   3 quarantined` only |
| Skip rule | [06b-plan] decision 6 | a mark in `<project>/lethal.equivalent.json` matching the survivor's R166 identity makes it `skipped`; `equivalenceRisk` never skips |
| Nested test project | [06b-plan] carried item 3 | any edit under a test project nested in the target gives `source-changed`; C02-06b files a roadmap item (id unknown) |
| Later full run | [06b-plan] "Out of scope", R247 | fresh `lethal run`, never `--resume` |
| Test app left installed | [06b-plan] "Out of scope" | verify does not restore the test app |

From master `eb9744f`, not the branch: `FLAG_OWNERS` (9 rows), `RUN_FLAGS` (44), `parseCliConfig`, `QUARANTINED_EXIT_CODE = 3`, `NOTHING_SCORED_EXIT_CODE = 4`, `exitCodeForReport`, the schema version constants, `ARTIFACT_ID_ABSENCES` (`carried`, `not-recorded`, `not-published`), `EQUIVALENCE_MARKS_FILENAME = "lethal.equivalent.json"`, `parseEquivalenceMarks` (requires `{ "marks": [...] }`, a non-empty `reason`, and EXACTLY five `|` fields in `key`), `applyEquivalenceMarks`, `serializeKey` (appends `|<ordinal>` when above 0), `identityKeyOf`, `parseVerifyRequest` (part a), the run default `--db` `<project>/lethal.sqlite`, R230 (open).

## The contract, as testable facts

Each promise, what it is checked against, and the test (task). "Executes" means the test runs the documented thing through the code; a test that only looks for a string says so.

| # | Promise | Checked by | Kind | Test (Task) |
|---|---|---|---|---|
| C1 | Every `lethal ...` command either document shows parses; every `lethal verify` example is also a valid request | `parseCliConfig`, then `parseVerifyRequest` on the parsed `artifact`/`survivors` | executes | "every lethal command the documents show parses", "every verify example is a request verify accepts" (2, 3) |
| C2 | Every accepted flag changes the parsed config, except the named dry-run exemption; a parsed value a precedence rule overrides at runtime is listed by name (`PRECEDENCE_OVERRIDES`); every non-owner refuses by ownership; every owner reads; every row has at least one owner; the owners of every flag equal the subcommands `--help` documents it under | `parseCliConfig` output with and without the flag, and `helpText` (neither is `FLAG_OWNERS`) | executes | "no invocation ignores a flag it accepts", "the precedence overrides are exact", "every owner reads its flag", "every non-owner refuses by ownership", "every row has an owner", "every flag's owners are where --help documents it" (1) |
| C3 | The reference's ownership table equals `FLAG_OWNERS` for the rows it lists (subcommand level; campaign verbs are refused further by `parseCampaignConfig`, stated in the doc) | `FLAG_OWNERS` (itself proved by C2) | compares | "the reference's ownership table is FLAG_OWNERS" (2) |
| C4 | The traps `run --report`, `explain --out`, `verify --out` are refused, and the Traps section names each | `parseCliConfig` | executes + scoped text | "the traps the reference warns about are refused" (2, 3) |
| C5 | `run` exit codes: `0` completed and says nothing about survivors, `1` error, `3` quarantined, `4` nothing scored; `3` beats `4` | `exitCodeForReport`, constants | executes + scoped table | "the run exit-code table is exitCodeForReport's" (2) |
| C6 | `verify` exit codes `0` `1` `3` `4` `5` `6`, precedence `3, 6, 4, 5, 0` with a competing-condition case at every boundary, all-skipped is `0` | `verifyExitCode`, `VERIFY_EXIT`, cli.ts constants | executes + parsed table | "verify exit codes and their precedence" (3) |
| C7 | Each schema version; every linked schema file exists; each current one is linked | constants, `schemas/` | compares | existing, plus "every linked schema exists" (2), `verifySchemaVersion` (3) |
| C8 | Verify's value sets, per field, exactly; each field row occurs exactly once | `VERIFY_VERDICTS`, `NEW_TEST_STATES`, `KILLED_BY` | parsed table, set equality | "verify's value sets are exact, per field" (3) |
| C9 | The refusal table is exactly `VERIFY_REFUSALS`; the two quarantining test-app reasons sit in the exit-`3` row and nowhere in the refusal table | `VERIFY_REFUSALS`, `TEST_APP_REFUSALS` | parsed tables, set equality | "the refusal table is VERIFY_REFUSALS", "exit 3 names exactly the quarantining reasons" (3) |
| C10 | The ONE recipe line, extracted and filled from a real `explain` row, is a command verify accepts naming that row, the run's database (`<project>/lethal.sqlite`) and the edited test project | `explain`, `parseCliConfig` (`dbPath`, `testDir`), `parseVerifyRequest`, `ARTIFACT_ID_ABSENCES` | executes | "the documented recipe turns an explain row into a request for that row" (3) |
| C11 | The ONE mark-key recipe line, filled from real report rows, gives a marks file that loads and matches those rows; a twin (ordinal above 0) is refused today, as the doc says (R230) | `parseEquivalenceMarks`, `applyEquivalenceMarks`, `serializeKey`, `identityKeyOf` | executes | "a mark built by the documented recipe loads and matches", "the R230 limit the doc states is the code's" (3) |
| C12 | `verify --db` is the run's database; run's default is `<project>/lethal.sqlite` | `parseCliConfig` run branch | executes + text | "the documented default database is the one run uses" (2) |
| C13 | The demo report's counts | committed report | compares | "the demo report's counts are the ones quoted" (2) |
| C14 | Every heading `##` to `######` in the reference is tagged `(checked)` or `(guidance)` | the reference | structure | "every section says whether a test checks it" (2) |
| C15 | Exactly six numbered rules in each document's rules section, with the verify rule's phrases inside that section | rules sections | parsed list | "both documents carry the six rules" (3) |
| C16 | `--help`: the EXIT CODES footer lists `0 1 3 4`, the verify block's exit line lists `0 3 4 5 6`; README states `4` and the SAME rule count as the reference | `helpText`, README | parsed | "help lists every promised exit code", "README agrees with the reference" (4) |
| C17 | No em dash in either document | text | text | "no em dashes" (2) |
| C18 | README no longer says LethAL never publishes the test project | README | text (regression guard only) | "README does not deny that verify publishes the test app" (4) |

What stays GUIDANCE, tagged so: how to write a killing AL test, which survivors are worth a test, the "what to do" column of the refusal table (the reason SET is checked, the advice is not), measured sizes and timings, the al-runner caveats, "cannot measure", config advice, the "after verify" advice.

## Global Constraints

- Build order (CLAUDE.md): `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`.
- Biome only on touched `.ts` files: `bunx biome check packages/runner/src/cli.ts packages/runner/tests/cli.test.ts packages/runner/tests/agent-contract.test.ts`.
- No `!` non-null assertions. `exactOptionalPropertyTypes`: `...(v !== undefined ? { k: v } : {})`.
- A test never holds a copy of a value set it checks. Argv fixtures, per-flag VALUES that satisfy a validator, and prose phrases live in the test; which flags exist, who owns them, and every enum come from the code.
- A red-check must go red for the reason it names: the executor quotes the failing assertion's message, and a red-check that goes red on a different assertion is not counted.
- No em dashes in any file this plan touches.
- No `SessionReport` field, event, `Caveat` or schema version moves. `bun scripts/generate-schemas.ts --check` passes unchanged.
- **Live gate: none, conditionally.** This task changes argv refusals (pure parsing), Markdown, `README.md`, `helpText` and tests. No verdict, publish or server path changes. Offline parsing cannot prove BC behaviour, and this plan does not claim it does. What could break a live gate is an invocation passing a now-refused flag. The waiver rests on the PROGRAMMATIC CALLER LIST of Task 1 Step 6 (every spawn and CLI entry call in tracked TypeScript, each classified), not on the prose audit, which cannot see argv built in code. The waiver holds only if, after merge: (a) that list's only LethAL-argv builder is still `scripts/demo-reset.ts` and its argvs parse under the new table, (b) no entry is left unclassified, and (c) the prose audit's hits are all quotations. If any entry builds a LethAL argv that now refuses and a gate uses it (itest, `demo-reset.ts`, a `.claude/skills` gate procedure), fix the caller and run that gate under the Cronus28 coord lease before submitting. The submit note states "no live gate" with both lists attached.
- Roadmap: re-check the next free id immediately before writing (`ls docs/roadmap/` on master AND `git -C U:/Git/LethAL-wt/lane-code ls-tree --name-only HEAD docs/roadmap/`). R257 was highest on both at this revision.
- Red-check every pin: break, run, see red for the named reason, restore, see green. Both lines go in the submit note.

## Review Focus

1. **A documented command that parses but does not work.** `lethal verify ... --survivors M0004` parses as argv and is refused at run time. C1 and C10 run the verify examples and the recipe through `parseVerifyRequest`, so this goes red.
2. **A silently ignored flag, in any mode.** C2's oracles are the parsed config and `--help`, not `FLAG_OWNERS`, so a wrong, missing or empty owners row and an ignored flag all go red. Two named exceptions are EXACT lists that can only change by a deliberate edit: `run --dry-run`'s ignored flags, and `PRECEDENCE_OVERRIDES` (a flag the parse stores but a precedence rule can override at runtime, today `clear-ceiling --config` under an explicit `--server`/`--instance` pair). A parsed-config change is not proof of runtime use; the plan does not claim more than "stored, or listed as overridden".
3. **Recipes that are right in the doc but wrong in practice.** The mark recipe is loaded by `parseEquivalenceMarks`, which is how R230 surfaced: the doc must state the twin limit.
4. **The refusal and value tables drifting in either direction.** Parsed tables, set equality, scoped to their section.
5. **A red-check that reddens for the wrong reason.** Each names the assertion message it must produce.

---

### Task 0: Confirm C02-06b is accepted, then re-check every [06b] fact

**Files:** none changed. Output: a note in the task run log, one line per [06b] row: "confirmed" or "changed to <X>".

- [ ] **Step 1: Acceptance, two independent proofs.** (a) The coord record: `ls H:/lethal-coord/tasks/C02-06b/runs/` and read the latest run's acceptance record; if it does not say accepted, stop and ask the orchestrator. (b) The code is on master: `git merge-base --is-ancestor ca6eef2 master && echo merged` (use the branch's final commit if it moved on; `git log --oneline master | grep "lethal verify"` alone is not proof). If either fails, stop: this task depends on it.
- [ ] **Step 2:** `git merge master` into this task's branch; `bun run typecheck`, `rm -rf packages/*/dist`, `bun test`. All green before any edit.
- [ ] **Step 3: Read, in full, on master:** the verify branch of `parseCliConfig` and `VERIFY_FLAGS`; `main`'s dispatch to `verifyFromCli` and all of `verifyFromCli` and `refusalOutput`; `helpText` from the usage lines to the end (the VERIFY block and the EXIT CODES footer, which are on different lines); all of `verify.ts`'s exported constants, `verifyExitCode`, `verifyRefusalOf`, `INSTALLED_ARTIFACT_REFUSALS`, `TEST_APP_REFUSALS`; `schemas/verify-v1.schema.json`; C02-06b's tests in `cli.test.ts`, `verify.test.ts`, `schemas.test.ts`; `docs/roadmap/` for the nested-test-project item.
- [ ] **Step 4:** For every row of the [06b] table, write "confirmed" or the new value. Every later task uses master's names and values. Any change to exit codes, refusals or value sets is only a doc change here (this task never changes verify's behaviour).

### Task 1: `FLAG_OWNERS` is total, and no invocation ignores a flag

**Files:**
- Modify: `packages/runner/src/cli.ts` (`FLAG_OWNERS` rows; `export` `FLAG_OWNERS` and `VALID_SUBCOMMANDS`; `instead` optional; its doc comment)
- Modify: `packages/runner/tests/cli.test.ts` (new `describe`; correct the R176 table's comment)

**Interfaces:**
- Produces: `export const FLAG_OWNERS: ReadonlyArray<{ readonly flag: string; readonly owners: readonly (typeof VALID_SUBCOMMANDS)[number][]; readonly instead?: string }>`, `export const VALID_SUBCOMMANDS`. Task 2 reads both.

- [ ] **Step 1: The invariant test (write first; it is also the measurement script).**

```ts
import { FLAG_OWNERS, RUN_FLAGS, VALID_SUBCOMMANDS, parseCliConfig } from "../src/cli";

/**
 * C02-07. Every invocation shape an agent or operator uses: one per subcommand, plus the modes and
 * verbs whose parse branches read different flags. Argv fixtures only.
 */
const INVOCATIONS: ReadonlyArray<{ readonly sub: string; readonly argv: readonly string[] }> = [
  { sub: "run", argv: ["run", "--project", "P", "--tests", "T", "--backend", "bcdev"] },
  { sub: "run", argv: ["run", "--project", "P", "--tests", "T", "--backend", "al-runner"] },
  { sub: "run", argv: ["run", "--project", "P", "--dry-run"] },
  { sub: "init", argv: ["init", "--project", "P"] },
  { sub: "clear-quarantine", argv: ["clear-quarantine", "--server", "S", "--instance", "I"] },
  { sub: "clear-ceiling", argv: ["clear-ceiling", "--project", "P", "--config", "C"] },
  // `--server`/`--instance` are a pair on clear-ceiling (R112): one alone is refused-other, so the
  // pair needs its own invocation for "every owner reads" to see them read.
  { sub: "clear-ceiling", argv: ["clear-ceiling", "--project", "P", "--server", "S", "--instance", "I"] },
  { sub: "force-reset-lease", argv: ["force-reset-lease", "--server", "S", "--instance", "I", "--config", "C"] },
  { sub: "doctor", argv: ["doctor", "--config", "C"] },
  { sub: "explain", argv: ["explain", "r.json"] },
  { sub: "export", argv: ["export", "r.json", "--format", "mutation-elements", "--project", "P", "--out", "o.json"] },
  { sub: "campaign", argv: ["campaign", "freeze", "--manifest", "m", "--stage", "s", "--report", "r", "--expect-mutants", "5"] },
  { sub: "campaign", argv: ["campaign", "anchors", "--manifest", "m", "--stage", "s", "--report", "r"] },
  { sub: "campaign", argv: ["campaign", "compare", "--manifest", "m", "--stage", "s", "--report", "r"] },
  { sub: "verify", argv: ["verify", "--db", "d", "--artifact", "0123456789abcdef0123456789abcdef", "--survivors", "0/M0001", "--tests", "T"] },
];

/** Values that satisfy a flag's own validator, so "read" is not confused with "refused a bad value".
 *  Every other string flag gets `zz-<flag>`, a value no default can equal. */
const VALUE: Readonly<Record<string, string>> = {
  lines: "src/A.al:1-2",
  thresholds: "70,50",
  top: "3",
  "expect-mutants": "7",
  workers: "2",
  "compile-concurrency": "3",
  "max-guards-per-batch": "5",
  "mutant-timeout-ms": "200000",
  "max-methods-per-call": "4",
  "request-ceiling-ms": "250000",
  "resume-run": "2",
  "selector-id": "50100",
  "control-id": "50101",
  "table-id": "50102",
  format: "mutation-elements",
};

/** MEASURED exemption: flags `run --dry-run` accepts and ignores. Filed (Task 5); may only shrink.
 *  Expected, from Q1: the 19 flags listed there. Step 2 fills it from the measured output. */
const DRY_RUN_IGNORES: ReadonlySet<string> = new Set([/* filled from Step 2's output, exactly */]);

/**
 * NAMED exception: a flag the parse STORES (so "reads" by the parsed-config oracle) whose value a
 * precedence rule can override at runtime. A parsed-config change is not proof of runtime use, so
 * each such case is listed here, with the rule that overrides it, rather than hidden inside "reads".
 * Found by reading every `*FromCli` consumer of each parsed field for a conditional read (Step 3).
 */
const PRECEDENCE_OVERRIDES: ReadonlyArray<{ readonly argv: readonly string[]; readonly flag: string; readonly rule: string }> = [
  {
    argv: ["clear-ceiling", "--project", "P", "--server", "S", "--instance", "I"],
    flag: "config",
    rule: "resolveCeilingIdentity: an explicit --server/--instance pair wins; the config is not opened",
  },
];

type Outcome = "reads" | "ignores" | "refused-by-owner" | "refused-other";

function outcome(argv: readonly string[], flag: string): Outcome {
  const spec = RUN_FLAGS[flag as keyof typeof RUN_FLAGS] as { readonly type: string };
  const extra = spec.type === "boolean" ? [`--${flag}`] : [`--${flag}`, VALUE[flag] ?? `zz-${flag}`];
  const before = JSON.stringify(parseCliConfig([...argv]));
  let after: string;
  try {
    after = JSON.stringify(parseCliConfig([...argv, ...extra]));
  } catch (e) {
    return /is only accepted by|is not accepted by/.test((e as Error).message)
      ? "refused-by-owner"
      : "refused-other";
  }
  return after === before ? "ignores" : "reads";
}

describe("C02-07: flags are read or refused, never ignored", () => {
  test("every invocation parses bare, so each case isolates one flag", () => {
    for (const { argv } of INVOCATIONS) expect(() => parseCliConfig([...argv]), argv.join(" ")).not.toThrow();
  });

  test("every shared flag has an owner", () => {
    const owned = new Set(FLAG_OWNERS.map((r) => r.flag));
    expect(Object.keys(RUN_FLAGS).filter((f) => !owned.has(f))).toEqual([]);
    expect(FLAG_OWNERS.length).toBe(owned.size);
  });

  test("every row has an owner", () => {
    // A row with `owners: []` would pass the test above, make "every owner reads" vacuous and make
    // "every non-owner refuses" demand a refusal everywhere, including where the flag is read.
    expect(FLAG_OWNERS.filter((r) => r.owners.length === 0).map((r) => r.flag)).toEqual([]);
  });

  test("the precedence overrides are exact", () => {
    // Each entry must still be STORED by the parse; an entry the parse stopped storing is stale.
    for (const { argv, flag } of PRECEDENCE_OVERRIDES) {
      expect(outcome(argv, flag), `${argv.slice(0, 1).join(" ")} --${flag}`).toBe("reads");
    }
    expect(PRECEDENCE_OVERRIDES.map((o) => `${o.argv[0]} --${o.flag}`)).toEqual(["clear-ceiling --config"]);
  });

  test("every flag's owners are where --help documents it", () => {
    // The independent spec for ownership, in both directions: the subcommands a flag appears under
    // in `--help` (its usage lines, plus the option lines of each per-subcommand section such as
    // the `RUN` or `CLEAR-CEILING` heading) must equal its FLAG_OWNERS row. Measured on
    // lethal/lane-code ca6eef2: equal for all 46 flags. A missing, extra or empty owner, or a flag
    // documented nowhere, fails here even though the refusal fires before the branch reads it.
    const lines = helpText("0.0.0").split("\n");
    const homes = new Map<string, Set<string>>();
    const add = (flag: string, sub: string) => {
      if (!(flag in RUN_FLAGS)) return;
      const s = homes.get(flag) ?? new Set<string>();
      s.add(sub);
      homes.set(flag, s);
    };
    let sectionSub = "";
    for (const line of lines) {
      const usage = line.match(/^\s+lethal ([a-z-]+)/);
      if (usage) {
        for (const m of line.matchAll(/--([a-z][a-z0-9-]+)/g)) add(m[1] ?? "", usage[1] ?? "");
        continue;
      }
      const heading = line.match(/^([A-Z][A-Z-]+)\b/);
      if (heading) {
        const sub = (heading[1] ?? "").toLowerCase();
        sectionSub = (VALID_SUBCOMMANDS as readonly string[]).includes(sub) ? sub : "";
        continue;
      }
      const option = line.match(/^\s+(?:-[a-zA-Z], )?--([a-z][a-z0-9-]+)/);
      if (option && sectionSub !== "") add(option[1] ?? "", sectionSub);
    }
    for (const { flag, owners } of FLAG_OWNERS) {
      expect([...(homes.get(flag) ?? [])].sort(), `--${flag}`).toEqual([...owners].sort());
    }
  });

  test("no invocation ignores a flag it accepts", () => {
    // The oracle is the parsed config, not FLAG_OWNERS: a flag that parses and changes nothing is
    // the `--report`-on-`run` bug (R176), whatever the table says.
    const ignored: string[] = [];
    for (const { argv } of INVOCATIONS) {
      for (const flag of Object.keys(RUN_FLAGS)) {
        if (argv.includes(`--${flag}`)) continue;
        if (outcome(argv, flag) !== "ignores") continue;
        const dry = argv.includes("--dry-run");
        if (dry && DRY_RUN_IGNORES.has(flag)) continue;
        ignored.push(`${argv.slice(0, 2).join(" ")}${dry ? " --dry-run" : ""} --${flag}`);
      }
    }
    expect(ignored).toEqual([]);
  });

  test("the dry-run exemption is exact", () => {
    const dry = INVOCATIONS.find((i) => i.argv.includes("--dry-run"));
    if (dry === undefined) throw new Error("no dry-run invocation");
    const measured = Object.keys(RUN_FLAGS).filter(
      (f) => !dry.argv.includes(`--${f}`) && outcome(dry.argv, f) === "ignores",
    );
    expect(new Set(measured)).toEqual(DRY_RUN_IGNORES);
  });

  test("every owner reads its flag in at least one of its invocations", () => {
    for (const { flag, owners } of FLAG_OWNERS) {
      for (const sub of owners) {
        const mine = INVOCATIONS.filter((i) => i.sub === sub);
        const results = mine.map((i) => (i.argv.includes(`--${flag}`) ? "reads" : outcome(i.argv, flag)));
        expect(results, `${sub} --${flag}`).toContain("reads");
      }
    }
  });

  test("every non-owner refuses by ownership", () => {
    for (const { flag, owners } of FLAG_OWNERS) {
      for (const { sub, argv } of INVOCATIONS) {
        if ((owners as readonly string[]).includes(sub) || argv.includes(`--${flag}`)) continue;
        expect(outcome(argv, flag), `${argv.slice(0, 2).join(" ")} --${flag}`).toBe("refused-by-owner");
      }
    }
  });

  test("explain --out is refused and says the JSON goes to stdout", () => {
    expect(() => parseCliConfig(["explain", "r.json", "--out", "e.json"])).toThrow(/stdout/);
  });
});
```

(`helpText` joins the imports from `../src/cli`.)

How the six ownership tests divide the work, so no single oracle is trusted:
- "no invocation ignores" and "every owner reads" consult only the parsed config. An EXTRA owner fails "every owner reads" (the flag is ignored there).
- A MISSING owner makes the code refuse a flag its branch reads; the parsed config cannot see that, because the refusal fires first. "every flag's owners are where --help documents it" catches it against the help text, which is written separately and names a home for EVERY flag: the usage lines cover the non-run subcommands, and the option lines under the `RUN` headings cover the 27 run-only flags that no usage line mentions (for example `--changed-since`).
- An EMPTY owners row fails "every row has an owner" and the help test.
- An owned invocation that throws for another reason (`campaign compare --project`) is `refused-other`, neither `reads` nor `ignores`. Verb-level refusals stay `parseCampaignConfig`'s job.
- "reads" means "the parse stores it", not "the run uses it". The one known case where a stored value is overridden (`clear-ceiling --config` under an explicit server pair) is in `PRECEDENCE_OVERRIDES`, pinned exactly.

- [ ] **Step 2: Measure, then run to see it fail.** Leave `DRY_RUN_IGNORES` empty and run `bun test packages/runner/tests/cli.test.ts -t "never ignored"`. Record the output of "no invocation ignores" in the run log: it is the per-subcommand list Q1 quotes. Copy the `run --dry-run` entries into `DRY_RUN_IGNORES` EXACTLY (expected exactly the 19 in Q1; any difference goes in the submit note). If "every invocation parses bare" fails, fix that argv from its branch. If a flag reads as `ignores` only because its `VALUE` equals a default, choose a value that the branch's validator accepts and that differs from the default, and say which in the submit note. Expected failures now: "every shared flag has an owner" (about 35 flags), "no invocation ignores" (exactly the Q1 newly-refused lists), "non-owner refuses", and "every flag's owners are where --help documents it" (rows that do not exist yet). "every row has an owner" and "the precedence overrides are exact" already pass.
- [ ] **Step 3: Implement.** In `cli.ts`: `export` `FLAG_OWNERS` and `VALID_SUBCOMMANDS`; `owners` typed as `readonly (typeof VALID_SUBCOMMANDS)[number][]`; `instead` optional, the message ending with the owners list alone when absent. Rows (confirm each against its branch; the test is the authority):

| Flag | Owners |
|---|---|
| `project` | `run`, `init`, `clear-ceiling`, `force-reset-lease`, `doctor`, `export`, `campaign` |
| `tests` | `run`, `doctor`, `verify` |
| `config` | `run`, `clear-ceiling`, `force-reset-lease`, `doctor`, `verify` |
| `db` | `run`, `clear-ceiling`, `verify` |
| `out` | `run`, `init`, `export` |
| `server`, `instance` | `clear-quarantine`, `clear-ceiling`, `force-reset-lease` |
| `file` | `clear-ceiling` |
| existing rows | unchanged (`json`, `report`, `manifest`, `stage`, `expect-mutants`, `top`, `format`, `thresholds`, `force`, `artifact`, `survivors`) |
| the rest | `run`, via one builder |

```ts
/** Flags only `lethal run` reads. One sentence serves them all: none has a second home. */
const RUN_ONLY_FLAGS = [
  "backend", "skip-known-survivors", "dry-run", "workers", "compile-concurrency", "keep-env",
  "allow-expiring-env", "selector-id", "control-id", "table-id", "only", "exclude", "operator",
  "lines", "changed-since", "tests-only", "max-guards-per-batch", "mutant-timeout-ms",
  "max-methods-per-call", "request-ceiling-ms", "no-group-runs", "resume", "resume-run",
  "retry-stranded", "stop-hung-sessions", "allow-large-run", "progress-out",
] as const;
```

spread as `...RUN_ONLY_FLAGS.map((flag) => ({ flag, owners: ["run"] as const, instead: "It is a `lethal run` flag." }))`. The `out` row's `instead`: "`lethal explain`, `lethal doctor --json` and `lethal verify` print JSON on stdout; redirect it to a file." Rewrite the `FLAG_OWNERS` doc comment: delete "Flags NOT listed here are shared on purpose (`--project`, `--config`) and are owned by nobody"; say every flag has a row and that "flags are read or refused, never ignored" in `cli.test.ts` enforces it against the parsed config. In `cli.test.ts`, correct the R176 table's comment: its fixed list does NOT catch a new unowned flag; point to the new test that does. **Find the precedence overrides:** for each owned (subcommand, flag) pair, read the `*FromCli` function that consumes the parsed field and note any read that is conditional on another flag (the known one: `resolveCeilingIdentity` returns an explicit `--server`/`--instance` pair without opening `--config`). Each one found goes into `PRECEDENCE_OVERRIDES` with its rule, and into the `FLAG_OWNERS` doc comment in one line; list what was read in the submit note, including "no other conditional read found" if that is the result. **`VERIFY_FLAGS` stays** (see Review responses, finding 2): it is the verify branch's own reader list, and removing it is not needed for any pin.

- [ ] **Step 4: Run to see it pass;** then all of `cli.test.ts`, `doctor-cli.test.ts`, `explain.test.ts`, `init-cli.test.ts`, `publish-ceiling.test.ts` UNEDITED except the R176 comment.
- [ ] **Step 5: Red-checks (each must fail on the named assertion).**
  - Delete the `file` row: "every shared flag has an owner" fails with `["file"]`.
  - Add `"explain"` to the `out` row: "no invocation ignores a flag it accepts" fails listing `explain r.json --out`, and "explain --out is refused" fails.
  - Remove `"doctor"` from the `project` row: "every flag's owners are where --help documents it" fails at `--project` (help has `doctor`, the row does not); `doctor-cli.test.ts`'s `--project` cases throw too. The parsed-config tests stay green here, by design: that is why the help test exists.
  - Set the `changed-since` row's owners to `[]`: "every row has an owner" fails with `["changed-since"]`, and the help test fails at `--changed-since` (help documents it under `RUN`).
  - Add `"doctor"` to the `db` row: "every owner reads its flag" fails with `doctor --db` giving `ignores`, and the help test fails at `--db`.
  - Change the `PRECEDENCE_OVERRIDES` entry's flag to `"file"`: "the precedence overrides are exact" fails on the name list. Separately, in the clear-ceiling branch stop storing `configPath` when a server pair is given (temporarily): the same test fails because the entry is no longer `reads`.
  - In the dry-run branch of `parseCliConfig`, stop returning `...operators`: "no invocation ignores" fails listing `run --dry-run --operator` (not in the exemption).
  - Remove one entry from `DRY_RUN_IGNORES`: "the dry-run exemption is exact" fails.
  Restore each; green.
- [ ] **Step 6: Caller audit, in two parts.** Both outputs go in the submit note; the live-gate waiver (Global Constraints) rests on part B.

**Part A, prose and literal-command audit.** It sees only `lethal ...`/`cli.ts ...` text written on one line (one match per line), so it covers documents, comments and literal command strings, and cannot see argv assembled in code. Run it after merge:

```ts
// scratch: every literal command line in tracked text, through the NEW parseCliConfig.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { parseCliConfig } from "./packages/runner/src/cli";
const files = execSync("git ls-files").toString().split("\n").filter((f) => /\.(md|ts|ps1|sh|json|ya?ml)$/.test(f));
const SUB = /(?:\blethal|cli\.ts)\s+(run|init|clear-quarantine|clear-ceiling|force-reset-lease|doctor|explain|export|campaign|verify)\b([^`|]*)/;
let n = 0;
for (const f of files) {
  let t: string;
  try { t = readFileSync(f, "utf8"); } catch { continue; }
  for (const [i, raw] of t.replace(/\\\r?\n\s*/g, " ").split("\n").entries()) {
    const m = raw.match(SUB);
    if (!m) continue;
    n++;
    const argv = [m[1] ?? "", ...[...(m[2] ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((x) => x[1] ?? x[2] ?? x[3] ?? "")];
    try { parseCliConfig(argv); } catch (e) {
      const msg = (e as Error).message;
      if (/is only accepted by|is not accepted by/.test(msg)) console.log(`${f}:${i + 1}: ${msg.slice(0, 100)} | ${raw.trim().slice(0, 120)}`);
    }
  }
}
console.log(`scanned ${n} command lines`);
```

Only ownership refusals are printed: other errors come from prose fragments that are not complete commands. A hit that is prose QUOTING a trap is left alone (on master: `CHANGELOG.md`'s R176 entry, two `cli.ts` comment/help lines, one `cli.test.ts` comment). A hit that is a real instruction (a skill or runbook step) has the ignored flag removed, listed in the note.

**Part B, programmatic callers.** Enumerate every process spawn and every CLI entry call in tracked non-test TypeScript:

```bash
git ls-files '*.ts' | grep -v '^\.claude/worktrees/' | grep -v '/tests/\|\.test\.ts$' | xargs grep -n "Bun\.spawn\|spawnSync\|\bspawn(\|execSync\|execFileSync\|\bexecFile(\|Bun\.\$\|runFromCli(\|parseCliConfig(\|verifyFromCli(\|explainFromCli(\|doctorFromCli(\|clearCeilingFromCli(\|exportFromCli(\|campaignFromCli("
```

Classify EVERY hit into one of: (1) builds a LethAL CLI argv, (2) spawns something else (git, alc, al-runner, bun build/install/run, biome, bash for a hook), (3) the CLI's own definition or `main()` dispatch, (4) unparsed: the command is a variable the grep line does not show. For (1), run the argv through the new `parseCliConfig` in a scratch script. For (4), read the call site until it is (1), (2) or (3); none may stay unclassified. Measured on master `eb9744f` (record the post-merge result beside it):

| Class | Sites |
|---|---|
| (1) LethAL argv | `scripts/demo-reset.ts` only: `clear-quarantine --server --instance`, `clear-ceiling --project --config`, `doctor --config`. All parse under the new table |
| (2) other programs | `.claude/hooks/biome-touched.ts`, `clean-dist.ts`, `compile-fixtures-touched.ts`, `roadmap-frontmatter.ts` (biome, bash `rm`, `bun run`, `bun scripts/...`); `packages/runner/src/al-runner-backend.ts`, `al-runner-contract.ts`, `al-runner-server.ts`, `al-runner-transport.ts` (al-runner); `artifact.ts` (alc); `campaign-subcommands.ts`, `line-filter.ts` (git); `env-tool.ts` (the environment tool); `publisher.ts` (altool); `scripts/build-binary.ts` (bun, git), `compile-fixtures.ts`, `bench-record.ts` (git), `probe-alrunner-canary.ts`, `probe-continia-env.ts`, `probe-grammar-crosscheck.ts`, `r126-server-probe/probe.ts`, `r159-aor-spike/compile-proof.ts`, `r161-emit-proof.ts`, `r171-compile-probe.ts`, `r171-emit-probe.ts`; `packages/runner/itest/al-runner.itest.ts` (al-runner `--version`), `gate-receipt.test.ts` (`bun run itest:tables`), `stale-publish.itest.ts` (wraps the publisher's spawn) |
| (3) CLI definition | `packages/runner/src/cli.ts`: the `*FromCli` definitions and `main()`'s one `parseCliConfig(process.argv.slice(2))` and dispatch |
| (4) unparsed until read | `fixtures/do-campaign/preflight.ts` (`bash -c <hook command>`): reads the settings file's hook commands and pipes them probe EVENTS; its `lethal run --project ... --only ... --tests-only ... --allow-large-run` string is hook INPUT, never executed, and every flag in it is run-owned. Classified (2) after reading |

Test files are excluded from Part B because `bun test` runs them against the new code; `packages/runner/tests/campaign-fence.test.ts` holds `lethal run ...` strings as fence-hook input (run-owned flags). If Part B's post-merge result differs from this table, classify the new sites the same way before claiming the waiver.

- [ ] **Step 7:** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test`, biome on the two files.
- [ ] **Step 8: Commit** `fix(cli): a flag is read or refused, never ignored; FLAG_OWNERS is total (C02-07)`

### Task 2: Pin what the documents already promise, by running it

**Files:**
- Modify: `packages/runner/tests/agent-contract.test.ts`
- Modify: `docs/using-lethal-from-an-agent.md`, `skills/lethal-mutation-testing/SKILL.md`

**Interfaces:**
- Consumes: `FLAG_OWNERS`, `parseCliConfig`, `exitCodeForReport`, exit constants.
- Produces, in `agent-contract.test.ts`: `shellWords`, `documentedCommands(text)`, `section(text, heading)`, `tableRows(body)`, `GIFT_CARD`. Task 3 uses all five.

- [ ] **Step 1: Write the failing tests.**

```ts
import { existsSync } from "node:fs";
import {
  DOCTOR_SCHEMA_VERSION, FLAG_OWNERS, NOTHING_SCORED_EXIT_CODE, QUARANTINED_EXIT_CODE,
  exitCodeForReport, parseCliConfig,
} from "../src/cli";

const GIFT_CARD = join(REPO_ROOT, "docs", "campaign", "2026-08-16-gift-card", "rehearsal.report.json");

/** Shell words, honouring "..." and '...'. The documents' examples use no variables or
 *  substitutions on purpose: an example must work exactly as a reader copies it. */
function shellWords(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/** Every `lethal ...` command inside a fenced code block, backslash continuations joined. */
function documentedCommands(text: string): string[][] {
  const out: string[][] = [];
  for (const block of text.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)) {
    for (const line of (block[1] ?? "").replace(/\\\r?\n\s*/g, " ").split("\n")) {
      const t = line.trim();
      if (t.startsWith("lethal ")) out.push(shellWords(t).slice(1));
    }
  }
  return out;
}

/** The body under one heading, up to the next heading of the same or higher level. */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^#+ /.test(l) && l.replace(/^#+ /, "") === heading);
  if (start < 0) throw new Error(`no heading "${heading}"`);
  const level = (lines[start]?.match(/^#+/)?.[0] ?? "").length;
  const end = lines.findIndex(
    (l, i) => i > start && /^#+ /.test(l) && (l.match(/^#+/)?.[0] ?? "").length <= level,
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** A Markdown table's body rows as cells, header and separator dropped. */
function tableRows(body: string): string[][] {
  const rows = body.split("\n").filter((l) => l.startsWith("|"));
  return rows.slice(2).map((r) => r.split("|").slice(1, -1).map((c) => c.trim()));
}

/** Every `backticked` token in a cell. */
const ticks = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

describe("C02-07: the documents' commands and tables are the code's", () => {
  const docs: ReadonlyArray<[string, string]> = [["reference", read(REFERENCE)], ["skill", read(SKILL)]];

  test("every lethal command the documents show parses", () => {
    for (const [name, text] of docs) {
      const cmds = documentedCommands(text);
      for (const sub of ["doctor", "run", "explain"]) {
        expect(cmds.some((c) => c[0] === sub), `${name} shows no \`lethal ${sub}\``).toBe(true);
      }
      for (const argv of cmds) {
        expect(() => parseCliConfig(argv), `${name}: lethal ${argv.join(" ")}`).not.toThrow();
      }
    }
  });

  test("the reference's ownership table is FLAG_OWNERS", () => {
    const rows = tableRows(section(read(REFERENCE), "Which subcommand reads which flag (checked)"));
    expect(rows.length).toBeGreaterThan(5);
    for (const [flagCell = "", ownersCell = ""] of rows) {
      const flag = ticks(flagCell)[0]?.replace(/^--/, "") ?? "";
      const row = FLAG_OWNERS.find((r) => r.flag === flag);
      expect(row, `--${flag} has no FLAG_OWNERS row`).toBeDefined();
      expect(ticks(ownersCell).sort(), `--${flag}`).toEqual([...(row?.owners ?? [])].sort());
    }
  });

  test("the traps the reference warns about are refused", () => {
    const rows = tableRows(section(read(REFERENCE), "Traps (checked)"));
    // Each row: | `lethal <sub> ... --flag x` | what to do instead |. The command is run.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const [cmdCell = ""] of rows) {
      const argv = shellWords(ticks(cmdCell)[0] ?? "").slice(1);
      expect(() => parseCliConfig(argv), argv.join(" ")).toThrow(/is only accepted by|is not accepted by/);
    }
    const subs = rows.map(([c = ""]) => shellWords(ticks(c)[0] ?? "")[1]);
    expect(subs).toContain("run");
    expect(subs).toContain("explain");
  });

  test("the run exit-code table is exitCodeForReport's", () => {
    const rows = tableRows(section(read(REFERENCE), "Exit codes (checked)"));
    expect(rows.map(([c = ""]) => ticks(c)[0]).sort()).toEqual(
      ["0", "1", String(QUARANTINED_EXIT_CODE), String(NOTHING_SCORED_EXIT_CODE)].sort(),
    );
    const meaning = (code: number) => flowed(rows.find(([c = ""]) => ticks(c)[0] === String(code))?.[1] ?? "").toLowerCase();
    expect(meaning(0)).toContain("says nothing about whether mutants survived");
    expect(exitCodeForReport({ validity: { caveats: ["narrowed"] } })).toBe(0);
    expect(meaning(1)).toContain("error");
    expect(meaning(QUARANTINED_EXIT_CODE)).toContain("vouch for its own verdicts");
    expect(meaning(NOTHING_SCORED_EXIT_CODE)).toContain("measured nothing");
    expect(exitCodeForReport({ validity: { caveats: ["all-errors"] } })).toBe(NOTHING_SCORED_EXIT_CODE);
    expect(
      exitCodeForReport({ quarantined: { reason: "x" } as never, validity: { caveats: ["all-errors"] } }),
    ).toBe(QUARANTINED_EXIT_CODE);
    expect(flowed(read(REFERENCE))).toContain(
      `both quarantined and scored nothing, \`${QUARANTINED_EXIT_CODE}\` wins`,
    );
  });

  test("the documented default database is the one run uses", () => {
    const parsed = parseCliConfig(["run", "--project", "P", "--tests", "T", "--backend", "bcdev"]);
    expect(parsed.mode === "run" ? parsed.dbPath : "").toBe(join("P", "lethal.sqlite"));
    expect(read(REFERENCE)).toContain("`<project>/lethal.sqlite`");
  });

  test("every linked schema exists and each current one is linked", () => {
    const text = read(REFERENCE);
    const linked = [...text.matchAll(/\.\.\/schemas\/([a-z]+-v\d+\.schema\.json)/g)].map((m) => m[1] ?? "");
    for (const f of linked) expect(existsSync(join(REPO_ROOT, "schemas", f)), f).toBe(true);
    for (const f of [
      `report-v${REPORT_SCHEMA_VERSION}`, `explain-v${EXPLAIN_SCHEMA_VERSION}`,
      `stream-v${STREAM_SCHEMA_VERSION}`, `doctor-v${DOCTOR_SCHEMA_VERSION}`,
    ]) {
      expect(linked, `the reference must link ${f}.schema.json`).toContain(`${f}.schema.json`);
    }
  });

  test("the demo report's counts are the ones quoted", () => {
    const r = JSON.parse(read(GIFT_CARD)) as {
      readonly counts: { readonly killed: number; readonly survived: number; readonly noCoverage: number };
      readonly mutants: readonly unknown[];
    };
    expect(flowed(read(REFERENCE))).toContain(
      `${r.mutants.length} mutants, ${r.counts.killed} killed, ${r.counts.survived} survived, ${r.counts.noCoverage} no-coverage`,
    );
  });

  test("every section says whether a test checks it", () => {
    const headings = read(REFERENCE).split("\n").filter((l) => /^#{2,6} /.test(l));
    expect(headings.length).toBeGreaterThan(10);
    expect(headings.filter((h) => !/ \((checked|guidance)\)$/.test(h))).toEqual([]);
  });

  test("no em dashes", () => {
    for (const [name, text] of docs) expect(text.includes("\u2014"), name).toBe(false);
  });
});
```

The existing R153 "exit codes" test stays; the new table test is stricter and scoped.

- [ ] **Step 2: Run to see them fail.** `bun test packages/runner/tests/agent-contract.test.ts`. Expected fails: ownership table, traps, run exit table (the current section is `### Exit codes` untagged), database, schema links, counts, headings, em dashes. "every lethal command the documents show parses" already PASSES (measured on `eb9744f` with this exact helper: all eight commands parse); if it fails after Task 1, that is a real drift Task 1 introduced: fix the example and say so.
- [ ] **Step 3: Edit the reference.** Keep everything still true. Changes:
  - Tag every heading (`##` and deeper) `(checked)` or `(guidance)`. `(checked)`: `Before anything else: doctor`, `Running`, `Exit codes`, `Which subcommand reads which flag`, `Traps`, `Reading the result` and its three surface subsections, the rules section, `Safety`. `(guidance)`: `What LethAL answers`, `What LethAL cannot measure`, `Which mutants can fail to terminate`, `Config`.
  - `### Which subcommand reads which flag (checked)` under `Running`: `| flag | read by |`, rows for `--project`, `--tests`, `--config`, `--db`, `--out`, `--progress-out`, `--json`, `--top`, `--report`, `--only`, `--exclude`, `--tests-only`, `--operator`, `--artifact`, `--survivors`, owners backticked exactly as `FLAG_OWNERS`. Above it: any other flag on any other subcommand is refused, not ignored; `campaign` refuses some of its flags per verb (`--project` only on `anchors`, `--expect-mutants` only on `freeze`). Below it: `lethal run --dry-run` still ignores its execution flags (the roadmap id from Task 5).
  - `### Traps (checked)`: `| command | instead |` with rows `` `lethal run --project app --tests tests --backend bcdev --report r.json` `` ("`run` writes its report with `--out`") and `` `lethal explain report.json --out e.json` `` ("`explain` prints on stdout; redirect it: `lethal explain report.json > e.json`"). Task 3 adds the verify row.
  - `### Exit codes (checked)`: the existing table, with `0`'s meaning kept as "The run completed. This says nothing about whether mutants survived." and the existing "`3` wins" sentence.
  - State the database default `` `<project>/lethal.sqlite` `` in `Running`, and that `verify` needs that same file.
  - One link per current schema file, for example `[../schemas/report-v2.schema.json](../schemas/report-v2.schema.json)`.
  - Gift card sentence: "60 mutants, 34 killed, 15 survived, 11 no-coverage", no em dash.
  - Replace every em dash.
- [ ] **Step 4: Edit the skill:** replace its em dashes; narrow the al-runner line to the reference's claim: "`al-runner` is offline and NOT authoritative: its coverage is conditional, so an unreached mutant can come back survived; never quote a score from it."
- [ ] **Step 5: Run to see them pass;** loop; biome.
- [ ] **Step 6: Red-checks (named assertion in brackets).**
  - Doc: add `--report report.json` to the reference's `lethal run` example [parses: `reference: lethal run ...` not.toThrow].
  - Doc: add `` `explain` `` to the `--out` row [ownership table: `--out` toEqual].
  - Code: add `"explain"` to the `out` row of `FLAG_OWNERS` [ownership table: `--out` toEqual, and Task 1's "no invocation ignores"].
  - Code: add `"run"` to the `report` row's owners in `FLAG_OWNERS` [traps: the `lethal run ... --report r.json` row's toThrow fails].
  - Doc: change `34 killed` to `35 killed` [counts: toContain].
  - Doc: drop ` (guidance)` from `#### ` or `###` heading [every section: toEqual([])].
  - Code: swap the two `if` lines in `exitCodeForReport` [run exit table: the `quarantined` + `all-errors` toBe(3)].
  - Doc: change `0`'s meaning to "The run completed." [run exit table: meaning(0) toContain].
  - Doc: delete the `explain-v5` link [schema links: toContain].
- [ ] **Step 7: Commit** `docs(agent): every example parses, tables are the code's, sections say what is checked (C02-07)`

### Task 3: The hardening loop, executed from the documents

**Files:**
- Modify: `packages/runner/tests/agent-contract.test.ts`
- Modify: `docs/using-lethal-from-an-agent.md`, `skills/lethal-mutation-testing/SKILL.md`

**Interfaces:**
- Consumes (names as confirmed in Task 0): from `../src/verify` `VERIFY_SCHEMA_VERSION`, `VERIFY_VERDICTS`, `NEW_TEST_STATES`, `KILLED_BY`, `VERIFY_REFUSALS`, `TEST_APP_REFUSALS`, `VERIFY_EXIT`, `verifyExitCode`, `parseVerifyRequest`; from `../src/cli` `VERIFY_NOT_ALL_KILLED_EXIT_CODE`, `VERIFY_REFUSED_EXIT_CODE`; from `../src/explain` `explain`, `ARTIFACT_ID_ABSENCES`; from `../src/selection` `identityKeyOf`, `serializeKey`; from `../src/equivalence-marks` `EQUIVALENCE_MARKS_FILENAME`, `parseEquivalenceMarks`, `applyEquivalenceMarks`; Task 2's helpers.

**Document conventions this task relies on (the tests extract by them):**
- The verify recipe is ONE line in a fenced block, the only `lethal verify` line containing `<`: `lethal verify --db <project>/lethal.sqlite --artifact <artifactId> --survivors <batchIndex>/<mutantCode> --tests <tests-dir>`. Placeholders named after `explain` survivor fields are filled from the row; `<project>`/`<tests-dir>` are filled with literals.
- The mark-key recipe is ONE line in a fenced block starting `key = `: `key = <astHash>|<codeunitName>|<procedureName>|<operatorName>|<operatorMajor>`, placeholders named after `report.json` row fields, with the documented rule "use `triggerName` when `procedureName` is empty". The twin limit is stated beside it naming R230.
- Every other `lethal verify` example uses literal values.

- [ ] **Step 1: Write the failing tests.**

```ts
import type { MutantManifestEntry } from "@lethal/schemata";
import { VERIFY_NOT_ALL_KILLED_EXIT_CODE, VERIFY_REFUSED_EXIT_CODE } from "../src/cli";
import {
  EQUIVALENCE_MARKS_FILENAME, applyEquivalenceMarks, parseEquivalenceMarks,
} from "../src/equivalence-marks";
import { ARTIFACT_ID_ABSENCES, explain } from "../src/explain";
import { identityKeyOf, serializeKey } from "../src/selection";
import {
  KILLED_BY, NEW_TEST_STATES, TEST_APP_REFUSALS, VERIFY_EXIT, VERIFY_REFUSALS,
  VERIFY_SCHEMA_VERSION, VERIFY_VERDICTS, parseVerifyRequest, verifyExitCode,
} from "../src/verify";

const ART = "0123456789abcdef0123456789abcdef";

type ReportRow = {
  readonly mutantCode: string; readonly verdict: string; readonly astHash: string;
  readonly codeunitName: string; readonly procedureName: string; readonly triggerName?: string;
  readonly operatorName: string; readonly operatorMajor: number; readonly identityOrdinal?: number;
};

/** The single line of a kind, or a thrown error: two recipes would let a wrong one hide. */
function onlyLine(text: string, pick: (argvOrLine: string) => boolean): string {
  const lines = [...text.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)]
    .flatMap((b) => (b[1] ?? "").replace(/\\\r?\n\s*/g, " ").split("\n").map((l) => l.trim()))
    .filter(pick);
  if (lines.length !== 1) throw new Error(`expected exactly one such line, found ${lines.length}`);
  return lines[0] ?? "";
}

/** Runs a verify argv the way `verifyFromCli` starts: argv parse, then the request parse. Returns
 *  both, so a caller can pin the database and test project as well as the ids. */
function verifyRequestOf(argv: readonly string[]) {
  const parsed = parseCliConfig([...argv]);
  if (parsed.mode !== "verify") throw new Error(`not a verify command: ${argv.join(" ")}`);
  return { parsed, req: parseVerifyRequest(parsed.artifact, parsed.survivors) };
}

describe("C02-07: the hardening loop, run from the documents", () => {
  const docs: ReadonlyArray<[string, string]> = [["reference", read(REFERENCE)], ["skill", read(SKILL)]];

  test("every verify example is a request verify accepts", () => {
    for (const [name, text] of docs) {
      const examples = documentedCommands(text).filter((c) => c[0] === "verify" && !c.join(" ").includes("<"));
      expect(examples.length, `${name} shows no literal \`lethal verify\``).toBeGreaterThan(0);
      for (const argv of examples) {
        expect(() => verifyRequestOf(argv), `${name}: lethal ${argv.join(" ")}`).not.toThrow();
      }
    }
  });

  test("the documented recipe turns an explain row into a request for that row", () => {
    const report = {
      ...JSON.parse(read(GIFT_CARD)),
      artifacts: [{ batchIndex: 0, artifactId: ART, sha256: "0".repeat(64), appVersion: "1.0.0.0" }],
    };
    const rows = explain(report).survivors;
    expect(rows.length).toBeGreaterThan(0);
    const recipe = onlyLine(read(REFERENCE), (l) => l.startsWith("lethal verify ") && l.includes("<"));
    for (const row of rows) {
      const fields = row as unknown as Record<string, unknown>;
      const filled = recipe.replace(/<([A-Za-z-]+)>/g, (_, name: string) => {
        if (name === "project") return "P";
        if (name === "tests-dir") return "T";
        const v = fields[name];
        if (v === undefined) throw new Error(`recipe placeholder <${name}> is not an explain survivor field`);
        return String(v);
      });
      const { parsed, req } = verifyRequestOf(shellWords(filled).slice(1));
      expect(req.artifactId).toBe(ART);
      expect(req.ids).toEqual([{ batchIndex: row.batchIndex, mutantCode: row.mutantCode }]);
      // The rest of the loop: the run's own database (the run default for project P) and the
      // test project the agent edited. A valid request against the wrong store or tests is the
      // "valid request, wrong hardening loop" case.
      expect(parsed.dbPath).toBe("P/lethal.sqlite");
      expect(parsed.testDir).toBe("T");
    }
    const body = section(read(REFERENCE), "From an explain row to a verify command (checked)");
    const absences = tableRows(body).map(([c = ""]) => ticks(c)[0] ?? "");
    expect(new Set(absences)).toEqual(new Set(ARTIFACT_ID_ABSENCES));
  });

  test("a mark built by the documented recipe loads and matches", () => {
    const rows = (JSON.parse(read(GIFT_CARD)) as { readonly mutants: readonly ReportRow[] }).mutants;
    const survivors = rows.filter((m) => m.verdict === "survived" && !m.identityOrdinal);
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.some((m) => m.procedureName === "")).toBe(true); // the trigger rule is exercised
    const recipe = onlyLine(read(REFERENCE), (l) => l.startsWith("key = ")).slice("key = ".length);
    const keyOf = (m: ReportRow) =>
      recipe.replace(/<([A-Za-z]+)>/g, (_, name: string) => {
        const v = name === "procedureName" ? m.procedureName || m.triggerName || "" : (m as Record<string, unknown>)[name];
        if (v === undefined) throw new Error(`recipe placeholder <${name}> is not a report row field`);
        return String(v);
      });
    const file = JSON.stringify({ marks: survivors.map((m) => ({ key: keyOf(m), reason: "equivalent" })) });
    const marks = parseEquivalenceMarks(file, EQUIVALENCE_MARKS_FILENAME);
    const identity = (m: ReportRow) =>
      serializeKey(identityKeyOf({ ...m, operatorVersion: `${m.operatorMajor}.0.0` } as unknown as MutantManifestEntry));
    const result = applyEquivalenceMarks(
      marks,
      rows.map((m) => ({ mutantCode: m.mutantCode, identity: identity(m), verdict: m.verdict })),
    );
    expect(result.stale).toEqual([]);
    expect(result.contradicted).toEqual([]);
    expect(result.matched.map((x) => x.mutantCode).sort()).toEqual(survivors.map((m) => m.mutantCode).sort());
    expect(section(read(REFERENCE), "Marking an equivalent survivor (checked)")).toContain(EQUIVALENCE_MARKS_FILENAME);
  });

  test("the R230 limit the doc states is the code's", () => {
    // A twin after the first serializes with a sixth field, which the marks parser refuses today.
    // When R230 is fixed this test goes red: then delete the limit from the doc and this test.
    const twin = serializeKey({ astHash: "h", codeunitName: "C", procedureName: "P", operatorName: "o", operatorMajor: 1, ordinal: 2 });
    expect(() =>
      parseEquivalenceMarks(JSON.stringify({ marks: [{ key: twin, reason: "r" }] }), "t"),
    ).toThrow(/expected 5/);
    const body = flowed(section(read(REFERENCE), "Marking an equivalent survivor (checked)"));
    expect(body).toContain("`identityOrdinal`");
    expect(body).toContain("R230");
  });

  test("verifySchemaVersion is this build's", () => {
    expect(statesVersion(read(REFERENCE), "verifySchemaVersion", VERIFY_SCHEMA_VERSION)).toBe(true);
    expect(read(REFERENCE)).toContain(`../schemas/verify-v${VERIFY_SCHEMA_VERSION}.schema.json`);
  });

  test("verify's value sets are exact, per field", () => {
    // | `results[].verdict` | `killed`, `survived`, ... |
    const rows = tableRows(section(read(REFERENCE), "Reading a verify result (checked)"));
    const valuesOf = (field: string) => {
      const matching = rows.filter(([f = ""]) => ticks(f)[0] === field);
      // Exactly once: a second row for the same field could carry different values and hide.
      expect(matching.length, `rows for ${field}`).toBe(1);
      return new Set(ticks(matching[0]?.[1] ?? ""));
    };
    expect(valuesOf("results[].verdict")).toEqual(new Set(VERIFY_VERDICTS));
    expect(valuesOf("newTests[].state")).toEqual(new Set(NEW_TEST_STATES));
    expect(valuesOf("results[].killedBy")).toEqual(new Set(KILLED_BY));
  });

  test("the refusal table is VERIFY_REFUSALS", () => {
    const listed = tableRows(section(read(REFERENCE), "Verify refusals (checked)")).map(([c = ""]) => ticks(c)[0] ?? "");
    expect(listed.length).toBe(new Set(listed).size);
    expect(new Set(listed)).toEqual(new Set(VERIFY_REFUSALS));
  });

  test("verify exit codes and their precedence", () => {
    expect(VERIFY_NOT_ALL_KILLED_EXIT_CODE).toBe(VERIFY_EXIT.notAllKilled);
    expect(VERIFY_REFUSED_EXIT_CODE).toBe(VERIFY_EXIT.refused);
    const rows = tableRows(section(read(REFERENCE), "Verify exit codes (checked)"));
    const codes = rows.map(([c = ""]) => ticks(c)[0] ?? "");
    expect(new Set(codes)).toEqual(new Set(["1", ...Object.values(VERIFY_EXIT).map(String)]));
    // Exit 3's row names exactly the test-app reasons that quarantine, and the refusal table none.
    const quarantining = Object.entries(TEST_APP_REFUSALS).filter(([, to]) => to === "quarantined").map(([r]) => r);
    const row3 = rows.find(([c = ""]) => ticks(c)[0] === String(VERIFY_EXIT.quarantined))?.[1] ?? "";
    expect(new Set(ticks(row3).filter((t) => t.startsWith("publish-")))).toEqual(new Set(quarantining));
    // One competing-condition case per precedence boundary, run through the real function.
    const R = (verdict: (typeof VERIFY_VERDICTS)[number]) => ({ verdict });
    const cases: ReadonlyArray<[string, Parameters<typeof verifyExitCode>[0], number]> = [
      ["3 over 6", { quarantined: "x", refused: {}, results: [], newTests: [] }, VERIFY_EXIT.quarantined],
      ["6 over 4", { refused: {}, results: [R("error")], newTests: [] }, VERIFY_EXIT.refused],
      ["4 over 5: all error AND a flaky new test", { results: [R("error")], newTests: [{ state: "flaky" }] }, VERIFY_EXIT.nothingMeasured],
      ["4 ignores skipped rows", { results: [R("error"), R("skipped")], newTests: [] }, VERIFY_EXIT.nothingMeasured],
      ["5: one survivor", { results: [R("killed"), R("survived")], newTests: [] }, VERIFY_EXIT.notAllKilled],
      ["5 over 0: all killed but a flaky new test", { results: [R("killed")], newTests: [{ state: "flaky" }] }, VERIFY_EXIT.notAllKilled],
      ["0: all killed, every new test stable", { results: [R("killed")], newTests: [{ state: "stable" }] }, VERIFY_EXIT.ok],
      ["0: every survivor skipped", { results: [R("skipped")], newTests: [] }, VERIFY_EXIT.ok],
    ];
    for (const [why, input, code] of cases) expect(verifyExitCode(input), why).toBe(code);
    const order = [VERIFY_EXIT.quarantined, VERIFY_EXIT.refused, VERIFY_EXIT.nothingMeasured, VERIFY_EXIT.notAllKilled, VERIFY_EXIT.ok]
      .map((c) => `\`${c}\``).join(", ");
    expect(flowed(read(REFERENCE))).toContain(`Precedence: ${order}.`);
    for (const [name, text] of docs) {
      const t = flowed(text).toLowerCase();
      expect(t, `${name}: meaning of 5`).toContain("not every named survivor was killed");
      expect(t, `${name}: meaning of 6`).toContain("refused before measuring");
      expect(t, `${name}: all skipped`).toContain("every survivor skipped");
    }
  });

  test("verify --out is a documented, refused trap", () => {
    const rows = tableRows(section(read(REFERENCE), "Traps (checked)"));
    const verifyRow = rows.find(([c = ""]) => shellWords(ticks(c)[0] ?? "")[1] === "verify");
    const argv = shellWords(ticks(verifyRow?.[0] ?? "")[0] ?? "").slice(1);
    expect(argv).toContain("--out");
    expect(() => parseCliConfig(argv)).toThrow(/--out/);
  });

  test("both documents carry the six rules", () => {
    const rules: ReadonlyArray<[string, string]> = [
      ["reference", section(read(REFERENCE), "The six rules (checked)")],
      ["skill", section(read(SKILL), "Rules that stop a wrong conclusion")],
    ];
    for (const [name, body] of rules) {
      const items = body.split("\n").filter((l) => /^\d+\. /.test(l));
      expect(items.length, `${name} rule count`).toBe(6);
      const lower = flowed(body).toLowerCase();
      expect(lower, `${name}: rule 6`).toContain("never with `--resume`");
      expect(lower, `${name}: rule 6`).toContain("`skipped` is not a measured kill or survival");
    }
  });
});
```

Extend the existing R153 "five rules" test's name to "six" only; its phrase checks stay document-wide (they predate this task).

- [ ] **Step 2: Run to see them fail.** Expected: every new test fails on a missing section or line (the `onlyLine` error "found 0", or `section` "no heading"). If a CODE half fails (for example the precedence cases), Task 0 missed a change: stop and fix Task 0's record.
- [ ] **Step 3: Write the reference's loop.** `## The hardening loop (checked)` after `Reading the result`:
  - Intro: the loop is `lethal run`, `lethal explain`, write a test, `lethal verify`, repeat until exit `0`, then a fresh `lethal run`. LethAL never writes the test.
  - `### From an explain row to a verify command (checked)`: the recipe line exactly as in "Document conventions"; one literal example (`lethal verify --db app/lethal.sqlite --artifact 0123456789abcdef0123456789abcdef --survivors 0/M0004 --tests tests`); `--db` is the database the run wrote; only the LAST batch stays installed (`batch-not-installed` otherwise). A table `| artifactIdAbsent | what it means for verify |` with rows `carried` (run a fresh `lethal run`), `not-recorded` (the report predates artifact ids; run again), `not-published` (the backend published nothing for that batch; verify cannot help).
  - `### Running verify (checked)`: bcdev only; JSON on stdout, progress on stderr; ids are checked when verify runs, not when the argv is parsed, so a wrong id is exit `6` `malformed-request`; one test-app publish per call; **the test project IS published and stays installed afterwards**.
  - `### Reading a verify result (checked)`: `verifySchemaVersion: 1`; link `../schemas/verify-v1.schema.json`; the table `| field | values |` with rows `` `results[].verdict` ``, `` `newTests[].state` ``, `` `results[].killedBy` `` and exactly the code's values; "`killedBy` never changes the exit code"; `killedByNewTest`, `invalidBaseline`.
  - `### Verify exit codes (checked)`: `| code | meaning |` rows `0` (every named survivor killed and every new test stable; also every survivor skipped, which measured nothing), `1` (an uncaught failure), `3` (quarantined, including the test-app outcomes `publish-indeterminate` and `publish-anomalous`, which leave the container needing a recycle), `4` (every non-skipped survivor `error`: measured nothing), `5` (not every named survivor was killed, or a new test is not `stable`), `6` (refused before measuring; `refused.reason` says why). Then `Precedence: \`3\`, \`6\`, \`4\`, \`5\`, \`0\`.`
  - `### Verify refusals (checked)`: `| reason | what to do |`, one row per `VERIFY_REFUSALS` value (no other rows), with the note "the set of reasons is checked; the advice is guidance". Advice per row as in the first draft: `malformed-request` fix the argv; `unknown-artifact` pass the run's `--db` and the `artifactId` from explain; `batch-not-installed` run the slice in one batch; `wrong-batch` take both values from one explain row; `unknown-mutant` re-copy the code; `not-a-survivor` drop the id; `carried` run a fresh `lethal run`; `source-predates-verify` run `lethal run` again (the run predates verify, stopped early, or its source changed while it ran); `source-changed` the target changed since instrumentation, run again, and a test project nested inside the target makes every test edit trigger this (roadmap id from Task 0); `covering-test-unmatched` restore the renamed, renumbered or removed covering test, or run again; `no-tests-to-run` write a test first; `unsupported-config` bcdev only, no `envTool`; `project-unreadable` the run's project path is gone; `equivalence-marks-unreadable` fix `lethal.equivalent.json`; `stale-artifact` another run published since, run again and use the new id; `artifact-files-unusable` the run's local build files are gone, run again; `artifact-identity-unavailable` the server could not say what is installed, run `lethal doctor`; `test-app-manifest-unreadable`, `test-app-symbols-unreadable` fix the test project's `app.json` or `.alpackages`; `test-app-compile-failed` fix the test AL, the detail has the compiler errors; `test-app-version-below-resident` raise the test app version; `test-app-publish-failed` read the detail; `test-app-resident-unreadable` check the dev credentials with `lethal doctor`.
  - Add to `### Traps (checked)` the row `` `lethal verify --db app/lethal.sqlite --artifact 0123456789abcdef0123456789abcdef --survivors 0/M0004 --tests tests --out v.json` `` ("verify prints on stdout; redirect it").
  - `### Marking an equivalent survivor (checked)`: file `<project>/lethal.equivalent.json` shaped `{ "marks": [ { "key": "...", "reason": "..." } ] }`, `reason` required; the `key = ` recipe line; "use `triggerName` when `procedureName` is empty"; **the limit, in bold: a row with `identityOrdinal` (a twin after the first) cannot be marked today, because the marks file accepts only five-field keys (R230)**; a marked survivor is `skipped`: never run, and not a measured kill or survival; `equivalenceRisk` alone never skips; a mark never changes the score.
  - `### Writing the killing test (guidance)` and `### After verify (guidance)`: as in the first draft (start from `coveringTests` and the mutated span; prefer `executionProven: true`; `covered-but-unreached` needs a new case; the test must pass twice unmutated; the blind spot of an edited non-covering test; confirm with a fresh `lethal run`, never `--resume`, R247).
  - Rename the rules heading `## The six rules (checked)`, add rule 6: "**A verify `killed` is proof for the installed build; the record is a fresh `lethal run`, never with `--resume`.** `skipped` is not a measured kill or survival: it is a reader's mark, listed in `results[].verdict` so the output accounts for every named id." Rule 2 stays.
- [ ] **Step 4: The skill's section.** `## 5. Harden a survivor`: the recipe in words plus ONE literal `lethal verify` example; exit codes `0`, `3`, `4`, `5`, `6` with "not every named survivor was killed", "refused before measuring" and "every survivor skipped" (exit `0`, measured nothing); "branch on `refused.reason`; the reference says what to do for each"; the test app stays installed; rule 6 as the sixth numbered item under "Rules that stop a wrong conclusion".
- [ ] **Step 5: Run to see them pass;** loop; biome.
- [ ] **Step 6: Red-checks (named assertion in brackets).**
  - Doc: change the literal example to `--survivors M0004` [every verify example: `verifyRequestOf` throws `malformed-request`].
  - Doc: change the literal example's artifact to `0123` [every verify example: `malformed-request`].
  - Doc: change the recipe to `--survivors <mutantCode>` [recipe: `verifyRequestOf` throws for the first row].
  - Doc: ADD a second recipe line with `<mutantCode>` beside the correct one [recipe: `onlyLine` "found 2"].
  - Doc: rename `<batchIndex>` to `<batch>` [recipe: "<batch> is not an explain survivor field"].
  - Doc: change the recipe's `--db <project>/lethal.sqlite` to `--db wrong.sqlite`, artifact and survivor placeholders untouched [recipe: `parsed.dbPath` toBe("P/lethal.sqlite")].
  - Doc: change the recipe's `--tests <tests-dir>` to `--tests other-tests` [recipe: `parsed.testDir` toBe("T")].
  - Doc: add a second `` `results[].verdict` `` row with only `` `killed` `` [value sets: "rows for results[].verdict" toBe(1)].
  - Doc: drop `|<operatorMajor>` from the key recipe [mark: `parseEquivalenceMarks` "expected 5"].
  - Doc: swap `<procedureName>` and `<operatorName>` in the key recipe [mark: `result.stale` not empty].
  - Doc: delete the R230 sentence [R230: toContain("R230")].
  - Code: in `parseEquivalenceMarks`, accept 5 or 6 fields (temporarily) [R230: toThrow fails]. Restore.
  - Doc: add `` `timeout` `` to the `results[].verdict` row [value sets: toEqual].
  - Doc: delete the `wrong-batch` row [refusal table: toEqual]; add a `publish-indeterminate` row there [refusal table: toEqual].
  - Code: swap the `refused` and `quarantined` lines in `verifyExitCode` ["3 over 6"].
  - Code: in `verifyExitCode`, check `newTests` before the all-error rule ["4 over 5: all error AND a flaky new test"].
  - Doc: write the precedence as `3`, `4`, `6`, `5`, `0` [precedence toContain].
  - Doc: move `publish-anomalous` out of the `3` row [exit 3: toEqual].
  - Doc: delete rule 6's line [six rules: count 5].
  Restore each.
- [ ] **Step 7: Commit** `docs(agent): the hardening loop, run from the documents against verify.ts (C02-07)`

### Task 4: Prose sweep outside the two documents

**Files:**
- Modify: `README.md` (the "Driving it from an agent" section, the Configuration exit-code line, the "does not even publish it" sentence), `packages/runner/src/cli.ts` (`helpText` EXIT CODES footer only)
- Test: `packages/runner/tests/agent-contract.test.ts`

- [ ] **Step 1: Find every claim.** Read each hit against the code:

```bash
grep -rn "exit code\|Exit code\|EXIT CODES\|rules\|output surfaces\|Three surfaces\|publish it\|under-reports\|verify" README.md docs/using-lethal-from-an-agent.md skills/lethal-mutation-testing/SKILL.md fixtures/README.md .claude/skills/*/SKILL.md
```

Known on master: README agent section (exit `0`/`1`/`3`, "three output surfaces", "the four rules"); README "Your test project is never touched at all: LethAL does not even publish it."; `helpText` footer `0 ok   1 error   3 quarantined`.

- [ ] **Step 2: Write the failing tests.**

```ts
import { helpText } from "../src/cli";

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];

test("help lists every promised exit code, in the right block", () => {
  const help = helpText("0.0.0");
  const footer = help.split("EXIT CODES")[1] ?? "";
  const runCodes = [...footer.matchAll(/(?:^|\s)(\d)\s/g)].map((m) => Number(m[1]));
  expect(new Set(runCodes)).toEqual(new Set([0, 1, QUARANTINED_EXIT_CODE, NOTHING_SCORED_EXIT_CODE]));
  const verifyLine = help.split("\n").findIndex((l) => l.trim().startsWith("Exit codes:"));
  const verifyText = help.split("\n").slice(verifyLine, verifyLine + 3).join(" ");
  for (const c of Object.values(VERIFY_EXIT)) expect(verifyText, `verify help omits ${c}`).toMatch(new RegExp(`\\b${c}\\b`));
});

test("README agrees with the reference", () => {
  const readme = read(join(REPO_ROOT, "README.md"));
  const body = flowed(section(readme, "Driving it from an agent, a script or CI"));
  expect(body).toContain(`\`${NOTHING_SCORED_EXIT_CODE}\``);
  expect(body.toLowerCase()).toContain("measured nothing");
  const count = section(read(REFERENCE), "The six rules (checked)").split("\n").filter((l) => /^\d+\. /.test(l)).length;
  expect(body).toContain(`the ${NUMBER_WORDS[count]} rules`);
  for (const w of NUMBER_WORDS.filter((_, i) => i !== count)) expect(body).not.toContain(`the ${w} rules`);
});

test("README does not deny that verify publishes the test app", () => {
  // Regression guard only (a string): the claim was true before lethal verify existed.
  expect(read(join(REPO_ROOT, "README.md"))).not.toContain("does not even publish it");
});
```

If there is more than one `Exit codes:` line in help after Task 0, scope `verifyLine` to the VERIFY block by starting the search at the line beginning `VERIFY`.

- [ ] **Step 3: Run to see them fail, then fix.** `helpText` footer: `0 ok   1 error   3 quarantined (...)   4 nothing scored (the run measured nothing)`; leave the VERIFY block's own line as C02-06b wrote it unless it misses a code. README agent section: exit codes `0`, `1`, `3`, `4` with meanings, "which output surface answers which question", "the six rules", one sentence on `lethal verify` pointing at the reference's loop. README line 31: "`lethal run` never touches or publishes your test project. `lethal verify` compiles and publishes it once, and leaves it installed." `run-limits.test.ts` pins help text: re-run it; if a pinned line moved, update only that expectation and say so.
- [ ] **Step 4: Run to see them pass;** loop; biome on `cli.ts` and the test.
- [ ] **Step 5: Red-checks.** Remove `4 nothing scored` from the footer [help: footer set]. Put `4` back as `4 nothing scored` but drop `5` from the VERIFY block's line [help: "verify help omits 5"]. Change README to "the five rules" [README: toContain("the six rules")]. Restore "does not even publish it" [README guard]. Restore each.
- [ ] **Step 6: Commit** `docs: README and --help state every exit code and rule the agent contract promises (C02-07)`

### Task 5: Roadmap, then submit

- [ ] **Step 1:** Re-check the next free id (Global Constraints). File from `docs/roadmap/_template.md`, names only:
  - `product-gaps`, `open`: "`lethal explain` does not print a survivor's R166 identity key, so an agent marking an equivalent must build it from `report.json`". Evidence: `ExplainSurvivor.readerMark` exists only for marked rows; the recipe test "a mark built by the documented recipe loads and matches".
  - `product-gaps`, `open`: "`lethal run --dry-run` accepts and ignores its execution flags (`--out`, `--progress-out`, `--tests`, `--backend` and more)". Evidence: `DRY_RUN_IGNORES` in `cli.test.ts` "the dry-run exemption is exact", which lists them and may only shrink.
- [ ] **Step 2:** `bun scripts/roadmap-index.ts`; `bun test scripts/roadmap-index.test.ts`. Commit `roadmap: file R<nnn> and R<nnn>, the mark key in explain and dry-run's ignored flags`.
- [ ] **Step 3:** Final loop: `bun run typecheck`, `rm -rf packages/*/dist`, `bun test`, `bun scripts/generate-schemas.ts --check`, biome on every touched `.ts`.
- [ ] **Step 4: Submit note:** Task 0's per-row result; Task 1 Step 2's measured lists (they replace Q1's numbers if different); Task 1 Step 6's audit output and every caller changed (or "none"); every red-check with its red assertion line and restored green; any `run-limits.test.ts` expectation changed; no schema version moved; the live-gate decision with its reason; the roadmap ids. Close issue #17 with the integrated commit when accepted.

## Out of scope, on purpose

- Fixing R230, printing the mark key in `explain`, fixing `run --dry-run`'s ignored flags: each filed or already filed, each its own scoped change.
- The verify-vs-full-run agreement gate (C02-08) and gap ids (C02-09).
- Any change to verify's behaviour, refusal set or exit codes. A disagreement found here is reported, not fixed here.
- Judging whether the prose is good (R153's own caveat, kept).

## Review responses (review-r1)

1. **Critical 1 (C1/C10 accept an invalid verify example), accepted.** Confirmed at `ca6eef2`: `parseCliConfig` only requires the flags; `verifyFromCli` calls `parseVerifyRequest`. Task 3 now runs every literal verify example through `parseCliConfig` then `parseVerifyRequest`, and extracts the ONE recipe line (`onlyLine` throws on zero or two) and fills it from every real `explain` survivor row; red-checks for `M0004`, a short artifact, a wrong recipe, a second recipe and a renamed placeholder.
2. **Critical 2 (C2's oracle is `FLAG_OWNERS`), accepted.** The oracle is now the parsed config: an accepted flag must change it ("no invocation ignores", "every owner reads"), and an owned invocation that throws for another reason is `refused-other`, not a pass. Campaign verbs, the clear-ceiling server pair and `run --dry-run` are separate invocations. A MISSING owner is invisible to the parsed config (the ownership refusal fires first), so a new test checks every flag `helpText`'s usage lines list against the parsed config; the "remove doctor from project" red-check now fails there, as the review asked. An "extra owner" red-check (`db` on `doctor`) fails "every owner reads". Stated ceiling: an owned flag in no usage line and no other test can lose its owner unseen; the submit note lists such flags. `VERIFY_FLAGS` is kept (the first draft proposed deleting it; nothing needs that).
3. **Important 3 (Q1 counts, compatibility), accepted.** Re-measured with a published definition (Task 1 Step 1 IS the measurement): master has 44 flags; `explain` ignores 35, `doctor` 32 (the review's counts; the first draft's 34 and 29 were wrong). `run --dry-run` is its own invocation, and its ignored set is an exact, filed exemption rather than silently passed. The caller audit now executes each documented or built argv through the new parser across all tracked files and reads the programmatic callers (none affected on master); external scripts are named as unknowable. Q1 is a yes/no with per-subcommand lists.
4. **Important 4 (presence checks), accepted.** C8 parses a per-field table with set equality; C9 compares the refusal table both ways and checks the exit-`3` row's `publish-*` set exactly; C6 adds "4 over 5: all error AND a flaky new test" and a case per boundary; C15 counts six numbered items inside each rules section with the phrases scoped there; C16 checks README's rule count against the reference's parsed count and rejects every other number word.
5. **Important 5 (mark key vs R230), accepted.** Confirmed: `parseEquivalenceMarks` requires exactly five fields; R230 is open. The test now LOADS a marks file built from the extracted recipe and matches it with `applyEquivalenceMarks` over non-twin survivors (including a trigger row), and a separate test pins that a six-field twin key is refused and that the doc names `identityOrdinal` and R230. C11 is no longer described as covering twins. R230 is not fixed here.
6. **Important 6 (README contradiction, al-runner claim), accepted.** Task 4 rewrites README's "does not even publish it" and adds a regression guard; Task 2 Step 4 narrows the skill's al-runner line to the reference's conditional-coverage claim.
7. **Important 7 (Task 0 insufficient), accepted.** Task 0 now requires the coord acceptance record AND `git merge-base --is-ancestor`, and a full read of the verify branch, dispatch, `verifyFromCli`, `helpText` (both blocks), `verify.ts`, the schema and C02-06b's tests, confirming every [06b] row. The [06b] table is updated to `ca6eef2`, where the CLI has landed.
8. **Minor (C3 per-verb), accepted in part.** C3 stays at subcommand level because `FLAG_OWNERS` is subcommand level; the doc states the two verb-level limits in prose and C2 covers verb behaviour through the three campaign invocations.
9. **Minor (C4 missing `verify --out`), accepted.** Task 3 adds the row and the test "verify --out is a documented, refused trap".
10. **Minor (C5 `0`/`1` meanings), accepted.** The run exit table is parsed; `0`'s "says nothing about whether mutants survived" is checked with `exitCodeForReport` returning `0` on a narrowed report, and `1`'s row must say "error".
11. **Minor (C14 misses `####`), accepted.** Headings `##` to `######`.
12. **Minor (R176 comment in `cli.test.ts`), accepted.** Task 1 Step 3 corrects it.
13. **Minor ("no live gate" needs a stronger audit), accepted.** Global Constraints make the no-gate decision conditional on the executed audit, with a named rule for when a gate must run; the plan no longer implies offline parsing proves BC behaviour.
14. **Minor (build order, schema check, stale figures), no change needed.** Confirmed by the review.

## Review responses (review-r2)

1. **Important 1 (C10 does not pin `--db`/`--tests`), accepted.** `verifyRequestOf` now returns the parsed config too, and the recipe test asserts `parsed.dbPath` is `P/lethal.sqlite` and `parsed.testDir` is `T` for every filled row (field names confirmed in C02-06b's verify branch at `ca6eef2`). Red-checks: `--db wrong.sqlite` and `--tests other-tests`, placeholders for artifact and survivors untouched.
2. **Important 2 (ownership false positive, empty-owner escape), accepted.** (a) `clear-ceiling --config` under an explicit server pair is confirmed stored-but-overridden (`resolveCeilingIdentity` returns the pair without opening the config); it is now a named, exact `PRECEDENCE_OVERRIDES` entry with its rule, each entry must still read as stored, and Task 1 Step 3 requires reading every `*FromCli` consumer for other conditional reads. C2's promise is narrowed to "stored, or listed as overridden", not "used at runtime". (b) "every row has an owner" rejects `owners: []`. (c) The intended home of EVERY flag, including the 27 run-only flags absent from usage lines such as `--changed-since`, is pinned by "every flag's owners are where --help documents it": the help's usage lines plus its per-subcommand option sections. Measured on `ca6eef2`: those homes equal the owners table for all 46 flags. This replaces round 1's usage-lines-only test, whose ceiling the review named.
3. **Important 3 (Q1 "no" path, newly-refused lists), accepted and overtaken by the owner's answer.** Q1 is recorded as decided, yes (owner, 2026-09-26); the "no" path is removed. Q1 now lists, per invocation, the exact flags accepted by `parseCliConfig` today and refused after (measured on master `eb9744f`, excluding flags already refused today), plus the 19-flag dry-run exemption.
4. **Important 4 (audit overstated), accepted.** Task 1 Step 6 is split: Part A is described as a prose/literal-command audit that cannot see argv built in code; Part B enumerates every spawn and CLI entry call in tracked non-test TypeScript with the grep given, classifies every hit (measured table included: one LethAL-argv builder, `scripts/demo-reset.ts`; `main()`; one site unparsed until read, `fixtures/do-campaign/preflight.ts`, classified as hook input), and requires no hit to stay unclassified. The no-live-gate waiver is tied to Part B's list and states its three conditions.
5. **Minor (`skipped` wording), accepted.** Rule 6, the marking section and the six-rules test now say "`skipped` is not a measured kill or survival", matching `VERIFY_VERDICTS`, which contains `skipped`.
6. **Minor (value-table first match), accepted.** `valuesOf` asserts each of the three field rows occurs exactly once; red-check adds a duplicate `results[].verdict` row.
