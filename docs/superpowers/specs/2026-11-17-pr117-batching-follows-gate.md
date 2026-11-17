# PR-117 pre-commitment (R1109): baseline batching follows the al-runner update gate

Coord PR-117 (lethal-code, 2026-11-17). Base: PR-115 (`2026-11-17-pr115-baseline-batching.md`, master cd2f36ce).

Spec-adversary r1 is folded in:
- **HIGH-1:** DBM must have batched and passed before anything is recorded.
- **M-1:** refresh drops old readings.
- **M-2:** a failing alone reference stays a gate-fail.
- **M-3:** no candidate rule; DBM reads its own record.
- **The lows.**

## Today
- **The switch:** `baselineBatchingOffReason` allows batching only for builds in `V3_BASELINE_BATCHING_BUILDS`, a hand list (edge-4ebfe7913).
- **The gap:** when edge moves `current`, batching turns off until someone edits the list.
- **Leg C:** any capability reading other than `matches` fails the gate, and `unmeasurable` is an infra-fail.
- **Leg DBM:** it is the only leg that runs a batched baseline, and it is not in `V3_GATE_LEGS`. So a receipt can say `pass` while DBM
  failed (`gateOutcome`).

## The change
1. **DBM tests batching on every gate run, through the seam.**
   - DBM sets `seams.baselineBatching = true` on its daemon backend exactly when ALL hold:
     - this run's leg C read all 8 capability facts `matches`;
     - the DBM backend's own fresh probe did too;
     - the Sleep rule is retired.
   - **If leg C and the DBM backend's probe disagree,** DBM is an infra-fail (`V3LegEnvironment`) and names both readings.
   - **If leg C was not among the selected legs,** DBM says so by name and runs unbatched.
   - **Forced on:** DBM requires 2 requests, and a per-mutant table equal to the one-shot session's.
   - **Otherwise:** it requires 4 requests and prints why.
2. **The record: `batchFacts`, written only from a gate that proved batching.**
   - The receipt carries `batchFacts` (leg C's 8 readings) and `dbmBatched: true` only when DBM passed with 2 requests.
   - On a pass, the update script writes `batchFacts` into `.gated`, and into the ledger row (`GatedBuildEntry`, `GATED_BUILD_KEYS`),
     only when the receipt has `legs.DBM === "pass"` and `dbmBatched === true`. Otherwise it writes none.
   - DBM stays outside `V3_GATE_LEGS`: a batching failure costs speed, never the build.
   - **`--refresh-rows` (M-1):** it strips the old `batchFacts` along with `warnFacts` (`refreshRows`'s `rest`), and writes only this
     refresh gate's, under the same rule. `onRefreshPass`'s type carries them.
   - **Parsing:** `parseGated`, the manifest path in `checkV3Gated` and `gatedBuildFault` read and check them, keeping only
     `matches`/`diverged`/`unmeasurable`. Rows without the field parse unchanged.
3. **Never inherited (PR-115 H1).** `batchFacts` come only from the receipt of the gate that writes the record:
   - a `--regate`, rejudge or refresh whose receipt does not qualify writes none, even when the old record had them;
   - they are never read through `readingsFrom` or a pin;
   - `v3ReadingsDigest` is unchanged.
4. **Leg C: a capability fact that reads `diverged` only in its batch half passes (M-2).**
   - Each capability judge reports its alone reference separately, as a new optional fact field
     `reference: "pass" | "fail" | "none"`. `classifyLegC` takes `V3_CAPABILITY_FACTS`, as it takes `warns`.
   - A capability fact that reads `diverged` with `reference === "pass"`: leg C prints
     `al-runner-v3-baseline-batching-off: <fact>: diverged (<measured>)` and passes. The build is recorded with that reading and never
     batches.
   - `reference === "fail"` (the single request itself is wrong): gate-fail, as today.
   - `reference === "none"` is unmeasurable: infra-fail.
   - `unmeasurable` and `unlike-bc` behave as today.
   - A unit test pins that no `V3_BUILD_PINS` `legC` has a capability key (a pin-mismatch would turn a passing `diverged` into
     `held`).
5. **The switch is the build's own record.** `V3_BASELINE_BATCHING_BUILDS` is deleted, and there is no candidate rule (M-3). A
   session batches only when ALL hold:
   - its own record (`.gated`, or the manifest row) has `batchFacts` with all 8 facts `matches`;
   - its own probe reads all 8 `matches`;
   - the Sleep rule is retired.

   Off reasons, by name:
   - `this build's gate record (lethalCommit <sha>) has no batchFacts`;
   - `<fact> not recorded`;
   - `the gate read <fact> <reading>`;
   - the probe and Sleep reasons, as today.
6. **The update log, on every pass,** says `gate record allows baseline batching` or
   `gate record does not allow baseline batching (<reason>)`. It is computed from what it wrote, plus the pin half of the Sleep
   rule (`findV3Pin(...).legC["sleep-is-noop"]`).
7. **DBM also checks the accessor.**
   - **Non-candidate:** DBM reads its own record with `checkGated(BIN, ...)`, computes the expectation from that record, its probe
     and the Sleep rule, and asserts that `isBaselineBatching()` of a fresh backend WITHOUT the seam equals it.
   - **Candidate:** it asserts false (a candidate has no record).

## Scope, stated
- **Release rows** (alpha.13, alpha.14) get `batchFacts` only through a `--refresh-rows` gate. Until then, a user on a release never
  batches (speed only).
- **A build that cannot measure the facts** stays an infra-fail, as since PR-114.

## Transition
- **Current's `.gated`** (edge-4ebfe7913, lethalCommit 4fcfaa92) has no `batchFacts`. After merge, sessions on `current` do not
  batch until it is re-gated.
- **The regate is already due:** PR-114 and PR-115 moved `PINS_FILE` since 4fcfaa92. But `gatedWithAllLegs` runs only when edge moves.
  So lethal-bugs is asked to run `--regate <master commit>` right after merge.
- **That regate's DBM** batches through the seam. On a pass it records `batchFacts`, and the log says
  `gate record allows baseline batching`.

## Predictions (pre-committed)
- **0 verdict moves.**
- **`itest:alrunner-v3` on the PR head** (non-candidate, current = edge-4ebfe7913, no `batchFacts` in its record) PASSES. Every pin and
  verdict is unchanged.
  - Leg C: 36 facts, the 8 capability facts `matches` with `reference: "pass"`.
  - DBM: forced on by the seam (leg C and its probe 8 `matches`), 2 requests, the table 15/3/104 over 122.
  - The accessor check: `isBaselineBatching()` false, with the reason `has no batchFacts`.
  - The receipt: `batchFacts` (8 `matches`) and `dbmBatched: true`.
- **After merge, the regate:** `.gated` gains `batchFacts`, and the log line says it allows batching. A session on `current` then
  prints `baseline batching (PR-115): N batch(es) kept`.
- **Unit tests, each red when its rule is reverted:**
  - **The accessor:**
    - on with a record of 8 `matches` (and the probe, and Sleep);
    - off with no record, with a fact not recorded, and with a fact `diverged` or `unmeasurable` in the record (each by name);
    - off when the probe alone reads 8 `matches` with no record (the M-3 red check).
  - **`classifyLegC`:**
    - capability `diverged` with `reference: "pass"` passes with the off line;
    - with `reference: "fail"` it gate-fails;
    - with `reference: "none"` it infra-fails;
    - a contract fact that reads `diverged` still gate-fails;
    - no pin's `legC` has a capability key.
  - **The capability judges:** a failing alone reference reports `reference: "fail"`.
  - **The update script:**
    - a qualifying receipt writes `batchFacts` into `.gated` and the row;
    - a receipt with `legs.DBM` not `pass`, or without `dbmBatched`, writes none;
    - a `--regate` with a non-qualifying receipt writes none although the old `.gated` had them;
    - `--refresh-rows` drops an old row's `batchFacts` when its receipt does not qualify;
    - the log line, both ways.
  - **`parseGated`, the manifest path and `gatedBuildFault`:** read the field, and drop a non-verdict value.
  - **r814:** digests unchanged.
