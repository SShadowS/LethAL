# R-557 plan r2: run al-runner tests under the name al-runner actually uses

Worktree `/work/lethal-wt/r557` (branch `lethal/r557`, from origin/master `cd1d76ef`, which includes R551).
Evidence:
- `/coord/handoff/R557/measure.md`: the problem;
- `/coord/handoff/R-557/measure.md`: r1's planning measurements, M1-M7;
- the Opus review, `/coord/handoff/R-557/review-plan-opus.md`, and its scratch `.../scratchpad/r557rev/` (u1, u2,
  `port.ts`).

Predictions: `precommitment.md` (r2). Upstream draft: `upstream-issue.md` (r2).

## Changes from r1

All the review's findings are accepted, with the coordinator's rulings.
1. **C1, new section 4.** `--skip-known-survivors` and `--resume` no longer use a prior al-runner run, or a baseline
   snapshot, that holds a pre-fix false miss. Each refusal has a named warning and a red test per direction. No
   schema change.
2. **I1.** The `--server` stop fires only on a clean suite answer: exit code 0 or 1, every row pass or fail, every
   row `Codeunit<id>.`. Anything else keeps today's per-test `error`, which now lists the skipped and `<ctor>` rows.
3. **I2.** Two corrections to the rule, measured by the reviewer on both builds:
   - format characters (Unicode Cf) are DELETED;
   - the keyword check uses .NET invariant simple upper-casing: map `ſ` to `s`, and compare only when the result is
     ASCII.

   The order is: mangle, then the keyword prefix, then delete Cf. T1a carries all 35 of the reviewer's names. Probe
   50012 gains `"Ærø Løb"`, `"default"` and a Cf name.
4. **I3.** The backend gets the session's test suite and the R403 undecided-kept set:
   - an undecided-kept test with no row keeps today's `error`, plus one named warning;
   - the server stop lists only missing tests from the session suite.
5. **M1.** The names legs assert the contract fact on the one-shot legs and assert there is no contract line on the
   `--server` legs.
6. **M2.** The Twin trap is declared UNIT-ONLY (T5). There is no forced-substring leg.
7. **M3.** Leg A2's cost is stated (section 9).
8. **M4.** A Danish-letter arm `"Blåbær Step"`: 12 procedures, 36 mutants. The master predictions are now 6 / 30 / 0
   and 6 / 0 / 30, re-derived in the pre-commitment.
9. **M6.** The doc comment states the Unicode-table drift between JS and .NET.
10. **Decisions.** Stop, scoped by I1 and I3. A permanent `bcdev-names.itest.ts`, never folded into `itest:bcdev`. A
    CLAUDE.md sentence is drafted for the owner (section 10). The lane does not edit CLAUDE.md, and the figures live in
    `fixtures/README.md` and the spec.
11. The reviewer's count of **161** names in `fixtures/` + `examples/`, 0 affected, replaces r1's 148 (`fixtures/`
    only).

## 1. Decision: the rule computes the name, and al-runner's own rows check it (hybrid, B first)

Compute al-runner's name for each AL test with BC's identifier rule. Treat al-runner's answer as the check: a
computed name that al-runner does not return stops the session by name, within the limits in section 3. The R123
contract probe checks the rule against real rows once per session.

**Why not (A), a map read from al-runner's output.** There is nothing to read (measure M1):
- al-runner has no list or discovery mode;
- a row is `{name, status, durationMs}`. al-runner reads the AL name (`NavTestAttribute.CalName` in
  `TestExecutor.TestAlName`) but never writes it to a row;
- pairing by position is unsafe: reflection-order fallback, rows truncated after a hung test, and one-shot would need
  an extra whole-suite call.

**Why (B) is safe enough.**
- The rule is BC's compiler's, and al-runner itself ports it (`RunnerPageInstance.EmittedIdentifier`, M2).
- With r2's two corrections it matches all 58 names measured on both builds (r1's 23, plus the reviewer's 35).
- Collisions are refused by al-runner's compiler (AL0757, M4).
- A wrong rule selects nothing, and that refuses. It never scores.
- When upstream puts the AL name on the row, the check can read it. That is a later change.

## 2. Code changes

1. **`packages/runner/src/al-runner-transport.ts`**
   - New `alRunnerMethodName(method: string): string`. It walks UTF-16 code units, as the C# loop does:
     - a. a space or `"` becomes `_`;
     - b. an identifier-PART unit (Unicode L, Nl, Nd, Mn, Mc, Pc, Cf) is kept. When it is the FIRST unit and not an
       identifier START (L, Nl, `_`), a `_` is put before it;
     - c. any other unit becomes `a` + its decimal code. A lone surrogate is in neither class, so a surrogate pair
       gives `a55357a56832`, as measured;
     - d. **keyword prefix:** take the result of a-c and replace every `ſ` with `s`. If, and only if, the whole string
       is then ASCII, upper-case it (ASCII upper-casing equals .NET's invariant simple upper-casing on ASCII) and test
       it against a fixed set: the 77 Roslyn reserved keyword texts, `__arglist`, `__makeref`, `__reftype`,
       `__refvalue` and `FINALIZE`. On a hit, put `_` before the result of a-c. So `"ſtatic"` becomes `_ſtatic`,
       while `"Claß"`, `"ﬁxed"` and `"ınt"` get no prefix (JS `toUpperCase` would wrongly give `CLASS`, `FIXED`,
       `INT`);
     - e. **delete every Cf code unit.** So `"<U+200D>Lead"` (a ZWJ first) becomes `_Lead`: the `_` from b stays, and the ZWJ goes.

     Doc comment:
     - cite al-runner `RunnerPageInstance.EmittedIdentifier` in `AlRunner/Patches/RunnerPageInstance.cs` at
       `c5bbaf89` (unchanged since `d694c40`), BC's `Utilities.StringExtensions.MangleIdentifierName`, and R557's
       measured tables;
     - say that step e is NOT in al-runner's port but is what BC's emitter does (measured, u1/u2);
     - **M6:** JS `\p{...}` classes follow the JS engine's Unicode version, and .NET's `char` categories follow
       .NET's. A code point added or reclassified in one and not the other can map differently. The R123 fact sees
       only the names it probes. A miss anywhere else refuses at baseline rather than mis-scoring.

     Cite by name, not by line (R117).
   - `qualifiedTestName(codeunitId, method)` becomes `Codeunit${codeunitId}.${alRunnerMethodName(method)}`. **The ONE
     function.** Every al-runner name consumer already goes through it:
     - `useDiscoveredTests`, and so `siblingsOf` and R488's excludes;
     - `run`;
     - `sendOneShot`'s `--test` / `--test-exact` (R551);
     - `oneShotVerdict`;
     - `runViaServer`.

     `ensureServerSuite`'s keys and `coverageByName` are al-runner row names, looked up by the same name. One-shot
     coverage is one Cobertura file per call. The canary and the frame, predefined and contract probes pass plain
     names, which the rule leaves unchanged.
   - New result kind `{ kind: "none-selected"; detail: string }`. It is returned on the process's own exit 6 with an
     envelope of `tests: []` and `exitCode: 6`. R551's exit-6 test moves here as `isNoneSelectedExit(exitCode,
     stdout)`, and `classifyTestExactProbe` calls it, so one predicate serves both readers.
2. **`packages/runner/src/al-runner-backend.ts`**
   - New `export class AlRunnerTestNameError extends Error` (extends `Error` directly). The message names:
     - the AL test `<Codeunit Name>.<method>`;
     - the name sent;
     - the al-runner build, when known;
     - R557, with the hint "al-runner's naming rule moved, or this build does not compile that test".
   - New exported constant `AL_RUNNER_UNDECIDED_ARM_MISSING`, a failure-text prefix.
   - **I3:** new optional `ExecutionBackend` method `useSessionTests(suite: readonly TestMethodRef[], undecidedKept:
     readonly TestMethodRef[])`:
     - `suite` is `chooseTestSuite`'s `tests`;
     - `undecidedKept` is `discovery.excluded` with reason `preproc-undecided-kept`.

     It is called by `runSession` next to `useDiscoveredTests` and given again to every worker.
   - **`run()` (one-shot).** Two cases decide:
     - `res.kind === "none-selected"`;
     - rows came back, none equals `wanted`, and today's code would return `error` "al-runner output has no test
       named ...".

     In either case:
     - if the ref is undecided-kept, return today's `error` (still `pre-dispatch-rejected`) with the text prefixed
       `AL_RUNNER_UNDECIDED_ARM_MISSING`;
     - otherwise throw `AlRunnerTestNameError`.

     R491's duplicate check and the R488/R551 "other tests" refusals run first and are unchanged.
   - **`runViaServer()` (I1, I3).** `ServerSuiteResults` gains `exitCode` (`al-runner-server.ts` already reads
     `runTests`' `exitCode`). On a miss for `wanted`:
     - **(a)** `hungTest` set: R534's `runner-test-error`, unchanged;
     - **(b)** ref undecided-kept: today's `error`, prefixed;
     - **(c)** **stop** when the answer is CLEAN: exit code 0 or 1, every row status `pass` or `fail`, every row name
       matching `^Codeunit\d+\.`. Throw `AlRunnerTestNameError`, listing every SESSION-SUITE test with no row (from
       `useSessionTests`, never the unfiltered discovery, which holds decided compiled-out tests);
     - **(d)** otherwise (exit 3, a `<ctor>` row, an emit-excluded row named `<AL object>.<method>`, an `error` or
       `skipped` row): today's `error`. Its text also lists every row that is not `pass`/`fail` or does not match
       `^Codeunit\d+\.`. These are compile or runner failures, not naming ones.
3. **`packages/runner/src/orchestrator.ts`**
   - Call `useSessionTests` (I3).
   - After each batch baseline, emit ONE warning `al-runner-undecided-test-missing` naming every test whose failure
     text carries `AL_RUNNER_UNDECIDED_ARM_MISSING`: "al-runner has no row for these tests, which sit in an `#if` arm
     LethAL could not decide (R403); they are not run, so a mutant only they would kill may read survived. Pass the
     build's symbols to decide the arm (R557)."
   - The C1 checks in section 4.
4. **`packages/runner/src/store.ts`**: one read-only query (section 4).
5. **`packages/runner/src/al-runner-contract.ts`**: the R123 fact (section 5).
6. **`packages/runner/src/al-runner-server.ts`**: the comment, and `exitCode` passed through to the suite result.

Callers of `OneShotTransport` (`al-runner-canary.ts`, `al-runner-frame-probe.ts`, `al-runner-predefined-probe.ts`)
treat `none-selected` as they treat `error` today. The type checker lists every site.

Not built (YAGNI):
- an AL-name collision check (M4);
- a whole-suite discovery call;
- `--dump-csharp` reading;
- a forced-substring live leg (M2 ruling).

## 3. Refusal: where it fires and what the session does

| Path | Trigger | Today | After |
|---|---|---|---|
| one-shot (exact or R488 path) | exit 6 + empty envelope, or rows with none equal to `wanted` (incl. 43f76177's exit 0 with zero rows) | `error`, retried once, baseline-red, only-kills read `survived` / `no-coverage` | **stop:** `AlRunnerTestNameError` from `run()`, not retried. `runOnce` propagates it, the session stops before any mutant is scored, and the CLI exits non-zero with the message |
| same, ref undecided-kept (R403) | same | `error` | `error` (prefixed) + one `al-runner-undecided-test-missing` warning |
| `--server`, clean answer | a session-suite test with no row, no hang | `error` "reported no test named" | **stop**, listing every session-suite test with no row |
| `--server`, ref undecided-kept | same | `error` | `error` (prefixed) + the warning |
| `--server`, unclean answer (exit 3, `<ctor>` row, emit-excluded row, error/skipped row) | miss | `error` | `error`, now listing the rows that made it unclean |
| `--server`, hung test | miss after the hang | `runner-test-error` (R534) | unchanged |

The precedent is `AlRunnerServerStopUnsetError` (R517 D1): a typed error thrown from `run()` stops the session. The
lane pins the CLI exit code and stderr in a CLI unit test.

## 4. C1: pre-fix false misses must not come back through history or resume

**The hole.** A pre-fix al-runner run recorded an affected test as an `error` baseline test, and stored its
only-kills as `survived` (or `no-coverage`). After the fix:
- `--skip-known-survivors` reads those survivors through `store.priorSurvivorKeys` and skips them;
- `--resume` carries their verdicts, and can reuse the batch's baseline snapshot with the test still non-green.

The test is never sent again, the stop never fires, and the false survivor stands.

**What "tainted" means.** A prior run with `runs.backend = 'al-runner'` is tainted when one of its BASELINE rows
(`test_results.mutant_row_id IS NULL`) has `outcome = 'error'` and a `method` that `alRunnerMethodName` changes. A
snapshot is tainted when one of its `BaselineObservation`s has `verdict.outcome === "error"` and such a `ref.method`.

Why `error` only:
- every pre-fix miss was `error` (R557 Q3, every leg);
- a post-fix affected test that genuinely fails its assertion reads `fail`, and does not taint. So a project with a
  real red quoted test keeps its history;
- a post-fix affected test with a genuine runtime `error` does taint. That direction is safe: it costs re-execution,
  never a verdict.

bcdev runs never taint: they never used the al-runner name.

**Store.** `baselineErrorMethods(runId): string[]` returns the distinct `method` values of that run's baseline rows
with `outcome = 'error'`. It reads existing columns only. The orchestrator applies `alRunnerMethodName`, so the rule
stays in one module.

**History.** `priorSurvivorKeys` gains one more refusal hook, next to `schemeChanged`, `symbolsChanged`,
`coverageModeChanged` and `testAppChanged`: `alRunnerTestNames(old, tests)`. When the latest finished run it selects
is a tainted al-runner run, it yields NO keys and calls the hook. The orchestrator emits warning
`history-al-runner-test-names` once per session, only under `--skip-known-survivors`, the same way R325/R354 do:
"the latest finished run, run N, ran on al-runner before R557 and recorded <k> test(s) as errors that al-runner never
ran (<up to 5 AL names>, ...); its survivors may be false, so none is skipped: every mutant is executed (R557)."

**Resume, carried verdicts.** Where `--resume` picks the unfinished run to carry from, a tainted al-runner run is not
resumed: nothing is carried and the session runs as a fresh one. Warning `resume-al-runner-test-names`: "run N ran on
al-runner before R557 and recorded <k> test(s) as errors that al-runner never ran (...); its verdicts are not carried:
every mutant is executed (R557)." By ruling this is a warning, not an error.

**Resume, baseline snapshot.** At the reuse site (`reused = snapshotApplies(...)`, before the
`resume-baseline-reused` warning), a tainted snapshot is not reused and the batch re-runs its baseline. The warning is
`resume-al-runner-test-names`, naming the snapshot's run and batch. The check is on the snapshot itself, because
`findBaselineSnapshot` can lend one from ANY run.

## 5. R123 contract probe: a new fact `test-name-mangling`

- Add `codeunit 50012 "Lethal Contract Names"` (`Subtype = Test`, empty bodies) to the probe's tests project, one
  method per rule step:
  - `"Space Name"`, `"Dash-Name"`, `"Paren(x)"`, `"Dot.Name"`, `"Slash/Name"`, `"Amp&Name"`;
  - `"7Lead"`;
  - `"default"` (the keyword step, lower case);
  - `"Ærø Løb"` (letters kept);
  - `"Soft<U+00AD>Hyphen"`, a soft hyphen, written in the TypeScript template as a JS unicode escape (Cf, deleted:
    `SoftHyphen`, measured in u2);
  - the control `PlainName`.

  Unquoted `Default` is NOT in the probe: it would collide with `"default"` in one codeunit (AL names ignore case).
  The fixture covers unquoted `Default` live.
- ONE more invocation: `buildAlRunnerArgv` with `qualifiedTest: "Codeunit50012."`. A codeunit prefix selects that
  whole codeunit (measured, M3), and the hanging test is in 50011, so it is not selected. It does not send
  `--test-exact`, for R551 M3's reason.
- The fact matches when the set of returned row names EQUALS `{ qualifiedTestName(50012, m) }`. Both directions
  count: a missing expected name is divergence, and so is an unexpected row. No readable envelope gives
  `unmeasurable`. Either way the session is refused, as for every R123 fact. `expected` and `measured` print both
  sorted lists.
- `CONTRACT_FACT_CONSEQUENCES["test-name-mangling"]`: "al-runner names a test by BC's C# identifier for the AL
  method. If that rule moved, an affected test selects nothing and the session refuses at baseline (R557); fix
  `alRunnerMethodName` against the measured rows."
- The header changes from "six facts, four invocations" to seven and five (about 5 s more). The
  `qualified-test-name` fact is unchanged.
- **M1:** per the review, the contract line appears only on the pinned one-shot legs. The names legs assert that the
  `test-name-mangling` fact is present and `matches` on A1 and A2, and that no contract line is present on A3 and A4.

## 6. Names in reports stay the AL names

Reports, `coveringTests`, `killingTest`, events, the store and `lethal verify` all use `orchestrator.ts`'s
`qualifiedTestName(ref)` (`<Codeunit Name>.<method>`). The mangled name lives only in the al-runner backend, its
argv and its error texts. All **161** test names in `fixtures/` and `examples/` map to themselves, so no committed
baseline or stored key moves.

## 7. Tests: one red test per direction

All in existing files under `packages/runner/tests/`. The red check reverts the named piece, sees the named test go
red, and restores. Use `mutation-red-checker` with Edit-only reverts.

| # | File | Test | Red when |
|---|---|---|---|
| T1a | `al-runner-transport.test.ts` | the rule over EVERY measured pair: r1's 23 (measure M3, plus `Stone Quoted`, `Dot.Name`, `2Lead`, `Pond`, and R557's `Plus+Paren(x)`), plus the reviewer's 29 (u1) and 6 (u2), listed below | any step removed or reordered: space, `a<code>`, the digit prefix, the keyword prefix, the ASCII-only keyword compare (`Claß`, `ﬁxed`, `ınt` gain a wrong `_` under JS `toUpperCase`), the `ſ` map (`_ſtatic` loses its `_`), Cf deletion (`Zwj`, `SoftHyphen`, `ZwSp`, `Middir`), Cf deletion done before the prefix (`_Lead`, `_Bom` lose their `_`) |
| T1b | same | names the rule must NOT change: `PlainCase`, `Pond`, `_Under`, `Record`, `Var`, `Under_Score`, `Straße`, `Ελλάδα`, `İstanbul`, `KelvinK` (U+212A), `ⅫRoman` | over-mangling: a contextual keyword prefixed, a letter or Nl encoded, an extra prefix |
| T2 | `al-runner-backend.test.ts` | one-shot exact path: ref `{78850, "Dash-Step"}` sends `--test` and `--test-exact` `Codeunit78850.Dasha45Step`; the fake's pass row gives `pass` on the caller's ref | `qualifiedTestName` reverted to the AL name |
| T3a | same | one-shot: exit 6 + empty envelope makes `run()` reject with `AlRunnerTestNameError` naming `Names Tests.Dash-Step` and `Codeunit78850.Dasha45Step`, after 1 spawn | the throw replaced by today's `error` |
| T3b | same | one-shot R488 path: exit 0 with zero rows gives the same refusal | the no-row-equals-`wanted` branch left as `error` |
| T3c | same | exit 1 with stderr is still `error` with no throw; a `fail` row named `wanted` is still a kill | refusal widened |
| T3d | same | I3: exit 6 for an undecided-kept ref gives `error` carrying `AL_RUNNER_UNDECIDED_ARM_MISSING`, with no throw | carve-out removed |
| T4a | same | `--server`: a mangled row and `perTestCoverage[].test`: the row is found AND coverage is attached | names reverted (the measured false `no-coverage`) |
| T4b | same | `--server`, clean answer (exit 0, all pass): a session-suite test with no row throws, listing every missing SESSION-SUITE test and NOT a decided compiled-out test that is present in the unfiltered discovery | throw replaced by `error`, or listing taken from `discoveredTests` |
| T4c | same | `--server`: a miss with `hungTest` stays `runner-test-error` | refusal swallows R534 |
| T4d | same | I1: exit 3 with an emit-excluded `Names Tests.Dash-Step` row (skipped) gives `error` listing it, with no throw | the clean-answer gate removed |
| T4e | same | I1: a `<ctor>` row gives `error`, with no throw | same |
| T4f | same | I3: a server miss for an undecided-kept ref gives a prefixed `error`, with no throw | carve-out removed |
| T5 | same | **Twin trap, unit-only (M2):** discovered `"Twin Pair"` and `Twin_PairLong`; on the R488 path the FIRST call for `Twin Pair` sends `--exclude-test Codeunit78850.Twin_PairLong` | siblings computed from AL names |
| T6a | `al-runner-contract.test.ts` | the fake returns the rule's names for 50012: `test-name-mangling` matches | fact not computed |
| T6b | same | `Dash_Name` returned for `"Dash-Name"`: diverged, session refused, both lists printed | count-only or one-direction compare |
| T6c | same | an extra row: diverged | subset compare |
| T7 | `al-runner-transport.test.ts` | `isNoneSelectedExit`: exit 6 + empty envelope gives `none-selected`; exit 6 with rows does not; envelope `exitCode` 0 does not. R551's probe tests are unchanged and green | predicate loosened, or R551 decision changed |
| T8a | the test file holding R325/R354's history-warning tests | C1 history: a finished al-runner run with `Space Step` baseline `error`, and survivors: under `--skip-known-survivors` nothing is skipped, and `history-al-runner-test-names` names the run and the test | taint check removed |
| T8b | same | other directions: the same run with only `Pond` as `error` skips its survivors, no warning; `Space Step` recorded as `fail` does not taint; a bcdev run with `Space Step` as `error` does not taint | check widened (any red, any outcome, any backend) |
| T9a | the R47 resume test file | C1 resume: an unfinished tainted al-runner run is not carried; `resume-al-runner-test-names` | check removed |
| T9b | same | an unfinished run with only a plain-name `error` is carried as before | check widened |
| T10a | the R192 snapshot test file | C1 snapshot: a snapshot with a `Space Step` `error` observation is not reused; the baseline re-runs; warning emitted | check removed |
| T10b | same | a snapshot with only a plain-name `error` observation is reused (`resume-baseline-reused`) | check widened |
| T11 | orchestrator test | I3 warning: a batch baseline with one `AL_RUNNER_UNDECIDED_ARM_MISSING` verdict emits `al-runner-undecided-test-missing` once, naming it; a batch without one emits nothing | warning missing, or emitted for every `error` |

T1a's added names. `\u{..}` marks invisible or non-ASCII code points. All are measured in
`r557rev/names-c5bbaf89.txt` (u1) and `r557rev/names2.txt` (u2), and are identical on 43f76177. **The lane copies the
AL names from the scratch sources and the rows from those files byte for byte, not from this table.**

| AL name (u1) | Row | AL name (u1, cont.) | Row |
|---|---|---|---|
| `Æble Øl Å` | `Æble_Øl_Å` | `\u{131}nt` | `\u{131}nt` |
| `Blåbær grød` | `Blåbær_grød` | `default` | `_default` |
| `Straße` | `Straße` | `Ελλάδα` | `Ελλάδα` |
| `Claß` | `Claß` | `\u{130}stanbul` | `\u{130}stanbul` |
| `\u{fb01}xed` | `\u{fb01}xed` | `Back\slash` | `Backa92slash` |
| `Cafe\u{301}` | `Cafe\u{301}` | `Base` | `_Base` |
| `\u{301}Lead` | `_\u{301}Lead` | `Var` | `Var` |
| `Smile\u{1f600}` | `Smilea55357a56832` | `\u{17f}tatic` | `_\u{17f}tatic` |
| `Hash#At@` | `Hasha35Ata64` | `Kelvin\u{212a}` | `Kelvin\u{212a}` |
| `Euro\u{20ac}` | `Euroa8364` | `Tab\u{9}X` | `Taba9X` |
| `Nb\u{a0}sp` | `Nba160sp` | `Under_Score` | `Under_Score` |
| `Mid\u{b7}dot` | `Mida183dot` | `Ünïcödé` | `Ünïcödé` |
| `Zw\u{200d}j` | `Zwj` | `æøålower` | `æøålower` |
| `\u{216b}Roman` | `\u{216b}Roman` | | |
| `\u{b2}Sup` | `a178Sup` | **u2:** `\u{200d}Lead` | `_Lead` |
| `\u{663}Arabic` | `_\u{663}Arabic` | `Soft\u{ad}Hyphen` | `SoftHyphen` |
| | | `Zw\u{200b}Sp` | `ZwSp` |
| | | `\u{feff}Bom` | `_Bom` |
| | | `Mid\u{200e}dir` | `Middir` |
| | | `Plain` | `Plain` |

## 8. Ripple

- `docs/roadmap/R557.md`: `status: "done (<commit>)"` in the submitted branch. Note keyword names (unquoted too), Cf
  deletion and C1. Then `bun scripts/roadmap-index.ts` and `bun test scripts/line-citations.test.ts`.
- `docs/measurements/README.md` §"al-runner v2": the test-name contract (rule, citations, the new fact).
- `fixtures/README.md`: rows for `Names Calc` 78800 and `Names Tests` 78850, selector ids 78847-78849 in the
  reserved list, and a "sandbox-names (R557)" section with **the frozen figures** (with the spec, their only home
  until the owner approves the CLAUDE.md sentence).
- Three new warning codes: `history-al-runner-test-names`, `resume-al-runner-test-names` and
  `al-runner-undecided-test-missing`. Wherever warning codes form a closed set or an interpretation table, they are
  added there; `grep -rn history-coverage-mode-changed packages` finds every such place.
- No `SessionReport` field, no `Caveat`, no schema change.
- `bunx biome check` on touched files only.

## 9. Fixture arm and gates

**New pair:**
- `fixtures/sandbox-names`: the target, ids 78800-78849, selector ids 78849/78848/78847;
- `fixtures/sandbox-names-tests`: ids 78850-78899.

Both ranges were free on origin/master `0816610b`; re-check them before writing.

- **Target** `src/NamesCalc.Codeunit.al`, `codeunit 78800 "Names Calc"`, twelve procedures in this order. Each is
  exactly `procedure <P>(x: Integer): Integer` / `begin exit(x + 1); end;` (3 mutants each: `empty-block`,
  `return-value`, `swap-additive`): `SpaceStep`, `DashStep`, `ParenStep`, `DotStep`, `SlashStep`, `AmpStep`,
  `DigitStep`, `KeywordStep`, `DanishStep`, `TwinStep`, `TwinLongStep`, `PlainStep`.
- **Tests** `src/NamesTests.Codeunit.al`, `codeunit 78850 "Names Tests"`, UTF-8. One test per procedure, each
  `if C.<P>(5) <> 6 then Error('<P>(5) must be 6');`. Names, in the same order: `"Space Step"`, `"Dash-Step"`,
  `"Paren(Step)"`, `"Dot.Step"`, `"Slash/Step"`, `"Amp&Step"`, `"7Digit Step"`, `Default`, `"Blåbær Step"`,
  `"Twin Pair"`, `Twin_PairLong`, `PlainControl`.
- `"Blåbær Step"` (M4) is the first live evidence for a non-ASCII test name on either backend. On bcdev it goes
  through `Test Method Line.Name` with `SetRange`.
- The Twin pair is unit-only evidence for R488 (T5). Live, the container build takes the exact path, and R488 throws
  away a merged first result anyway, so no live verdict depends on it.
- If `alc` rejects unquoted `Default`, use `"Default"`. The table is unchanged.
- Before committing the pre-commitment, the lane confirms OFFLINE that the target yields exactly 36 mutants in table
  order.

**al-runner gate.** `packages/runner/itest/names-fixture.ts` holds the table and checks (after `wrapped-fixture.ts`).
`al-runner.itest.ts` gets `runNamesLegs()`, four sessions at one batch:
- A1: one-shot, coverage `al-runner`; baseline `al-runner.names.baseline.json`, recorded through R332;
- A2: one-shot, coverage `none`;
- A3: `--server`, coverage `al-runner`;
- A4: `--server`, coverage `none`.

Each leg must equal the table per mutant (verdict, killing test, kill text), and A2-A4 must equal A1 per mutant.
Also asserted:
- `baselineGreen: true`, and no `baseline-red` caveat;
- no `al-runner-undecided-test-missing` warning;
- M1's contract assertions.

Add `preflightGateBaseline` and the four leg names to the receipt list.

**M3, cost.** A2 sends every mutant's covering set of 12 green tests in killer-first order.
- The first mutant of each procedure runs tests in name order until its killer. The other two run the killer first.
- That is 12 baseline calls + (1 + 2 + ... + 12 = 78) + 24 ≈ **115 one-shot invocations**, about **10-11 min** at the
  5.4 s per call measured on the container (R557 Q2).
- A1 is about 12 + 36 = 48 calls (4-5 min). A3 and A4 are one daemon suite run per mutant, about a minute each after
  the first compile.

So the names legs add about 16-18 min to `itest:alrunner`.

**bcdev gate.** `packages/runner/itest/bcdev-names.itest.ts` is its own script and is never folded into
`itest:bcdev`. Its shape is copied from `bcdev-wrapped.itest.ts`: sandbox-app's connection, `LETHAL_ITEST_BCDEV=1`, one
`fenced` leg against the same table, baseline `bcdev.names.baseline.json`. Add the `package.json` script
`itest:bcdev-names`.

**Gates that must stay unchanged** (161 names map to themselves, so the argv is byte-identical):
- `itest:alrunner` existing legs: main 3 / 12 / 4; symbols 5 / 4 / 0 per set; layout 7 / 3 / 0; multiobject,
  wrapped and cli-default equal to their committed baselines;
- `itest:bcdev`: 3 / 12 / 4, `groupedCalls` 15, `warmKills` 0, `vacuous`.

## 10. CLAUDE.md sentence, drafted for the owner (the lane does NOT edit CLAUDE.md)

> Since R557 `itest:alrunner` also runs `fixtures/sandbox-names` + `-tests`: 12 tests, each the ONLY killer of its
> procedure. al-runner renames 10 of their AL names (space, `-`, `()`, `.`, `/`, `&`, a leading digit, the unquoted
> keyword `Default`, Danish letters), and 2 are unrenamed controls. The legs are one-shot and `--server`, under
> coverage `al-runner` and `none`.
> Frozen: killed **36** / survived **0** / no-coverage **0**, per mutant against
> `docs/superpowers/specs/2026-10-09-r557-names-precommitment.md`, baseline `al-runner.names.baseline.json`.
> RED-CHECKED: on the pre-R557 name builder it reads 6 / 30 / 0 (coverage none) and 6 / 0 / 30 (coverage al-runner).
> `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev-names` runs the same table on Cronus28, fenced: 36 / 0 / 0, baseline
> `bcdev.names.baseline.json`, kept out of `itest:bcdev` so its 3 / 12 / 4 cannot move.

## 11. Live plan (the lane, in order)

1. Work in `/work/lethal-wt/r557`. WIP pushes carry `[skip ci]`.
2. Write the fixture pair. Run `bun run compile:fixtures`. `alc` the target into `sandbox-names-tests/.alpackages`,
   then compile the tests app.
3. Offline mutant listing: 36 in table order. Commit `docs/superpowers/specs/2026-10-09-r557-names-precommitment.md`
   (from `precommitment.md` r2, plus the census sha) as a specs-only `[skip ci]` commit to master from a scratch
   origin/master worktree, BEFORE any live run. Send the sha.
4. Code and unit tests (section 7), then the red checks.
5. Build loop: `bun run typecheck`, `rm -rf packages/*/dist`, `bun scripts/verify.ts`.
6. **RED gate check:** the names legs on a scratch worktree at origin/master plus only the fixture and itest files.
   It must go red on exactly the rows predicted in pre-commitment section B.
7. `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner`. Record `al-runner.names.baseline.json` once with
   `LETHAL_ITEST_RECORD_BASELINE=al-runner.names.baseline.json` (exits 3 by design), then re-run to a pass. The
   existing legs must be unchanged.
8. bcdev:
   - take the Cronus28 lease (coord);
   - `altool publishapp` over the dev endpoint: the plain `sandbox-names` build, then `sandbox-names-tests`. On a
     downgrade refusal, unpublish the tests app first, then the target, then republish;
   - record `bcdev.names.baseline.json`, then run `itest:bcdev-names` to a pass;
   - run `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev`: 3 / 12 / 4 unchanged;
   - release the lease.
9. Opus review of the built diff, CI both jobs green, R557 `done (<commit>)` in the branch, submit with the CLAUDE.md
   sentence in the note.
10. Upstream: the orchestrator files `upstream-issue.md`.

## 12. Open questions left after r2

1. **A case-only collision after mangling** (`"Dash-Name"` with `DashA45Name`) is unmeasured. R491's duplicate-row
   refusal would catch it on the exact path. No code is added.
2. **Host pin `c39ad5de`** is not in the source clone. The new R123 fact checks the rule on the first host session.
3. **C1's `error`-only narrowing** is the plan's own addition, not the review's. The review said "non-green". `error`
   keeps a project with a genuinely failing quoted test (`fail`) from losing its history forever, and every pre-fix
   miss was `error`. If the coordinator wants "any non-green" as written, T8b's `fail` row flips to "taints" and
   nothing else changes.
