# PR-40 pre-commitment: the mutant-level differential (PR-34's method) on Encoding, Base64, Confirm Management and Upgrade Tags

Status: pre-commitment (coord PR-40, lethal-code, 2026-11-15), before the measured v3 runs and any bcdev run. Method and rules:
PR-34 (`2026-11-15-pr34-mutant-differential-v3-bcdev.md`, addenda 1-2), R1051. The bcdev side is lethal-bugs' (standing approval,
bc2, leased, scratch ids, unpublished after). Evidence: `/coord/handoff/PR-40/`. Invented AL only in anything committed.

## The copies (`/coord/handoff/PR-40/src/`, `prepare.md`; not committed)

Each module, its test app and every dependency LethAL does not get from the server are copied with their own namespace
(`LethAL.PR40.*`), app ids and object ids (91800-91919), as in PR-34: DotNet Aliases (for Encoding and Base64), BLOB Storage (Base64's
tests), the Confirm Management and Upgrade Tags test libraries (their `internalsVisibleTo` now names the copies). All 12 apps compile
clean with alc against bc2's symbols. Two changes beyond namespace and ids:
- the Upgrade Tags test library's permission set is renamed `PR40 UpgTags View` (the server's own System Application Test Library
  has one named `Upgrade Tags View`; the test's `PermissionsMock.Set` names it);
- one space restored between the id and the name in 27 object headers the renumbering had glued (`codeunit 91830"Encoding Test"`):
  alc accepts the glued form, LethAL's test discovery (`discovery.ts`, `CODEUNIT_HEADER_GLOBAL`, `\s+`) does not and refuses the
  run by name. Filed with PR-40's records.

Findings for the hand-off: Upgrade Tags' `Upgrade Tag Impl.` subscribes to three platform Company-table events (fire twice on BC
beside the server's original) — no test writes the Company table, so they are not expected to run in a test; its `Upgrade Tag
Install` runs when the copy installs (it writes the copy's own tables). Base64 has 4 `[NonDebuggable]` procedures of 41.

## Scope and modes

- v3: every mutant of each module, on `current`. The hang filter first (PR-34 addendum 2): the census
  (`census-<m>.json`) tags 0 sites in Encoding, Base64 and Upgrade Tags and finds no assignment at all in Confirm Management; the
  measured v3 run must show **0 timeout-killed** per module before its bcdev run. A module with any is not run on bcdev until its
  hang-capable procedures are excluded by whole procedure and the scoped v3 run shows 0 (an addendum names them).
- bcdev: the same scope, `--stop-hung-sessions` always; `coverageMode: "procedure"` (default) for Encoding, Confirm Management and
  Upgrade Tags; `"none"` for Base64 (its 4 `[NonDebuggable]` procedures would read `no-coverage`, R1049).

## Predictions

1. Baselines: all green on v3 (as measured before: Encoding 3/3, Base64 13/13, Confirm Management 4/4, Upgrade Tags green) and on
   BC (Encoding 3/3 and Base64 13/13 measured in PR-14/PR-03; Confirm Management and Upgrade Tags not measured on BC before: a red
   BC baseline there is a finding, reported, and that module is compared on the green tests only).
2. Per mutant, the same verdict and killing test, except these classes known from PR-34, each listed and not a finding: (a) a v3
   refusal (`error`) that BC scores; (b) a different killing test with the same verdict where each backend ran its own first
   covering test (R197); (c) v3 `no-coverage` from line evidence where bcdev (procedure grain) runs the mutant; (d) Upgrade Tags
   reads the clock (`Upgrade Tag Impl.`): a difference traced to v3's fixed 12:00:00 clock (#8161). Any other difference — a
   `killed`/`survived` disagreement, or an `error` on bcdev that v3 scored — is a finding: classified (al-runner wrong, BC flaky
   by one re-run, LethAL), invented repro, upstream issue or roadmap item.
3. No `error` verdict on bcdev that v3 scored; no daemon left stranded (every bcdev run carries `--stop-hung-sessions`).
