# PR-143 (R1121): R72's screen lists kills by Linux BC's RDLC stub, kept killed

Coord PR-143 (lethal-code, 2026-11-18). R1121: on BC for Linux (`bc1`-`bc4`, `bc5`), a mutant that routes a test into an RDLC report
render is scored `killed` by the platform's stub error, not by an assertion. PR-68's changed arm had 11 such kills out of 22
(`/coord/handoff/PR-137/result.md`). The orchestrator's ruling: never re-score; extend R72's `platformArtifactKills` screen.

## The text
Measured in `/coord/handoff/PR-68/changed-v1/report.json`. All 11 killing failures contain:

    RDLC report rendering is not implemented on Linux BC

It comes inside BC's "The report could not be created as a Pdf document ... Error Text: ..." and continues "the Windows Reporting
Service is stubbed out (bc-linux StartupHook.cs Patch #19)".

## Why a text match here, where R72 refuses one
R72 keys on the site's syntax, never on BC's failure text, for two reasons. Neither holds for this text:
- **BC's own refusal text is generic** ("An error occurred and the transaction is stopped"), so a text rule would fire on any
  platform-stopped transaction. This text names one cause, and it is not a test's own message.
- **BC's text localises (R66).** This one is written by the bc-linux startup hook's patch, not by BC's resources, so it is
  English on every BC for Linux.

R72's site rule stays as it is. This adds a second kind of mechanism, keyed on the killing failure text, and says so.

## The change (`platform-artifact-kills.ts`, `report.ts`)
1. **The mechanism.** `PLATFORM_FAILURE_TEXT_MECHANISMS`: one entry, `linux-rdlc-stub`, with its fixed substring and an
   explanation:
   - what the stub is, and that on BC for Linux any test that renders an RDLC report fails on it;
   - that LethAL cannot tell whether an assertion would have failed had the render worked;
   - that the remedy is a BC on Windows, or a test that does not render.
2. **The report.**
   - **Who is listed:** a `killed` mutant whose `killingTestFailure` contains the substring is listed under `linux-rdlc-stub`
     in `platformArtifactKills.byMechanism`. That holds with or without a site tag; a mutant with both is listed under both.
   - **`killedCount`** counts distinct mutants.
   - **What does not move:** the verdict and `mutationScore`. The caveat `platform-artifact-kills` is pushed, as for a site tag.
   - **`timeout-killed`** stays out, as R72 decided.
3. **The diagnosis sentence** says that every mechanism but one is keyed on the site, and that `linux-rdlc-stub` is keyed on
   the failure text. It is not true otherwise. The committed gift-card report keeps the text it was written with: a report states
   what its build said.
4. **No new report field, Caveat or schema.** `byMechanism[].mechanism` is a string, and `explanation` comes from either map.

## Tests (red both ways)
1. **The stub flags:** a killed mutant whose `killingTestFailure` holds PR-68's text (an invented document number) is listed under
   `linux-rdlc-stub`, with its explanation and the caveat. Its verdict stays `killed`, and the score is unchanged.
2. **An ordinary failure does not flag:** a killed mutant with an assertion failure, and one with BC's generic "the transaction is
   stopped", is not listed, and the caveat is absent when nothing else is.
3. **Not for a survivor or a timeout:** a `survived` or `timeout-killed` mutant carrying the text is not listed.
4. **Both kinds at once:** a site-tagged kill that also carries the text appears under both mechanisms, and `killedCount` counts
   it once.

A live bcdev leg is not run. It would need a fixture that renders an RDLC report, and no fixture does. PR-68's report is the live
evidence; test 1 uses its text.
