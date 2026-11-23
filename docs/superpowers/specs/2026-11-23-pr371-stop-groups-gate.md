# PR-371 pre-commitment: the full v3 gate with `alRunnerV3.stopGroups` forced on, measure-only (R1146)

Status: pre-commitment (coord PR-371, lethal-preproc, 2026-11-23), before the run. Measure-only: no code reaches master.
`current` main-bf3a3e863's `.gated` records `stop-groups: matches` (lethal-bugs' re-gate, 07:11:42Z), so PR-256's flag is
accepted there. Rules being measured: `docs/superpowers/specs/2026-11-22-pr256-stop-groups.md` with amendments 1 and 2.

## How it is measured
- **Three runs of `itest:alrunner-v3`** (V3_TABLES, the CDO leg), all from ONE master commit, each with
  `LETHAL_ITEST_V3_REPORT_DIR` set, so every session's report is kept per leg. They run in sequence on CPUs 12-21 on a quiet
  box:
  1. **control:** master as it is. It is shared with PR-347's measurement.
  2. PR-347's run: refusedCutTail's default flipped.
  3. **this run:** stopGroups forced on where supported.
- **The forced-on edit**, uncommitted, in a scratch worktree of that commit: the stop is on when the flag is not explicitly
  `false` AND the build has the fact AND the §6 Sleep rule is retired. That is a `forcedStop` field set in `status()` after
  today's two refusal checks, read by the `stopGroups` getter and by the mutant-request condition. Today's refusals for an
  explicit `true` stay as they are.
  - So a leg on a build without the fact (a pinned older build) keeps the stop OFF instead of being refused. Its reports
    must equal the control's.
- **Judged per mutant**, on the full site key, run 3 against run 1, leg by leg. The gate's own pass or fail is recorded but
  is not the judge: a committed baseline that pins `killingTest` fails on an allowed move.

## Predictions (per leg)
1. **Verdicts equal** to the control, per mutant, in every leg. Any verdict difference is a BLOCK on the flag.
2. **`killingTest` may move only of amendment 1's kind:** the flag-on killer is a covering test whose run ALONE (the re-run
   of a skipped ref, no stop) failed and reproduced. Each move is listed with its row's evidence (the alone selection and the
   reproduction). Any other move is a BLOCK.
3. **No new refusal, error class, cut or daemon close** caused by the stop. No `al-runner-v3-stop-groups-*` error or
   warning, and no skip read as a refusal.
4. **Counts reported per leg** from the serve-entries line (flag on only): `stopSkipped` (skipped), `uncounted`, `reruns`
   and `heldForRed`, against the requests sent. Not pinned in advance. A leg where the stop never fired is named; in it,
   run 3 must equal run 1 entirely.
5. **Legs whose build lacks the fact:** named from their session lines. Their reports equal the control's.
6. **Notes and warning sets:** differences are listed. A new warning code is a finding to explain, not by itself a BLOCK,
   since this is measure-only.

## Length
Three gate runs of about 9 minutes each, about 30 minutes in all with the control, then the per-mutant comparison (offline).

## Out of scope
The DO measurement of the saving (PR-359, lethal-code, flag off against on).
