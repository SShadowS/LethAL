# C02-08: Verify-vs-full-run agreement gate, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-09-26),** after review r1 (`H:/lethal-coord/reviews/C02-08-plan/review-r1.md`) and the owner's ruling on the 20% line. Changed: Open question 1 is RULED (record now, gate later; the 20% criterion stays open as a roadmap item); the freshness check reads `validity.caveats`, `resumedFrom` and `mutants[].carried`; the identity check is part of `agree`; new join cases (renumbered codes, same hash in different procedures, ordinal twins) and content checks on the negative control; Task 0 separates a changed prediction from a result contrary to C02-03's frozen spec (a STOP); `itest:harden` runs after BOTH agreement runs; the restore keeps both failures. See "Review responses" at the end.

**Revision 1 (2026-09-26),** drafted before C02-03 is accepted. Every fact that C02-03 still owns is listed in "Facts that depend on C02-03" and re-checked by Task 0. Nothing here runs live until Task 0 passes and the spec in Task 3 is committed alone.

## Open questions for the orchestrator and owner

Question 1 is ruled. The others have a default the plan uses if no ruling arrives. A ruling that differs changes only the task named.

1. **RULED by the owner (2026-09-26): record now, gate later.** The gate asserts per-mutant agreement and `verify.timings.totalMs < B.timings.totalMs` (verify is faster than the full run it replaces). It RECORDS the ratio against the 0.20 line and prints `ABOVE the epic's 20% line` when it is. The epic's criterion "wall time of verify under 20% of the full run" stays OPEN: Task 7 files it as a roadmap item whatever the ratio turns out to be, because this task does not gate it. The submit note and the closing comment on #18 must say plainly that the 20% goal was NOT met or gated by C02-08 (exact wording in Task 7), so nobody reads the closing as meeting it. The evidence behind the ruling, all on `sandbox-app`: C02-06b `itest:verify` run 1, 3266 / 22058 ms = 0.148 (COLD full run as denominator); run 2, 2956 / 7593 ms = 0.389 (warm); the orchestrator's measurement on the merged tree 06805a0, 3297 / 9384 ms = **0.351**. `sandbox-harden` is about the same size (21 mutants against 19, one batch), and verify does MORE work there (four survivors, each with its covering test plus five new tests, every new test run twice unmutated). Verify's fixed costs (a test-app compile, one publish, a lease, a baseline, the second unmutated run) do not shrink with the fixture, so the predicted warm ratio is above 0.20.
2. **Literal `lethal campaign compare`, or the principle it uses?** The issue says "verify's verdicts equal `campaign compare`'s per mutant". `campaign compare` runs `diffMutants(committedBaseline, normalizeForComparison(report))` behind a campaign manifest and a COMMITTED stage baseline. A committed baseline of the post-verify full run would pin `killingTest` for all 21 mutants, and for the 16 non-target mutants several tests kill each one after the answer tests are added, so their `killingTest` depends on R197's order. **Default:** this gate REUSES `campaign compare`'s identity principle (the R166 key built by `keyOf` in `packages/runner/itest/mutant-equality.ts`, and per-mutant comparison, never aggregate counts). It does NOT run `lethal campaign compare`, and its join differs on purpose: `diffMutants` compares per-key MULTISETS, while this comparator needs exactly ONE `B` mutant per key and reports two as a disagreement, because each verify row names one mutant. Plus a pre-committed per-mutant table for `B`. No new campaign stage, no new committed baseline file. The submit note says this in those words.
3. **Gate-table registration.** C02-03's orchestrator ruling 3 says C02-08 registers `harden` in `scripts/agentflow/gate-table.ts`, which first needs `LEG_CONTAINER`'s type (`"agent-app" | "agent-data"`) widened to name Cronus28, and `tick.ts` reads that contract. That is an agentflow decision with its own blast radius, unrelated to agreement. `verify` and `testapp` are not registered either. **Default:** OUT of this task; Task 7 files it as a roadmap item covering `harden`, `verify`, `testapp` and the new `agreement` leg together. If the owner keeps ruling 3, Task 6 is written out below and runs.
4. **How the answer-key tests reach verify.** C02-03's hand-off rule says `lethal verify --tests fixtures/sandbox-harden-answers` is "a ready deterministic control". Against the merged verify it is not: `planVerify` requires every covering test of the source run (all in codeunit 79550 `Harden Tests`) to be present in `--tests`, and the answers app holds only codeunit 79575, so verify refuses `covering-test-unmatched` before it measures anything. **Default:** the gate builds a scratch copy of `fixtures/sandbox-harden-tests` and adds the answer key's five tests to it, as an agent would add tests to its own suite (Task 2). The code lane has confirmed the hand-off correction on master and changes only C02-03 Task 6's README text for it, so this task writes nothing about it; Task 0 only checks that the landed README does not say the opposite.
5. **`killingTest` on the 16 non-target mutants of the post-verify full run.** **Default:** verdict asserted per mutant for all 21; `killingTest` asserted only for S1 to S4, where the fixture is built so exactly one test kills each. For the other 16, adding the answer tests can give a mutant a second killer, and which one is recorded is order-dependent (R197). Pinning them would make the gate flaky, not stricter.

**Goal:** A live gate on `sandbox-harden` that proves, per mutant, that `lethal verify`'s verdicts on the five planted survivors equal the verdicts a later, FRESH full `lethal run` with the same tests reaches, and that records verify's wall time as a fraction of that full run.

**Architecture:** One new pure module, `packages/runner/itest/verify-agreement.ts`, joins verify's result rows to two `SessionReport`s by the R166 identity key and returns one difference per disagreeing mutant; it is unit-tested offline with hand-built reports. One new standalone gate, `packages/runner/itest/verify-agreement.itest.ts` (`LETHAL_ITEST_AGREEMENT=1 bun run itest:agreement`), runs: a source full run, `lethal verify` with a scratch suite that holds the answer-key tests, a fresh full run with that same suite, the comparison, a negative control, the ratio, and a restore. Every prediction is pre-committed in a spec before the first live run.

**Tech Stack:** Bun + TypeScript (gate, comparator, unit test), AL only inside the scratch copy the gate writes to a temp dir, `alc` through `BcDevMcpBackend.compileTestApp`, Cronus28.

**Spec:** GitHub issue #18 (child 8 of epic #10): "Live itest on fixture 3: verify's verdicts equal `campaign compare`'s per mutant; wall-time ratio recorded. Depends on: 3, 6." Epic acceptance lines it serves: "After the agent adds tests, verify completes with ONE test-app publish", "Reports 4 killed / 1 skipped", "A subsequent full lethal run agrees on all 5 verdicts", "Wall time of verify under 20% of the full run". Inputs: `docs/superpowers/plans/2026-09-25-C02-03-harden-fixture.md` (the fixture), `docs/superpowers/plans/2026-09-26-C02-06-lethal-verify.md` (decision 9, ruling 4, and the "later full run must be FRESH" line), `docs/superpowers/specs/2026-09-26-c02-06-verify-precommitment.md` (the style, and its "Correction after live run 1"), `docs/roadmap/R247.md`.

## What "agreement" means, exactly

**The join.** Verify reports each row as `id = <batchIndex>/<mutantCode>` of the SOURCE run's store. Mutant codes restart per run and are not stable across runs, so they are never compared across runs. For each verify row:

1. Find the ONE mutant in the source report `A` with that `batchIndex` and `mutantCode`. Zero or two is a thrown error (a broken join, not a disagreement).
2. Check that row's `file`, `line`, `operatorName` and `procedureName` equal that mutant's. A mismatch is a disagreement: the join went to the wrong mutant. It is part of `agree` (the row is `agree: false` AND a difference is pushed), never a separate note beside a row that says `agree: true`.
3. Compute the identity key of that mutant with `keyOf` from `packages/runner/itest/mutant-equality.ts` (`astHash|codeunitName|scope|operatorName|operatorMajor[|ordinal]`, the key `campaign compare` and every frozen baseline use).
4. Find the ONE mutant in the fresh full-run report `B` with that key. Zero or two is a disagreement named with the key.

**The per-mutant rule.** A verify row and its `B` mutant AGREE when:

| verify `verdict` | agrees only when `B`'s mutant has |
|---|---|
| `killed` | `verdict: "killed"` AND `killingTest === row.killingTest.method` |
| `survived` | `verdict: "survived"` |
| `skipped` (`reason: "reader-marked-equivalent"`) | `verdict: "survived"` AND `readerMark.key === row.skipped.mark.key` AND `B.readerMarkedEquivalent.matched` holds that mutant's `mutantCode` |
| `error` | never. An error measured nothing, so it cannot agree with anything. |

`B` verdicts `no-coverage`, `error`, `timeout-killed` and anything else never agree with any verify row. The comparison is per mutant. An aggregate count is printed for the reader and never asserted as the agreement.

`killingTest` is compared by method name because `MutantOutcome.killingTest` is a bare method name (C02-06 decision on `killingTestRef`: the qualified ref is internal and never reaches the report). This is sound here only because every method name in the scratch suite is unique; the gate asserts that before it runs (Task 2).

**Coverage of the comparison.** The gate also asserts: verify returned exactly five rows, their ids equal the five requested ids as a set, and the comparator returned five compared rows. Empty against empty never passes (the comparator throws on an empty verify result).

**Negative control, inside the gate.** The same comparator on (verify output, `A`, `A`), that is against the source run where S1 to S4 still survive, must return EXACTLY four differences, one per S1 to S4 id, each reading `verify killed by <K method>, full run survived`, with `row.agree === false` on those four and `true` on S5. That proves on live data that a VERDICT difference is detected. It does NOT live-control a wrong killer or a stale mark (both sides agree on S5's mark, and `A` has no killer for S1 to S4). Those two failure modes are controlled OFFLINE only, by Task 1's cases (b), (c), (d) and the tampered-`B` cases (o), (p), and the plan claims no more than that.

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Biome only on touched files: `bunx biome check <paths>`.
- No `!` non-null assertions. `exactOptionalPropertyTypes`: `...(v !== undefined ? { k: v } : {})`. Fail loudly: throw on a broken join or empty input, never return an empty "no differences".
- A differing verdict or killer is a BLOCK for the owner, never "close enough", never an edit to the spec or the table. The pre-commitment spec is committed ALONE before the first live run. A later correction is APPENDED below the committed text, as C02-06's "Correction after live run 1" was.
- Never self-record or re-record a baseline. This gate writes NO baseline file. `packages/runner/itest/harden.baseline.json` is read only.
- The post-verify full run is FRESH: a new temp store file, no `resume` in the `runSession` config (R247), and the report proves it: no `resumed` in `validity.caveats`, no `resumedFrom`, no `carried: true` mutant.
- The epic's 20% time criterion is NOT met or gated by this task (owner ruling). No file or comment this task writes may say or imply otherwise.
- Container: ONLY `Cronus28`, under `coord lease Cronus28 code`, heartbeat every 5 minutes, one gate at a time, release right after. Standing owner authorization covers publishing and running gates there.
- Roadmap text cites names, never `file.ts:<line>` (R117). Re-check the next free roadmap id with `ls docs/roadmap/` immediately before writing.
- No em dashes in any file this task writes.

## Review Focus

1. **The comparator cannot pass on nothing.** An empty verify `results`, a verify row whose id is not in `A`, or a `B` without the key must never return "no differences". Pinned by the unit tests in Task 1 (cases e, f, g) and live by the five-row and negative-control assertions.
2. **Skipped is not survived.** A verify `skipped` row agrees only when `B` confirms the SAME mark matched a survivor. If the mark went stale in `B` (the equivalent mutant moved), or `B` killed it (the mark is contradicted), that is a disagreement. Pinned by Task 1 cases c and d.
3. **The full run is not a resume.** A `B` with any `carried: true` mutant, a `resumed` entry in `validity.caveats`, or a `resumedFrom` is refused before comparison, including a resumed report that carried ZERO mutants. Pinned by Task 1 cases h1 to h4 and the live freshness assertions.
4. **The test app on the server after the gate is the committed one.** The restore compiles `fixtures/sandbox-harden-tests` and publishes it in a `finally`, then checks the fresh read-back hash. This is a checked attempt, not a guarantee: if `B` deployed part way, or the restore fails or cannot name the resident artifact, the container can still hold the scratch app, and the gate then prints both failures and requires manual repair before any other gate. Task 5 runs `itest:harden` after EACH agreement run as the runtime proof (S1 to S4 survive again only if the answer tests are gone).
5. **Exactly one test-app publish by verify.** A spy on `BcDevMcpBackend.prototype.publishTestApp` counts exactly 1 during the verify call (epic line "ONE test-app publish").

## Facts that depend on C02-03 (unmerged, on `lethal/lane-code`)

At 06805a0, the COMMITTED `lethal/lane-code` branch holds only C02-03 Task 1 (commit 63983c4): the three AL projects. The lane worktree `U:/Git/LethAL-wt/lane-code` has C02-03 Task 2 IN PROGRESS and uncommitted: `harden-expected.ts` and `harden-fixture.test.ts` untracked, and `lethal.equivalent.json` modified to one mark on `...|Harden Logic|BonusFor|lethal.remove-assignment|1`. That work in progress is NOT a completed hand-off. `harden.itest.ts`, `harden.baseline.json` and the C02-03 pre-commitment spec do not exist anywhere yet. So every fact below is from the C02-03 PLAN, not from accepted code. (The mark key ends in `|1`, the serialized `operatorMajor`; Task 0 confirms it names exactly S5 through C02-03's own offline test, not by reading it.)

| # | Fact this plan uses | Source today |
|---|---|---|
| F1 | Paths: `fixtures/sandbox-harden`, `fixtures/sandbox-harden-tests`, `fixtures/sandbox-harden-answers` | lane-code 63983c4 |
| F2 | Tests app `idRanges` 79550-79574, codeunit 79550 `Harden Tests`; 79574 is free | lane-code app.json; plan decision 1 |
| F3 | Answer key: codeunit 79575 `Harden Answer Key`, methods `IsLargeAtTheBoundary`, `CountInCategoryIgnoresOtherCategories`, `FirstAmountReadsTheFirstRow`, `SetAmountRunsValidation`, `BonusForTwiceOnOneInstance`, plus a local `InsertEntry`; its `Error(...)` texts as quoted in the spec section of Task 3 | lane-code 63983c4 |
| F4 | Leg A: 21 deployed mutants, 16 killed, 5 survived, 0 no-coverage; S1 to S5 at the (file, line, operator) of `EXPECTED`; each killed row has exactly one killer | plan Task 2 table |
| F5 | `harden-expected.ts` exports `EXPECTED`, `ANSWER_KILLERS`, `Planted`, `assertHardenVerdicts`, `assertHardenMarks` | plan Task 2 |
| F6 | `harden.baseline.json` committed, recorded by a run that matched the C02-03 pre-commitment, and a second run matched it | plan Task 5 |
| F7 | `lethal.equivalent.json` holds exactly one mark, on S5, and `runSession` reports it `matched` when given `equivalenceMarks: await loadEquivalenceMarks(PROJECT_DIR)` | plan Task 2, 4 |
| F8 | `fixtures/sandbox-harden/lethal.config.local.json` exists, names Cronus28 only, `selectorIds` 79547/79548/79549 (verify reads selector ids from the config, not the store: R261) | plan Task 1 step 4 |
| F9 | Cronus28 holds the target, the committed tests app and the answers app, all at the dev endpoint (not global scope) | plan Task 5 step 3 |
| F10 | The five planted survivors are all in one batch (one batch for the whole run) | inferred: 21 mutants, no `--max-guards-per-batch` |
| F11 | `harden.itest.ts` prints leg A's `timings.totalMs` (first ratio evidence) | plan Task 4 |
| F12 | Nothing in C02-03 writes the "verify --tests answers is a ready control" rule into a file that ships | code lane: corrected on master, C02-03 Task 6 README only |

---

### Task 0: Re-check the C02-03 facts after C02-03 is accepted

**Files:** none changed except this plan (an erratum line per ALLOWED change, Step 4).

- [ ] **Step 1:** `git fetch; git log --oneline master -20` and confirm C02-03's commits are on master (the fixture, `harden-expected.ts`, the C02-03 spec, `harden.itest.ts`, `harden.baseline.json`) and that C02-03 is marked accepted by the orchestrator. Work in progress in the lane worktree does not count. If not, stop: this task is not ready.
- [ ] **Step 2:** Check F1 to F8 by reading the files: `ls fixtures/sandbox-harden*`, the three `app.json`, `HardenAnswerKey.Codeunit.al`, `packages/runner/itest/harden-expected.ts`, `lethal.equivalent.json` (exactly one mark, non-empty key), `docs/superpowers/specs/2026-09-25-c02-03-harden-precommitment.md`, `grep -rn "7957[0-9]" fixtures --include=*.al --include=*.json` (79574 must be unused). Run `bun test packages/runner/itest/harden-fixture.test.ts` (C02-03's own proof that the mark names exactly S5).
- [ ] **Step 3: Reconcile C02-03's four records of the same facts BEFORE treating F4, F6 or F7 as accepted.** For each of the 21 rows (and the five planted ones in particular), compare: (i) the committed C02-03 pre-commitment spec, (ii) `EXPECTED` in `harden-expected.ts`, (iii) the committed `harden.baseline.json`, (iv) C02-03's live-run history (its submit note and logs, including any appended correction). Classify every difference into exactly one of two kinds:
  - **Kind 1, a changed PREDICTION:** C02-03 changed its plan's table (a line moved, a row added or removed) and then committed its spec, `EXPECTED` and baseline in agreement with each other, and its live run matched that committed spec. This is an ordinary input change. Go to Step 4.
  - **Kind 2, a result CONTRARY to C02-03's own frozen spec:** the committed baseline or a recorded S1 to S5 outcome (verdict, killer, mark status, a sixth survivor, a no-coverage mutant) differs from what the committed C02-03 spec predicted, whether or not an erratum was appended to it, or the four records disagree with each other. **STOP. Report it to the owner with the per-mutant table. Do not adopt the new value into this plan or the Task 3 spec, and do not start Task 1.** A frozen figure that moved is the owner's call, not this task's.
- [ ] **Step 4:** For every Kind 1 change, append `**Erratum <date> (Task 0):** F<n> is now <value> (Kind 1: C02-03 changed its prediction before its live run, commit <id>), which changes <task/step>.` under this section. The Task 3 spec is not yet written, so there is nothing to un-commit.
- [ ] **Step 4b:** F12: `grep -rn "sandbox-harden-answers" fixtures/README.md docs`. The code lane is correcting the hand-off text in C02-03 Task 6's README. If a landed file still says verify can take the answers app alone as `--tests`, do NOT edit it here: report it to the orchestrator as a C02-03 finding.
- [ ] **Step 5:** Read C02-03's live logs for leg A's `timings.totalMs` (F11). Write both leg A figures into Task 3's ratio section as the prior evidence.
- [ ] **Step 6:** Confirm the control-app minimum the client needs today (`MIN_CONTROL_VERSION` in `packages/runner/src/harness.ts`; C02-06b's run 2 logged control 1.0.0.19) and write it into Task 5 step 2.

### Task 1: The comparator and its offline test

**Files:**
- Modify: `packages/runner/itest/mutant-equality.ts` (export the existing private `keyOf`; no other change)
- Create: `packages/runner/itest/verify-agreement.ts`
- Create: `packages/runner/itest/verify-agreement.test.ts` (plain `bun test`, like `config-path.test.ts` beside it; confirm it is picked up)
- Modify (optional, same commit): `packages/runner/itest/verify.itest.ts` and `test-app-publish.itest.ts` to import `keyOf` instead of their copies. Do it only if the diff stays a pure import swap.

**Interfaces:**
- Consumes: `VerifyOutput`, `VerifyResult` from `packages/runner/src/verify.ts`; `SessionReport`, `MutantOutcome` from `packages/runner/src/report.ts`; `keyOf` from `mutant-equality.ts`.
- Produces:

```ts
export function keyOf(m: MutantOutcome): string; // mutant-equality.ts, now exported

// verify-agreement.ts
export interface AgreementRow {
  readonly id: string; // verify's <batchIndex>/<mutantCode>, source-run scoped
  readonly key: string; // keyOf(source mutant)
  readonly verify: string; // verify verdict
  readonly full: string; // B verdict, or "missing" / "ambiguous(<n>)"
  readonly agree: boolean;
}
export class AgreementJoinError extends Error {} // extends Error directly (CLAUDE.md)
/** Throws AgreementJoinError on an empty result list or a verify id not exactly once in `source`.
 *  Returns every row, and one human-readable difference per disagreeing mutant. */
export function compareVerifyToFullRun(
  out: Pick<VerifyOutput, "results">,
  source: SessionReport,
  full: SessionReport,
): { readonly rows: readonly AgreementRow[]; readonly diffs: readonly string[] };
/** Throws AgreementJoinError when `full` shows ANY sign of --resume: a "resumed" entry in
 *  `validity.caveats`, a `resumedFrom`, or a mutant with carried === true. Each is checked on its
 *  own, so a resumed run that carried zero mutants is still refused (R247). */
export function assertFreshFullRun(full: SessionReport): void;
```

- [ ] **Step 1: Write the failing tests.** Build reports by hand (the pattern `notinstrumented-evidence.ts` and C02-03's "refuse a wrong report" test use): a helper `mutant(overrides)` returning a full `MutantOutcome`, `report(mutants, extra?)` returning a `SessionReport` cast. A base scene: source `A` with five mutants S1..S5 (S1..S4 `survived`, S5 `survived` with `readerMark`), `B` with the same five keys (S1..S4 `killed` by `K1`..`K4`, S5 `survived` with the same `readerMark` and `readerMarkedEquivalent.matched` naming it), verify output with S1..S4 `killed` (`killingTest.method` `K1`..`K4`) and S5 `skipped` with that mark. In the base scene `B`'s mutant codes are DIFFERENT from `A`'s (A: M0001..M0005; B: M0011..M0015, in another order), so no test passes by joining on codes. Every case asserts BOTH the `diffs` it expects AND each affected row's `agree` value. Tests, each named after what it pins:

```ts
describe("C02-08: compareVerifyToFullRun", () => {
  test("agrees on the base scene: five rows, all agree, zero diffs, with B's codes renumbered", ...);
  test("(a) a killed row whose full-run mutant survived is one diff naming its id; that row agree false", ...);
  test("(b) a killed row whose full-run killer differs by method is one diff; agree false", ...);
  test("(c) a skipped row whose full-run mutant was killed is one diff (a contradicted mark); agree false", ...);
  test("(d) a skipped row whose full-run mutant carries no readerMark, or another key, or is absent from matched (that variant keeps the per-row readerMark), is one diff each; agree false", ...);
  test("(e) an empty verify result throws AgreementJoinError", ...);
  test("(f) a verify id not in the source report, or in it twice, throws", ...);
  test("(g) a key missing from the full run, or present twice, is one diff naming the key; agree false", ...);
  test("(i) an error row never agrees, even with a full-run error", ...);
  test("(j) a verify row whose file, line, operator or procedure differs from its source mutant is one diff AND row.agree is false, even though its B verdict would agree", ...);
  test("(k) the negative control: the base scene against A itself gives exactly four diffs, each naming one S1..S4 id and reading 'verify killed by K<n>, full run survived'; S1..S4 agree false, S5 agree true", ...);
  test("(l) renumbered codes: A's M0003 is B's M0011 and B's M0003 is a different mutant; the join follows the key, never the code", ...);
  test("(m) same astHash in two procedures: A's S1 and a B mutant with the same astHash and operator in ANOTHER procedure do not join; only the same-procedure one does", ...);
  test("(n) ordinal twins: two byte-identical mutants in one procedure (identityOrdinal 0 and 1) with different B verdicts each join to their own twin", ...);
  test("(o) tampered B killer: B's S2 killed by a base-suite method is one diff", ...);
  test("(p) tampered B mark: B's S5 survived but readerMarkedEquivalent lists it under stale, not matched, is one diff", ...); // fixture: S5 KEEPS its per-row readerMark and is removed ONLY from matched (a deliberately inconsistent hand-built report; a real buildReport drops the row mark), so red-check (11) cannot stay green through the row-mark condition
});
describe("C02-08: assertFreshFullRun", () => {
  test("(h1) a carried mutant throws", ...);
  test("(h2) a 'resumed' entry in validity.caveats throws", ...);
  test("(h3) a resumedFrom with ZERO carried mutants and no caveat throws", ...);
  test("(h4) a clean report passes", ...);
});
```

- [ ] **Step 2:** `bun test packages/runner/itest/verify-agreement.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.** In `mutant-equality.ts` change `function keyOf` to `export function keyOf`. In `verify-agreement.ts`:

```ts
import type { MutantOutcome, SessionReport } from "../src/report";
import type { VerifyOutput, VerifyResult } from "../src/verify";
import { keyOf } from "./mutant-equality";

export class AgreementJoinError extends Error {}

function agreeWith(r: VerifyResult, f: MutantOutcome, full: SessionReport): boolean {
  switch (r.verdict) {
    case "killed":
      return f.verdict === "killed" && r.killingTest !== undefined && f.killingTest === r.killingTest.method;
    case "survived":
      return f.verdict === "survived";
    case "skipped": {
      const key = r.skipped?.mark.key;
      return (
        key !== undefined &&
        f.verdict === "survived" &&
        f.readerMark?.key === key &&
        (full.readerMarkedEquivalent?.matched ?? []).some((m) => m.mutantCode === f.mutantCode && m.key === key)
      );
    }
    default:
      return false; // "error" measured nothing
  }
}

export function compareVerifyToFullRun(out, source, full) {
  if (out.results.length === 0) throw new AgreementJoinError("verify returned no rows; nothing to compare");
  const rows: AgreementRow[] = [];
  const diffs: string[] = [];
  for (const r of out.results) {
    const src = source.mutants.filter((m) => m.batchIndex === r.batchIndex && m.mutantCode === r.mutantCode);
    const [s] = src;
    if (s === undefined || src.length !== 1) throw new AgreementJoinError(`${r.id}: ${src.length} source mutants, not 1`);
    const key = keyOf(s);
    // Part of `agree`, not a side note: a wrong join must never print as an agreeing row.
    if (s.file !== r.file || s.line !== r.line || s.operatorName !== r.operatorName || (s.procedureName ?? "") !== r.procedureName) {
      rows.push({ id: r.id, key, verify: r.verdict, full: "join-mismatch", agree: false });
      diffs.push(`${r.id} (${key}): verify row names ${r.file}:${r.line} ${r.operatorName} ${r.procedureName}, the source mutant ${s.file}:${s.line} ${s.operatorName} ${s.procedureName}`);
      continue;
    }
    const hits = full.mutants.filter((m) => keyOf(m) === key);
    const [f] = hits;
    if (f === undefined || hits.length !== 1) {
      const full_ = hits.length === 0 ? "missing" : `ambiguous(${hits.length})`;
      rows.push({ id: r.id, key, verify: r.verdict, full: full_, agree: false });
      diffs.push(`${r.id} (${key}): verify ${r.verdict}, full run ${full_}`);
      continue;
    }
    const agree = agreeWith(r, f, full);
    rows.push({ id: r.id, key, verify: r.verdict, full: f.verdict, agree });
    if (!agree) diffs.push(`${r.id} (${key}): verify ${r.verdict}${r.killingTest ? ` by ${r.killingTest.method}` : ""}, full run ${f.verdict}${f.killingTest ? ` by ${f.killingTest}` : ""}${f.readerMark ? " (marked)" : ""}`);
  }
  return { rows, diffs };
}

export function assertFreshFullRun(full: SessionReport): void {
  // Three independent checks: a resume that carried nothing still sets resumedFrom (R247).
  if (full.validity.caveats.includes("resumed")) throw new AgreementJoinError("the full run's validity.caveats says resumed (R247)");
  if (full.resumedFrom !== undefined) throw new AgreementJoinError(`the full run resumed from run ${full.resumedFrom.runId} (R247)`);
  const carried = full.mutants.filter((m) => m.carried === true).map((m) => m.mutantCode);
  if (carried.length > 0) throw new AgreementJoinError(`the full run carried ${carried.join(", ")} by --resume (R247)`);
}
```

(Checked at 06805a0: caveats live at `SessionReport.validity.caveats` (`readonly Caveat[]` of strings), and `SessionReport.resumedFrom` is an optional object with `runId`; `buildReport` pushes `"resumed"` exactly when `resumedFrom` is set, so (h3) builds its report by hand to prove the two checks are independent. Still to check while implementing: `MutantOutcome.procedureName` may be optional and trigger rows use `triggerName`; verify's `procedureName` is always a string. Match verify's own rule for a trigger row, read in `runVerify`'s result builder, and add a unit case for a trigger row if verify can target one.)

- [ ] **Step 4:** `bun test packages/runner/itest/verify-agreement.test.ts`. Expected: PASS, 20 tests.
- [ ] **Step 5: Red-checks** (use the `mutation-red-checker` subagent; revert one thing, see the named test go red, restore, see green; record both lines):
  (1) `killed` case: drop the `killingTest` comparison. Red: (b).
  (2) `skipped` case: return `f.verdict === "survived"` only. Red: (d).
  (3) `default` returns `true`. Red: (i).
  (4) Remove the empty-results throw. Red: (e).
  (5) Treat `hits.length > 1` as agreeing with `hits[0]`. Red: (g).
  (6) Delete the file/line/operator/procedure check. Red: (j).
  (6b) Keep the check but push the diff WITHOUT `agree: false` and `continue` (the r1 shape). Red: (j), on its `row.agree` assertion.
  (7) In `assertFreshFullRun`, delete the caveat check. Red: (h2).
  (7b) Delete the `resumedFrom` check. Red: (h3).
  (7c) Delete the `carried` check. Red: (h1).
  (8) Join `B` by `mutantCode` instead of `keyOf`. Red: (l) and the base scene.
  (9) Build the key without `procedureName` (the pre-R166 key). Red: (m).
  (10) Build the key without `identityOrdinal`. Red: (n) (two hits become `ambiguous(2)`).
  (11) In the skipped case, drop the `matched` membership test. Red: (p).
- [ ] **Step 6:** Full loop: `bun run typecheck`, `rm -rf packages/*/dist`, `bun test`, `bunx biome check packages/runner/itest/verify-agreement.ts packages/runner/itest/verify-agreement.test.ts packages/runner/itest/mutant-equality.ts`.
- [ ] **Step 7: Commit** `test(itest): compare lethal verify to a fresh full run per mutant (C02-08)`.

### Task 2: The scratch suite: the committed tests plus the answer key

**Files:**
- Modify: `packages/runner/itest/verify-agreement.ts` (add `writeScratchSuite`)
- Modify: `packages/runner/itest/verify-agreement.test.ts`

**Interfaces:**
- Produces:

```ts
/** The five answer-key tests renumbered into the tests app's range. */
export const SCRATCH_ANSWERS = { codeunitId: 79574, codeunitName: "Harden Verify Answers" } as const;
/** Copies `testsDir` (including .alpackages) to `dest`, then writes the answer key's codeunit into
 *  `dest/src/HardenVerifyAnswers.Codeunit.al` with its header rewritten to SCRATCH_ANSWERS. Leaves
 *  app.json byte-identical (same app id, name, version: publishing it REPLACES the committed suite,
 *  which is why the gate restores). Throws when the header to rewrite is not found exactly once, or
 *  when any [Test] method name occurs in two codeunits of the result (killingTest is compared by
 *  method name). Returns the discovered test refs. */
export async function writeScratchSuite(testsDir: string, answersFile: string, dest: string): Promise<TestMethodRef[]>;
```

Why renumber and rename: the answers app declares 79575-79599, outside the tests app's `idRanges` (79550-79574), so the file cannot be added unchanged. The answers app stays published on Cronus28 under its own name `Harden Answer Key`; a second codeunit with that name could collide at publish (not measured, so avoided).

- [ ] **Step 1: Failing tests:** `"C02-08: the scratch suite holds the six base tests and the five answer tests, all names unique"` (runs `writeScratchSuite` on the real fixture dirs into `mkdtemp`, then checks the discovered refs: 11 tests, five under codeunit 79574 `Harden Verify Answers` with the F3 method names, `app.json` bytes equal the committed one); `"C02-08: a duplicate method name across codeunits throws"` (a temp copy where the answers file also declares `IsLargeSeparatesSmallFromLarge`); `"C02-08: a missing header throws"`.
- [ ] **Step 2:** Run, see FAIL.
- [ ] **Step 3:** Implement with `cp(..., { recursive: true })`, one `replace` of the exact header line `codeunit 79575 "Harden Answer Key"` (count occurrences first; not exactly 1 throws), `discoverTests(dest)`.
- [ ] **Step 4: Offline compile.** Write the scratch suite into a temp dir and compile it with the `al-compiler` subagent (its `.alpackages` must hold the target's `.app`, which the copy carries). Expected: 0 errors. This is the only proof before the live run that the renumbered codeunit builds.
- [ ] **Step 5:** Run the tests, PASS. Red-check: remove the duplicate-name check, see the duplicate test go red, restore.
- [ ] **Step 6:** Full loop and biome on the two files. **Commit** `test(itest): the scratch suite C02-08 verifies with (base tests plus answer key)`.

### Task 3: The pre-commitment spec, committed alone

**Files:** Create `docs/superpowers/specs/2026-09-26-c02-08-agreement-precommitment.md` (use the date it is actually written, keep the rest of the name).

It opens with: "Committed ALONE, before the first live run of `LETHAL_ITEST_AGREEMENT=1 bun run itest:agreement`. Every prediction below is a gate assertion: any one failing exits 1. A differing verdict or killer is a BLOCK, never close enough." It names the target (Cronus28), the fixture versions from `app.json`, the control app and the plan. Then, written from Task 0's re-checked facts and never from a live run:

- **The five mutants,** by `(file, line, operator, procedure)` from `EXPECTED` and by identity key read from `harden.baseline.json` (a key suffix per row, as C02-06's spec does), each with its frozen verdict `survived`.
- **Step 1, source run `A`:** `runSession(sandbox-harden, sandbox-harden-tests)` into a fresh temp store with the fixture's marks; per mutant equal to `harden.baseline.json` (`diffMutants`, zero diffs); `assertHardenVerdicts` and `assertHardenMarks` pass; 21 deployed, 16 / 5 / 0; one batch; all five planted in the last `artifacts[]` batch; no quarantine.
- **Step 2, scratch suite:** the 11 tests listed by qualified name.
- **Step 3, verify:** through `verifyFromCli` with `--db <A's store> --artifact <A's last artifact> --tests <scratch> --survivors <S1..S5 ids>`:
  - exit **0**, `ok: true`, `refused` and `quarantined` absent;
  - `newTests`: exactly the five `Harden Verify Answers.*` tests, `codeunitId` 79574, each `state: "stable"`, two runs `pass` and `fresh`, two different `sessionId`s;
  - S1: `killed`, `killingTest` `{ 79574, "Harden Verify Answers", "IsLargeAtTheBoundary" }`, `killedByNewTest: true`, `killedBy: "other"`, `killingTestFailure` contains `IsLarge(100) should be false, got true`;
  - S2: `killed` by `CountInCategoryIgnoresOtherCategories`, text `CountInCategory(A) should be 2, got 3`;
  - S3: `killed` by `FirstAmountReadsTheFirstRow`, text `FirstAmount() should be 7, got 9`;
  - S4: `killed` by `SetAmountRunsValidation`, text `SetAmount(Entry, 5) should leave Doubled 10, got 0`;
  - S5: `skipped`, `reason: "reader-marked-equivalent"`, `mark.key` equal to the committed mark's key;
  - no row carries `invalidBaseline`; `counts` `{ killed: 4, survived: 0, error: 0, skipped: 1 }`;
  - `BcDevMcpBackend.prototype.publishTestApp` called exactly **1** time during the call; `testApp.sha256` equals a fresh read-back; at least one lease acquire observed; no new quarantine record; a lease acquire right after succeeds.
  - `testApp.name` and `testApp.version` equal the scratch copy's `app.json` (which is the committed tests app's identity, unchanged), so the app verify published is the scratch suite, stated rather than inferred.
  - For each kill, the one-line reason the mutant differs on that input (S1: `>=` makes 100 large; S2: without `SetRange` the `B` row counts; S3: `FindLast` reads Amount 9; S4: a plain assignment skips `OnValidate`, so `Doubled` stays 0).
  - The `killingTestFailure` texts are pre-committed HYPOTHESES read from the answer key's AL, not from a live run. A mismatch is a BLOCK like any other. If C02-03's answers leg has logged `killingTestFailure` for K1 to K4 by the time this spec is written, the spec quotes that evidence beside each hypothesis; it is never used to correct a prediction after C02-08 runs.
- **Step 4, fresh full run `B`:** `runSession(sandbox-harden, <scratch>)` into a NEW temp store file (asserted absent before the run), no `resume`, the fixture's marks. `assertFreshFullRun` passes (no `resumed` in `validity.caveats`, no `resumedFrom`, no carried mutant). `B.baselineGreen` is `true`, `B.staleTestApp` is absent (so the server ran the scratch suite verify published, all 11 tests present), `B.validity.reliability` is `"full"`. 21 deployed; per mutant: the 16 leg-A killed rows `killed` (killer not asserted, Open question 5), S1 to S4 `killed` by the four answer methods above, S5 `survived` with `readerMark` equal to the committed mark and `readerMarkedEquivalent` `{ matched: [S5], stale: [], contradicted: [] }`; `likelyEquivalentSurvivors` lists S5 only; counts 20 / 1 / 0; no quarantine.
- **Step 5, agreement:** `compareVerifyToFullRun(verify, A, B)`: five rows, all `agree: true`, zero diffs. Negative control `compareVerifyToFullRun(verify, A, A)`: exactly four diffs, one per S1 to S4 id, each reading `verify killed by <K method>, full run survived`; those four rows `agree: false`, S5's row `agree: true`. This live-controls a VERDICT difference only; a wrong killer and a stale mark are controlled offline (Task 1 cases b, c, d, o, p).
- **Step 6, ratio (owner ruling: record now, gate later):** `verify.timings.totalMs / B.timings.totalMs`, printed with both numbers, and also against `A` (A is colder, so it is printed, not gated). GATED: `verify.timings.totalMs < B.timings.totalMs`. RECORDED, not gated: the ratio against 0.20, with `ABOVE the epic's 20% line` printed when it is. The PREDICTION, stated before the run: above 0.20 on this fixture. Evidence, all on `sandbox-app`: 0.389 (C02-06b run 2, warm), 0.351 (orchestrator, merged tree 06805a0, 3297 / 9384 ms), and 0.148 (C02-06b run 1, cold denominator), plus Task 0's leg A timings; verify does more work here. A ratio below 0.20 would also be reported, not celebrated: it would most likely mean a cold denominator. Either way the epic's 20% criterion stays OPEN (Task 7).
- **Step 7, restore:** the committed `sandbox-harden-tests` compiled and published; fresh read-back hash equals the compiled hash. After EACH agreement run, `itest:harden` passes unchanged (S1 to S4 `survived` again), which is the runtime proof the answer tests left the server.
- **Not exercised live:** a verify `error` row, a `skipped` row against a stale mark, a wrong killer in `B`, a resumed `B`. All four are pinned offline in Task 1.
- **The stop rule:** any difference from the lines above is reported to the owner with the per-mutant table. Nothing above is edited after commit; a correction is appended.

- [ ] **Step 1:** Write it. Self-check: every assertion in Task 4's list appears here, and nothing here is missing from Task 4.
- [ ] **Step 2: Commit it ALONE:** `spec(C02-08): pre-commit verify-vs-full-run agreement on sandbox-harden before its first live run`.

### Task 4: The gate, `itest:agreement`

**Files:**
- Create: `packages/runner/itest/verify-agreement.itest.ts`
- Modify: `package.json` (`"itest:agreement": "bun packages/runner/itest/verify-agreement.itest.ts"`, after `itest:verify`)

Base it on `verify.itest.ts` (the env gate, the config reads, `validateBcDevConfig`, the backend construction, the BC-build and control-version lines printed first, the lease spy on `LeaseClient.prototype.acquire`, `verifyFromCli` driven with a captured writer, the quarantine-dir diff, the step-3/step-4 `try` and error-joining shape). Changes:

- `LETHAL_ITEST_AGREEMENT`, `emitSkipped("agreement", ...)`, `emitPassed("agreement", { sublegs: ["agreement"], artifacts: { reported: false } })`, `emitFailed("agreement", ...)`.
- `PROJECT_DIR = fixtures/sandbox-harden`, `TEST_DIR = fixtures/sandbox-harden-tests`, `ANSWERS_FILE = fixtures/sandbox-harden-answers/src/HardenAnswerKey.Codeunit.al`, `BASELINE_PATH = harden.baseline.json` (read only; never call `assertMatchesBaseline`, which writes a missing file), `SELECTOR_IDS = { selectorId: 79547, controlId: 79548, tableId: 79549 }` and assert they equal the config's `selectorIds` before anything runs (R261: verify reads the config, the full run reads this constant; they must be the same).
- A second spy, on `BcDevMcpBackend.prototype.publishTestApp`, counting calls, installed the same way as the lease spy.
- `runSession` gets `equivalenceMarks: await loadEquivalenceMarks(PROJECT_DIR)` in both full runs, and NO `resume` key. Each full run gets its OWN `mkdtemp` store directory. Before `B`, assert its store file does not exist.
- Five planted ids: for each `EXPECTED` row with `planted`, find exactly one mutant of `A` by `file`, `line`, `operatorName`, assert it is in `A`'s last `artifacts[]` batch, and build `<batchIndex>/<mutantCode>`.
- The steps, in order, with each assertion of the Task 3 spec:
  1. `A`; close its store before verify opens it (as `verify.itest.ts` does).
  2. `writeScratchSuite(TEST_DIR, ANSWERS_FILE, <scratch>/tests-with-answers)`.
  3. verify; record `verifyMs = out.timings.totalMs` and the spy counts.
  4. `B`, only if step 3 passed. `assertFreshFullRun(B)`; `B.baselineGreen === true`; `B.staleTestApp === undefined`; `B.validity.reliability === "full"`; then the per-mutant table: build it from `EXPECTED` (planted S1..S4 become `killed` by `ANSWER_KILLERS`, S5 stays `survived`, every other row `killed` with no killer assertion), matched by `file`, `line`, `operatorName`, and fail on any unpredicted mutant.
  5. `compareVerifyToFullRun(out, A, B)` (zero diffs AND every row `agree`) and the negative control on `(out, A, A)` (the four diffs by id and content, S5 `agree`).
  6. The ratio, per the owner's ruling: assert `verifyMs < B.timings.totalMs`; print the ratio and whether it is above 0.20; never fail on 0.20.
  7. Restore, in a `finally` once step 3 began. Keep BOTH errors: the gate's own failure (from any of steps 3 to 6) and the restore's failure are collected separately and thrown together, each with its stack, in the shape `verify.itest.ts` uses for its steps 3 and 4. A restore failure never hides the original one, and a passing restore never hides it either. Pick the store whose artifact is resident: `B`'s if step 4 finished its deploy, else `A`'s (establish which artifact is resident with the merged read-back `DeploymentVerifier.verify({ appId, artifactId })`, the check `BcDevMcpBackend.attach` uses, run for candidate `B` and then candidate `A`; exactly one must be accepted. `HarnessVerifier` does not report the target artifact and `artifacts[]` records what a run published, not what is resident, so neither may decide this. If neither or both are accepted, or `B` is partly deployed or unrecorded, do not publish: fail with the manual recovery text below. Orchestrator erratum after review r2). Compile `TEST_DIR` with `backend.compileTestApp(TEST_DIR, artifact)` and publish it inside one `runNamedMutants` call's `inLease`, exactly as `test-app-publish.itest.ts` step 7 does (a new unfinished run row; one request: the resident run's S1 code with methods `[Harden Tests.IsLargeSeparatesSmallFromLarge]`, expected `survived`). Then assert the fresh read-back hash equals the compiled hash. On failure print: "The container may carry the scratch test app. Republish fixtures/sandbox-harden-tests by hand (C02-03 plan Task 5 step 3, dev endpoint) and see itest:harden pass before any other gate." This restore is a checked attempt, not a guarantee (a partly deployed `B`, or no nameable resident artifact, can leave the scratch app behind); manual repair is REQUIRED after any restore failure, and Task 5's `itest:harden` runs are what prove the state.
- Print the per-mutant agreement table (id, key suffix, verify, full, agree), then totals, then the ratio line.

- [ ] **Step 1:** Write the gate and the script entry.
- [ ] **Step 2:** Typecheck, clean dist, `bun test` (the gate is not a `bun test` file), biome on the touched files.
- [ ] **Step 3:** `bun run itest:agreement` with the env var UNSET: prints the skip line, exits 0.
- [ ] **Step 4: Commit** `test(itest): itest:agreement, verify against a fresh full run on sandbox-harden (C02-08)`.

### Task 5: Live run (lane, under the lease)

From the main checkout `U:\Git\LethAL` (only it holds the gitignored configs), after Tasks 0 to 4 are merged there and the Task 3 spec is committed. Foreground, one gate at a time, never polled.

- [ ] **Step 1:** `pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus28`. Stopped: `coord ask`, never start it. Then `coord lease Cronus28 code`; heartbeat every 5 minutes.
- [ ] **Step 2:** Confirm the control app on Cronus28 meets `MIN_CONTROL_VERSION` (Task 0 step 6) and that `fixtures/sandbox-harden/lethal.config.local.json` names Cronus28 only.
- [ ] **Step 3:** `LETHAL_ITEST_HARDEN=1 bun run itest:harden`. It must PASS unchanged. This proves the starting state: the committed suite is the one on the server.
- [ ] **Step 4:** `LETHAL_ITEST_AGREEMENT=1 bun run itest:agreement`. Keep the full output. Any failure: BLOCK. Report the per-mutant table to the owner and change nothing. If the prediction itself was wrong (as C02-06's run 1 was), the diagnosis goes in a file under `.superpowers/`, and the correction is APPENDED to the spec in its own commit before any second run.
- [ ] **Step 5:** `LETHAL_ITEST_HARDEN=1 bun run itest:harden` again. It must PASS unchanged: the runtime proof the restore worked.
- [ ] **Step 6:** Run `itest:agreement` a SECOND time. Every verdict and every S1..S4 killer must repeat. The ratio is recorded for both runs.
- [ ] **Step 7:** `LETHAL_ITEST_HARDEN=1 bun run itest:harden` a THIRD time. It must PASS unchanged: the runtime proof the second run's restore worked too. If any `itest:agreement` run failed its restore, do the manual repair first and say so in the submit note.
- [ ] **Step 8:** Release the lease.

### Task 6 (only if the owner keeps C02-03 ruling 3): register the gates in the agentflow table

**Files:** Modify `scripts/agentflow/gate-table.ts`, `scripts/agentflow/gate-table.test.ts`, and read `scripts/agentflow/tick.ts` for every use of `LEG_CONTAINER`.

- [ ] **Step 1:** Widen `LEG_CONTAINER`'s value type with `"cronus28"`. Add `"harden"` and `"agreement"` to `LEGS`, `LEG_ORDER` (before `hang`, which is terminal) and `LEG_CONTAINER` (`"cronus28"`). Not to `FULL_SET` unless the owner says so (unmatched changes would then need Cronus28).
- [ ] **Step 2:** One rule: `startsWith("fixtures/sandbox-harden/", "fixtures/sandbox-harden-tests/", "fixtures/sandbox-harden-answers/")` selects `["harden", "agreement"]`; a second: `isOneOf("packages/runner/src/verify.ts")` selects `["agreement"]` plus whatever it selects today.
- [ ] **Step 3:** Tests in `gate-table.test.ts`: a change to each of the three fixture directories selects both legs; an answers-only change still selects them; `tick.ts` still type-checks. Red-check: drop the answers prefix, the answers-only test goes red.
- [ ] **Step 4:** Full loop. **Commit** `feat(agentflow): register harden and agreement on Cronus28 (C02-08)`.

### Task 7: Roadmap and submit

- [ ] **Step 1:** `ls docs/roadmap/` immediately before writing. File what applies, one file each from `_template.md`, citing names only:
  - ALWAYS (owner ruling), whatever the ratio: `section: "product-gaps"`, status `open`, title "The epic's 20% verify wall-time criterion (c02) is recorded but not gated: C02-08 measured it on sandbox-harden and left it open". Body: the ruling (record now, gate later); both agreement runs' ratios with numerators and denominators; verify's `compileMs` and `publishMs`; the `sandbox-app` figures 0.389, 0.351 (3297 / 9384 ms, merged tree 06805a0) and 0.148 (cold denominator); why a small fixture's full run does not dwarf verify's fixed costs; and what would close it (a gate at 0.20 on a fixture or campaign project large enough to measure scaling, with a warm denominator);
  - if Open question 3 defaults to OUT: one item "harden, verify, testapp and agreement are not in the agentflow gate table, because `LEG_CONTAINER` cannot name Cronus28".
- [ ] **Step 2:** `bun scripts/roadmap-index.ts`, then `bun test scripts/roadmap-index.test.ts scripts/line-citations.test.ts`. **Commit** `roadmap: R<n> ... (C02-08)`.

**Submit note must say:** every red-check with its red and restored-green line; that the spec was committed alone before run 1 (its commit id); both live runs' full output, including the BC build and control-version lines, the per-mutant agreement table, the negative control's four diffs, both ratios with their numerators and denominators; `itest:harden` before, between and after; any restore failure and its manual repair; the lease taken and released; the roadmap ids filed; that the gate reuses `campaign compare`'s identity principle and does not run `lethal campaign compare`; that no baseline file was written and `CLAUDE.md` was not edited (the owner adds the `itest:agreement` line after acceptance). And, in these words: **"The epic's 20% wall-time goal was NOT met or gated by C02-08. The ratio was recorded (<r1>, <r2>) and the criterion stays open as R<n>."**

**The closing comment on #18** (posted by whoever closes it, drafted in the submit note) must carry the same sentence, first, before any "done": **"Not met: the epic's 20% wall-time goal. C02-08 recorded the ratio (<r1>, <r2>) and did not gate it (owner ruling: record now, gate later); it stays open as R<n>."** Then: per-mutant agreement on all five survivors, one test-app publish, 4 killed / 1 skipped, the spec and gate paths.

## Out of scope, on purpose

- **Changing `lethal verify` or `runSession`.** This task measures them. A defect found is filed and reported, not fixed here.
- **A committed baseline for the post-verify full run, or a campaign stage** (Open question 2).
- **R247's fix.** The gate avoids a resume; it does not make resume safe.
- **Agent-side test synthesis and the equivalence ruling.** The answer key stands in for the agent's tests; the mark is C02-03's.
- **An al-runner leg.** Verify runs on bcdev only.

## Self-review

- Spec coverage: agreement per mutant (Task 1, 4, 5), ONE publish (spy, Task 3/4), 4 killed / 1 skipped (Task 3), fresh later full run (Task 1 cases h1 to h4, Task 4), wall-time ratio recorded and the 20% criterion left open (Open question 1, Task 3/4/7), fixture 3 = `sandbox-harden` (Task 0).
- Every live assertion has an offline red-check (Task 1, 2) or a live negative control (Task 3 step 5); the restore has a runtime proof (`itest:harden` after each agreement run).

## Review responses (review r1, `H:/lethal-coord/reviews/C02-08-plan/review-r1.md`)

| Finding | Response |
|---|---|
| Critical: `ratio < 1.0` can pass while the 20% requirement fails | Owner ruled before the Task 3 spec: record now, gate later. The gate asserts per-mutant agreement and verify < full run; the ratio is recorded against 0.20; the 20% criterion stays OPEN as a roadmap item filed unconditionally (Task 7); the submit note and #18's closing comment say plainly it was NOT met or gated. The 0.351 figure (3297 / 9384 ms, merged tree 06805a0) is cited. Open question 1, Global Constraints, Task 3 step 6, Task 4 step 6, Task 7. |
| Important: freshness check reads `full.caveats`, which does not exist | Fixed: `assertFreshFullRun` reads `validity.caveats`, `resumedFrom` and `mutants[].carried`, each independently; case (h3) is a resumed report with zero carried mutants and no caveat; red-checks 7, 7b, 7c. Task 1. |
| Important: a wrong join can print `agree: true` | Fixed: the identity check is part of `agree` (the row is `agree: false`, a diff is pushed, the loop continues); case (j) asserts both the diff and `row.agree`; red-check 6b restores the r1 shape and goes red. Task 1, "What agreement means". |
| Important: Task 0 must separate a changed prediction from a moved frozen figure | Fixed: Task 0 step 3 reconciles C02-03's spec, `EXPECTED`, committed baseline and live history, and classifies each difference as Kind 1 (changed prediction, erratum allowed) or Kind 2 (result contrary to C02-03's frozen spec, or records disagree): STOP for the owner, nothing adopted. The dependency note now says the lane worktree has Task 2 in progress uncommitted (`harden-expected.ts`, a one-mark `lethal.equivalent.json`) and that this is not a hand-off. |
| Sound, add join cases | Added (l) renumbered codes across A and B (and the base scene renumbers B), (m) same hash in different procedures, (n) ordinal twins, with red-checks 8, 9, 10. |
| Sound, `campaign compare` wording | Open question 2 and the submit note say the gate reuses `campaign compare`'s identity principle and does not run it; its join (one hit per key) differs from `diffMutants`' per-key multiset on purpose. |
| Negative control proves only verdict differences | The spec and plan now claim only that. The four diffs are checked by id AND content, S5 `agree` is checked, offline case (k) pins the same content, and wrong-killer and stale-mark are covered offline by tampered-`B` cases (o) and (p). |
| Hand-off correction | Accepted. The code lane confirmed it on master and changes only C02-03 Task 6's README; Task 0 step 4b only checks it and reports, never edits. |
| Restore is a checked attempt | The plan says so; both the original failure and the restore failure are kept and thrown together; manual repair is required after a restore failure; `itest:harden` runs after BOTH agreement runs (Task 5 steps 5 and 7). |
| Predictions are hypotheses | Task 3 labels the `killingTestFailure` texts as pre-committed hypotheses, quotes C02-03's answers-leg evidence if it exists, never corrects after the run; `B.baselineGreen`, absent `staleTestApp`, `validity.reliability: "full"` and the published scratch app's name and version are now explicit assertions. |
- Names used across tasks: `compareVerifyToFullRun`, `assertFreshFullRun`, `AgreementJoinError`, `writeScratchSuite`, `SCRATCH_ANSWERS`, `keyOf`; all defined in Task 1 or 2.
