# PR-94 pre-commitment: send `runSelectedOnly` on serve requests whose entries are all whole or prefix-cut, so L4's cut stops running the tail (R1094)

Coord PR-94 (2026-11-16). Evidence: R1094 (lethal-preproc, PR-91's probe) and this spec's own probe (`/coord/handoff/PR-94/probe.ts`).

## The problem
PR-20's L4 cut (R1030) gives each mutant's entry an `excludeTests` list: every test of the codeunit after the mutant's last
covering test. The list also takes R998's left-out run. On v3 serve, `excludeTests` only HIDES rows: the excluded tests still run,
unless the request carries `runSelectedOnly: true` (v3 `run.rs`: `run_only` is set only by `runSelectedOnly` or by a selection
of exactly one method). On DO window t10, mutant entries reach 71% into their codeunit (23.4 of 33.0 tests), so about 29% of
the test execution in cut entries produces rows nobody reads.

## Measured facts this rests on
1. **A `runSelectedOnly` PREFIX gives exactly the full run's first rows** (R1094, `carry.ts`). The codeunit's OnRun runs, and
   the state flows forward as in the full run. A selection with a GAP really skips the missing test and changes what the later
   tests see, so only prefixes are sound.
2. **This spec's probe, two rounds, on the same daemon**:
   - an entry with NO `excludeTests` under `runSelectedOnly: true` still runs all 10 tests, the same rows as without the flag;
   - a request with `runSelectedOnly: true` holding one uncut entry and one suffix-cut entry gives the uncut entry all 10 rows
     and the cut entry exactly its prefix (T01-T04);
   - the flag is per request, on one daemon: preproc's probe alternated it on one daemon too.
   - Time: a suffix-cut entry alone took 55-90 ms against 120-160 ms for a full one.

## Every entry's excluded set is a suffix, except one case
- R998's `mutantLeftOutNames` is the trailing run of the codeunit's baseline order (al-runner-v3-backend.ts,
  `mutantLeftOutNames`): a suffix.
- L4's `cutAfterLastCovering` adds every test after the last covering test: a suffix. The union of two suffixes is a suffix.
- **The exception, #8059:** v3 matches `excludeTests` by name prefix, so a tail test whose name is a prefix of a test that must
  run is kept in. That entry then runs prefix + T with the tests between them excluded: a GAP.

## The change
- **A predicate on the request** (narrowed after the spec-adversary review, M1 and M2). The flag is set only when ALL of these
  hold:
  - at least one test entry in the request has a non-empty effective exclusion. A request of only uncut entries is never
    flagged: it would save nothing and only expose v3's shallow test scan, which misses a `[Test][Other]` attribute on one
    line (review M1);
  - for EVERY non-echo entry, the discovered test set of its codeunit equals its baseline test set, lower-cased (the cut's own
    precondition, review M2);
  - for EVERY non-echo entry, v3's EFFECTIVE exclusion is a suffix of the baseline order BY POSITION. The effective exclusion
    is every baseline or discovered name that an `excludeTests` entry is a lower-cased `contains`/prefix of, by v3's
    `matches` rule. "By position" means no kept test sits after an excluded one, and a duplicated name cannot hide a gap;
  - echo entries count as uncut.
- **Where the flag goes** (review L2): it is set in `send()` for prefetch and live requests only, never in `requestBase`.
  `plain()`'s baseline daemon and coverage windows use `leftOutNames`, which can leave a gap, so they are never flagged. An
  alone (R895) or isolated (R857) request keeps its own flag as today; its `call` entry's exclusion is never a suffix, and PR-94
  neither adds nor removes the flag there.
- When the predicate holds, `runSelectedOnly: true` is added to the request body. **The request MODE and the daemon are
  unchanged:** `modeKey` and `daemonFor` stay as they are, so no new daemon and no extra warm-up.
- `suiteMissing`'s order check (the rows back in baseline order) runs on EVERY flagged entry, not only when L4 added names
  (review M2).
- A request that fails the predicate is sent exactly as today: no flag, and any excluded tests run hidden (R1096).
- Warm-up requests are unchanged in this PR. They compare against baseline rows with R998's names; extending the flag to them
  is a follow-up, once this is measured.
- A stat `selectedOnlyRequests` (counted per request), `selectedOnlyTestsSkipped` (excluded tests in flagged requests) and
  `selectedOnlyRefusedGapped` (requests not flagged because an entry failed the predicate) are added to the serve-entries stats
  line. PR-56's drift re-run restores them like its other stats, so a re-run never counts twice (review L3).

## Why no verdict can move
- The rows a verdict reads (the covering tests, all at or before the last covering test) are the same rows by fact 1, because
  the kept tests form a prefix.
- R612's warm-up compare, PR-56's drift guard and `suiteMissing`'s order check all read the kept rows only, which are
  unchanged.
- **Corrected after review (H1).** Today a tail test is hidden but still RUNS, and LethAL never sees its row. So a tail test
  that is refused or hangs, on state a covering test left under the mutant, runs on the daemon UNSEEN. R612 cannot close the
  daemon for it, and the daemon is reused. PR-94 stops those tests running on flagged requests. So the change REMOVES unseen
  state from those requests; it adds none. A tail hang was never streamed either: it never cut an answer and never entered
  `timedOutMutants`, so removing it changes no class.
- **Packing can change on DO** (review M3). R987's `noteEntryCost` keeps each call's highest per-entry memory reading, and
  `groupsThatFit` packs by it. With tails not running, readings stay lower, so later requests can hold more entries and land on
  daemons differently. That holds wherever the cap was lowered. The gate's fixtures are small; the observe run covers them.
  On DO this is a change of layout, not of rows.
- **An arbiter for a DO-slice difference, pre-committed** (review H1). If a mutant's verdict differs before vs after, it is
  re-run ONE-SHOT (a fresh process, no daemon reuse) on the same build:
  - if one-shot agrees with the AFTER run, the difference is recorded as PR-94 removing hidden contamination (R1096);
  - if it agrees with the BEFORE run, it is a regression and a BLOCK.
- The remaining hidden-run paths (the warm-up's R1004 leave-outs, gapped entries, coverage windows) are filed as R1096, with a
  probe first.

## Predictions (pre-committed)
- **Unit tests** (each red when its rule is reverted):
  - the predicate: a suffix-cut entry gives the flag; a request of only uncut and echo entries gives NO flag; one gapped
    (#8059) entry, a codeunit whose discovered set differs from its baseline, or a duplicated name hiding a gap each give no
    flag;
  - the flag only in `send()` for prefetch and live, never in `plain()`; an alone request still carries its own flag;
  - `suiteMissing`'s order check on an R998-only flagged entry;
  - the drift re-run does not double the new stats;
  - a request built from flagged entries carries `runSelectedOnly: true`, and its mode and daemon are the ones it would have
    without it (a daemon counter: no extra spawn);
  - R857 and R895 requests unchanged;
  - the stats.
- **`itest:alrunner-v3`:** every per-mutant verdict and killing test unchanged. The serve pins (`entriesSent`, `boundChecks`,
  `prefetchRequests`, `pairBatchRequests`, `pairRequests`, `warmups`, `liveRequests`) unchanged, because packing and request
  counts do not change. The gate's fixtures are small, so few cuts apply. An observe run (`LETHAL_ITEST_V3_OBSERVE_PINS=1`)
  comes first; any moved pin goes in an addendum before the real gate.
- **DO-scoped, before and after** (v3, same build, config and fresh store, sequential, under heavy-slot): PR-67's area, the
  `CDOEMailTemplateImportExport` codeunit with its test codeunit (952 mutants, 849 s on one lane before).
  - **Preconditions** (review M3), or the slice is not evidence: `l4Entries > 0`, `selectedOnlyRequests > 0` and
    `selectedOnlyTestsSkipped > 0` in the AFTER run. `selectedOnlyRefusedGapped` is reported.
  - **Per mutant (scripts/report-diff.ts): IDENTICAL** in verdict, killing test, coverageFiltered, errorClass and mutated-text
    hash. Any difference goes to the one-shot arbiter above; only a difference the arbiter calls a regression is a BLOCK.
- **A pre-build probe** (review L1), added to `/coord/handoff/PR-94/probe.ts`: a codeunit whose tests are declared out of
  alphabetical order, cut at a prefix by declaration order, under the flag. Its rows must equal the full run's first rows in
  declaration order. If not, the build stops.
  - **Reported, not predicted:** the wall, `testsMs` summed over requests, `selectedOnlyRequests`, `selectedOnlyTestsSkipped`,
    daemon closes, and `serve-drift-after-kept-refusal` count, before and after.
  - The expected direction: less test time. preproc's estimate is about 400 s per full DO window. This slice's figure is
    reported as measured.
- **R1094's status** moves to done when this lands (`done (<commit>)`), with the measured slice saving.
