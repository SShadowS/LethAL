# R-307: one bad file is skipped and named, not a whole-run abort (r2)

Base: master `d1698cf1`. Item: `docs/roadmap/R307.md` (with R299, R305, R308). Owner rule: no crash
first. r2 answers `H:/lethal-coord/reviews/R-307-plan/rulings-r1.md`; see "Changes from r1" at the end.

## The idea

Every per-file throw in schemata depends on ONE file's source and specs. So `generateMutationSet`
runs the writer's own per-file steps once per file, as a trial, before the file joins `files`. A
file whose trial throws the new typed error `FileRefusedError` is refused whole. It never enters
`planArtifacts`, `assignMutantIds`, a batch or a verdict. Any other exception still aborts the run,
so an unforeseen bug is never quietly turned into an excluded file. The trial and the writer call
ONE extracted function, `instrumentOneFile`, so they cannot drift. The writer keeps every throw.
A throw that fires in the writer after a clean trial is a new LethAL bug, and it still aborts.

**A refused file still runs.** It is published uninstrumented. `prepareBatchProject` copies it as
it copies every file with no mutant, and tests that call it still run it. It only loses its mutants.

## 1. Throw sites

Per-file refusals are decided in `generateMutationSet`, in the file loop, after dedup, the
`--operator`/`--lines` filters and `canCarryMutationSelectorVar`, and before `files.push`. No mutant
id exists yet. "All of that file" holds by construction: the whole `InstrumentedFile` is never pushed.

| Site | Decision | Reason |
|---|---|---|
| `assertNoOverlap` (engine `printer.ts`) | per file, typed | Edits of one file's source only. |
| Injector unsupported kind + the three anchor throws (`compile.ts`) | per file, typed | One file's objects. |
| Latch no-owner + R303/R316/var-keyword throws (`injectReachLatches`) | per file, typed | One file's members. |
| `objectHeadersOf` no header; `assertNoUnsupportedObjectMix` (R299); `attributeHeader` (`project.ts`) | per file, typed | One file. R299 stays open: it asks for per-OBJECT dropping. |
| "no reach grain" (writer) | backstop, untyped | Built from the same `ided`; no input reaches it. |
| `LineMap` declared-but-unmapped, object WITH mutants | whole run, kept | Post-compile, after publish (C2). See below. |
| `LineMap` declared-but-unmapped, object with NO mutant | refused object, no throw | Cannot affect any verdict. Real shape: R305's split-header file. |
| Gap-id collision (writer, across files) | whole run | A hash collision between two files; no one file is at fault. |
| Duplicate basename (`prepareBatchProject`) | whole run, unchanged | A layout conflict: every file is copied flat, refused or not. |
| `dedupeSpecs` throws | whole run | An operator bug, not a file property. Called outside the `try`. |
| Generation refusals (`--only`, `--operator`, `--lines`, snapshot) | whole run | Caller input. |

**`FileRefusedError`** lives in `@lethal/engine` (the lowest package, since `assertNoOverlap` is
there) and extends `Error` directly. Fields: `file`, `shape` (`"overlap"`, `"unsupported-kind"`,
`"latch-owner"`, `"no-anchor"`, `"no-header"`, `"object-mix"`, `"site-before-header"`), `line?`. The
listed sites throw it with their CURRENT message text, which carries only paths, offsets, lines,
node kinds and object names. No site may put AL source into it (M8).

**Line map (C2).** Every `LineMap` construction site (`bcdev-backend.ts` twice, at artifact index
time; `al-runner-coverage.ts` once) passes the batch manifest's object keys (`objectType:codeunitId`).
The constructor, which runs on the EMITTED source against the COMPILED declarations before any
baseline: for each declared key with no map entry, throws the existing message if the key has a
mutant, else records it as refused with a reason, on R298's path (`refusedByKey`, named once by
`nameRefusals`). The `lookup` throw then cannot fire and is deleted. Task T5 confirms the al-runner
site builds before baseline; if it does not, the check moves to its index step. No trial-time
line-map guard: the original tree proves nothing about the emitted one.

## 2. Where the skip lands, and the scope beside the score

`skipped` (`NotInstrumentedFile`) does not fit: no reason field, and its caveat would say "cannot
carry the selector var", which is false here. `ExcludedSites` (`excluded-sites.ts`) already has
`reason` and an optional `detail`: new reason `"instrumentation-refused"`, `detail` =
`${shape}: ${message}`. The `notInstrumented` and `declarativeSites` views are untouched.

- **No source in the report (M8).** A test asserts that no refused `detail` contains any line
  (trimmed, longer than 12 characters) of the refused file's source.
- `kinds` comes from `describeObjectKinds`, so R308's gap applies. Not fixed here.
- **Scope beside the score (I6).** A refused file narrows the scope: `reliability` is `narrowed`
  (or `narrowed-degraded`) when any row has the new reason, never `full`. `scoreDescribes` gains
  "; N file(s) refused, M site(s) not mutated", so `renderConsole`'s SCOPE line prints it beside
  the score. New Caveat `"files-refused"` with its `CAVEAT_INTERPRETATIONS` entry.
- **Ripple:** `events.ts` (`mutation-set-generated.refusedFiles?`, optional, present only when
  non-empty, so older streams stay valid), `report-fold.ts` pass-through, `excluded-sites.ts`,
  `report.ts` (reliability, `scoreDescribes`, caveat), `bun scripts/generate-schemas.ts`, caveat
  counts in `interpretation.test.ts` and `report.test.ts`, then `schemas.test.ts` and
  `report-equality` unchanged. Warning code `instrumentation-refused-files` names each file.
- **Versions.** `REPORT_SCHEMA_VERSION` stays 3: its rule bumps for a renamed, removed or re-meant
  field or a new required one, and this adds an optional row value and a caveat value.
  `EXPLAIN_SCHEMA_VERSION` goes 8 to 9: its rule (R233) bumps on any widened value domain, and
  `caveat` widens. Freeze `schemas/explain-v8.schema.json`, generate v9. **Numbering against R-214:**
  whichever lands on master second takes the next free number at its merge (10 if R-214 took 9),
  regenerates, and says so in its merge commit, exactly as IDENTITY_SCHEME 5 is held for R-214.
  IDENTITY_SCHEME stays 4 (section 3).
- **No live sample regeneration.** No `SessionReport` field is added, nothing new is required, and
  no committed sample has a refused file, so every sample stays byte-identical and valid. If
  `report-equality` moves anyway, stop and tell the orchestrator before any lease.

## 3. Identity (C1, I3)

**The hazard.** Identity ordinals number twins (same astHash, object name, member, operator,
major) in source order over a batch's rows (`identityOrdinalsOf`). If Bad held ordinal 0 and a
surviving twin in another file held 1, dropping Bad would give the survivor ordinal 0, Bad's old
key, and resume, history and marks would hand it Bad's verdict.

**The reservation.** For each refused file, `generateMutationSet` records its RESERVED identities:
one `{file, startIndex, operatorName, tuple}` per deduped spec, computed BEFORE the trial runs, from
the spec set only, with no instrumentation. The fields come from one new `project.ts` helper,
`identityFieldsOf(spec, headerName)`, which the writer's own row build also uses: `astSubtreeHash`,
`procedureNameOf`, `triggerNameOf`, operator name and version. The object name is the header
regex's (`objectHeadersOf` + `attributeHeader`), as the writer's; if those are the refusal itself,
the enclosing object node's AST name is used instead. `writeInstrumentedProject` takes a REQUIRED
`reserved` input (scripts pass `[]`, so no caller forgets it). `identityOrdinalsOf` numbers rows and
reserved entries together, sorted by file, then start, then mutant id, with a reserved entry's tie
broken by operator name, which is the order `assignMutantIds` gives the same specs. Reserved
entries take a number and produce no row. Every batch gets the whole reserved list; an entry whose
tuple matches no row in that batch changes nothing.

**What is stable, exactly.**
- Against a later run where Bad instruments, in one batch (the default, and every gate): every
  surviving key is identical, twins included. M-ids of files after Bad shift; they are per-batch
  labels and may.
- Against `--exclude Bad` (Bad still in the semantic context, I3): every surviving row is
  identical, M-ids included, except a twin of a reserved entry, whose ordinal is higher by the
  number of reserved twins before it. Both "ways" cannot hold for a twin: without Bad it is ordinal
  0, with Bad instrumenting it is 1. The ruling picks the second, the one that prevents inheritance.
- With `--max-guards-per-batch`: no surviving mutant takes a reserved key within its batch. Exact
  stability against a later run holds only if Bad would land in the same batch. That limit is
  pre-existing: twins in two different batches already both get ordinal 0 today, since ordinals are
  numbered per batch. T9 files it; it is not widened here.

No key is computed differently for an instrumented file, so IDENTITY_SCHEME stays 4.

## 4. When the run still refuses (I5)

Only when nothing is left to measure: at least one file was refused and no file is left to
instrument. A plain `Error` (exit 1, like the empty `--lines` refusal), naming every refused file
and its shape. Everything else runs, with the scope shown (section 2).

## Tasks

Build loop per CLAUDE.md (native parser if needed, `bun run typecheck`, `rm -rf packages/*/dist`,
`bun test` from repo root, `bunx biome check <touched files>`). No al-runner, no live BC. Each
red-check reverts one named line, pins the exact failing assertion, and restores.

**T1. `FileRefusedError` (engine) and typed throws** at the sites in section 1 (engine
`printer.ts`, schemata `compile.ts`, `project.ts`), message text unchanged. Test: each existing
throw test also asserts `instanceof FileRefusedError` and its `shape`.

**T2. Extract `instrumentOneFile` and `identityFieldsOf`; add `reserved`** (schemata `project.ts`,
`index.ts`). A verbatim move plus the reserved entries in `identityOrdinalsOf`. Test: manifest of
`fixtures/sandbox-data` byte-identical before and after with `reserved: []`. **Tell the
orchestrator before the `project.ts` commit** (R-214 edits this file; the preproc lane is
coord-only). Merge master first.

**T3. Trial and refused list** (runner `orchestrator.ts`): in the loop, compute reserved entries,
then `try { instrumentOneFile(...) } catch (e) { if (!(e instanceof FileRefusedError)) throw e; ... }`.
Thread `refused` and `reserved` through `MutationSetResult`, `runSession`, `prepareArtifactDir`
(bisection included). Tests in `packages/runner/tests/per-file-skip.test.ts`, temp project dirs,
`generateMutationSet` then `writeInstrumentedProject`.

**T4. One test per real shape.** Each asserts the exact refused row (`file`, `kinds`, `sites`,
`reason`, full `detail`), that the good file writes, and that no manifest row names the bad file.
- Mix (R299): table + enum + codeunit in one file. Red-check: move `assertNoUnsupportedObjectMix`
  out of `instrumentOneFile` into the writer; the refused-row assertion fails (no row) and the
  write throws `object-mix`.
- Injector: a plain codeunit plus an R305 split-header codeunit in one file. Step 1 confirms on
  master that it throws the unsupported-kind message; if not, report it and move it to T4b.
  Red-check: change the `instanceof` test to a class that never matches; the test fails with the
  exact `unsupported-kind` error escaping `generateMutationSet`.
- No header: try R-297's plan shapes first; if none reaches it, say so and drop the case.
- An unforeseen error aborts: a stubbed plain `Error` from `instrumentOneFile` propagates. Red-check:
  catch everything; the test fails because a row appears.
- No source in `detail` (section 2) over all rows above.

**T4b. Sites no real AL reaches:** latch no-owner (`compile.test.ts` already says no real statement
sits outside every member) and `assertNoOverlap` (operator specs are laminar; insertions are zero
width; no known shape). Hand-built node and hand-built partial-overlap spec pair through
`instrumentOneFile`: exact message and `shape`. Red-check: throw a plain `Error` at that one site;
the `instanceof` assertion fails.

**T5. Line map (C2).** (a) `lineMapFromSources` over the R305 split-header file (no mutant) plus a
normal file, both declared: construction succeeds, `refusedByKey().get(key)` equals the exact
reason, `lookup` returns `undefined`. Red-check: delete the refuse branch; the exact reason
assertion fails. (b) A declared key with a manifest mutant and no map entry (hand-built; no real
shape known): construction throws the exact existing message. Red-check: drop the mutant check;
nothing throws.

**T6. Identity (C1, I3).** Cross-kind same-name twin: `A_Twin.Table.al` (table 50100 "Twin", plus
an enum, so the file is refused as `object-mix`) and `B_Twin.Codeunit.al` (codeunit 50100 "Twin"),
each with the same `procedure Bump(): Integer begin exit(1 + 1); end;`. Run 1: the enum in its own
file, so A instruments. Run 2: A refused. Assert: B's serialized `identityKeyOf` in run 2 equals run
1's and differs from A's run-1 key; given run-1 verdicts A `killed`, B `survived`, the resume index
(`resume.ts`) carries `survived` to B and nothing to anything else. Red-check: pass `reserved: []`;
B's key equals A's run-1 key (ordinal 0) and the equality fails with both keys printed. Also
compare run 2 with an `--exclude A_Twin.Table.al` run: all non-twin rows deep-equal including
`mutantId`; B's ordinal is exactly 1 higher.

**T7. Layout and execution (I3, I4).** (a) `a/Dup.Codeunit.al` refused and `b/Dup.Codeunit.al`
good: the run still refuses with `prepareBatchProject`'s exact duplicate-basename message. (b)
With the orchestrator's fake backend (`orchestrator.test.ts`): a test calling Good and the refused
Bad keeps its Good coverage (Good's mutant is scored, not `no-coverage`); a test that calls Good's
`P2` then fails inside Bad makes P2's mutants, covered only by it, `error` with the baseline note,
never `survived`. Also assert Bad's file sits in the batch dir byte-identical to its source.
Red-checks: exclude refused files from `prepareBatchProject`'s copy, and the batch-dir assertion
fails; let the fake report the failing test as passing, and P2's exact `error` assertion fails.

**T8. Refusal and scope.** All files refused: throws the exact message. One refused, one good: runs,
`reliability` `narrowed`, SCOPE line contains "1 file(s) refused". Red-check: remove the refused
term from the reliability condition; the report says `full` and the assertion fails. Then the
ripple in section 2, explain v9, and the fold test (a stream without `refusedFiles` folds to
today's bytes).

**T9. Measure the trial's cost (M7).** No caching. W4 from RUST-03
(`docs/superpowers/specs/2026-09-28-rust-03-precommitment.md`): `bun scripts/measure-peak.ts bun
packages/runner/src/cli.ts run --project "U:/Git/BC.History/BaseApp/Source/Base Application"
--dry-run`, three runs on master and three on this branch, same day. Gate in owner order: every run
completes with no crash; median peak at or under 16,384 MB (the W4 ceiling) and at or under master's
same-day median plus 5%. Report wall time against master's (RUST-03's final W4 was 5,001 MB, 493.72
s) but do not gate on it. Diff the two outputs: any new `instrumentation-refused-files` lines are a
finding about BaseApp; list them. A miss is filed and reported before landing.

**T10. Roadmap.** `R307` `done (<commit>)`; a line on R299 (now a named per-file skip, open for
per-object dropping); file one item for cross-batch twins sharing ordinal 0 (re-check the next free
id in every worktree first); `bun scripts/roadmap-index.ts`.

## Changes from r1

- **C1:** reserved identity ordinals for refused files (section 3), cross-kind twin test with a
  resume carry check (T6).
- **C2:** the unmapped throw stays for any compiled object with mutants, checked at line-map
  construction on emitted source against compiled declarations; the trial-time guard is removed.
- **I3:** duplicate-basename test (T7a); surviving rows compared against `--exclude Bad` (T6).
- **I4:** section "The idea" says a refused file still runs; T7b pins coverage and baseline errors.
- **I5:** the more-than-half rule is gone; exit 1 only when nothing is left to measure.
- **I6:** reliability `narrowed`, SCOPE line names the count, explain 8 to 9 with the R-214 rule.
- **M7:** no caching; T9 measures W4 against the RUST-03 ceiling.
- **M8:** typed `FileRefusedError`, never a generic catch; no source in `detail`, tested; every
  red-check pins an exact row or message.
- **Coordination:** tell the orchestrator before the `project.ts` commit.

## Open question

- Section 3: a twin of a refused file cannot keep its key both against `--exclude Bad` and against
  a later run where Bad instruments. This plan keeps the second, as C1 prefers. Confirm.
