# R-902 pre-commitment: five more BC.History apps on al-runner v3

Committed before any run, 2026-11-10. Coord task R-902: run five BC.History apps that ship their own test app and that we have not
installed and tested before, on current master, with every fix since R-881 in place. Evidence goes to `/coord/handoff/R-902/`. No
source text from BC.History is committed here or anywhere: file, object, procedure and test names only.

## Why these five

Each one ships a test app, and none has been installed and tested by LethAL before (only statically counted, by R-464 and R-521).
Each one needs only packages we already hold (R-881's `pkgs-pp`), so a red baseline points at the runner, not at missing setup.
- **Statistical Accounts, Simplified Bank Statement Import, EU 3-Party Trade Purchase:** small apps, as the brief suggested.
- **VAT Group Management** in place of Review G/L Entries: Microsoft names Review G/L Entries' test app `_Exclude_...` (left out of its
  own runs), so a red baseline there would tell us little. VAT Group Management has 83 tests.
- **Intrastat Core** as the larger app (3,301 mutants, 111 tests). Sustainability was the other suggestion. It needs the Power BI
  apps and their test library, which we do not hold. ExciseTaxes needs Sustainability, so it is out for the same reason.

## Setup

- **Corpus:** `/work/src/BC.History`, `version.txt` w1-28.6.55443.0, read-only. Scratch copies of the ten projects in
  `/coord/handoff/R-902/src/`. Only `app.json` is changed, as in R-881: the build placeholders are filled (version 28.6.55443.0,
  platform 28.0.0.0), and the minimum versions are lowered from 28.6 to 28.0, because the packages are 28.4.
- **Packages:** R-881's 14 Microsoft packages from `bc3` (BC 28.4.53241.56646, System 28.0.54946.56477). So 28.6 source runs
  against 28.4 packages: a difference that comes from this gap is the setup's, not LethAL's.
- **Demo data:** R-881's scratch cache (w1, build 28.4.53241.56646), with `downloadDemoData: false`, as R-895 ran it.
- **al-runner:** `current` = edge-3096bf68f (3.0.0-alpha.13+edge.20261110, sha256 `4907c4a2…`) and its own .NET sidecar (R886).
- **LethAL:** master at the time of the run; each report names the sha.
- **Command:** `lethal run --backend al-runner-v3 --allow-large-run`, serve-entries (the default transport), full mutant set, all
  tests of the app's own test project, default coverage mode and timeouts. No `--only`, no `--tests-only`. One heavy slot per app,
  at least 10 GB available at start. A cap of 4 hours per app (6 hours for Intrastat Core).

| app | key | test procedures | deployed mutants | hang-refused sites | selector ids |
|---|---|---|---|---|---|
| Statistical Accounts | sa | 18 | 1444 | 58 in 3 files | 2637, 2638, 2639 |
| Simplified Bank Statement Import | sbi | 6 | 888 | 2 in 1 file | 8860, 8861, 8862 |
| EU 3-Party Trade Purchase | eu3 | 14 | 155 | 0 | 4898, 4899, 4900 |
| VAT Group Management | vat | 83 | 1272 | 2 in 1 file | 4718, 4719, 4720 |
| Intrastat Core | ist | 111 | 3301 | 13 in 3 files | 4838, 4839, 4840 |

Test procedures are `[Test]` attributes counted by grep. The other counts are from `lethal run --dry-run` on master b7e77153
(`/coord/handoff/R-902/dry-<key>.txt`).

## Anchors (checked against each report)

1. **Cardinality, exact:** each report holds exactly the deployed count above. Any other number is a finding before anything else
   is read.
2. **No crash:** each run ends with a report. An exit with no report, or a stack trace, is a finding.
3. **Every mutant has a verdict** that is one of the report's own kinds.

## Expectations, stated before seeing anything

- **No `dotnet-unavailable` refusal** in any baseline (R886), and no run stopped by install code under a mutant (R887).
- **Baseline:** no figure predicted. Every red or refused baseline test is recorded with its cause and counted by cause. A red that
  BC would not show is a finding: upstream for al-runner, a roadmap item for LethAL.
- **Verdicts:** no kill or survival rate predicted. Read: every refusal, timeout and infra error; each automatic switch of test
  isolation (R890); each cut at a timeout (R897); a killing test that does not reach the mutated code; and a sample of survivors on
  code a green test clearly asserts.
- **GUI branch:** v3 runs the client branch (R895). Survivors and kills behind `GuiAllowed` or a confirm wrapper are named as such
  and not counted as findings on their own.
- **Wall time:** not predicted; recorded per app.

## What is not claimed

al-runner v3 is not authoritative (R586). A verdict here is not BC's verdict, and no figure here is a gate figure. No BC server is
used.
