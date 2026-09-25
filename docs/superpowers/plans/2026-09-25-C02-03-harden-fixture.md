# C02-03: Five-survivor fixture with one planted equivalent, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-09-25),** after review round 1 (`H:/lethal-coord/reviews/C02-03-plan/review-r1.md`) and the orchestrator rulings at the end of this file. Changed: `TestPermissions = Disabled;` on both new test codeunits (finding 1); `EXPECTED` is now the reviewer's exact 21-mutant table with no "if emitted" rows (finding 2); the dry run names the fixture config so the selector ids resolve (finding 3); `harden.baseline.json` is written only after BOTH legs pass (sequencing note); `harden` is NOT registered in the agentflow gate table in this task (finding 4, ruling 3 changed). Owner questions removed: ruled.

**Goal:** A new fixture pair, `fixtures/sandbox-harden` (target) and `fixtures/sandbox-harden-tests` (its suite), whose full `lethal run` on Cronus28 gives EXACTLY five survivors and no `no-coverage` mutant. Four survivors are ordinary gaps a reasonable test kills. One is a true equivalent mutant, and a committed `lethal.equivalent.json` records the ruling. A new env-gated gate, `itest:harden`, freezes every mutant's verdict. This is the fixture C02-08 (issue #18) will run `lethal verify` against, so its mutant set must be exact and stable.

**Architecture:** One codeunit with five small procedures, one planted survivor each, and one table whose `OnValidate` gives `validate-to-assign` something to skip. Every OTHER mutant in the fixture has exactly one covering test that kills it, so its `killingTest` does not depend on R197's test order. The four actionable survivors come from operators that declare NO `equivalenceRisk`, and the equivalent comes from one that does (`remove-assignment`, `value-rewrite`). So `likelyEquivalentSurvivors` lists exactly one mutant, the reader mark matches exactly that one, and C02-01's per-row `equivalenceRisk`/`readerMark` separate "likely-equivalent" from "actionable" with no new code. A third small app, `fixtures/sandbox-harden-answers`, holds an answer key: four tests that kill the four actionable survivors, plus one that tries and fails to kill the equivalent. The gate's second leg runs it, so "killable by a reasonable test" is a measured fact, not a claim.

**Tech Stack:** AL (runtime 13.0, like `sandbox-hang`), Bun + TypeScript for the gate and one offline test, `alc`, `bun test`.

**Spec:** GitHub issue #13 (child 3 of epic #10): "New `fixtures/sandbox-harden` + tests, R169 ids, compiled and published, frozen per-mutant baseline, a committed `lethal.equivalent.json` for the equivalent." Epic acceptance it serves: "Fixture app with 5 planted survivors (1 equivalent): harden marks the equivalent one as likely-equivalent and the other 4 as actionable; ... a subsequent full lethal run agrees on all 5 verdicts". Pre-commitment: `docs/superpowers/specs/2026-09-25-c02-03-harden-precommitment.md`, written in Task 3 and committed ALONE before any live run.

## The five planted survivors

| Id | Procedure | Operator | Tier | `equivalenceRisk` | Why the base suite misses it | Answer-key test that kills it |
|---|---|---|---|---|---|---|
| S1 | `IsLarge` | `lethal.conditional-boundary` (`>` to `>=`) | 1 | none | tests use 500 and 50, never exactly 100 | `IsLargeAtTheBoundary`: `IsLarge(100)` must be false |
| S2 | `CountInCategory` | `lethal.remove-setrange` | 2 (AL) | none | every row in the test is in the wanted category | `CountInCategoryIgnoresOtherCategories`: two `A` rows and one `B` row, count of `A` must be 2 |
| S3 | `FirstAmount` | `lethal.swap-find-direction` (`FindFirst` to `FindLast`) | 2 (AL) | none | the test inserts ONE row, so first and last are the same row | `FirstAmountReadsTheFirstRow`: rows 1 (Amount 7) and 2 (Amount 9), result must be 7 |
| S4 | `SetAmount` | `lethal.validate-to-assign` | 2 (AL) | none | the test reads `Amount`, never `Doubled`, which `OnValidate` sets | `SetAmountRunsValidation`: after `SetAmount(Entry, 5)`, `Doubled` must be 10 |
| S5 | `BonusFor` | `lethal.remove-assignment` on `Bonus := 0` | 1 | `value-rewrite` | EQUIVALENT: no test can kill it (below) | none; `BonusForTwiceOnOneInstance` tries and must fail |

Four operators, all different, three of them AL-specific (Tier 2). The equivalent is a fifth operator.

### Why S5 is equivalent in AL, not just untested

`Bonus` is a LOCAL variable of `BonusFor`. AL gives every local variable its type's default value each time the procedure is called (Integer: 0), before the first statement runs. `Bonus := 0` is the first statement, and nothing reads `Bonus` before it. So with or without that statement, `Bonus` holds 0 at the same point, on every input, every table state and every call order. The procedure writes nothing else and returns only `Bonus`. No test can observe a difference.

Two things would break this, and the fixture avoids both on purpose. If `Bonus` were a codeunit GLOBAL, a second call on the same instance would start from the last call's value, and the mutant would be killable (this is why `sandbox-hang`'s `Counter := 0` is equivalent only per instance, see the `CountUpTo` rows in `hang.itest.ts`). If any statement read `Bonus` before the assignment, the default would be observable. Neither holds here.

The base test calls `BonusFor(11)`, then `BonusFor(10)`, then `BonusFor(5)` on ONE codeunit instance. If AL carried a local across calls, the mutant would return 11 on the second call and be killed. So S5 surviving the live run is also a measurement of the rule above, not only an appeal to documentation.

Constraints the equivalent must meet, and does: a PROCEDURE mutant, not a trigger (R229: trigger marks never match); identity ordinal 0, no byte-identical twin in `BonusFor` (R230: a twin after the first cannot be marked); a 5-field key.

## Decisions

1. **Id blocks (R169, and the one-line rule in `fixtures/README.md` §"Object ids").** Taken today: 79000-79199 `sandbox-app`/`-tests`, 79200-79299 `sandbox-probes`, 79300-79399 `sandbox-data`/`-tests` (and `sandbox-coverage-probe` 79320-79329 inside it), 79400-79449 `sandbox-hang`, 79450-79499 `sandbox-hang-tests`. 79500-79599 is unused by any fixture (grep of `*.al`/`*.json` finds only a closed measurement's probe at 79600). So: target `idRanges` 79500-79549, tests 79550-79574, answers 79575-79599. Target objects: codeunit 79500 `Harden Logic`, table 79501 `Harden Entry`. Tests: codeunit 79550 `Harden Tests`. Answers: codeunit 79575 `Harden Answer Key`. Selector triple, by "the highest range the app declares, counting DOWN from its top" (`pickSelectorIds`): 79547/79548/79549, shared with no other fixture. Re-run the grep immediately before writing, since other sessions commit here.
2. **Why a new app and not an arm on `sandbox-data`.** `sandbox-data` has 60 survivors; "exactly five" needs its own app. It also keeps every existing frozen gate out of reach: no existing gate's project or test directory changes.
3. **Frozen baseline form: a new itest, `itest:harden`, not a campaign stage.** It follows `hang.itest.ts`: a pre-committed per-mutant table in code (`EXPECTED`, keyed by file, line and operator, so a moved line fails loudly), then `assertMatchesBaseline` against a committed `harden.baseline.json` (semantic identity). A campaign stage is for committed sample reports of demo projects and cannot carry the extra assertions below (the mark, the equivalence list, the answer-key leg). C02-08 can compare `verify`'s verdicts to `harden.baseline.json` per mutant.
4. **The table lives in ONE module both the offline test and the gate import** (`packages/runner/itest/harden-expected.ts`). The spec file is the dated prose record; the module is the same content made executable. A second hand-copied table is how the two would drift.
5. **The mark key is computed, never typed.** No CLI command prints a mutant's R166 identity key today (filed in Task 7). The implementer derives it with the same functions the report uses (`identityKeyOf`, `serializeKey` in `packages/runner/src/selection.ts`) through the offline test's helper, and the offline test fails if the committed key names anything but S5.
6. **Base tests raise through bare `Error(...)`, no `Library Assert`,** like `sandbox-hang-tests`. No dependency to install, and nothing in this task reads R121's screen. **Both new test codeunits declare `TestPermissions = Disabled;`**, as `DataTests.Codeunit.al` and `HangTests.Codeunit.al` do: BC's restrictive default refuses the test bodies' `DeleteAll`/`Insert`, so without it the baseline is not green. An `alc` compile does not catch its absence; only the live baseline does.
7. **Each test deletes the table's rows first.** A grouped `RunMutantMany` call runs several methods; this makes each test independent of what an earlier method left, whatever the isolation does.
8. **The answer key is a separate app,** so the base suite (and its frozen baseline) never contains the killers. Its leg asserts only the five planted mutants; the rest of its verdicts are printed, not frozen.
9. **No `CLAUDE.md` edit by the lane.** The owner adds the `itest:harden` line after acceptance.

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions. `exactOptionalPropertyTypes`: `...(v !== undefined ? { k: v } : {})`.
- Fail loudly: a mutant the table does not predict, a stale or contradicted mark, or a missing planted mutant is a thrown error naming it. Never "close enough".
- After touching ANY `.al` under `fixtures/`: `bun run compile:fixtures`. Each project needs its own `.alpackages` (gitignored); `compile-fixtures.ts` prints `SKIP` without one, which is not a pass.
- The tests and answers apps compile against the target's `.app` in their own `.alpackages` (the CLAUDE.md recipe "Changed a fixture's AL? Symbols and the test app do NOT update themselves").
- Container: ONLY `Cronus28`, under `coord lease Cronus28 <lane>`, heartbeat every 5 minutes, release right after, one gate at a time (`docs/superpowers/runbooks/autonomy/README.md`, "Containers, leases and the pause"). Standing owner authorization covers publishing these apps and running the gate there.
- Roadmap text cites names, never `file.ts:<line>` (R117).

## Review Focus

1. **The mark names exactly S5, and would not survive a drift.** Expected: `lethal.equivalent.json` parses, holds one mark with a non-empty reason, and its key equals the serialized identity of exactly one manifest mutant: `remove-assignment` at `BonusFor`'s `Bonus := 0`, ordinal 0, a procedure (not trigger) mutant. Pinned offline by `harden-fixture.test.ts` "C02-03: the committed mark names exactly the planted equivalent", and live by `assertHardenMarks` (matched = [S5's code], stale = [], contradicted = []).
2. **Only the equivalent is flagged by operator risk.** Expected: of the five planted operators, only `remove-assignment` declares an `equivalenceRisk`, so the live `likelyEquivalentSurvivors` is `{ count: 1, byRisk: [{ risk: "value-rewrite", mutants: [S5] }] }`. If an operator later gains a risk tag, this fixture's "four actionable" design breaks, and a test must say so. Pinned offline by "C02-03: only the planted equivalent's operator declares an equivalence risk" (reads the real operator registry), and live by `assertHardenVerdicts`.
3. **No sixth survivor and no no-coverage mutant, ever quietly.** Expected: the deployed mutant set (after dedup) equals `EXPECTED` exactly, by (file, line, operator); a new site from an operator change fails offline before any live run. Pinned offline by "C02-03: the deployed mutant set equals the pre-committed table", and live by `assertHardenVerdicts` (every row's verdict) plus `harden.baseline.json`.
4. **A kill cannot change its killer between runs.** Expected: every killed row names exactly one `killingTest`, and the live report agrees for every one. Each target procedure is called by exactly one base test and the trigger's mutants are killed by only one of their two covering tests, so R197's order cannot move it. Pinned by `assertHardenVerdicts` (a `killingTest` mismatch throws) and its unit test with a hand-built report.
5. **The four are killable and the fifth is not, measured.** Expected: on the answers leg, S1 to S4 are `killed` by K1 to K4 BY NAME, and S5 is `survived` with its mark still `matched`. Pinned by `assertHardenAnswers` and its unit test; the live leg is the measurement.

---

### Task 1: The three AL projects

**Files:**
- Create: `fixtures/sandbox-harden/app.json`, `src/HardenLogic.Codeunit.al`, `src/HardenEntry.Table.al`, `lethal.equivalent.json` (Task 2 fills the key)
- Create: `fixtures/sandbox-harden-tests/app.json`, `src/HardenTests.Codeunit.al`
- Create: `fixtures/sandbox-harden-answers/app.json`, `src/HardenAnswerKey.Codeunit.al`
- Local only (gitignored): `.alpackages/` in all three, `fixtures/sandbox-harden/lethal.config.local.json`

`app.json`: copy `fixtures/sandbox-hang/app.json` and `fixtures/sandbox-hang-tests/app.json` field for field (runtime 13.0, `resourceExposurePolicy`, empty `features`). New GUIDs (`bun -e "console.log(crypto.randomUUID())"`), names `LethAL Sandbox Harden`, `LethAL Sandbox Harden Tests`, `LethAL Sandbox Harden Answers`, all version `1.0.0.0`, the id ranges from Decision 1. Tests and answers each depend on the target by id, name, publisher and version.

**Target** (the shape is fixed; keep comments as one line so the line numbers below hold, and re-derive them from the dry run in Task 2 in any case):

```al
codeunit 79500 "Harden Logic"
{
    // S1 conditional-boundary: no base test asks about exactly 100.
    procedure IsLarge(Amount: Integer): Boolean
    begin
        exit(Amount > 100);
    end;

    // S2 remove-setrange: every row in the base test is in the wanted category.
    procedure CountInCategory(WantedCategory: Code[10]): Integer
    var
        Entry: Record "Harden Entry";
    begin
        Entry.SetRange(Category, WantedCategory);
        exit(Entry.Count());
    end;

    // S3 swap-find-direction: the base test inserts one row, so first and last are the same.
    procedure FirstAmount(): Integer
    var
        Entry: Record "Harden Entry";
    begin
        if Entry.FindFirst() then
            exit(Entry.Amount);
        exit(0);
    end;

    // S4 validate-to-assign: the base test reads Amount, never Doubled, which OnValidate sets.
    procedure SetAmount(var Entry: Record "Harden Entry"; NewAmount: Integer)
    begin
        Entry.Validate(Amount, NewAmount);
    end;

    // S5, the planted EQUIVALENT: a local starts at 0 on every call, so `Bonus := 0` changes nothing.
    // Bonus must stay a LOCAL; as a global it would be killable (fixtures/README.md, sandbox-harden).
    procedure BonusFor(Amount: Integer): Integer
    var
        Bonus: Integer;
    begin
        Bonus := 0;
        if Amount > 10 then
            Bonus := Amount;
        exit(Bonus);
    end;
}
```

```al
table 79501 "Harden Entry"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "Entry No."; Integer) { }
        field(2; Category; Code[10]) { }
        field(3; Amount; Integer)
        {
            trigger OnValidate()
            begin
                Doubled := Amount * 2;
            end;
        }
        field(4; Doubled; Integer) { }
    }

    keys
    {
        key(PK; "Entry No.") { }
    }
}
```

Deliberate choices, each one keeps a mutant out: the parameter is `WantedCategory`, not `Category` (a name collision with the field is R70's shape); the key has no `Clustered = true` (a declarative boolean `flip-boolean-literal` refuses and R144 counts); no string literal in the target (no `toggle-blank-string` site); no loop (no `loop-*` site, no hang); no `Insert`/`Modify` in the target (no `swap-modify-flag` site, no platform-artifact tag); `Bonus` is a local. `ordering` comparisons (`> 100`, `> 10`) are ceded by `shift-integer` to `conditional-boundary`, so they carry no `shift-integer` mutant.

**Base tests** (`codeunit 79550 "Harden Tests"`, `Subtype = Test`, `TestPermissions = Disabled;` (Decision 6), no `TestIsolation` property, see `fixtures/README.md` on `AL0223`). Each test uses a LOCAL `Logic: Codeunit "Harden Logic"` and a LOCAL record; a local helper `InsertEntry(EntryNo: Integer; Cat: Code[10]; Amt: Integer)` does `Init`, assigns the three fields directly (no `Validate`) and `Insert()`:

| Test | Body | Kills |
|---|---|---|
| `IsLargeSeparatesSmallFromLarge` | `IsLarge(500)` must be true; `IsLarge(50)` must be false | every `IsLarge` mutant but S1 |
| `CountInCategoryCountsRows` | `DeleteAll`; `InsertEntry(1,'A',1)`, `InsertEntry(2,'A',2)`; `CountInCategory('A')` must be 2 | every `CountInCategory` mutant but S2 |
| `FirstAmountReadsARow` | `DeleteAll`; `InsertEntry(1,'A',7)`; `FirstAmount()` must be 7 | every `FirstAmount` mutant but S3 |
| `SetAmountStoresTheAmount` | `Init`; `SetAmount(Entry, 5)`; `Entry.Amount` must be 5 | every `SetAmount` mutant but S4 |
| `AmountValidateDoublesIt` | `Init`; `Entry.Validate(Amount, 5)` directly (no codeunit call); `Doubled` must be 10 | every `OnValidate` mutant |
| `BonusForPaysOnlyAboveTen` | on ONE `Logic` instance: `BonusFor(11)` must be 11, then `BonusFor(10)` must be 0, then `BonusFor(5)` must be 0 | every `BonusFor` mutant but S5 |

Each failure message states the call, the expected and the actual value (`Error('BonusFor(10) should be 0, got %1', Got)`), so `killingTestFailure` is readable.

**Answer key** (`codeunit 79575 "Harden Answer Key"`, same rules including `TestPermissions = Disabled;`, its own `InsertEntry`): K1 `IsLargeAtTheBoundary`, K2 `CountInCategoryIgnoresOtherCategories`, K3 `FirstAmountReadsTheFirstRow`, K4 `SetAmountRunsValidation` (bodies in the survivors table above), and K5 `BonusForTwiceOnOneInstance`: on ONE instance, `BonusFor(11)` must be 11, then `BonusFor(5)` must be 0. K5 is the test an agent would write to attack S5, and it is expected to pass on the mutant.

- [ ] **Step 1:** Re-run the id grep (Decision 1). Write the seven files.
- [ ] **Step 2:** Symbols. Copy the Microsoft symbol packages from `fixtures/sandbox-hang/.alpackages` (same container, BC 28) into `fixtures/sandbox-harden/.alpackages`. Compile the target with `alc` (the `al-compiler` subagent or `/al-compile`), copy the resulting `LethAL_LethAL Sandbox Harden_1.0.0.0.app` plus the Microsoft symbols into the tests' and answers' `.alpackages`, then compile both.
- [ ] **Step 3:** `bun run compile:fixtures`. All three new projects must say compiled, not `SKIP`. Every existing project's status is unchanged.
- [ ] **Step 4:** Create the gitignored `fixtures/sandbox-harden/lethal.config.local.json` by copying `fixtures/sandbox-hang/lethal.config.local.json` (it already points at Cronus28), changing `packageCachePath` to `fixtures/sandbox-harden/.alpackages` and `selectorIds` to 79547/79548/79549. Confirm `git status` does not list it.
- [ ] **Step 5:** Dry run: `bun packages/runner/src/cli.ts run --project fixtures/sandbox-harden --config fixtures/sandbox-harden/lethal.config.local.json --dry-run` (the config supplies selector ids 79547-79549; without it the CLI defaults to 79197-79199, which `validateSelectorIds` refuses as outside the declared range, and that refusal is not an AL design result; the three selector-id flags are an equivalent alternative). Compare its per-site list with the `EXPECTED` table in Task 2. **A site the table does not predict is fixed in the AL (remove the site, or give it a base test that kills it with one named test), never absorbed as a sixth survivor.** Record the per-site list for Task 3.
- [ ] **Step 6: Commit** `test(fixtures): sandbox-harden, five planted survivors and an answer key (C02-03)`.

### Task 2: The pre-committed table, the mark, and their offline test

**Files:**
- Create: `packages/runner/itest/harden-expected.ts`
- Create: `packages/runner/itest/harden-fixture.test.ts` (runs under plain `bun test`, like `config-path.test.ts` beside it; confirm it is picked up)
- Modify: `fixtures/sandbox-harden/lethal.equivalent.json`

**`harden-expected.ts`.** The table below is review r1's exact prediction for the Task 1 AL: **21 deployed mutants, 16 killed, 5 survived**, with lines from the Task 1 text. There are no "if emitted" rows. Four sites a first reading expected are absent, each for a reason read from the operator source:

- no `negate-conditional` on `Amount > 100` or `Amount > 10`: that operator flips `=`/`<>` and `and`/`or`, not `>`;
- no `negate-guard` on `if Amount > 10`: it cedes comparison guards (to `conditional-boundary`);
- no `shift-integer` on the `2` in `Amount * 2`: it claims a literal only when it is directly the assigned value or an equality-comparison operand;
- no `void-method-call` on `Entry.SetRange(...)`: its deletion has the same span and replacement text as `remove-setrange`'s, and section 3.2 dedup keeps the Tier-2 one.

Nor is there a `swap-additive`, `flip-boolean-literal` or `toggle-blank-string` site: the target has no `+`/`-`, no executable Boolean literal and no string literal. The Task 1 Step 5 dry run must still confirm the table ROW BY ROW (not only the total) before the spec is written; a disagreement is resolved by changing the AL or, if the reading was wrong, by correcting the row with the operator-source reason in the spec.

```ts
import type { SessionReport } from "../src/report";

export type Planted = "S1" | "S2" | "S3" | "S4" | "S5";

export interface ExpectedMutant {
  readonly file: string; // project-relative, as MutantOutcome.file spells it
  readonly line: number;
  readonly operator: string;
  readonly scope: string; // procedure, or trigger as the report names it
  readonly verdict: "killed" | "survived";
  readonly killingTest?: string; // required when verdict is "killed"
  readonly planted?: Planted;
}

const L = "src/HardenLogic.Codeunit.al";
const T = "src/HardenEntry.Table.al";

export const EXPECTED: readonly ExpectedMutant[] = [
  { file: L, line: 5, operator: "lethal.empty-block", scope: "IsLarge", verdict: "killed", killingTest: "IsLargeSeparatesSmallFromLarge" },
  { file: L, line: 6, operator: "lethal.conditional-boundary", scope: "IsLarge", verdict: "survived", planted: "S1" },
  { file: L, line: 6, operator: "lethal.return-value", scope: "IsLarge", verdict: "killed", killingTest: "IsLargeSeparatesSmallFromLarge" },
  { file: L, line: 13, operator: "lethal.empty-block", scope: "CountInCategory", verdict: "killed", killingTest: "CountInCategoryCountsRows" },
  // Tier-2 remove-setrange displaces void-method-call's identical deletion at this span (section 3.2 dedup).
  { file: L, line: 14, operator: "lethal.remove-setrange", scope: "CountInCategory", verdict: "survived", planted: "S2" },
  { file: L, line: 15, operator: "lethal.return-value", scope: "CountInCategory", verdict: "killed", killingTest: "CountInCategoryCountsRows" },
  { file: L, line: 22, operator: "lethal.empty-block", scope: "FirstAmount", verdict: "killed", killingTest: "FirstAmountReadsARow" },
  { file: L, line: 23, operator: "lethal.negate-guard", scope: "FirstAmount", verdict: "killed", killingTest: "FirstAmountReadsARow" },
  { file: L, line: 23, operator: "lethal.swap-find-direction", scope: "FirstAmount", verdict: "survived", planted: "S3" },
  { file: L, line: 24, operator: "lethal.return-value", scope: "FirstAmount", verdict: "killed", killingTest: "FirstAmountReadsARow" },
  // `exit(0)` on line 25: return-value skips a zero, and shift-integer claims only a literal directly in an assignment or equality comparison.
  { file: L, line: 30, operator: "lethal.empty-block", scope: "SetAmount", verdict: "killed", killingTest: "SetAmountStoresTheAmount" },
  // Both kept: dedup keys on replacement text, and validate-to-assign's is never empty.
  { file: L, line: 31, operator: "lethal.void-method-call", scope: "SetAmount", verdict: "killed", killingTest: "SetAmountStoresTheAmount" },
  { file: L, line: 31, operator: "lethal.validate-to-assign", scope: "SetAmount", verdict: "survived", planted: "S4" },
  { file: L, line: 39, operator: "lethal.empty-block", scope: "BonusFor", verdict: "killed", killingTest: "BonusForPaysOnlyAboveTen" },
  { file: L, line: 40, operator: "lethal.remove-assignment", scope: "BonusFor", verdict: "survived", planted: "S5" },
  { file: L, line: 40, operator: "lethal.shift-integer", scope: "BonusFor", verdict: "killed", killingTest: "BonusForPaysOnlyAboveTen" },
  { file: L, line: 41, operator: "lethal.conditional-boundary", scope: "BonusFor", verdict: "killed", killingTest: "BonusForPaysOnlyAboveTen" },
  { file: L, line: 42, operator: "lethal.remove-assignment", scope: "BonusFor", verdict: "killed", killingTest: "BonusForPaysOnlyAboveTen" },
  { file: L, line: 43, operator: "lethal.return-value", scope: "BonusFor", verdict: "killed", killingTest: "BonusForPaysOnlyAboveTen" },
  // Trigger mutants: covered by SetAmountStoresTheAmount too, which passes on all of them.
  { file: T, line: 12, operator: "lethal.empty-block", scope: "OnValidate", verdict: "killed", killingTest: "AmountValidateDoublesIt" },
  { file: T, line: 13, operator: "lethal.remove-assignment", scope: "OnValidate", verdict: "killed", killingTest: "AmountValidateDoublesIt" },
];

/** The answer key's killer for each actionable survivor, by method name. */
export const ANSWER_KILLERS: Readonly<Record<Exclude<Planted, "S5">, string>> = {
  S1: "IsLargeAtTheBoundary",
  S2: "CountInCategoryIgnoresOtherCategories",
  S3: "FirstAmountReadsTheFirstRow",
  S4: "SetAmountRunsValidation",
};

export class HardenGateError extends Error {}

/** Leg A: every row's verdict and killer, nothing extra, no no-coverage, and the equivalence list. */
export function assertHardenVerdicts(report: SessionReport, expected = EXPECTED): void { /* ... */ }
/** Both legs: the mark matched S5 only; stale and contradicted are empty. */
export function assertHardenMarks(report: SessionReport, expected = EXPECTED): void { /* ... */ }
/** Leg B: S1..S4 killed by ANSWER_KILLERS by name, S5 survived. Other rows are not asserted. */
export function assertHardenAnswers(report: SessionReport, expected = EXPECTED): void { /* ... */ }
```

The three checks match a report mutant to a row by `file`, `line` and `operatorName`, throw `HardenGateError` naming the row or the unpredicted mutant, and never pass on an empty report (assert the report has at least one mutant per row first: empty-versus-empty is this project's signature bug). `assertHardenVerdicts` also asserts `counts.noCoverage === 0`, `counts.survived === 5`, the survivors' operator set equals the five planted operators, and `likelyEquivalentSurvivors` deep-equals `{ count: 1, byRisk: [{ risk: "value-rewrite", mutants: [<S5's mutantCode>], meaning: <any string> }] }`.

**`harden-fixture.test.ts`:**

```ts
describe("C02-03: sandbox-harden's mutant set is exactly the pre-committed one", () => {
  // helper: manifest(): generateMutationSet(PROJECT_DIR), then writeInstrumentedProject into a
  // mkdtemp dir with operatorTiers (orchestrator.ts) and selector ids 79547-79549, then read
  // mutant-manifest.json. Copy the argument list from runSession's own call, not from memory.
  test("C02-03: the deployed mutant set equals the pre-committed table", async () => {
    // multiset of `${file}:${startLine}:${operatorName}` from the manifest equals the one from EXPECTED
  });
  test("C02-03: the committed mark names exactly the planted equivalent", async () => {
    // parseEquivalenceMarks(lethal.equivalent.json): length 1, reason non-empty.
    // manifest entries whose serializeKey(identityKeyOf(e)) equals the key: exactly one,
    // and it is the S5 row (file, line, operator), with identityOrdinal absent or 0 and no triggerName.
  });
  test("C02-03: only the planted equivalent's operator declares an equivalence risk", () => {
    // for each planted row, look the operator up in tier1Operators/tier2Operators:
    // S5's equivalenceRisk is "value-rewrite", S1..S4's is undefined.
  });
  test("C02-03: every killed row names a killer and every survivor is planted", () => {});
  test("C02-03: the gate checks refuse a wrong report", () => {
    // hand-built SessionReport from EXPECTED (the notinstrumented-evidence.ts pattern):
    // passes as built; then one killingTest changed -> assertHardenVerdicts throws naming it;
    // one extra survived mutant -> throws; one no-coverage -> throws; likelyEquivalentSurvivors
    // listing two mutants -> throws; readerMarkedEquivalent absent -> assertHardenMarks throws;
    // S3 survived on leg B -> assertHardenAnswers throws naming S3.
  });
});
```

- [ ] **Step 1:** Write the module and the test with `lethal.equivalent.json` holding `{ "marks": [] }`. Run `bun test packages/runner/itest/harden-fixture.test.ts` and see the mark test fail.
- [ ] **Step 2:** Fill `EXPECTED` from the dry run (Task 1 Step 5) until the set test passes. Every row change is a DESIGN change and goes into the spec in Task 3.
- [ ] **Step 3:** Write the mark. Take the key from the helper's output for the S5 entry (print it once from the test on failure), never by hand:

```json
{
  "marks": [
    {
      "key": "<serializeKey(identityKeyOf(S5 entry))>",
      "reason": "Equivalent: Bonus is a local, AL sets every local to its default (0) on each call, and nothing reads Bonus before `Bonus := 0`, so deleting the statement changes no observable value. Planted by C02-03; see fixtures/README.md, sandbox-harden.",
      "markedBy": "C02-03",
      "markedOn": "2026-09-25"
    }
  ]
}
```

- [ ] **Step 4:** Full loop: typecheck, clean dist, `bun test`, biome on the two new files.
- [ ] **Step 5: Red-checks** (revert, see red, restore, see green; report each):
  (a) add a statement `Bonus := Bonus;` to `BonusFor`: the set test goes red naming the new site. Restore.
  (b) put the key of the line-40 `shift-integer` entry into the mark: the mark test goes red. Restore.
  (c) add `equivalenceRisk: "value-rewrite"` to `swap-find-direction`'s operator object: the risk test goes red. Restore.
  (d) in `assertHardenVerdicts`, skip the `killingTest` comparison: the "refuse a wrong report" test goes red on the changed-killer case. Restore.
  (e) in `assertHardenMarks`, return early when `readerMarkedEquivalent` is undefined: red. Restore.
- [ ] **Step 6: Commit** `test(itest): pre-committed table and mark for sandbox-harden (C02-03)`.

### Task 3: The pre-commitment spec, committed alone

**Files:** Create `docs/superpowers/specs/2026-09-25-c02-03-harden-precommitment.md`.

It must contain, written from the offline dry run and never from a live run:

- Every mutant of leg A: file, line, operator, scope, predicted verdict, and killer by name. It is the final `EXPECTED`, row for row.
- The five survivors with, for each: why the base suite misses it, and the answer-key test that kills it (or, for S5, the equivalence argument in full, including the two conditions that would break it and the repeat-call measurement).
- Leg A totals: 21 deployed (and the raw count from the dry run), killed 16, survived 5, no-coverage 0, `likelyEquivalentSurvivors` = S5 only, `readerMarkedEquivalent` matched = S5, stale and contradicted empty.
- Leg B: S1 to S4 `killed` by K1 to K4 by name; S5 `survived`, mark matched. Its other verdicts are not predicted.
- That no existing gate moves: no existing fixture, test project or baseline changes. The only shared resource is Cronus28, which gains three apps in an id block no other fixture uses. A collision with an app we do not own (Continia, `CG Test Harness`) fails at publish, loudly, before any gate runs; if that happens, stop and pick another block.
- The stop rule: any verdict, killer or total that differs is a BLOCK reported to the owner, not an edit to the table.

- [ ] **Step 1:** Write it. **Commit it ALONE:** `spec(C02-03): pre-commit sandbox-harden's verdicts before its first live run`.

### Task 4: The gate, `itest:harden`

**Files:**
- Create: `packages/runner/itest/harden.itest.ts`
- Modify: `package.json` (`"itest:harden": "bun packages/runner/itest/harden.itest.ts"`, beside `itest:hang`)
- Later, by the live run: `packages/runner/itest/harden.baseline.json`

Model it on `hang.itest.ts`'s ON leg, the smallest standalone bcdev gate: same env-gate shape (`LETHAL_ITEST_HARDEN`, `emitSkipped("harden", ...)`), the same `itestConfigPath` config read, the same `runSession` wiring minus the stop options. Two legs, one after another, each a full `runSession`:

1. **Leg A**, `--tests fixtures/sandbox-harden-tests`, with `equivalenceMarks: await loadEquivalenceMarks(PROJECT_DIR)` (exported from `packages/runner/src/cli.ts`). Assert `baselineGreen`, then `assertHardenVerdicts`, then `assertHardenMarks`. If `harden.baseline.json` EXISTS, also `assertMatchesBaseline(report, BASELINE_PATH)` here. If it is absent, do NOT call it yet: `assertMatchesBaseline` writes the file immediately when it is missing, and the file must not exist until leg B has also passed. Print the per-mutant table, the totals, `timings.totalMs` (C02-08's 20% check needs it) and the build facts the other gates print.
2. **Leg B**, `--tests fixtures/sandbox-harden-answers`, same marks. Assert `baselineGreen`, `assertHardenAnswers`, `assertHardenMarks`. No baseline file of its own; print its full table.
3. **Record, last.** Only after leg B passed, and only if the file was absent at the start, call `assertMatchesBaseline(reportA, BASELINE_PATH)`, which writes it. This ordering lives in ONE small exported function in `harden-expected.ts`, so it can be red-checked offline:

```ts
/** Writes the baseline (via assertMatchesBaseline) only after legB() resolved. A leg-B throw
 *  propagates and leaves no file behind. When the file already exists, leg A compared against it. */
export async function recordAfterBothLegs(
  reportA: SessionReport,
  legB: () => Promise<void>,
  baselinePath: string,
): Promise<void>;
```

Order the assertions so the first failure names a mutant: the table checks run before the baseline diff.

- [ ] **Step 1:** Write the gate and the script.
- [ ] **Step 2:** Typecheck, clean dist, `bun test` (the gate itself is not a `bun test` file), biome on touched files.
- [ ] **Step 3:** `bun run itest:harden` with the env var UNSET prints the skip line and exits 0.
- [ ] **Step 4: Unit test and red-check for the record order.** In `harden-fixture.test.ts`, "C02-03: the baseline is written only after leg B passes": with a temp `baselinePath` that does not exist, a `legB` that throws makes `recordAfterBothLegs` reject AND leaves no file; a `legB` that resolves leaves a file whose content equals the normalized leg-A report. Red-check: move the write above `await legB()`; the throwing case goes red (the file exists). Restore.
- [ ] **Step 5: Red-check** (offline): drop the `equivalenceMarks` line from leg A's config. The gate cannot run offline, so show instead that `assertHardenMarks` throws on a report without `readerMarkedEquivalent` (Task 2 case (e) covers the check; say in the submit note that the wiring itself is proven only by the live run, R172's lesson).
- [ ] **Step 6: Commit** `test(itest): itest:harden, the five-survivor gate (C02-03)`.

### Task 5: Live (lane, under the lease)

Run from the main checkout `U:\Git\LethAL` (only it holds the gitignored configs), after Tasks 1 to 4 are merged there, one step at a time, foreground, never polled.

- [ ] **Step 1:** `pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus28`. Stopped: `coord ask`, never start it. Then `coord lease Cronus28 <lane>`, heartbeat every 5 minutes.
- [ ] **Step 2:** Confirm the control app on Cronus28 is 1.0.0.18 (or whatever `MIN_CONTROL_VERSION` in `harness.ts` requires at that time) and that `grep -h '"server"' fixtures/sandbox-harden/lethal.config.local.json` names Cronus28 only.
- [ ] **Step 3: Publish through the DEV ENDPOINT** (`.claude/skills/control-app`, "Rebuilding a container that came back EMPTY", step 2), in this order: target, tests, answers. Never at global scope: LethAL replaces the target on every run, and a global target blocks that replace.

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
$cfg  = Get-Content 'U:\Git\LethAL\fixtures\sandbox-harden\lethal.config.local.json' -Raw | ConvertFrom-Json
$cred = New-Object System.Management.Automation.PSCredential(
          $cfg.bcdev.username, (ConvertTo-SecureString $cfg.bcdev.password -AsPlainText -Force))
foreach ($app in @(
  'U:\Git\LethAL\fixtures\sandbox-harden\LethAL_LethAL Sandbox Harden_1.0.0.0.app',
  'U:\Git\LethAL\fixtures\sandbox-harden-tests\LethAL_LethAL Sandbox Harden Tests_1.0.0.0.app',
  'U:\Git\LethAL\fixtures\sandbox-harden-answers\LethAL_LethAL Sandbox Harden Answers_1.0.0.0.app')) {
  Publish-BcContainerApp -containerName Cronus28 -appFile $app -skipVerification -sync -install -useDevEndpoint -credential $cred
}
```

  A "defined in multiple apps" error is an id collision: stop, release the lease, report. Never echo the credentials.
- [ ] **Step 4:** `LETHAL_ITEST_HARDEN=1 bun run itest:harden`. On the first run the gate writes `harden.baseline.json` only after BOTH legs passed every pre-committed check (`recordAfterBothLegs`). If any leg failed, confirm no `harden.baseline.json` was left behind (delete it if one exists) before reporting. Any mismatch: BLOCK, report to the owner with the per-mutant table, change nothing.
- [ ] **Step 5:** Run it a SECOND time. Leg A now compares against the file just written; it must pass unchanged (determinism, including every `killingTest`).
- [ ] **Step 6:** Release the lease.
- [ ] **Step 7:** The lane commits `harden.baseline.json` (ruling 1; the orchestrator reviews it at acceptance). Message: `test(itest): record sandbox-harden's baseline, matches the pre-commitment (C02-03)`.

### Task 6: Fixture documentation

**Files:** Modify `fixtures/README.md`.

- [ ] **Step 1:** Add the four objects (79500, 79501, 79550, 79575) to the "Object ids" tables, and `sandbox-harden` 79547-79549 to the selector-triple sentence (R169's "two fixtures must never share the three ids").
- [ ] **Step 2:** Add a short section "sandbox-harden (C02-03)": what it is for (C02's survivor loop), the five survivors table, the S5 argument and its two breaking conditions, the answer-key app and why it is separate, and the hand-off rule for C02-08 below.
- [ ] **Step 3: Commit** `docs(fixtures): sandbox-harden (C02-03)`.

### Task 7: Roadmap

- [ ] **Step 1:** `ls docs/roadmap/` immediately before writing (R234 is TAKEN since 2026-09-25; expect R235 or later, and re-check: other sessions file concurrently). Copy `_template.md`. File one item, `section: "product-gaps"`, `status: "open"`: "No command prints a mutant's identity key, so a reader writes `lethal.equivalent.json` keys by hand". Evidence by name: `parseEquivalenceMarks` in `packages/runner/src/equivalence-marks.ts` needs `astHash|codeunitName|procedureName|operatorName|operatorMajor`; neither `lethal run --dry-run` nor `lethal explain` prints it; the C02-03 fixture had to compute it through `identityKeyOf` and `serializeKey` in `packages/runner/src/selection.ts`; and R229 shows hand assembly already goes wrong for triggers. Closing it: print the serialized key per survivor in `explain` (or per site in `--dry-run`), built by the same two functions. Cite names, never `file.ts:<line>`.
- [ ] **Step 2:** `bun scripts/roadmap-index.ts`, then `bun test scripts/roadmap-index.test.ts scripts/line-citations.test.ts`.
- [ ] **Step 3: Commit** `roadmap: R<n> no command prints a mutant's identity key (C02-03)`.

## Hand-off rules for C02-08

- The agent's new tests must NOT be committed into `fixtures/sandbox-harden-tests`: that app's baseline freezes five survivors. Work on a copy. If the copy keeps the tests app's id and name, publishing it REPLACES the published suite, and `itest:harden` then refuses with `StaleTestAppError` until the committed suite is republished. Give the copy its own id or republish afterwards.
- `lethal verify --tests fixtures/sandbox-harden-answers` is a ready deterministic control: it must report S1 to S4 killed and S5 skipped.

## Out of scope, on purpose

- **`lethal harden` / the survivor packet** (C02-01) and **`lethal verify`** (C02-04 to C02-06). This task only supplies the fixture they are measured on.
- **The C02-08 gate and its wall-time ratio.** Leg A prints `timings.totalMs`; nothing is asserted about time.
- **Registering `harden` in `scripts/agentflow/gate-table.ts`** (ruling 3, changed). Its container contract, `LEG_CONTAINER`, accepts only `"agent-app"` and `"agent-data"`, and those name containers LethAL may no longer use; Cronus28 is the only one it may. Registering the leg means changing that contract first, which is a gate-table decision, not a fixture one. C02-08 does it, and its fixture rule must cover all three projects (target, tests AND answers), so an answer-key-only change still selects the gate. Until then a change under `fixtures/sandbox-harden*` matches no row and default-deny runs the full set, which does not include `harden`: the gate is run by hand.
- **An al-runner leg.** The epic's verify path is bcdev; al-runner has no attestation channel.
- **Fixing R229 or R230.** The fixture avoids both shapes instead.
- **A `Library Assert` arm or any R121 screen pin.** Not what this fixture measures.

## Submit note must say

- Every red-check, with its red and restored-green output line.
- The dry run's per-site list, the rows it removed or added against the plan's prediction (expected: none against the 21-row table), and that the spec was committed before the first live run.
- `bun run compile:fixtures` output for the three new projects (compiled, not `SKIP`).
- Both live runs' per-mutant tables and totals, the answers leg's five planted rows, and the mark's matched/stale/contradicted.
- That no existing fixture, test project, baseline or `CLAUDE.md` line changed.
- That the lease was taken and released, and which apps were published to Cronus28.

## Orchestrator rulings (2026-09-25)

1. **The lane records `harden.baseline.json`**, and only after the first live run matches the committed pre-commitment spec on every row. It is a NEW baseline, not a re-record of a frozen one, so the "re-recording is owner-only" rule does not apply; the orchestrator reviews it at acceptance. Any mismatch against the pre-commitment is a block for the owner, never a reason to adjust the spec.
2. **Keep the answer-key app.** It is what makes "four killable" measured, and C02-08 needs a fixed control.
3. **(Changed after review r1, finding 4.) Do NOT register `harden` in `scripts/agentflow/gate-table.ts` in this task.** Its container contract (`LEG_CONTAINER`: `agent-app` / `agent-data`) points at containers LethAL may no longer use, so registration needs that contract changed first. C02-08 registers it, with a fixture rule covering the target, tests and answers projects. Recorded in Out of scope.
4. **Live work** runs on Cronus28 only, under `coord lease Cronus28 code`, with the standing owner authorization (runbook README). The owner adds the `itest:harden` line to `CLAUDE.md` after acceptance.
