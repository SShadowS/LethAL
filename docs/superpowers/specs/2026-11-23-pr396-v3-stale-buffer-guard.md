# PR-396 pre-commitment: an al-runner-v3 kill carrying #8721's stale-buffer text is withheld as error, never counted

Written 2026-11-23, before the build and before any server call. Mantra 1: a wrong answer is worse than an error. Coord
PR-396 (lethal-code).

## Why
- PR-365's keep rows let 68975's tests run in sequence, so c4 (PR-379) scores **M13065 killed** by
  `CopyToTemplate_RunTwice_DoesNotDuplicateTheChildren`. On BC that test passes under the mutant (PR-302's BC check: the
  only contradiction of 228): it is al-runner's #8721 (a stale record buffer after a failed `Insert` of a copy; fix in
  draft #8801), a FALSE kill, where c3 gave an honest `error`.

## The signature, measured first (`/coord/handoff/PR-396/sig-measure.py`, read-only; names and counts only)
- **The text:** `cannot be saved because some information on the page is not up-to-date` (BC's own stale-record
  error, which al-runner raises in #8721's shape). The #8721 repro (`/coord/handoff/PR-302bc/repro-main-bf3a3e863.json`)
  carries it.
- **How often a v3 KILL carries it:** t1b 2 of 6,725; c3 1 of 6,548; c4 2 of 6,670; y3 2 of 6,442. Always the same two
  mutants: **M13065** (68975, `CopyToTemplate_RunTwice_...`, a void-method-call in `CDODocumentTemplateLine.CopyToTemplate`)
  and **M13625** (68907, `Worksheet_AnOldFormatFileWithVariants_CollapsesToOneRow`, a remove-setrange in
  `CDOEMailTemplImpWorkshtL.CreateDocumentTemplateLines`).
- **Against BC truth (PR-302's 228-kill check):** the only checked kill carrying the text is M13065, CONTRADICTED (a
  false kill). **M13625 was never checked on BC.**
- So the false-alarm count on known-real kills is **0 of the BC-checked set**, but the one other carrier is unmeasured, and
  BC can raise this error for real (a removed `SetRange` can make code modify a row another variable changed).

## Step 1 (before the build): M13625 on BC
- One mutant (M13625's site, by the full site key) through PR-302bc's driver on bc4 under a lease (doctor before and
  after; released healthy), `--stop-hung-sessions`, the client at nice 19 on CPUs 0-11. The v3 hang check: c3 and c4 (the
  same site, full DO) read 0 timeout-killed there.
- **BC survives** (its killing test passes under the mutant on BC): a second #8721 false kill. The text-only rule below is
  built; it catches 2 of 2 and has 0 false alarms on known truth.
- **BC kills it with the same text:** the text alone over-flags a real kill. Stop, and narrow the signature (for example,
  the stack shape #8721 needs: a `Modify` after a failed `Insert` of the same record) in an amendment before any build.
- **BC kills it with another text, or the mutant is not judgeable on BC:** stop and amend.

## The rule (built only after step 1 says "BC survives")
- In the al-runner-v3 row mapping (`al-runner-v3-backend.ts`), a test row that FAILED under a mutant whose message holds
  the signature becomes `outcome: "error"`, `runnerRow: "runner-test-error"`, with the failure text kept and a named note:
  `[al-runner #8721: a stale-record raise that BC does not make (PR-302: M13065 passes on BC); NOT scored as a kill
  (PR-396)]`.
- So the mutant is not `killed` by that test; if no other covering test kills it, its verdict is `error`, never
  `survived` (a withheld kill is not a survivor).
- **Not a recheck target:** the note does NOT carry `V3_NOT_RUN_SUFFIX`, so PR-144's withheld-kill recheck does not re-run
  it alone (#8721 happens inside the one test, so a re-run alone would "recover" the false kill).
- **Baseline rows are left as they are:** the rule applies to mutant runs only (an unmutated test failing this way is red
  at baseline already).
- **Removal trigger (recorded in the roadmap item):** the guard is removed when a gated `current` carries #8801 (#8721's
  fix), measured by M13065 passing under v3 on that build.

## Predictions
- On c4's event stream refolded (offline): M13065 moves killed -> error with the note; M13625 (if step 1 says BC
  survives) moves killed -> error; every other verdict is unchanged (6,668 kills stay).
- No gate moves: no fixture test raises this text (checked by grep over `fixtures/` before the build).

## Tests (red-checked each way)
1. A failed row with the #8721 text under a mutant: `error`, the note present, no kill; the same text at baseline: left as
   a fail (baseline untouched).
2. A failed row with another text: a kill, as today.
3. A guarded row is not a PR-144 recheck target (no `V3_NOT_RUN_SUFFIX`; `withheldKillOf` returns nothing for it).
4. A mutant with one guarded row and one ordinary killing row: killed by the ordinary one.

## Checks
VERIFY (one at a time), Opus review, selectLegs' gates, CI.
