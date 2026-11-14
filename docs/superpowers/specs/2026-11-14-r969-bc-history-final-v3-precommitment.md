# R-969 pre-commitment: the last 54 BC.History test projects outside BaseApp, on al-runner v3

Committed before any run, 2026-11-14. Coord task R-969. Evidence goes to `/coord/handoff/R-969/`. No BC.History source text is
committed: app, test and procedure names and counts only.

## What runs

Every project the R-962 inventory (`docs/measurements/2026-11-13-r962-bc-history-inventory.md`) lists as not run and runnable: 54
test projects, 351 `[Test]` methods, each against the app it tests (`/coord/handoff/R-969/modules.tsv`: the System Application
source module of the same name, or the test project's own dependency in its folder). Dry runs: all 54 deploy, 38,081 mutants in
all (`dry.txt`); Contoso Coffee Demo Dataset alone has 20,790 (6 tests), the median project a few hundred.

## Method

- **LethAL:** lane-preproc at current master (c1ccfd44 or later), named in each run's first line; defaults as master ships them.
  R979's selector change is NOT in master and NOT in these runs.
- **al-runner:** `current`, edge-c8fe56e05, named in each run's first line; if `current` moves during the batch, each app's report
  says which build it used.
- **Environment `onprem`** (R938), as batches 7-11. **Transport:** the default.
- **Packages:** `bch-notrun-closure@d9fad4a0933b+25661207` (read-only), which holds the closure of all 54.
- **Selector ids:** as `lethal init` picks them, from the spare range 1999990000-1999990010 where a dependency's codeunit clashes
  (R888) or the app has no free ids.
- **Runs:** each project's full mutant set, one `--time-budget 3600` window each, two at a time, each through
  `scripts/heavy-slot.sh --wait --peak serve baseapp` (admission by memory, R972); retry on exit 75 only.

**Nothing is pre-committed about verdicts.** Reported per app as batches 7-10 (baseline reds by cause, error mutants by cause, daemon
closes, a false-kill sample). Every al-runner refusal or difference gets an invented repro and an upstream issue, or a count comment;
every LethAL gap a roadmap item. The result ends with BC.History's final tally: run, and blocked by what.
