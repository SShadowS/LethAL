# R-913 pre-commitment: seven more BC.History apps on al-runner v3

Committed before any run, 2026-11-11. Coord task R-913 (owner: more BC.History on v3, to dig out bugs). Evidence goes to
`/coord/handoff/R-913/`. No BC.History source text is committed: file, object, procedure and test names only. al-runner v3 is not
authoritative (R586); nothing here is BC's verdict, and no figure here is a gate figure. No BC server is used.

## Setup

- **Corpus:** `/work/src/BC.History`, w1-28.6.55443.0, read-only. Scratch copies in `/coord/handoff/R-913/src/` made by `prep.ts`:
  only `app.json` changes (placeholders filled, 28.6 minimums lowered to 28.0, since the packages are 28.4).
- **Packages:** R-881's 14 Microsoft packages (28.4.53241.56646, System 28.0.54946.56477), one folder per app. Added, compiled with
  alc from the same corpus:
  - ExciseTaxes: Statistical Accounts, Power BI Report embeddings, Sustainability;
  - EnforcedDigitalVouchers: its test library. The app itself is compiled only into a scratch folder, never into the run's.
- **al-runner:** `current` = edge-3138effad (3.0.0-alpha.14+edge.20261110). Demo data downloaded into a new cache
  `/coord/handoff/R-913/cache` on the first run. Sidecar from `.gated`. `noClient` not set (the client stays, the default).
- **LethAL:** master at the time of each run; each report names the sha.
- **Command:** `lethal run --backend al-runner-v3 --allow-large-run --time-budget 3600`, the transport LethAL picks (serve-entries
  where proven), full mutant set, all tests of the app's own test project, default coverage and timeouts. One app at a time, through
  `scripts/heavy-slot.sh other`. A run the time budget stops is continued once with `--resume`, with the same budget.

| app | key | test procedures | deployed mutants | hang-refused sites | selector ids |
|---|---|---|---|---|---|
| Error Messages with Recommendations | emr | 20 | 375 | 0 | 7918-7920 |
| Data Search | ds | 14 | 1793 | 129 in 5 files | 2697-2699 |
| Payment Links to PayPal | pyp | 29 | 922 | 0 | 1087-1089 |
| Excise Taxes | ext | 12 | 625 | 0 | 7458-7460 |
| PEPPOL | peppol | 151 | 1400 | 385 in 6 files | 37298-37300 |
| Enforced Digital Vouchers | edv | 50 | 710 | 8 in 1 file | 5595-5597 |
| Audit File Export | afe | 7 | 1084 | 16 in 2 files | 5277-5279 |

Test procedures are `[Test]` attributes counted by grep. The other counts are from `lethal run --dry-run` on master 13027c81
(`dry-<key>.txt`).

## Anchors (checked against each report)

1. **Cardinality:** a complete report holds exactly the deployed count above. A report stopped by the time budget holds fewer, and
   says it is partial: the resumed run then holds exactly that count. Any other number is a finding.
2. **No crash:** each run ends with a report (complete, or partial with exit 7 from the budget). An exit with no report is a finding.
3. **Every mutant has a verdict** that is one of the report's own kinds.
4. **The estimate (R912):** the report's mutant-phase estimate is recorded beside the actual time; a miss of more than 3x either way
   is a finding.

## Expectations, stated before seeing anything

- **No figure predicted** for baselines or verdicts. Every red or refused baseline test is recorded with its cause and counted by
  cause.
- **Every new refusal cause, crash, hang, wrong-looking verdict, misleading report line or tool friction is a finding:** an invented
  repro, then a roadmap item or an upstream al-runner issue.
- **Read:** every refusal, timeout and error; each automatic isolation switch (R890); each hang cut (R897); the hang-refused sites of
  PEPPOL and Data Search (a share that large is itself read); killing tests that do not reach the mutated code; a sample of
  survivors on code a green test clearly asserts.
- **The GUI branch:** v3 runs the client branch by default (R895). A survivor or kill behind `GuiAllowed` or a confirm wrapper is named
  as such, and is not a finding on its own.
