# R-307: one bad file is skipped and named, not a whole-run abort

Base: master `d1698cf1`. Item: `docs/roadmap/R307.md` (with R299, R305, R308). Owner rule: no crash first.

## The idea in one paragraph

Every schemata throw that can refuse a file depends on ONE file's source and specs. So
`generateMutationSet` runs the writer's own per-file steps once per file, as a probe, BEFORE the
file joins `files`. A file whose probe throws is recorded as refused, with the error text, and never
enters `planArtifacts`, `assignMutantIds`, `identityOrdinalsOf`, a batch or a verdict. The probe and
the writer call ONE extracted function, so they cannot drift. The writer keeps every throw as a
backstop: if one fires after a clean probe, that is a new LethAL bug and it still aborts loudly.

## 1. Throw sites: per file or whole project

All "per file" rows are decided in `generateMutationSet`, after the file's specs pass dedup, the
`--operator` and `--lines` filters and `canCarryMutationSelectorVar`, and before `files.push`. That
is before any mutant id or identity ordinal exists. "All of that file" holds by construction: the
unit of refusal is the whole `InstrumentedFile`, which is simply never pushed.

| Site | Decision | Reason |
|---|---|---|
| `assertNoOverlap` (engine `printer.ts`), via `compileSchemataForFile` | per file | Edits of one file's source only. |
| Injector unsupported kind (`injectMutationSelectorVar`, `compile.ts`), plus its three anchor throws in `injectSelectorVarIntoObject` | per file | One file's objects. |
| Latch no-owner (`injectReachLatches`), plus its R303/R316/var-keyword throws | per file | One file's members. |
| `LineMap.lookup` declared-but-unmapped (`line-map.ts`) | split, see below | Fires AFTER publish, at coverage time. |
| `objectHeadersOf` "no AL object header" (`project.ts`) | per file | One file's text. |
| `assertNoUnsupportedObjectMix` (R299, `project.ts`) | per file | One file's headers. R299 stays open: it asks for per-OBJECT dropping. |
| `attributeHeader` "sits before first header" | per file | One file. |
| "no reach grain" (writer) | backstop only | Built from the same `ided`; no input reaches it. Not in the probe. |
| Gap-id collision (writer, across files) | whole project | A 48-bit hash collision between two files; no single file is at fault. |
| `dedupeSpecs` throws (same operator twice, same-tier clash, unorderable tier) | whole project | An operator or registry bug, not a file property. Skipping would hide it as a smaller mutant set on every file with that shape. Runs outside the probe's `try`. |
| Generation refusals (`--only`/`--exclude` empty, unknown `--operator`, unknown `--lines` file, snapshot miss) | whole project | Caller input. Unchanged. |

**The line map, in two halves.** (a) An UNMUTATED declared object with no map entry cannot affect
any verdict, yet today it aborts the run the moment a test touches it. Real shape: R305's
`preproc_split_declaration` codeunit, which `generateMutationSet` already skips but the batch still
compiles and declares. Fix: the `LineMap` constructor marks every declared key it did not map as
REFUSED, with a reason, the same path R298 uses (`refusedByKey`, and `nameRefusals` names it once).
The throw in `lookup` becomes dead and is deleted. (b) A MUTATED object with no map entry would now
read `no-coverage` silently, which breaks "never reach a verdict". So the probe also runs the line
map's own rule: every spec's enclosing object (walk up to a child of `isObjectContainer`) must be a
root in `fileLineMapEntries(root, objectIdentityOf)`, else the file is refused. No known real AL
reaches (b): a split header is refused by the injector first, and a `#if`-wrapped object is mapped
(as refused, R298). It is the guard that makes (a) safe.

## 2. Where the skip lands

`skipped` (`NotInstrumentedFile`: file, kinds, sites) does NOT fit: it has no reason, and its
warning and caveat say "cannot carry the selector var", which would be false here. But
`ExcludedSites` (`excluded-sites.ts`) was built for exactly a third reason: rows carry `reason` and
an optional `detail`. So: new reason `"instrumentation-refused"`, `detail` = the error message.
`notInstrumented` and `declarativeSites` views are untouched (`rowsOf` filters by reason).

- `detail` must never carry source. Checked messages carry paths, offsets, node kinds and object
  names only, which the 2026-08-09 ruling allows. A test asserts no refused `detail` contains the
  site's source text.
- `kinds` comes from `describeObjectKinds`, so R308's gap (a `#if`-wrapped object is misnamed)
  applies here too. Not fixed here; the mix message in `detail` names the objects correctly.
- Ripple: `events.ts` (`mutation-set-generated.refusedFiles?`, optional, present only when
  non-empty, so older streams stay valid), `report-fold.ts` (pass through to `buildExcludedSites`),
  `excluded-sites.ts` (reason union + input), `report.ts` (Caveat `"files-refused"` +
  `CAVEAT_INTERPRETATIONS` + the push beside `uninstrumentable-files`), `bun scripts/generate-schemas.ts`
  (two enums widen), counts in `interpretation.test.ts` and `report.test.ts`, then
  `schemas.test.ts` and `report-equality` run unchanged. Warning code `instrumentation-refused-files`
  names each file and its reason, like `not-instrumentable-files-skipped`.
- **No live sample regeneration.** No `SessionReport` field is added (`excludedSites` exists and is
  optional), no enum value is required, and no committed sample has a refused file, so every sample
  stays byte-identical and valid. No lease is needed. If `report-equality` moves anyway, stop and
  tell the orchestrator before any lease.

## 3. Identity

M-ids are numbered by `assignMutantIds` inside `writeInstrumentedProject`, per BATCH (counter from
1, files in path order), and identity ordinals by `identityOrdinalsOf` over that batch's rows. A
refused file never reaches either. So a project `{A, Bad, C}` produces, for A and C, the same M-ids,
identity keys, gap ids and manifest rows as `{A, C}`, provided Bad adds nothing to the semantic
context the others read (the test's files share no names). The test proves it byte for byte.

Against a later run where Bad instruments, C's M-ids shift by Bad's mutant count, exactly as adding
any file does today. M-ids are per-batch labels, never cross-run identity. Identity keys do not
shift, except for a cross-file twin in one batch (same astHash, object name, member and operator in
two objects of different kinds sharing a name, R70's shape), which is also what adding a file does.
Nothing about how a key is computed for unchanged source changes, so `IDENTITY_SCHEME` stays 4.

## 4. Threshold

After the loop, `generateMutationSet` throws a plain `Error` (exit 1, like the barren `--operator`
and empty `--lines` refusals) when either holds:
- at least one file was refused and no file is left to instrument; or
- refused files hold more than half of the would-be sites (sum of `fileSpecs.length`, refused vs
  refused + instrumented).

Past half, the score describes a minority of the code asked about. The message names every refused
file with its reason and says `--exclude <file>` runs the rest; that turns a silent shrink into an
explicit narrowing, which the report already labels (`only-narrowed-run`). No new flag.

## Tasks (ordered)

Build loop per CLAUDE.md: native parser if needed, `bun run typecheck`, `rm -rf packages/*/dist`,
`bun test` from repo root, `bunx biome check <touched files>`. No al-runner, no live BC.

**T1. Extract the per-file step (schemata, `project.ts` only).** Move `objectHeadersOf`,
`assertNoUnsupportedObjectMix`, `compileSchemataForFile`, the `grainOf` map and a per-spec
`attributeHeader` out of the writer's loop into `export function instrumentOneFile(f, deduped,
ided)` returning `{ headers, compiled, grainOf, headerOf }`; the writer calls it; export via
`index.ts`. About 25 moved lines, no behaviour change. Coordination: this is the only schemata edit,
and it sits inside R-214's file. Merge master first, keep the move verbatim, tell R-214's lane.
Test: existing schemata suite green, manifest bytes of `fixtures/sandbox-data` unchanged (a
before/after `writeInstrumentedProject` diff in the test run).

**T2. The probe and the refused list (runner, `orchestrator.ts`).** In the loop, after the
`canCarryMutationSelectorVar` branch: dedup, local ids, `try { instrumentOneFile(...); lineMapGuard
}` `catch` records `{file, kinds, sites: fileSpecs.length, detail}` and `continue`s. Add `refused`
to `MutationSetResult`, emit the warning. Test file `packages/runner/tests/per-file-skip.test.ts`
(temp project dirs, `generateMutationSet` then `writeInstrumentedProject` on the result).

**T3. One test per real shape, each asserting: the good file instruments and writes, the bad file
is named with its reason text, no manifest row names the bad file.**
- Mix (R299): table + enum + codeunit in one file. Red-check: move `assertNoUnsupportedObjectMix`
  back out of `instrumentOneFile` into the writer: generation admits the file and the write throws.
- Injector: a plain codeunit plus a `#if`-split-header codeunit (R305 shape) in one file. Step 1
  confirms on master that this throws the unsupported-kind message; if it does not, report it and
  treat the injector like the latch below. Red-check: delete the probe's `catch`: the run throws.
- No object header: a file whose only object the header regex misses. Find one by trying the
  shapes in R-297's plan (`docs/superpowers/plans/2026-09-28-R-297-instrumentation-real-corpora.md`)
  first; if none, say so and drop this test. Red-check as the mix row.

**T4. Sites no real AL reaches.** Latch no-owner (the comment in `compile.test.ts` already says no
real statement sits outside every member) and `assertNoOverlap` (operator specs are laminar and
insertions are zero width; no known shape). Test `instrumentOneFile` with the existing hand-built
detached node, and a hand-built partial-overlap spec pair, expecting the same messages the probe
records. Red-check: remove the call inside `instrumentOneFile` that holds each throw; the test goes
green-to-red on the missing message.

**T5. Line map (runner, `line-map.ts`).** Constructor refuses unmapped declared keys; delete the
`lookup` throw; probe guard (b) from section 1. Tests: (a) `lineMapFromSources` over an R305
split-header codeunit file plus a normal one, both declared: `lookup` returns `undefined`,
`refusedByKey` names the split one, no throw. Red-check: restore the throw, the test goes red.
(b) guard: hand-built root where a spec's object is not a map root, refused. Red-check: drop the
guard.

**T6. Identity.** Test: `{A, Bad, C}` vs `{A, C}` through `generateMutationSet` +
`writeInstrumentedProject`; the two manifests' rows for A and C are deep-equal, including `mutantId`
and `identityKeyOf`. Bad sorts between A and C so a shift would show. Red-check: push Bad into
`files` anyway and drop its rows in the writer after `assignMutantIds` (a skip AFTER numbering):
C's ids no longer match.

**T7. Threshold.** Tests: all refused, throws; refused > 50% of sites, throws naming files and
`--exclude`; 1 of 3 refused, runs. Red-check: flip `>` to `>=` and the boundary test at exactly half
goes red.

**T8. Report ripple** (section 2 list). Test: a fold over a stream with `refusedFiles` yields an
`excludedSites` row with the new reason and `detail`, the caveat, and a validating report; a stream
without it yields byte-identical output to today. Red-check: drop the fold pass-through.

**T9. Roadmap.** `R307` to `done (<commit>)`; add a line to R299 (now a named per-file skip, still
open for per-object dropping); `bun scripts/roadmap-index.ts`.

## Open questions

- Is "M-ids stable against `{A, C}`, keys stable against a fixed Bad" the invariant the reviewer
  wants? Stable M-ids against a FIXED Bad would need id reservation across batches, which M-ids have
  never had; this plan does not build it.
