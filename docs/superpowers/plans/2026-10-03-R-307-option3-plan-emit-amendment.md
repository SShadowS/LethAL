# R-307 plan amendment: option (3), PLAN + EMIT split (draft r3)

Amends `docs/superpowers/plans/2026-09-30-R-307-per-file-skip.md` (r3, c6555c6d). That plan lives on
branch `lethal/lane-code`, not on master. Status: DRAFT r3. Reviewers: the orchestrator, plus
gpt-6.1-sol when pi is installed in the container (Claude-only review until then). No code is built
before step 1 (the measurement) passes and this amendment is approved.

## Changes since r1 (answers `/coord/reviews/R-307-amend/claude-adversary-r1.md`)

Each numbered item answers the review item with the same number. Changed sections are marked **[r2]**.

1. `measure-peak.ts` units: new task **T0** inside step 1 (section 4), red-checked, checked by the
   1 GB probe. The 16,384 MB ceiling stays, and is only read after T0 lands.
2. Control: M is pinned to `99b3dbc3` on Linux. A run counts only if median B > median M × 1.05;
   otherwise the result is **inconclusive**. The 4189 MB comparison is gone (section 4).
3. O8 is no longer circular: **O1** now also records the sha256 of every fixture file's instrumented
   output BEFORE any refactor, and O8 compares against that record (sections 5 O1, O8).
4. C8 red-check: uses the inline xmlport case at `compile.test.ts:799` (the test at :774), run
   through `planOneFile` (section 5 O8).
5. E1 test: a spy makes PLAN's `resolveStatement` throw; the real `planOneFile` and orchestrator run
   (section 5 O6).
6. PLAN and EMIT are separate MODULES, `dispatch.ts` split too. EMIT may import from PLAN only with
   `import type`. Plan lookups are total (each edit carries what EMIT needs; EMIT does no Map
   lookup). EMIT has no `??` / `||` fallbacks. All pinned by the scan (sections 3, 5 O7).
7. I5: a counting `Proxy` counts EVERY property read on every node, not three named getters
   (sections 2, 5 O5).
8. The known batch-subset gap now cites **R419** (section 3).

## Changes since r2 (answers `/coord/reviews/R-307-amend/claude-adversary-r2.md`)

Changed sections are marked **[r3]**.

1. The table no longer breaks its own import rule. `printer.ts` and `project.ts` are now
   COMPOSITIONS. `joinEdits` moves to a new EMIT file `engine/src/ast/join-edits.ts`, and
   `planOneFile` moves to a new PLAN file `schemata/src/project-plan.ts`. The `dispatch.ts` barrel
   is on the "neither" list by name, and no PLAN or EMIT module may import it, because O7 sees
   direct imports only (section 3, O7).
2. The writer gets each mutant's header (and grain) from `FilePlan.mutants`, a list in `ided`
   order, walked in step with `ided`. A missing or out-of-order entry throws. No map lookup is
   needed (section 3, "What PLAN hands EMIT").

Words used here:
- **Trial**: the per-file dry instrumentation inside `generateMutationSet`
  (`packages/runner/src/orchestrator.ts:1016-1022`). It exists to find a refused file before the
  writer does.
- **PLAN**: the step that decides, and that throws. It builds a rewrite map of spans and kinds only.
- **EMIT**: the step that turns a finished plan into text. It cannot refuse.
- **Refusal**: a `FileRefusedError`. It skips one file and names it, instead of aborting the run.
- **Peak**: the largest resident memory of the process (maxRSS), as `scripts/measure-peak.ts` prints it.
- **Total lookup** [r2]: a read that cannot miss. EMIT never asks a map "what is X's plan?"; the
  edit it is emitting already holds X's plan as a field.

## 1. Context and why

T9 missed its bar. On BaseApp (BC.History 4d61fc58), a dry run peaks at 4362 MB on master and
5248 MB on this branch, about 20% more; the bar is master plus 5%. Attribution (task-9-attr2) found
the cause is the T3 trial: stubbing the trial alone brings the branch to 4189 MB, below master.
These figures are from the Windows host. The trial runs the whole writer path per file, so it builds
every dispatch chain and the full instrumented file text, then throws them away. Most throw
decisions do not need that text. So we split the writer into PLAN (all decisions, all throws, no
text) and EMIT (text only). The trial runs PLAN only. The pre-check is then the real code path, so
it is exact and cannot drift from it.

## 2. Rulings (decided, not reopened)

- **Q1 = (a).** PLAN holds every throw: the 12 `FileRefusedError` sites (H1-H3 in `project.ts`,
  C1-C8 in `compile.ts`, P in `engine/src/ast/printer.ts:63`), the plain Errors, and
  `assertNoOverlap`, run on a span-only rewrite map. EMIT cannot refuse. The trial runs PLAN only.
  No hand-written per-site predicates (the P1-P4/G1 pre-check from option3-throw-sites.md is NOT built).
- **Q2.** The plain-Error checks go into PLAN: E1/E2 (`enclosing.ts:46,57`), E3 (`dispatch.ts:297`),
  E4 (`printer.ts:44`), E5/E6 (`project.ts:543,548`). `per-file-refusal.test.ts:193` and
  `per-file-skip.test.ts:176` stay unweakened.
- **Q3.** No dry-run fallback. Pinned by a source-scan test and a fixture soundness sweep, both red-checked.
- **c1.** ONE shared function describes a splice. PLAN uses it to decide reach grain over spans;
  EMIT uses it to build text. No second copy. Test: PLAN's grain equals today's regex grain
  (`dispatch.ts:272-276`) on every fixture file. `describeSplice` limits the filler's look-ahead to
  the root's end, as `emptiedSlotFiller` does now, so the three-piece window equals today's regex
  input.
- **I4.** `RangeError: Invalid string length` stays in EMIT as a crash, not a 13th refusal shape.
  It is documented at the EMIT boundary as a real-run crash a dry run will not see. The source scan
  allows exactly this one non-refusal failure in EMIT, by name.
- **I5** [r2]. PLAN reads every operator-supplied node and freezes the answers (spans, predicate
  results). EMIT slices `source` by span and never touches a node. Test: every node a custom-tier
  spec supplies is wrapped in a counting `Proxy` whose `get` trap counts EVERY property read; after
  PLAN returns, EMIT adds zero reads (O5).
- **Order.** (1) Measure T9 first with a PLAN-only prototype. (2) Review this amendment. (3) Build.

## 3. The PLAN/EMIT boundary

### Modules [r2, r3]

PLAN and EMIT live in separate files. A file is either PLAN, EMIT, a composition (calls plan then
emit, holds no instrumentation logic of its own), or on a named "neither" list. The source scan (O7)
pins the lists. A composition may import VALUES from both PLAN and EMIT; that is the only place the
two meet.

| Role | Module | Holds |
|---|---|---|
| PLAN | `engine/src/ast/rewrite-plan.ts` (new) | `planEdits`: E4, the stable sort, `assertNoOverlap`, P |
| EMIT | `engine/src/ast/join-edits.ts` (new) [r3] | `joinEdits` (the final join) |
| composition | `engine/src/ast/printer.ts` [r3] | `printWithRewrites` = `planEdits` then `joinEdits`; nothing else |
| PLAN | `schemata/src/dispatch-plan.ts` (new, from `dispatch.ts`) | `describeSplice`, `leadingBeginEnd`, `placeReach`'s decision, `reachGrainOf`, `headerEndOf`, `preambleArmHeaderEnds`, `splitVarHoistAnchor`, `varSectionUnparsed`, `reachLatchRefusedOwner`, `sameNode` |
| EMIT | `schemata/src/dispatch-emit.ts` (new, from `dispatch.ts`) | `emitDispatch`, `REACH_MARKER`, splice TEXT built from `SpliceParts` |
| neither (named) [r3] | `schemata/src/dispatch.ts` | re-exports only, kept so `index.ts` and existing tests (`enclosing.test.ts`) resolve; no function bodies. No PLAN, EMIT or composition module may import it: they import `dispatch-plan.ts` / `dispatch-emit.ts` directly (today `compile.ts:24` and `project.ts:19` import it; both move) |
| PLAN | `schemata/src/compile-plan.ts` (new, from `compile.ts`) | `planFile`, `injectReachLatches` (C1-C4), `injectMutationSelectorVar` / `injectSelectorVarIntoObject` (C5-C8), `latchNameFor`, `latchAnchorInVarSection`, `insertionNodeAt`, `wrapIfSingleStatementSlot`'s decision, `refusal` |
| EMIT | `schemata/src/compile-emit.ts` (new) | `emitFile`, the `begin ... end` wrap text, `EMIT_CRASHES` and the I4 header comment |
| composition | `schemata/src/compile.ts` | `compileSchemataForFile` = `planFile` then `emitFile` |
| PLAN | `schemata/src/project-plan.ts` (new) [r3] | `planOneFile`, H1-H3, E5/E6, `objectHeadersOf`, `stripAlComments` / `maskAlNonCode`, `assertNoUnsupportedObjectMix`, `attributeHeader` |
| EMIT | `schemata/src/project-emit.ts` (new) | `emitOneFile` |
| composition (writer) [r3] | `schemata/src/project.ts` | `instrumentOneFile` = `planOneFile` then `emitOneFile`; `writeInstrumentedProject` (the writer: dedup, ids, manifest rows, file writes). Holds no `new FileRefusedError` and builds no instrumented AL text; its manifest code reads only `FilePlan` fields |
| PLAN | `schemata/src/components.ts`, `enclosing.ts` | `buildComponents`, `resolveStatement` (E1, E2) and `resolveSite` |

[r3] r2 kept `printer.ts` as EMIT and `project.ts` as PLAN, but `printer.ts` needed a VALUE import
of `planEdits` and `project.ts` a VALUE import of `emitOneFile`, which the import rule forbids. Both
are now compositions, and the logic they held moved to `join-edits.ts` and `project-plan.ts`.
`printer.test.ts:57` still calls `printWithRewrites` and is unchanged.

**Import rule** [r2]: an EMIT module may import from a PLAN module only with `import type` (the type
of the plan). It may import values from other EMIT modules and from modules that are neither (for
example `@lethal/engine`'s `FileRefusedError` type is a type-only import too). A PLAN module may not
import from an EMIT module at all.

**Total lookups, no fallbacks** [r2]: every value EMIT needs is a field of the edit it is emitting.
EMIT does no `Map.get`, no `.find`, and uses no `??` and no `||` (so no quiet `?? ""` default can
stand in for a missing plan). Together with the biome `noNonNullAssertion` rule this leaves EMIT one
way to get a value: read a field PLAN set.

**Split functions:**
- `spliceIntoRoot` (`dispatch.ts:292`) becomes `describeSplice(root, member, source)` in
  `dispatch-plan.ts`, returning `SpliceParts = { relStart, relEnd, insert }`. It holds the E3 span
  check, the empty-slot filler (`emptiedSlotFiller`, `dispatch.ts:352`, its look-ahead limited to
  the root's end) and the `;` decision. This is THE c1 function. A helper
  `leadingBeginEnd(parts, s)` runs `LEADING_BEGIN` over the three-piece window
  `source[S.start, before.start) + insert + source[before.end, S.end)`. EMIT builds splice text from
  the frozen `SpliceParts` only.
- `placeReach` (`dispatch.ts:251`): grain and placement (P0-P3, plus the `begin` offset for P1) go
  to PLAN via `describeSplice` + `leadingBeginEnd`. The marker text goes to EMIT.
- `reachGrainOf` (`dispatch.ts:84`): computed once in PLAN and stored on the member plan. Today it
  runs three times (`compile.ts:95`, inside `emitDispatch`, `project.ts:784-786`).
- `resolveSite`: export kept for `enclosing.test.ts`. PLAN calls a new `resolveStatement` (E1, E2
  by span, no `mutatedText`).
- `printWithRewrites` (`printer.ts:9`): E4, sort and P move to `rewrite-plan.ts` (`planEdits`).
  `printer.ts` holds no `new FileRefusedError` and `printer.test.ts:57` is unchanged. The early
  return on an empty map stays before E4.
- `compileSchemataForFile` (`compile.ts:27`) becomes `planFile` + `emitFile`; the old name stays as
  the composition.
- `instrumentOneFile` (`project.ts:765`) becomes `planOneFile` + `emitOneFile`; the old name stays as
  the composition, used by the writer.

**What PLAN hands EMIT** [r2] (frozen, plain data; no node or operator object is read after this,
and no lookup can miss):

```ts
interface FilePlan {
  source: string;
  headers: readonly ObjectHeader[];         // for the manifest, plain data
  edits: readonly PlannedEdit[];            // sorted, E4 and P checked; in today's insertion order
  mutants: readonly PlannedMutant[];        // [r3] one per ided spec, in `ided` order
}
interface PlannedMutant { mutantId: string; header: ObjectHeader; grain: ReachGrain }
type PlannedEdit = { start: number; end: number; kind: string; header: ObjectHeader; payload:
  | { kind: "text"; text: string }                         // latch decl, var blank, selector var
  | { kind: "chain"; component: PlannedComponent; latch: string | undefined; wrap: boolean } };
interface PlannedComponent {
  rootStart: number; rootEnd: number;                      // spans only
  members: readonly PlannedMember[];                       // carried, not looked up
}
interface PlannedMember {
  mutantId: string; guard: number; mutatedText: string;
  grain: ReachGrain; splice: SpliceParts; place: Placement;
}
```

r1's `headerOf` and `memberPlan` maps are gone: the header and each member's plan travel inside the
edit. `headers` is still returned by `planOneFile` for the manifest, as plain data.

**Where the writer gets each mutant's header** [r3]. Today `writeInstrumentedProject`
(`project.ts:814-830`) reads `headerOf.get(mutantId)` and `grainOf` from `instrumentOneFile`. After the
split, `planOneFile` computes both once per ided spec (`attributeHeader`, `reachGrainOf`, exactly as
`project.ts:784-790` does now) and returns them as `FilePlan.mutants`, in `ided` order.
`instrumentOneFile` passes `mutants` through unchanged. The writer walks `ided` and `mutants`
together, by position, with `for ... of` over `ided` and a running index. It throws a plain `Error`
naming the file and the mutant if the lengths differ or `mutants[i].mutantId !== ided[i].mutantId`.
This is a caller-contract check in the writer (a composition), not a refusal, and it replaces today's
"no object header for <id>" throw at `project.ts:828-830`. The `headerOf` and `grainOf` maps go away.

Edit order must match today's insertion order: latches first (`compile.ts:53`), then chain
placeholders in component order (`compile.ts:54-59`), then selector edits (`compile.ts:73`). The
stable sort plus this order is what lets a zero-width latch at `begin` sit before a chain whose root
starts at the same offset. Identity-keyed `Map` semantics (first position kept on overwrite) apply
inside PLAN while the edit list is built, and carry over unchanged.

**The EMIT boundary note (I4)** goes in the header comment of `compile-emit.ts` and in a constant
`EMIT_CRASHES = ["RangeError: Invalid string length"] as const`: "EMIT builds text of
size sum(k+1)·L per component. If that passes the engine's string limit, EMIT crashes the run. This
is a crash, not a refusal. A dry run runs PLAN only and will not see it."

**Known gap, unchanged by this amendment — R419** [r2]: the writer plans on batch subsets
(`narrowFilesToSubset`), and grain is not monotone in the spec set, so C1-C4 can still first fire
at write time (`docs/roadmap/R419.md`). Today's trial has the same gap. It is a refusal raised by
PLAN in the writer, not by EMIT, so "EMIT cannot refuse" still holds. This amendment does not close
R419.

## 4. Step 1: measure first (before review, before build)

Blocked today: the corpus is not in the container (task-9-plan-only.md; coord question
q-20261003T220718-cb1965c4, pending owner).

**T0. Fix `measure-peak.ts` units (red-checked)** [r2]. On Linux, Bun's
`resourceUsage().maxRSS` is in BYTES (measured in the container: a 1 GB child printed
`peak_mb 1061668`); the script divides by 1024 as if KB (`scripts/measure-peak.ts:17`, comment
:3-4, proven on Windows only, where 1 GB printed 1,364 MB).
- Change: a pure function `maxRssToMb(maxRss, platform)` exported from the script: `linux` divides
  by 1024 × 1024; `win32` keeps today's ÷ 1024 (proven); any other platform THROWS naming it (no
  guessed unit). The header comment states the unit per platform and the date each was measured.
- Check: the 1 GB probe. `scripts/measure-peak.test.ts` spawns a child that allocates and fills
  1 GB (as the Windows proof did), runs it through the script, and asserts `peak_mb` is in
  [1024, 2048] on the platform it runs on. Plus a unit test of `maxRssToMb` for both platforms and
  the throw.
- Red-check: restore `/ 1024` for `linux`; the probe test goes red with a value near 1,061,668;
  restore; green. Report both outputs.
- T0 is a measuring-tool fix and lands as its own commit before any measurement below.

- **Prototype**: a throwaway WIP on top of lane-code HEAD where the trial calls a PLAN-only path:
  everything up to and including `planEdits`, with chain payloads as placeholders and no
  `emitDispatch`, no splice text, no join. It need not be clean; it must run PLAN's real decisions
  (all 12 sites, the plain Errors, `assertNoOverlap`) and build no chain text.
- **Sides** [r2]: M = master pinned at `99b3dbc3`, B = lane-code HEAD, P = prototype, S = trial
  fully stubbed (optional). All four on the SAME Linux machine, with T0's fixed script. S is
  compared only with this M, never with the host's 4189 MB.
- **Command**, one process at a time, never in parallel, alternating M, B, P, (S), three rounds:
  `bun scripts/measure-peak.ts bun packages/runner/src/cli.ts run --project "$BAPP" --dry-run`
  with `BAPP` = BaseApp `Source/Base Application` at BC.History `4d61fc58bc55dd0acb78f8b9b6ea54109b960785`.
  Read `peak_mb` and `wall_s` from the `measure-peak:` stderr line. Keep stdout of every run.
- **Control** [r2]: the run COUNTS only if median B > median M × 1.05, i.e. the Windows excess
  reproduces on this machine. If not, the result is **inconclusive**: stop, send the table to the
  orchestrator, do not start the build, and do not read P against the bar.
- **Bar** (only when the control holds): P's median peak at or under M's median × 1.05, and at or
  under 16,384 MB; no crash; P's stdout byte-identical to B's (same refused rows, none expected on
  BaseApp). Wall time is reported against M, not gated.
- **Miss**: stop. Send the table (M/B/P/S, peak and wall per run, medians, and whether the control
  held) to the orchestrator. Do not start the build.
- Raw output to `/coord/handoff/R-307/raw/t9-plan/`.

## 5. Tasks (after the measurement passes and the amendment is approved)

Build loop per CLAUDE.md for every task: `bun run typecheck`, `rm -rf packages/*/dist`,
`bun scripts/verify.ts`, `bunx biome check <touched files>`. Each task writes the failing test
first, then the change. Each red-check reverts one named line or hunk, names the assertion that goes
red, and restores. The controller commits per task. Tell the orchestrator before the `project.ts`
commit.

**O1. Golden records, BEFORE any refactor** [r2] (`packages/runner/tests/reach-grain-fixtures.test.ts`
or a sibling; fixtures under `packages/runner/tests/__fixtures__/`). Two records, both committed in
the same commit, before O2:
- (a) `reach-grain-golden.json`: today's `reachGrainOf` result for every member of every fixture
  project the existing test walks, keyed `<project>/<file>/<mutantId>`, plus three hand cases where
  `before` starts at `S.start` (the regex then reads `afterText` and the filler). The c1 oracle.
- (b) `instrumented-output-golden.json`: for every `.al` file of every fixture project, with its
  real spec set, the sha256 of today's `instrumentOneFile` output, keyed `<project>/<file>`; a file
  that refuses today records its refusal `shape` and `file` instead of a hash. This replaces
  `per-file-refusal.test.ts:223-240` as the only byte pin (that pin covers `sandbox-data` alone) and
  is the oracle O8 compares against.
The commit message names the commit (lane-code HEAD) the records were taken at. Red-check: none
(recording); O3 and O8 red-check against them. A later re-record needs the orchestrator's ruling,
as with any frozen baseline.

**O2. Site ids** (`engine/src/file-refused.ts`, the 12 sites). Add a required `site` field
(`"project.no-header"`, `"compile.latch-owner"`, ...) to `FileRefusalFields`. Failing test first:
`file-refused.test.ts` asserts every existing site test's thrown error carries its id. Then the
source-scan test, part 1 (`packages/schemata/tests/refusal-sites.test.ts`): read `packages/*/src/**/*.ts`,
collect every `new FileRefusedError(`, assert each has a `site:` id, the id set equals a pinned list
of 12, and there is no `extends FileRefusedError` and no construction without `new`.
Red-check: delete one `site:` id (scan goes red, names the file:line); add a 13th dummy construction
(set check goes red).

**O3. The shared splice function (c1)** (`schemata/src/dispatch-plan.ts`). Failing test: PLAN grain
(`describeSplice` + `leadingBeginEnd`) equals the O1(a) golden table for every member. Change:
extract `describeSplice` and `leadingBeginEnd`; make the splice text build FROM `SpliceParts` and
`placeReach` take its grain from `leadingBeginEnd`. There is no other code path for either.
Red-check: make `leadingBeginEnd` read the window without `insert` (golden test goes red on the
`before`-at-`S.start` hand cases).

**O4. `planEdits` in the engine** (`engine/src/ast/rewrite-plan.ts`, `join-edits.ts` [r3], `printer.ts`). Failing test:
a `planEdits` twin of `printer.test.ts:57` with the same expected refusal fields, plus an
empty-map case that never reaches E4. Change: move E4, sort and `assertNoOverlap` out of
`printer.ts`; `joinEdits` goes to `join-edits.ts` and `printWithRewrites` = `planEdits` + `joinEdits` stays in `printer.ts` as its only content [r3]. Red-check: swap latch-before-chain
insertion order in one test map (the overlap twin passes where it must throw, or the valid case refuses).

**O5. `planFile` / `emitFile`, frozen plan (I5)** [r2] (`compile-plan.ts`, `compile-emit.ts`,
`components.ts`, `enclosing.ts`). Failing tests: (a) plan-only twins of `compile.test.ts:774`
(unsupported-kind, the xmlport case) and `:3276` (latch-owner) with identical `FileRefusedError`
fields; (b) the I5 test: a custom-tier spec whose `before` and `after` nodes are wrapped in a
counting `Proxy`. Its `get` trap counts every read of every property (string and symbol keys,
including `startIndex`, `kind`, `children`, `parent`, `text`) and wraps any node-like value it
returns (the parent, each child) in the same proxy, memoised in a `WeakMap` by target so a node
keeps one proxy identity (the plan relies on identity-keyed `Map`s; a fresh proxy per read would
change behaviour, not only count it). `has`, `ownKeys` and `getOwnPropertyDescriptor` count too.
Run `planFile`, record the total, run `emitFile`, assert the total did not change. Change:
`resolveStatement`; PLAN stores spans, `wrap`, the `isStatement*` answers and component root spans;
EMIT reads only `plan.source.slice(start, end)` and fields of `PlannedEdit`. Red-check: make EMIT
read `component.root.kind` (a property r1's three counters did not see; I5 goes red); then make it
read `component.root.text` (red); drop the plan-only latch-owner check (twin (a) goes red).

**O6. `planOneFile` / `emitOneFile`; the trial runs PLAN** [r2, r3] (`schemata/src/project-plan.ts`,
`project-emit.ts`, `project.ts`, `runner/src/orchestrator.ts:1016`). [r3] Also: the writer reads
headers and grains from `FilePlan.mutants` by position (section 3). Failing test first: a
`planOneFile` result whose `mutants` is shorter than `ided`, or out of order, makes the writer throw
naming the file and mutant. Red-check: drop the order check (the out-of-order case writes a wrong
header instead of throwing). Retarget `per-file-refusal.test.ts:193` and
`per-file-skip.test.ts:176` to spy on `planOneFile`, every assertion unchanged (the review diff
checks that only the spied name moved). Add:
- a spy asserting the trial never calls `emitOneFile`;
- the E1 case: `spyOn` PLAN's `resolveStatement` (the module export the real `planOneFile` calls;
  a Bun spy also catches calls through a re-export, checked in r1's review) with an implementation
  that throws the same plain `Error` E1 throws today. The REAL `planOneFile` and the REAL
  orchestrator run on a fixture with at least one mutable site, as `--dry-run`. Assert the dry run
  aborts with that error (it is NOT turned into a refusal row), and that the spy was called at
  least once (so a test that never reaches `resolveStatement` cannot pass). This replaces r1's
  hand-built spec with no enclosing statement, which `isMutableSite` (`orchestrator.ts:913`) drops
  before the trial.
The output pin `per-file-refusal.test.ts:223-240` (manifest sha256 and all-files hash) must stay
byte-identical. Red-checks: point the trial back at `instrumentOneFile` (the never-EMIT spy goes
red); make the trial's catch treat any `Error` as a refusal (the E1 case goes red: no abort); move
the `resolveStatement` call out of `planOneFile` into `emitOneFile` (the E1 case goes red: the spy
is never called on a dry run).

**O7. Source-scan part 2: PLAN and EMIT modules** [r2] (`refusal-sites.test.ts`). It parses each
listed module with the `typescript` compiler API (`createSourceFile`), so comments and strings cannot
false-hit. A pinned list of PLAN, EMIT and composition modules (section 3's table); every `.ts`
under `packages/schemata/src` and `packages/engine/src/ast` must be in exactly one list or in a
pinned "neither" list, so a new file cannot dodge the scan. Assertions:
- every `new FileRefusedError(` is in a PLAN module;
- EMIT modules contain no `throw` statement;
- EMIT modules import from PLAN modules only through `import type` (a whole-statement
  `import type`, or every specifier marked `type`); PLAN modules import nothing from EMIT modules;
- EMIT modules contain no `??` and no `||` operator, no `.get(` call, and no `.find(` call (total
  lookups, no quiet fallback);
- composition modules hold only the functions named in section 3 for them, and no
  `new FileRefusedError(` [r3];
- [r3] no PLAN, EMIT or composition module imports `dispatch.ts` (the named "neither" barrel), so
  an import routed through the barrel cannot hide a PLAN value import in an EMIT module. The scan
  sees direct imports only, so this rule is what makes it sound;
- `compile-emit.ts`'s `EMIT_CRASHES` equals exactly `["RangeError: Invalid string length"]`, and its
  header comment names it (I4).
Red-checks, one at a time: move one refusal throw into `emitDispatch` (red, names it); add a plain
`throw new Error` to `dispatch-emit.ts` (red); turn one `import type` from `dispatch-plan.ts` into a
value import (red); add `?? ""` to one EMIT read (red); add a `.get(` lookup in `emitFile` (red); add
a second `EMIT_CRASHES` entry (red); add a new unlisted `.ts` file under `packages/schemata/src` (red).

**O8. Fixture soundness sweep** [r2] (`packages/runner/tests/plan-emit-soundness.test.ts`). For
every `.al` file of every fixture project, with its real spec set: if `planOneFile` returns, then
`emitOneFile` on that plan does not throw, and the sha256 of its output equals the O1(b) record
taken before the refactor; if `planOneFile` refuses, the O1(b) record is a refusal with the same
`shape` and `file`. Also run on the hand-built T4b refusal cases: PLAN throws the same site id the
old path did. Plus the C8 case: the inline xmlport source from `compile.test.ts:799` (the test at
:774), run through `planOneFile`, must refuse with `shape` `unsupported-kind`, the C8 site id, file
`MyPort.XmlPort.al` and lines `[11, 11]`. Red-checks: make `emitFile` throw for one fixture's file
(sweep goes red); change one emitted byte (for example the `REACH_MARKER` spacing; the hash
comparison goes red, which r1's comparison against `instrumentOneFile` could not show); move the
C8 check from PLAN to EMIT (the xmlport case goes red: `planOneFile` returns).

**O9. T9 for real**: the section 4 procedure, with the finished build as P. Same control, same bar.
Then the gates (section 6). An inconclusive control or a miss: stop and report.

**O10. Docs and roadmap**: the EMIT boundary note (I4) in `docs/` where the agent guide describes
refusals; R307 status after the final review; R419 stays open and is cross-referenced from R307;
if the R418 mask fix later moves header offsets, that stays R418's.

## 6. Gates afterwards, then final review

1. `bun scripts/verify.ts` (full unit suite, `CI=true`, no snapshot change).
2. `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` on the pinned build (`/opt/al-runner/c39ad5de/al-runner`
   in the container, `H:/al-runner-builds/c39ad5de/al-runner.exe` on the host). Frozen figures,
   per mutant, all legs.
3. `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` on Cronus28, under a coord lease. Frozen 3/12/4,
   `groupedCalls` 15, `warmKills` 0, discrimination `vacuous`.
4. Final whole-branch review (range c6555c6d..HEAD): orchestrator plus sol when available.

Any differing verdict is a block.

## 7. Notes for the reviewer

- The ruling cites `per-file-skip.test.ts:177`; the test starts at line 176 (177 is its spy line).
- I4 is not a `throw` statement, so a source scan cannot "allow it by name" as a throw. O7 makes it
  concrete as: zero `throw` in EMIT, plus a pinned one-entry `EMIT_CRASHES` list and comment.
- Implicit stack overflows (I2, recursive walks) all sit in PLAN functions (`dispatch.ts:191` is
  inside `varSectionUnparsed`; `compile.ts:131,200,438` in latch/selector code), so they stay
  dry-run visible. Section 3's table puts each of them in a PLAN module, and O7 pins the table.
- [r2] The `compile.test.ts` xmlport case: the `it(` is at line 774 and the
  `compileSchemataForFile` call the review names is at line 799. Both numbers are cited.
- [r2] O7's "no `??`/`||` in EMIT" is stricter than "no `?? \"\"`": it forbids every fallback form,
  so a scan cannot be dodged by `?? 0`, `|| []` or `?? undefined`. If EMIT turns out to need a
  boolean `||`, the build asks the orchestrator rather than loosening the scan.
- Step 1's prototype is a large part of the build. It is throwaway; O1-O8 rebuild it under test.
