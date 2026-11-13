# R-950 pre-commitment: six refusal-heavy apps re-run on al-runner edge-c8fe56e05, per mutant against their old-build runs

Written 2026-11-13 by lane preproc, before any run. `current` moved edge-2bd87774f -> edge-c8fe56e05 (279 upstream commits).
Configs: `/coord/handoff/R-950/prep.ts` (each a copy of the old run's config; only the binary path, the cache dir and the stated
environment change). No BC.History source text is committed.

| key | app | old run (build) | environment (as the old run) | mutant stop |
|---|---|---|---|---|
| crypto | Cryptography Management | R-937 crypto.after (42af5d384) | saas (al-runner's default then) | 180 s, `--mutant-timeout-ms 180000` |
| excel | Edit in Excel | R-933 excel.after (42af5d384) | saas | 180 s |
| sus | Sustainability (`--only src/ESGReporting/SustESGReportingName.Table.al`, as before) | R-933 sus.after (42af5d384) | saas | 180 s |
| uri | URI | R-940 uri.run (2bd87774f) | onprem | 180 s |
| password | Password | R-945 password.after (2bd87774f) | onprem | R954's default (as the old run) |
| pagesum | Page Summary Provider | R-940 pagesum.run (2bd87774f) | onprem | 180 s |

The stop is held to the old run's so that only al-runner and LethAL's merged changes since differ. LethAL: lane-preproc at current
master (e3cc73c3 or later: R954, R963, R948 in), named in each run's first line. Runs one at a time in one heavy slot, one
`--time-budget 3600` window, the memory rule (memory.current + 16 GiB < 28 GiB) before each start.

## Expected results and how each difference is read

Not predicted per mutant: 279 upstream commits were not read against these apps. Reported per app, per mutant against the old run:
baseline pass/red per test, refusals by cause (which vanished, which are new), verdicts and their direction.
- A refusal of a cause filed upstream (#7819, #7854, #7924, #7934, #7935 and earlier) that vanishes: that issue gets a comment, and
  the tests and mutants it unblocked are counted.
- A NEW refusal, or a verdict that moves away from what BC would say (survived where the old run killed with a real failure, a
  baseline test going red on a plain fail), is a regression: invented repro and upstream issue.
- Expected without running: Edit in Excel and Cryptography Management keep their .NET-helper refusals unless #7924 is fixed;
  Sustainability's 4 API tests stay refused (`Api Web Service` has no provider) unless that cause is fixed.
