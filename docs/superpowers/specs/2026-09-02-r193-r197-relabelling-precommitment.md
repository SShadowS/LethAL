# Pre-commitment: R193 (identity ordinal) and R197 (kill-first test order), one re-record

Written and committed BEFORE the live gates run. Nothing above the OUTCOME line is edited afterwards.
Machine-checkable half: `scripts/r193-r197-baseline-proof.ts`, run over each gate's OLD baseline and
the NEW report.

## 1. What changes, and what must NOT

Two changes that both touch the per-mutant baselines, landed together so the baselines re-record
once.

**R193.** `MutantManifestEntry.identityOrdinal`: a mutant's position, in source order, among the
mutants of its artifact that share its five-part identity tuple. `serializeKey` appends `|<n>` only
when `n > 0`. A mutant with no twin keeps the exact key it had.

**R197.** A mutant's covering tests are tried in the order: tests that already killed in the same
procedure this session (most kills first), then fewest members covered at baseline, then fastest
at baseline, then name. Before, they ran in coverage-index order.

**Verdicts do not move.** Neither change touches what a test does to a mutant. R193 relabels
keys. R197 changes which of several killing tests is MET first, so `killingTest` can change where
more than one test kills; a kill is still confirmed against the baseline, and a survivor still runs
every covering test.

## 2. Predicted baseline diffs, per gate

Measured offline from the committed baselines before any run:

| gate | entries | colliding keys today | mutants in them |
| --- | ---: | ---: | ---: |
| tables | 377 | **6** | **12** |
| bcdev | 19 | 0 | 0 |
| al-runner | 19 | 0 | 0 |
| envtool | 19 | 0 | 0 |

So:

- **tables**: exactly the 6 colliding keys split. Each group of size `n` becomes `n` distinct keys
  (`K`, `K|1`, …, `K|n-1`). Every other key is byte-identical. The multiset of verdicts over each
  split group equals the old group's multiset. `killingTest` may change on killed mutants; each
  change is listed, not hidden, and the count is reported.
- **bcdev, al-runner**: no key changes at all. Only `killingTest` may change, on at most the 3
  kills each gate has.
- **envtool**: NOT re-recorded. The environment was deleted 2026-09-01 and the gate cannot run. Its
  baseline stays the 2026-08-28 measurement. Since R197's last tie-break is baseline DURATION, which
  differs between a hosted environment and a container, its `killingTest` values may legitimately
  differ from `itest:bcdev`'s after this change, and the two tables can no longer be asserted
  identical by copying. The next live envtool run must expect `killingTest`-only differences,
  delete the baseline and re-record it; anything else there is a regression.

The frozen aggregate figures are unchanged everywhere: tables 299/63/15 over 377, bcdev 3/12/4,
al-runner 3/16/0.

## 3. The proof script

`scripts/r193-r197-baseline-proof.ts <old-baseline.json> <new-report.json>` asserts:

1. every key in the old baseline that is not a colliding key appears in the new report's
   normalised set exactly once, with the same verdict;
2. every colliding key `K` of size `n` in the old baseline appears in the new set as `K`, `K|1`,
   …, `K|n-1`, and the verdict multisets agree;
3. no other key appears or disappears;
4. `killingTest` changes are counted and listed by mutant, and every changed one is on a mutant
   whose verdict is `killed` on both sides.

Exit 1 on any of 1 to 3 failing. Item 4 is a listing, since a changed killer is legitimate by
construction (see §1) and the number is what a reader wants.

## 4. What refuses this build

- Any verdict differing for any mutant on any gate.
- A key changing that is not one of the 6 colliding tables keys, or a colliding key splitting into
  the wrong number of parts.
- Aggregate figures moving.
- The al-runner gate is the one that can show R197 changing verdicts if the order ever mattered to
  al-runner's shared-session runner (R57's class); it must stay 3/16/0.

## 5. What is NOT claimed

- That the order saves time on the fixtures: sandbox-app's 3 kills and sandbox-data's 299 sit in
  small suites where the killer is usually first already. The saving was measured on real code
  (R197's row) and is not re-measured here.
- Anything about `envtool`, see §2.

---

## OUTCOME

**PASS, on the second tables run. Every §4 refusal condition held; §2's predictions held exactly
for keys and aggregates; and the first run refuted a claim §1 made about R197, which is recorded
here rather than edited away.**

### The refutation, first

§1 called R197's order "deterministic by construction". The tables gate's own two-pass determinism
check (R9) refused the first re-record: ten `killingTest` values differed between two consecutive
runs of one invocation. The third sort key was baseline DURATION, and a test's duration differs
between two runs of the same test, so where two tests both killed and covered the same members the
run picked whichever was faster that time. The key was removed (`test-order.ts`: kills, then
narrowness, then name; every input a function of verdicts and coverage), the unit test that had
asserted "faster first" now asserts "name decides, never a duration", bcdev and al-runner were
re-recorded under the fixed order (byte-identical to the committed files), and the tables gate was
run again. That run passed both determinism passes.

### The proof, per gate

| gate | old entries / keys | new entries / keys | keys split | verdict changes | `killingTest` changes | gate |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| tables | 377 / 371 | 377 / 377 | **6 over 12 mutants** | **0** | 7, listed by the script | PASS, 299/63/15 |
| bcdev | 19 / 19 | 19 / 19 | 0 | 0 | 0 | PASS, 3/12/4 |
| al-runner | 19 / 19 | 19 / 19 | 0 | 0 | 0 | PASS, 3/16/0, on al-runner **2.10.0.0** |
| envtool | not run | | | | | see §2; note added to `UNVERIFIED_MOVES` and CLAUDE.md |

The seven tables `killingTest` moves are all kills with more than one killer: four in `Data
Shadow` (`ShadowedBuiltinsRun` -> `SelfShadowedRun`), two in `Data Trigger Probe.OnValidate`
(`ValidateRunsTheFieldTrigger` -> `ImplicitValidateRunsInsideTheTable`), one in `Data Swap
Ops.PrimaryStamp` (`WeakStampAssertionMissesTheSwap` -> `LinkedPairIsStamped`). Each new killer is
either the narrower test or a test that had already killed in that procedure, which is the order's
rule; none is a verdict.

### What else the gates found

al-runner had moved to 2.10.0.0 and prints no provisioning sentence on a warm cache, so the
R147 pin had nothing to read and the gate refused on `platformAppsDir`. Not this change's doing,
verdicts identical, filed and fixed as [[R200]] in its own commit.
