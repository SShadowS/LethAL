# R-915 pre-commitment: four large BC.History apps on al-runner v3, to find bugs

Committed before any run, 2026-11-11. Coord task R-915 (owner, 2026-11-11: more BC.History on v3, to dig out bugs). Evidence goes to
`/coord/handoff/R-915/`. No source text from BC.History is committed: app, test and procedure names and counts only.

## Setup

- **LethAL:** `lethal/lane-preproc` at current master, recorded in each run's first line. Defaults as master ships them: serve-entries,
  demo data, the sidecar, auto isolation, the hang cut, probing paths. `--no-client` off.
- **al-runner:** the pinned `current`, recorded in each run's first line.
- **Apps** (BC.History w1-28.6, placeholders filled to 28.6/28.0, runtime 17, dependencies at 28.0, `prep.ts`):

| app | test app | deployed mutants (dry run) | selector ids |
|---|---|---|---|
| Subscription Billing | Subscription Billing Tests | 22,638 | 8113, 8112, 8111 |
| E-Document Core | E-Document Core Tests | 15,287 | 6531, 6530, 6436 |
| Quality Management | Quality Management-Tests (with its Test Library) | 17,132 | 20600, 20598, 20597 |
| Shopify Connector | Shopify Connector Test | 18,226 | 30460, 30459, 30450 |

- **Packages:** R-882's 28.4.53241.57822 set, plus Power BI Report embeddings, PEPPOL and AI Test Toolkit built from BC.History source.
  Every app, dependency and test app compiles with 0 errors.
- **Runs:** `lethal run --backend al-runner-v3`, the full mutant set, `--time-budget 14400` per session, `--resume` until each app
  finishes. Each session in a heavy slot (`scripts/heavy-slot.sh other`). At most two of mine at once, and three v3 jobs container-wide.

## Expectations

**Nothing is pre-committed about verdicts.** These apps were never measured on v3, so there are no figures to hold them to.

Estimate, from R-911's PaymentPractices and VAT Group Management runs (about 0.5 s per mutant on serve): about 3 h for Subscription
Billing, 2 h for E-Document Core, 2.5 h each for Quality Management and Shopify. Reported beside the actual wall time.

## What counts as a finding

Every new refusal cause, crash, hang, wrong-looking verdict, misleading report line or tool friction. Each gets an invented repro,
then a roadmap item or an upstream al-runner issue. Small LethAL ones are fixed in this task, red both ways.

## Amendment 1, before any sampled run (2026-11-11)

**Why.** On full apps the serve default falls back to one-shot (R918). E-Document Core also ran with coverage off, because of one
split-header enum (R920). A full app cannot finish in a session.

**What changes.**
- **LethAL:** sampled runs use branch `lethal/r915` at `f7b31ce8`: current master plus R920's fix, which keeps coverage on for
  E-Document Core. Its first line records the head.
- **Sample:** per app, files shuffled with seed **915**, taken in that order while the total stays at or under **150** deployed
  mutants (`/coord/handoff/R-915/sample.ts`, file lists in `sample-<app>.txt`). The result is 149 to 150 mutants:
  Subscription Billing 16 files, E-Document Core 3, Quality Management 7, Shopify 14. Each run passes them as `--only`.
- **Runs:** each sample one-shot (`"transport": "one-shot"`), `--time-budget 14400`. Subscription Billing and E-Document Core also
  run the SAME sample with `"transport": "serve-entries"`, explicit, in a separate session. One heavy slot at a time.
- **Paired check:** for those two apps, per mutant on the mutants both runs reached: verdict and killing test. **Nothing is
  pre-committed.** Every difference is a finding. Agreement is evidence for R918's "prove serve for those shapes", never proof on
  its own. The serve figures are never reported without the one-shot figures beside them.
- Subscription Billing's full-app session 2 (already running when this was written) runs to its budget and is reported as
  measured. No further full-app sessions.
