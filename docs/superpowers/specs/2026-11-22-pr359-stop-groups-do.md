# PR-359 pre-commitment v2.1 (R1146): PR-256's stop groups measured on full DO, flag on (arm B) against c3 (arm A)

Written 2026-11-22, before arm B runs. Sources: PR-256's spec (`2026-11-22-pr256-stop-groups.md`, amendments 1-2), PR-357's
c3 (`/coord/handoff/PR-357/`), PR-332's void rules. Names and numbers only; no DO source text.

## The two arms
- **Arm A is PR-357's c3,** reused as it stands:
  - head ec78cff18 (it already contains PR-256 and PR-342);
  - config `/coord/handoff/PR-357/v3.json`: binary `main-bf3a3e863` (sha256 b3e1d255..., version
    `al-runner 3.0.0-alpha.15+main.20261122 (bf3a3e863)`), its own cold `cacheDir`;
  - pack 256, workers 8, `--profile slim`, client session kind, triage first, CPUs 0-11, carry walk at its default (on).
- **Arm B differs in one thing: `"stopGroups": true`.** Its config `/coord/handoff/PR-359/v3.B.json` is A's, plus the flag,
  with its own cold `cacheDir` (as c3 had).
  - **The same head, ec78cff18, pinned by sha** (the orchestrator's rule): never a newer master. PR-354's keep entry, for
    one, would change warm-ups and daemon closes, so a later head would measure two changes at once.
  - Its driver, `/coord/handoff/PR-359/arm.sh`, is PR-357's `arm.sh` with only the config and these checks changed.
- **Preconditions (each a STOP in the driver, before anything starts):**
  - c3's AND c3off's reports exist, and no process still runs in PR-357's worktree (a c3off triage writes no pid file);
  - **the build's gate record equals the one c3 ran on, plus the new fact** (review BLOCK 1). The session reads
    `batchFacts` for more than the flag: all eight capability facts decide baseline batching, and
    `batch-sequential-carry` read as anything but `matches` turns the carry walk off. So:
    - c3's record is saved as `/coord/handoff/PR-359/gated-before-regate.json` (taken 2026-11-22 before the re-gate,
      sha256 df7332df...);
    - the new `.gated` must read `stop-groups: matches`, `batch-sequential-carry` absent or `matches`, and otherwise the
      same `batchFacts`, `warnFacts`, binary sha256, version and sidecar. `lethalCommit` and `gatedAt` may differ.
    - The check is `gated-check.jq`, with its self-test `gated-check-test.sh` (11 cases, each way).
    - **Today the record has no `stop-groups`** (gated at 12:42Z, before PR-342). lethal-bugs re-gates it after PR-357
      (master ba3138718's pre-commitment). Any other new fact also stops the driver, and it goes ahead only after a
      delta amendment here.
  - the §6 Sleep rule is retired on this build (c3's stderr: "§6 Sleep rule retired"), or the flag is refused (amendment 1).
  - The triage step runs first under B's config, so a refusal in `status()` (for example
    `al-runner-v3-stop-groups-unsupported`) stops the arm before the heavy slot.
- **After the run, B must have printed the same decisions as c3** (rc 4 otherwise; rc 4 voids speed, V is still judged):
  - the same §6 Sleep-rule line and R907 line, word for word;
  - a baseline-batching (PR-115) line, and the PR-340 carry-walk summary line when c3 printed one (present, not compared
    word for word: they carry run counts, which are reported);
  - no "build not carry-proven" note in B's stderr, events or report (c3 has none). B runs its own fresh leg-C probe, since
    the probe cache key holds the newer `lethalCommit`.
- The names of every `AL_*`, `BUN_*` and `DOTNET_*` variable are logged at the start (`LETHAL_*` ones are cleared, as in c3).
- **The box:** arm B starts only when the orchestrator says the box is free (after PR-357's c3off and bugs' re-gate), on
  CPUs 0-11, with nothing timed on 12-21.

## V, the hard claim (BLOCK on any miss)
- **The join:** the full site key (file, startLine, operator, start index, end index), verified before any comparison.
- **The same mutant set** in both reports, none missing. A mutant missing on either side is "not measured" and voids V
  (INFRA), never "moved", EXCEPT when B's stderr or events carry a stop-groups error code
  (`al-runner-v3-stop-groups-*`): then it is a BLOCK.
- **Verdicts: 0 moves** per mutant.
- **`killingTest`: predicted 0 moves.** PR-256 amendment 1 (change 3) allows one kind only: B's killer P is a covering test
  of the mutant that B's walk skipped and re-ran alone, where its fail was real and reproduced, while A's walk (R978) named
  the earlier F.
  - Each move is listed and checked:
    - with PR-217's keepcheck kit on a fresh daemon: P alone under the mutant fails twice, and P alone with no mutant
      passes;
    - P is a covering test of the mutant, and comes AFTER F in R197's order;
    - P and F were in the SAME entry of one of B's requests for that mutant (from `serve-request-sized` `calls` in B's
      events).
  - This proves "a real kill in the shape the stop makes", not "caused by the stop": no per-mutant record of an alone
    re-run exists (`reruns` is a total). The result says so.
  - A move that fails any of these checks is a BLOCK (the orchestrator's ruling, 2026-11-22). Allowed moves do not block,
    but each is named in the result, and a default flip needs the orchestrator's ruling with that list.
- **No `al-runner-v3-daemon-churn`,** and B's stderr carries the stop counts (else the flag did not reach the backend: STOP).

## Counts reported (not judged)
From B's `serve-entries (R635)` line:
- `stopSkipped` (stop-skipped rows) and the ones not counted as a saving;
- the alone re-runs (rule 5);
- `heldForRed` (mutant requests sent without the stop because an entry runs a baseline-red test).
  - Its denominator is prefetch plus live requests, since `heldForRed` counts every mutant request, prefetch included. A
    re-sent request can count twice, so the share is an upper bound.
  - **If that share is over half,** the stop is mostly off on DO. That is reported to the orchestrator as PR-256 amendment 2
    asks (true exclusion needs a ruling on `runSelectedOnly` with gaps).
- **0 stop-skipped rows** means the flag did nothing: speed is INCONCLUSIVE, not "S1 fails".

## The speed reading (ONE pair: it records a saving, it cannot carry a default flip; review SERIOUS 2)
- **S1, the wall:** (B's mutant-phase wall ÷ B's baseline median ms per test) ÷ (the same for A) ≤ 0.95.
  - The mutant phase: `elapsedMs` of the `phase-left` event with `"phase":"mutants"` (from its `phase-entered` with
    `"phase":"mutants"`). The baseline ms per test: the median over the `kind:"baseline"` requests of the baseline phase,
    as PR-332 used (normalising by the mutant phase's own ms per test would divide the effect away).
  - The bound: PR-257's warm fork measurement (PERF-18) gave wall -7.6% and tests -12.5%; R1098's 10.7% of serve test time
    after a kill is an upper bound. On full DO, with heldForRed and alone re-runs, less is expected, so 0.95 is the claim.
  - **The noise of one pair is not known here.** PR-332's single arms moved 10-16% from load alone, and A and B run hours
    apart. So a passing S1 is recorded as "a saving seen in one pair", and a default flip needs a later interleaved series
    of pairs (its own pre-commitment), not this result.
- **S2, no extra work:** B's own CPU ÷ A's (`time.txt`, user plus system with children) ≤ 1.00.
- **Reported, not judged:** the raw wall ratio, the mutant phase's ms per test, both arms' box figures, and each arm's
  R948 memory-guard time (`bound <ms> over <n> checks` in its serve-entries line).

## Void rules (either arm void: speed is INCONCLUSIVE; V is still judged)
- the BOOTTIME - MONOTONIC gap grew during the arm (the box slept);
- the mean busy share of CPUs 12-21 in `box.tsv` above 0.20 (2 of 10 cores), i.e. outside work beside the run;
- **outside load on CPUs 0-11** (review SERIOUS 3, as amended by amendment 1 below);
- B's memory-guard time (`bound` ms) exceeds A's by more than 1% of A's mutant-phase wall;
- B printed a decision unlike c3's (the driver's rc 4, above);
- the watchdog stopped it, R948's guard stopped it, or the run did not end rc 0 with a complete report.
- A void arm B is re-run once, as B2, under the same rules. A void arm A cannot be re-run here (c3 is PR-357's); then speed
  is INCONCLUSIVE.

## Amendment 1 (2026-11-23, before arm B runs): load averages withdrawn, per-core shares instead
- **Why:** lethal-code's own work on CPUs 12-21 (nice 19) during c3: `bun test scripts/` at about 23:20Z and
  23:28-23:31Z, and four PR-360 VERIFYs (verify-ledger: 23:34:46-23:39:19, 23:40:19-23:44:09, 23:44:49-23:51:38,
  23:52:07-23:54:42Z). In c3's `box.tsv` the 12-21 share reads 0.68-1.0 there, load1 up to 253, and CPU pressure up to 83.
  `/proc/loadavg` and `/proc/pressure/cpu` are box-wide, so c3's load1 and pressure are contaminated, and the rule above
  would void B for being quieter. Load averages prove nothing per core (the orchestrator, 2026-11-23).
- **The load1 and pressure comparison is withdrawn.**
- **CPUs 0-11, measured:** B's `box.tsv` now also records the busy share of CPUs 0-11 from `/proc/stat` (column
  `cpu0_11_busy`, beside `cpu12_21_busy`).
  - B's outside load on 0-11 = its mean `cpu0_11_busy` over the run minus its own CPU (`time.txt` user plus system) ÷
    (12 × the elapsed wall). **Void if above 0.10** (about 1.2 cores).
  - **A cannot be measured this way:** c3's `box.tsv` has no 0-11 column. Its own CPU ÷ (12 × wall) is reported, and the
    result states that A's 0-11 outside load is unmeasured.
- **CPUs 12-21:** the 0.20 mean-share rule stands for both arms, over each arm's mutant phase.
- **The contamination's bias favours B** (A was slowed in those windows, so its wall is longer). So S1 must ALSO hold
  with A's mutant-phase wall reduced by its measured excess in them:
  - the windows: every 30 s sample of A's `box.tsv` with `cpu12_21_busy` > 0.5 inside the mutant phase;
  - A's rate: mutants scored per second (from `mutant-scored` events) inside those windows, against A's rate in the rest
    of its mutant phase;
  - the excess: the windows' total length × (1 − rate in them ÷ rate outside), counted only when positive.
  - S1 passes only if it holds both with and without that correction. The windows, both rates and the excess are
    reported.
- The driver change (`arm.sh`, the `cpu0011` sampler) is in place and its syntax is checked.

## What follows
- **V, S1 and S2 hold:** R1146 records the saving seen in one pair. The next step is a task with an interleaved series of
  pairs and the flag-on gates (R1146's "flag-on gates"); only that can propose default on.
- **V holds, S1 fails or S2 fails:** stays opt-in; R1146 records the measured saving and the counts.
- **V fails:** BLOCK. The flag stays off and a correctness item is filed with the moved mutants by site key.
- **INCONCLUSIVE:** R1146 stays open with both arms recorded.

## The tools (under `/coord/handoff/PR-359/`)
- `arm.sh B`, `v3.B.json`, `gated-before-regate.json`, `gated-check.jq` and `gated-check-test.sh` (written; the self-test
  passes, and the check reads today's record as "stop-groups absent").
- The review: Opus spec-adversary on v1, 1 BLOCK and 4 SERIOUS findings, all folded in above (v2); its delta review of v2
  found nothing blocking, and its two LOW items and the pressure floor are folded in (v2.1).
- `compare.py`: written after the run, from PR-357's `compare.py` and PR-332's, implementing exactly the rules above.

## Amendment 2 (2026-11-23, the orchestrator's ruling, before any arm runs): two fresh arms, c3 for verdicts only
- **Why:** c3 cannot be a speed reference. Its CPUs 12-21 were busy 0.41-0.55 every hour from 23:00 to 02:55Z (lethal-code's
  work and the orchestrator's merge VERIFYs), and its wall (14,923 s) against c2's (13,458 s) shows it. Amendment 1's
  correction for slowed windows is therefore withdrawn, and with it every speed rule that reads c3.
- **The arms (`series.sh`):** **A** = the flag off (`v3.A.json`), then at once **B** = the flag on (`v3.B.json`), back to back.
  - Both run on the same head ec78cff18, the same binary (sha and version before and after), and the same re-gated record,
    which each arm checks before it starts (`gated-check.jq`, as before).
  - Each has its own cold `cacheDir`. The two configs differ only in `stopGroups` and `cacheDir` (checked by `jq`).
  - Both use PR-357's settings otherwise, and both record the per-core busy shares of 0-11 and 12-21 (`box.tsv`).
  - Arm A refuses to run with the flag on (it must print no stop counts), and arm B refuses to run before A's report exists.
- **The box:** both arms start only on the orchestrator's word that the box is free. The orchestrator holds merges and
  VERIFYs during both. Time: about 2 × 6-7 h.
- **V (hard) is now A against B** per mutant on the full site key: 0 verdict moves; `killingTest` moves only of PR-256
  amendment 1's kind, each listed and checked as above, any other a BLOCK.
- **Each arm against c3 is reported, not judged:** A against c3 is expected to equal (the same head, build and settings), and
  any difference is named and filed as a nondeterminism finding. It does not block B's claim.
- **Speed: S1 and S2 as written, B over A,** with no correction.
- **The void rules, per arm and between the arms (the speed reading is void if any holds):**
  - an arm's mean `cpu12_21_busy` over its mutant phase above 0.20;
  - **the two arms' mean `cpu12_21_busy` over their mutant phases differ by more than 0.05;**
  - an arm's outside load on 0-11 (its mean `cpu0_11_busy` minus its own CPU ÷ (12 × its elapsed wall)) above 0.10, or
    the two arms' outside loads on 0-11 differ by more than 0.05;
  - the suspend, watchdog, R948, decision-line and completeness rules as before.
  - **A void arm is re-run once, at once, under its letter (A2 or B2),** and the series keeps the A-then-B order. A second
    void leaves speed INCONCLUSIVE.
- **What follows, unchanged:** one pair records a saving; a default flip needs an interleaved series of pairs.
