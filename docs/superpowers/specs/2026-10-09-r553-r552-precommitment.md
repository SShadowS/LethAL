# R-553 (+ R552): pre-commitment r2

Written 2026-10-09, before any build or live run. Base: master `08ec410e`. These predictions are
fixed. A result that differs is a failure to be explained, never a reason to reword them.

## Changes from r1

- Prediction 1 is now leg A only (`ar-A.config.json`, coverage off), compared with `ar-A.report.json`.
  ar-B is removed: it differs from A on M0031–M0034 (C1).
- Preconditions are pinned: numberingDigest, identityScheme, corpus fingerprint, and the three mutants
  named by identity. A digest mismatch means the run is not comparable (I5).
- Added: `backend` is `"al-runner"`, and `discriminationNote` is the standard `partial` note (the new
  backend note must not appear).
- Prediction 2 now separates the gates that are RUN from the gates ARGUED from source.
- Prediction 4 (R552) adds the offline `compile-only.ts` step and the `itest:bcdev` step with the stale
  symbol moved aside. The cache is compared by name, size, sha256 and mtimeMs.

## Change under test

**R553.**
- Applies on a session whose report says `backend: "al-runner"`, keyed on the backend's identity (the
  al-runner backend kind), NOT on `caps.authoritative` (orchestrator ruling at adoption: an al-runner
  backend made authoritative one day must still strip).
- R121's screen reads each kill's message half with ONE leading
  `/^(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*Exception: /` removed.
- On bcdev the screen's input is unchanged.
- `mutants[].killingTestFailure` is never changed.
- A `vacuous` al-runner screen where at least one `killed` kill's text lacked that prefix gets a note
  that names the backend.

**R552.**
- The bcdev compile, and `compile-only.ts`, stage `lethal-control.app` in a LethAL-owned directory
  inside their private compile copy, passed to alc as a second `/packagecachepath:` entry.
- Nothing is written to the configured `packageCachePath`.
- A leftover `lethal-control.app` there gets one warning and is never touched.

## Prediction 1: the R546 slice on al-runner, leg A

**Run.**
- Slice: CDO `CDO Recipient Mgt.` (`--only .dependencies/CDO/Codeunit/CDORecipientMgt.Codeunit.al`,
  `--tests-only Src/Recipients/CDORecipientMgtTests.Codeunit.al`).
- Flags, gate and config: leg A of R546's `ar-legs.sh`, including `ar-A.config.json` (coverage off).
- al-runner: the copied build `v2.12.0-main.43f76177`, from the R553 build.

**Preconditions.** If any of these fails, the run is NOT comparable. It is re-pre-committed, never
translated:
- report `numberingDigest` = `abbe9b55c02f3161bb260b4536b64212f7c9b4d5fe1277d2d7a51c823a870c94`;
- report `identityScheme` = 36;
- `gate.sh` passes, with corpus fingerprint `aa47c61c1fcbb7e3`.

Mutant codes are compared as codes only under that digest. They are never mapped after the fact.

**Predictions.**
1. `backend` = `"al-runner"`.
2. `counts`: killed 51, survived 12, noCoverage 0, timeoutKilled 0, errors 0.
3. Every mutant's verdict equals its verdict in R546's `ar-A.report.json`, compared per mutant by code,
   for all 63 mutants.
4. `assertionScreen.kills` = 51, `killsWithText` = 51, `killsWithoutText` = 0.
5. `assertionScreen.flaggedMutants` is EXACTLY `["0/M0044", "0/M0045", "0/M0051"]` (`flagged` = 3).
   No other code is flagged and none of these is missing. They are, by identity:
   - M0044 = `MoveRecipientFromHeaderToTable`, `lethal.remove-assignment`, line 68;
   - M0045 = `MoveRecipientFromHeaderToTable`, `lethal.toggle-blank-string`, line 68;
   - M0051 = `MoveRecipientFromHeaderToTable`, `lethal.remove-assignment`, line 74.
6. `assertionScreen.discrimination` = `"partial"`.
7. `assertionScreen.discriminationNote` equals the shipped `ASSERTION_SCREEN_DISCRIMINATION_NOTES.partial`.
   The al-runner backend note does NOT appear.
8. `assertionScreen.runnerRefusals` = 0.
9. `validity.caveats` contains `kills-without-assertion`.
10. The stored text is not stripped. Every kill's `killingTestFailure` still begins with an
    `...Exception: ` type name: 48 `NavNCLDialogException`, and 3 `NavCSideDuplicateKeyException`,
    which are M0044, M0045 and M0051.

If the leg stops at the 6922 s timeout, nothing is compared. The prediction is neither met nor failed,
and the leg is re-run.

**Offline evidence already in hand (not the test).**
- The proposed rule over R546's reports gives exactly M0044, M0045, M0051 `partial` on ar-A, with bc-A
  and bc-B unchanged.
- Replaying `ar-A.events.ndjson` through master's real `buildReport` rebuilds 51/12/0 with all 63
  verdicts equal to the stored report, and 51 flagged `vacuous`. The proposed strip over the rebuilt
  texts gives M0044, M0045, M0051 `partial`.
- After the build, both replays are repeated with the SHIPPED code and must give the same result.

## Prediction 2: every itest gate's screen figure is unchanged

**Gates RUN for this change.**
- `itest:alrunner`: every leg's per-mutant verdicts and every frozen figure are unchanged. This gate
  does not assert the screen, so it is NOT evidence for R553; Prediction 1 is.
- `itest:bcdev` (R552 step 2, under a Cronus28 lease):
  - killed 3 / survived 12 / no-coverage 4, per mutant equal to its baseline;
  - `groupedCalls` 15, `warmKills` 0;
  - `assertionScreen.discrimination` `"vacuous"`, with `flagged` = `killsWithText`.

**Gates ARGUED from source, not run.** The change is reached only when the backend is the al-runner
backend, and these gates run on bcdev; R552 changes only the alc argv and where a symbol is staged.
- `itest:tables`: `"partial"`, both populations non-empty, the twin-pair, blank-string and shift
  screens by mutant, `runnerRefusals` and every frozen figure unchanged.
- `itest:envtool` and `itest:chunked`: unchanged.

## Prediction 3: unit suite

- The 73-kill corpus test still reports 23 flagged, 6 of 6 false kills caught, precision 6/23.
- `bun scripts/r121-classify-eval.ts` prints output byte-identical to master's.
- No `.snap` file changes under `bun scripts/verify.ts`.

## Prediction 4: R552

1. **Unit tests.**
   - After `deploy()`, `compileCheck()` or a failed compile, the configured `packageCachePath` lists
     the same files with the same name, size, sha256 and mtimeMs, and has no new file.
   - A pre-existing stale `lethal-control.app` there keeps its bytes and its mtimeMs, and is named by
     exactly one warning.
2. **Offline `compile-only.ts`** with Linux alc on `fixtures/sandbox-app`, against a scratch copy of
   its `.alpackages` that holds no LethAL Control package:
   - it compiles (exit 0);
   - the copy's listing (name, size, sha256, mtimeMs) is identical before and after;
   - it gains no `lethal-control.app`.
3. **`itest:bcdev`**, with the leftover `lethal-control.app` in the gate's configured `packageCachePath`
   moved to scratch before the run and restored after, and the move recorded. That path is
   `/work/lethal/fixtures/sandbox-app/.alpackages` (the main checkout's fixture folder, set in the
   gitignored gate config and read as that one field only). Its leftover was last rewritten
   2026-10-09 12:31 by an earlier bcdev run, so its version is not asserted here:
   - the cache listing (name, size, sha256, mtimeMs) is identical before and after the run;
   - there is no new file;
   - the frozen 3/12/4 holds per mutant.
