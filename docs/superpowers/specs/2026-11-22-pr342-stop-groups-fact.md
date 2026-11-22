# PR-342 pre-commitment: the leg-C capability fact `stop-groups` (what PR-256's `alRunnerV3.stopGroups` needs)

Status: pre-commitment (coord PR-342, lethal-preproc, 2026-11-22), after the build, before review and gates. Branch
`lethal/pr-342` (b499b8c31). Related: PR-256 (`2026-11-22-pr256-stop-groups.md`), upstream #8564 (stopGroup).

## The change
- **The fact.** `runV3ContractProbe` measures `stop-groups` in leg C of the update gate only. A normal session never
  measures it; PR-256 reads the gate's recorded reading from the record's `batchFacts`.
  - One serve daemon, invented AL (ids 50781-50785), three requests:
    1. the stop: group a's `50781.First` fails, so `50781.Second` and entry `50782` are skipped with the pinned text
       naming the failure; group b's `50783` still passes;
    2. a plain follow-up request on the same daemon (the daemon is still usable after a stop);
    3. a guard: a timeout row and a refusal row as the first failure (recorded only, never judged).
- **The judge** (`judgeStopGroups`):
  - `matches` only when the skips, group b and the follow-up all hold;
  - `diverged` when the build refuses the request (no #8564) or stops wrongly;
  - `unmeasurable` when there is no answer.
- **The gate rule** (`classifyLegC`): `stop-groups: diverged` never fails the gate; it prints the warning
  `al-runner-v3-stop-groups-off`. `unmeasurable` stays an infra-fail, as for every fact.
- **Fail closed.** PR-256's flag needs `matches`. A `diverged` build, whether it lacks #8564 or carries it but stops
  wrongly, leaves the flag refused, so a wrong stop can never reach a verdict. That is why `diverged` is non-blocking.

## Predictions
- **Leg C's fact count: 36 -> 37** (9 defect, 18 contract, 1 warn, 9 capability). `V3_LEG_C_FACTS` and its pin in
  `r586c-pins.test.ts` move together.
- **On `current` (main-bf3a3e863, which carries #8564):** `stop-groups: matches`. Any other reading is a BLOCK until
  explained.
- **On a build without #8564:** `stop-groups: diverged`, the gate does not fail, and leg C prints
  `al-runner-v3-stop-groups-off`. The warning is printed in leg C only, no other leg.
- **The itest receipt's `batchFacts`** gains the key `stop-groups`; no other key moves.
- **`v3ReadingsDigest` is unchanged:** the fact is a capability fact, outside the readings the digest covers.
- **`itest:alrunner-v3` (the full gate):** no per-mutant verdict, killing test, note set, refusal set or warning set moves.
  The fact runs only in the update gate's leg C.
- **The BC gates** (bcdev, lease, tables, chunked; legs from `selectLegs`): no figure moves. The diff touches no BC path;
  they run because `selectLegs` names them for `packages/runner/src`.

## Recording
lethal-bugs records the fact for main-bf3a3e863 with an update-gate run after merge (bugs owns the gate and its records).
PR-256's flag-on gates wait for that record.

## Amendment 1 (2026-11-22, the Opus build review, before any gate)
- **The record depends on DBM batching (review S1).** The update gate writes a build's `batchFacts` into `.gated` only when
  DBM passed and batched (`receiptBatchFacts` in `scripts/al-runner-v3-update.ts`). A build whose `stop-groups` matches
  but whose DBM does not batch gets no `batchFacts`, so PR-256's flag stays refused there. That fails closed; it is a named
  limit, not a fix in this PR.
  - Measured for main-bf3a3e863: its receipt has DBM `pass` and `dbmBatched: true`, and its `.gated` already carries
    `batchFacts` (the eight `batch-*` facts, all `matches`). So the recording plan above holds for `current`.
- **Review nits, fixed in the branch:** the itest comment's stale "36 facts ... 8 capability" count, and a test that a
  doubled skip row reads `diverged` (the exactly-one-row rule).
- **The predictions are unchanged.**

## Amendment 2 (2026-11-22, the merge with PR-340, before any gate)
PR-340 landed on master with its own new leg-C fact, `batch-sequential-carry` (`V3_CARRY_FACT`, outside
`V3_CAPABILITY_FACTS`, pre-committed `matches`), and took the count from 36 to 37 too. Merging master into `lethal/pr-342`
resolved `V3_LEG_C_FACTS = 37` with NO conflict, because both sides made the same edit. With both facts it is 38.
- **Leg C's fact count: 38** (9 defect, 18 contract, 1 warn, 8 capability, plus the two facts outside `V3_CAPABILITY_FACTS`:
  `batch-sequential-carry` and `stop-groups`). `V3_LEG_C_FACTS` = 38 and its pins move together. The old counts 36 and 37
  are gate-fail.
- **Daemons:** leg C's contract probe starts one daemon more than either side alone (serve-keep-reasons, the capability
  facts, the carry fact's, stop-groups'); the spawn guards count every one of them, and every one wraps `v3ChildEnv`.
- **The itest receipt's `batchFacts`** carries both `batch-sequential-carry` and `stop-groups`, next to the eight.
- **On `current` main-bf3a3e863:** `stop-groups` `matches` (as before), and `batch-sequential-carry` as PR-340 pre-committed
  it. No other leg-C reading moves.
- **`v3ReadingsDigest` is unchanged.**
- The gate re-runs on the merged head after PR-330 ends (CPUs 12-21 stay light until then).
