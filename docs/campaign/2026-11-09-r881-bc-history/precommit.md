# R-881 pre-commitment: three BC.History apps on al-runner v3

Committed before any run, 2026-11-09. Coord task R-881 (owner's request: try LethAL on BC.History for feedback). Evidence goes to
`/coord/handoff/R-881/`. No source text from BC.History is committed here or anywhere: file, object, procedure and test names only.

## Setup

- **Corpus:** `/work/src/BC.History`, `version.txt` w1-28.6.55443.0, read-only. Scratch copies of the seven projects in
  `/coord/handoff/R-881/src/`, with only `app.json` changed: the build placeholders (`$(app_currentVersion)` and the others)
  filled in, and the minimum versions lowered from 28.6 to 28.0, because the packages are 28.4.
- **Packages:** 14 Microsoft packages downloaded read-only from `bc3` (BC 28.4.53241.56646, System 28.0.54946.56477), all
  dependencies followed. Payment Practices Test Library is built from its own source with alc against them, and added for that app
  only. So 28.6 source runs against 28.4 packages: a difference that comes from this gap is the setup's, not LethAL's.
- **al-runner:** `current` = edge-05d692e5e (3.0.0-alpha.13+edge.20261109, sha256 `df99fc06…4b6c89`), gated today.
- **LethAL:** master at the time of the run; the report names the sha.
- **Command:** `lethal run --backend al-runner-v3 --allow-large-run`, full mutant set, all tests of the app's own test project,
  default coverage mode, default timeouts. No `--only`, no `--tests-only`.

| app | project | tests project | test procedures | selector ids |
|---|---|---|---|---|
| BankDeposits | `_Exclude_Bank Deposits` | `_Exclude_Bank Deposits Tests` | 75 | 10148, 10149, 10150 |
| PaymentPractices | `Payment Practices` | `Payment Practices Tests` | 36 | 696, 697, 698 |
| ServiceDeclaration | `Service Declaration` | `Service Declaration Tests` | 61 | 5257, 5258, 5259 |

## Anchors (checked against each report)

1. **Cardinality, exact:** the report holds exactly the deployed count the dry run printed: BankDeposits **2080**, PaymentPractices
   **880**, ServiceDeclaration **1044**. Any other number is a finding before anything else is read.
2. **No crash:** the run ends with a report. An exit with no report, or a stack trace, is a finding.
3. **Every mutant has a verdict** that is one of the report's own kinds. A mutant with none is a finding.

## Expectations, stated before seeing anything

- **Baseline:** I do not expect a fully green baseline. The test apps use `TestPage` variables (BankDeposits 56 declarations,
  ServiceDeclaration 8, PaymentPractices 1), UI handlers and report runs (BankDeposits 21). Which of these al-runner supports is
  not known to me. So no baseline figure is predicted. Every red or refused baseline test is recorded by name and read: a red
  that BC would not show is a finding, either an al-runner issue upstream or a LethAL one.
- **Verdicts:** no kill or survival rate is predicted. What is read: every refusal, timeout and infra error; a killing test
  that does not touch the mutated code; and a sample of survivors that look like false survivors (a mutant on code a green test
  clearly asserts).
- **Wall time:** not predicted; recorded per app.

## What is not claimed

These runs measure al-runner v3, which is not authoritative (R586). A verdict here is not BC's verdict, and no figure from here
is a gate figure or is quoted as one. No BC server is used for the runs.
