# R-728 pre-commitment (2026-10-24): BC's not-reinstalled list as a real run receives it, through altool

Committed before any server call. Probe: `scripts/r728-probe/` (lethal/r728; README there), built offline. Server:
bc2 (BC 28.4 W1), under lethal-preproc's lease. **Do not rebuild after this commit.**

| build | app (id) | version | sha256 |
|---|---|---|---|
| T1 | R728 Probe Target (cd81e5cb-17c3-4a98-a12f-c03a41c5c517) | 1.0.0.1 | a12c38bb156a8cad006d7963d2f2b03baab0f00023a53674115129dcb06a99bf |
| T2 | same, `Answer` removed | 1.0.0.2 | ce5368a26b92503e5a84df3a1f47c03c6b33bbcbf2ba97f2230c53b51c627573 |
| D1 | R728 Probe Dep One (bcd962d9-58d6-4e7b-8f46-20d6087cfda2), calls T.Answer | 1.0.0.1 | f1df98c44474379dff0eeaa65a6263b1c025fff09dee24ba6fcedd08bb39ca58 |
| D2 | R728 Probe Dep Two (7fed51c2-9122-45ff-8786-35a299428e2e), calls T.Answer | 1.0.0.1 | a5b4b2065b1e2db090dabb9b037659393a3e507663683f79bfddd39c2159d9c5 |

The app ids are fresh, so bc2 holds no installed-version record for them. Object ids are 93760-93779.

## Question
What does a real `lethal run` receive when BC refuses an upgrade that breaks installed dependents and cannot restore?
Step 3 publishes T2 through LethAL's own deployer (`deployerFor` -> `ContainerDeployer.publish`, altool `publishapp`
with the run's arguments, bc2's fixture config). The thrown `Error.message` is saved in full (`error-3.txt`). R-709b
measured BC's list over a direct HTTP publish only.

## Steps (`drive.ts --all`, once)
1. Publish T1, D1, D2 directly and read them back (installed 1.0.0.1).
2. Call D1 and D2 (200, value 1).
3. Publish T2 through the deployer; save the full message, plus `restoreFailed`, `notReinstalledApps`, and the
   `UpgradeNotRestoredError` message built from it; read T, D1, D2; call both.

Then cleanup: uninstall and unpublish what remains, and read back absent.

## Predictions
- P1: the publish throws, and the message holds "could not be restored" (`restoreFailed` true).
- P2: the message holds BC's list lines `R728 Probe Target by LethAL Probe`, `R728 Probe Dep One by LethAL Probe` and
  `R728 Probe Dep Two by LethAL Probe`, somewhere in altool's stdout.
- P3 (the uncertain one): `notReinstalledApps` returns those three entries. It returns null if altool drops BC's
  trailing blank lines (altool's stderr line "Publish failed: ..." then follows the list directly), or if it escapes
  or reflows the text.

## Readings, decided now
- **Valid run:** steps 1 and 2 as expected, and step 3 threw. Otherwise there is no result: fix the probe, record an
  addendum before any re-run, and read nothing.
- **P3 holds (three entries, in that order):** no code change. R728 closes with the measurement, and the R709 docs
  say the list is measured on both paths.
- **P3 fails, P2 holds:** change `notReinstalledApps` to read exactly the measured altool shape, fail-closed. For
  example, end the list at altool's own stderr wrapper line, if that is what follows the list, and nothing more
  general. Test-first, with red tests per direction (this list parses; an odd line still voids the list; no list is
  null, never `[]`).
- **P2 fails (no list in the message at all):** no parser change. R728 closes with the finding: the refusal says it
  names no readable list, and BC's text is kept.
- **P1 fails (no throw, or no "could not be restored"):** that is a finding in its own right. Report it before any
  change.

## Leftovers
bc2 keeps an installed-version record for T at 1.0.0.2 until a restart (R605). The earlier records on bc2 (R623,
R707, R702, R709's T and U) are unchanged.
