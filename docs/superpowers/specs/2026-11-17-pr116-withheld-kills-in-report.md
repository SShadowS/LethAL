# PR-116 (R1108): name withheld kills in the report

Status: r2 (coord PR-116, lethal-preproc, 2026-11-17). r2 answers the spec-adversary review of r1 (§0). Report-only: no
verdict, cause, failure note, exit code or gate-compared field changes.

## 0. Review of r1 (opus spec-adversary), finding by finding
1. **The remedy told an "auto" run to use "auto".**
   - The caveat's text now covers both modes. The console line is built from the run's own mode: `SessionReport.isolation`
     is present only on an auto run.
   - Auto's rule is stated as it is: a codeunit moves to method when its baseline passes strictly more tests so, or ties
     and v3 refused one of its tests by name.
2. **The cause was named for one shape only.** The text now says "after an earlier test of its codeunit was refused,
   failed or ran out of time".
3. **The manual-binding cascade is al-runner's own artifact**, not the covering test's reaction to the mutant. It is
   excluded by name, with a test.
4. **Confirm and reproduction notes** ("confirming ...: ", "reproducing ...: ") are excluded. The note must start with
   v3's row prefix `NotRun: out-of-scope: `. Undercounting is the safe direction.
5. **`counts.withheldKills` is dropped.**
   - A required count would force a live regeneration of the committed sample report.
   - The per-mutant field and the caveat carry the fact; the console counts the mutants.
6. **The explain schema bump** is added to the ripple: a new caveat value is an explain schema change (v29 → v30, the
   README row, the R233 enum list). The `report-equality` snapshot is added too.
7. **Softer wording.**
   - "a kill candidate", not "a kill BC would score": had al-runner trusted the failure, it would still go through the
     confirm and R577's reproduction, and on DO 2 of 35 withheld failures were al-runner conversion errors.
   - The count is a LOWER bound, and is said as "at least": a direct refusal met first hides a later withheld kill
     (PR-107's M2320); `kill-not-reproduced` takes precedence; a phrase on a plain `fail` row is `runner-test-error`.
8. **Extraction.** The LAST occurrence of the phrase is used. The withheld failure runs up to v3's not-run suffix, or else
   up to LethAL's own appended suffixes (PR-51's held note, PR-108's cap note).

## Why
- [[R1102]] (PR-106, PR-107): on DO, 557 of 868 error verdicts (run 15) are withheld kills.
  - A covering test FAILED under the mutant, but al-runner v3 reported the failure as `NotRun`. An earlier test of the
    same codeunit had been refused, had failed, or had run out of time, so "the state it would have left is not BC's".
  - The row text holds `this failure is not trusted: <the failure>`.
- LethAL records such a mutant as `error` with cause `runner-refused`, the same as a mutant whose own path al-runner
  refuses. A reader sees "error", and a score that leaves those mutants out, with no word that a covering test failed.
- Per-test isolation recovers them: PR-107 measured 450 of 451 such errors become kills on DO under isolation "auto", at
  +21 min of baseline and ~3x per mutant in moved codeunits. The ruling (orchestrator, 2026-11-17): DO's default stays
  "test"; "auto" is a measured opt-in.

## 1. The detection rule (one pure function)
`withheldKillOf(verdict, cause, failureNote)` returns `{ failure, afterTest? }` or `undefined`. It returns a value
only when all of these hold:
- `verdict === "error"` and `cause === "runner-refused"`;
- the note starts with `NotRun: out-of-scope: ` (the covering loop's row as v3 wrote it; confirm and reproduce notes carry
  a prefix);
- the note contains `this failure is not trusted: `;
- the note is not the manual-binding cascade (`left a manual event subscription bound`, R1019, `al-runner-server.ts`).

The values:
- **`failure`:** the text after the LAST occurrence of the phrase, up to the first of v3's suffix
  (` [al-runner v3 did not run this test`, `V3_NOT_RUN_SUFFIX`) or LethAL's appended held-note and cap-note markers; trimmed.
- **`afterTest`:** the earlier test, when the note starts with
  `NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (<T>: ` or
  `NotRun: out-of-scope: a test before this one in the codeunit did not pass (<T>: `. Otherwise absent.

Computed in the report builder from the mutant's recorded fields, so it cannot move a verdict, and works the same on a
report rebuilt from a store.

## 2. The change
1. **Per mutant:** `MutantRecord.withheldKill?: { readonly failure: string; readonly afterTest?: string }`. It is
   optional in the schema, absent on every other mutant and on older reports.
2. **Caveat `withheld-kills`**, pushed when at least one mutant has `withheldKill`, with its `CAVEAT_INTERPRETATIONS` entry:
   - **meaning:** at least one `error` mutant is a withheld kill. A covering test failed under it, but al-runner v3 did not
     trust the failure, because an earlier test of its codeunit was refused, failed or ran out of time and the state it
     left is not BC's. Such a mutant is outside `mutationScore`, so the score leaves out a kill candidate. Each such mutant
     carries `withheldKill` (the withheld failure, and the earlier test when v3 names it). The count is a lower bound:
     some are hidden behind a direct refusal met first.
   - **remedy (LethAL's own machinery):** per-test isolation runs each test in its own session, where the earlier test is
     never sent.
     - Under a config that forces `"alRunnerV3.isolation": "test"`, the default `"auto"` moves to method the codeunits
       whose baseline passes strictly more tests so, or ties with a test v3 refused by name. On DO it scored 450 of 451
       such errors, at about 21 min more baseline and about 3x the time per mutant in moved codeunits (R1102).
     - Under "auto", the ones left are in codeunits auto kept on "test". `"method"` runs every codeunit one test per
       session, which moves other baseline outcomes (R1102 measured 156 on DO). al-runner's own rule is asked about in
       #8218.
   - **entailedNegative:** not a kill LethAL counts, not a wrong verdict, and not a claim that BC would kill each one: the
     earlier test's effect on the state is unknown, and a trusted failure would still be confirmed and reproduced.
   - **basis:** R1108. It comes with `some-errors` or `all-errors` (every withheld kill is an error).
3. **Console**, one line after the error-range line, when at least one mutant has `withheldKill`:
   - `at least N of the E error mutant(s) are withheld kills: a covering test failed under the mutant, but al-runner v3 did
     not trust the failure after an earlier test of its codeunit was refused, failed or ran out of time. The score leaves
     them out (validity.caveats "withheld-kills").`
   - followed, when `SessionReport.isolation` is absent (the run forced a mode), by
     ` Isolation "auto" scores most of them (R1102).`
   - or, when it is present, by
     ` They are in codeunits isolation "auto" kept on "test"; "method" runs them one test per session (R1102, #8218).`
   - **Known limit (build review #3):** a resumed auto session in which every mutant is carried, and no batch runs a
     baseline, has no `isolation`. Its console would print the forced-mode text. This is console-only.
4. **`lethal explain`:** the caveat by reference, as every caveat. Its not-measured entries are unchanged (no
   `withheldKill` there, so explain's path pin does not move beyond the caveat enum).

## 3. The ripple
- `report.ts`: the `MutantRecord` type, its builder, the caveat union and `CAVEAT_INTERPRETATIONS`, and the banner.
- `bun scripts/generate-schemas.ts`: report-v3 gains the optional property and the caveat value.
- **The explain schema:** `EXPLAIN_SCHEMA_VERSION` 29 → 30, the new `explain-v30` schema file, v29 kept, the
  `schemas/README.md` row, and the R233 literal enum list.
- `tests/schemas.test.ts`: the caveat enum and the explain version. No root-required list moves, because the field is
  optional; the committed sample reports still validate.
- `interpretation.test.ts` and `report.test.ts`: the caveat counts.
- The `report-equality` snapshot: unchanged in the build, as its golden scenario holds no withheld row; the field and
  caveat are pinned by `pr116-withheld-kills.test.ts` (build review #5).
- `report-fold.ts`, `events.ts`: unchanged, since the field is derived in the builder from recorded fields. If the
  builder does not see `cause` or `failureNote` there, the field is added to the fold instead, and this spec says so in
  the build notes.

## 4. Tests (each red-checked both ways)
- **Detection:**
  - all three v3 shapes (after a refused test, after a failure, after a timeout) are detected, with `failure` and
    `afterTest`;
  - excluded: a note without the phrase; a `killed` mutant; an error with another cause; the manual-binding cascade; a
    "confirming ...: " note;
  - the last occurrence is used when the phrase appears twice;
  - the PR-51 / PR-108 suffixes are cut.
- **Caveat:** present iff at least one `withheldKill`; it comes with `some-errors`, and with `all-errors`.
- **Console:** the line iff at least one, with N and E; the "auto" variant iff `isolation` is present.

## 5. Gates
- **The v3 gate:** no pinned figure moves. It compares verdict, `killingTest`, `coverageFiltered`, `errorClass`,
  `mutatedTextSha256` and the killed/survived/noCoverage counts, and checks named caveats only for presence. A moved
  figure is a BLOCK.
- **No BC gate:** bcdev never sets cause `runner-refused`.
