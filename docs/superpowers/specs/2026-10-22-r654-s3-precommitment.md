# R-654 S3 (coord R-654c) pre-commitment: retire the .NET al-runner (v2), code part

Written 2026-10-22 on branch `lethal/r654-s3` at master 99b41589 (S1 and S2 merged).
- Plan: `docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md` (r0, r1, r2), §S3, as narrowed by the
  orchestrator's S3 rulings (the owner items are held; see §3).
- Nothing in this file has run live yet. It is committed to master BEFORE any live run of the S3 head.
- The exact leg list in §2 is filled in from `selectLegs` at the end of the build, before any gate runs, as an
  addendum.

**Any figure below that moves is a BLOCK.** It is not recorded, not re-baselined and not explained away: the lane
stops and reports it to the orchestrator.

## 1. What S3 removes from the gates

- **`itest:alrunner` is gone**: `al-runner.itest.ts`, its legs, its supervisor, the cli-default leg, its 8
  `al-runner.*.baseline.json` files, the `package.json` script and agentflow's `alrunner` leg. Its receipt is no
  longer asked for.

## 2. Gates that must hold, per mutant

- **`itest:alrunner-v3`: all 12 legs unchanged per mutant**, on the pinned gated build:
  - C: 26 facts (9 defect, 16 contract, 1 warn), each as pre-committed;
  - S1: 3 / 12 / 4 over 19, equal to `bcdev.baseline.json`;
  - S3: `al-runner-v3-resource-selector-refused`;
  - N1: 36 / 0 / 0 over 36, equal to `bcdev.names.baseline.json`;
  - X (a)-(f): as pre-committed;
  - L1: 7 / 3 / 0 over 10, equal to `al-runner-v3.layout.baseline.json`;
  - Y-A: 5 / 4 / 0 over 9, equal to `al-runner-v3.symbols-lethala.baseline.json`;
  - Y-B: 5 / 4 / 0 over 9, equal to `al-runner-v3.symbols-lethalb.baseline.json`;
  - K: 3 / 12 / 4 over 19, equal to `bcdev.baseline.json`;
  - D1 (with `LETHAL_ITEST_V3_CDO`): 51 / 12 / 0 over 63;
  - D1c: 51 / 8 / 4 over 63;
  - T (with `LETHAL_ITEST_V3_TABLES`): 290 / 57 / 59 over 406.
- **`itest:bcdev`: 3 / 12 / 4 over 19**, unchanged per mutant against `bcdev.baseline.json`.
- **Every other leg that agentflow's `selectLegs` picks for the S3 diff**: unchanged per mutant against its
  committed baseline. S3 touches `packages/runner/src` (orchestrator, store, report, cli), so this is **the full
  set**: `bcdev`, `lease`, `stale-publish`, `tables`, `chunked`, `alrunner-v3`, `hang`. The exact list is written
  to `/coord/handoff/R-654/s3-legs.txt` from `selectLegs` on `git diff --name-only origin/master...HEAD` once the
  build is done, and replaces this sentence.

## 3. The new refusals (exact texts)

Each is a named error class that extends `Error` directly. `<N>` is a run id.

- **F1, `--backend al-runner`** (`parseBackendKind`, so `run`, `dry-run` and every other subcommand that takes
  `--backend`):
  `al-runner-v2-retired: the .NET al-runner backend was retired (R654); use --backend al-runner-v3`
- **F3, a stored v2 run** (`backendBuildRefusal`, so all four lend sites: history, `--resume`, `--resume-run`,
  snapshot reuse; and the `--resume-run` backend check, which names it before its generic mismatch):
  `al-runner-v2-retired: run <N> ran on the retired .NET al-runner (R654); nothing of it is lent`
- **F3, a SessionReport with `backend: "al-runner"`** (the report readers `explain`, `campaign compare`,
  `campaign freeze`, `verify --report`):
  `al-runner-v2-retired: <path> is a report of the retired .NET al-runner (R654); it is not read`
  (where a reader has no path, `<path>` is `the report`.)

**Held, not built in S3 (orchestrator ruling):** F2, the refusal of a config `alRunner` section. Also held:
every `.kraken/project.yaml` edit, `scripts/al-runner-update.sh`, `scripts/al-runner-bootstrap.sh` and
`/work/tools/al-runner`.

## 4. Offline evidence before any live run

- Each refusal is tested both ways (the v2 input refused by name; the v3 or bcdev input still passes) and
  red-checked: `/coord/handoff/R-654/s3-redcheck.md`.
- Each re-pointed lend/resume fake from the plan's I2 table is red-checked against its own guard.
- The WrappedRule `al-runner-index` arm and M-3 (the v3 duplicate-name throw) keep their red checks.
- `bun scripts/verify.ts` is green on the submitted head.

## Addendum 1 (2026-10-22, after the build and its review, before any live run)

**The leg list in §2, from `selectLegs`** (`/coord/handoff/R-654/s3-legs.txt`): bcdev, lease, stale-publish,
tables, chunked, alrunner-v3, coverage-differential and hang. Each must hold unchanged against its committed baseline.
- **BC legs** run one at a time on `bc1`, the only server in use (bc2 and bc3 are out).
- **`alrunner-v3`** runs locally with `LETHAL_ITEST_V3_CDO` and `LETHAL_ITEST_V3_TABLES` set, so D1, D1c and T run, as
  §2 requires. Agentflow's own leg list omits them.
- **`coverage-differential`** has no script. It is run by the `coverage-differential` skill's ground-truth procedure,
  as in S1: `sandbox-app`, fenced against none, on bc1. Expected:
  - fenced 3 / 12 / 4, equal to `bcdev.baseline.json`;
  - none 3 / 16 / 0, where only the 4 SandboxPricing mutants move, from no-coverage to survived (the ordinary
    outcome for code no test reaches);
  - 0 attribution losses;
  - compare PASS.

**The report readers, corrected.**
- §3 named `verify --report`, but no such reader exists.
- `lethal export` (`exportFromCli`) also reads reports, and now refuses a v2 report with the same text.
- `--resume` (the "last" form) cannot show the by-name refusal: `findResumableRun` selects by backend, so the generic
  "found no unfinished run" message applies. `--resume-run <id>` shows it by name.
