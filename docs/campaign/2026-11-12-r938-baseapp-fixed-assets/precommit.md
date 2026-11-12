# R-938 pre-commitment: Base Application x Tests-Fixed Asset on al-runner v3

Committed before any run, 2026-11-12. Coord task R-938 (owner, 2026-11-12: "Fixed Assets first"), the first BaseApp test-app slice.
Evidence goes to `/coord/handoff/R-938/` (setup and dry runs in `prep.md`). No BC.History source text is committed: names and counts.

## Setup

- **Target:** BC.History's Base Application (w1-28.6.55443.0, 8,098 files), copied to `/coord/handoff/R-938/src/baseapp`, `app.json`
  edited only as in R-914/R-925 (build placeholders filled; minimum versions lowered to 28.0, because the packages are 28.4). The
  first BaseApp built from source by LethAL: no earlier run did, and the corpus-build cache holds none; the build goes into the cache
  before cleanup.
- **Test app:** Tests-Fixed Asset, 460 `[Test]`s in 16 codeunits (`src/fa-test`), placeholders filled the same way, plus a Base
  Application dependency and its idRanges. All its dependencies are held 28.4 packages (Tests-TestLibraries, Library Variable
  Storage, System Application Test Library, Permissions Mock, Application Test Library, Any, Library Assert, Business Foundation Test
  Libraries); the package folder (`pkgs/`) leaves Microsoft's Base Application out, because the target replaces it. Unknown until the
  first compile: whether the held test libraries, built against Microsoft's Base Application, compile against the rebuilt one.
- **Config** (`v3.fa.json`): `alRunnerV3.environment: "onprem"` (R938: LethAL's BC servers are on-prem and BaseApp's own code branches
  on the environment; not measured against `saas` here), probing path `/coord/cache/bc28-service-windows` (BaseApp names .NET types in
  220 files), selector ids 99009699 / 99009698 / 99009697 (checked free against the target, the test app and every package codeunit).
- **al-runner:** an explicit build path in the config, never `current`, so an update cannot split a run: edge-42af5d384 unless the
  pending update has landed and passed its gate before the first window starts; the result names the build every window used.
- **LethAL:** master at the time of the run; each report names the sha.
- **Command:** `lethal run --backend al-runner-v3 --allow-large-run --only 'FixedAssets/**'`, default transport, auto isolation,
  all 460 tests, `--time-budget 14400` per window and `--resume` for the next window, at most three windows (12 h). Each window in a
  **BaseApp-class** slot (`scripts/heavy-slot.sh baseapp`; at most two BaseApp-class jobs container-wide, one slot per lane), at least
  10 GB available at start, retried only on exit 75. (The prep's dry runs did not take a slot; every real run does.)

| scope | files with mutants | sites | deployed | hang-refused |
|---|---|---|---|---|
| `FixedAssets/**` (this run) | 160 of 213 | 17,144 | 16,446 | 1,957 in 37 files |

**Correction (2026-11-12, before any mutant ran):** this file first said `src/FixedAssets/**`; BaseApp's folders sit at the project
root, so that glob matched nothing and window 1 refused at once ("--only matched no .al file"). The prep's dry runs, whose counts are
above, used `FixedAssets/**`: the scope and every figure are unchanged, only the transcription was wrong.

Counts from `lethal run --dry-run` on master (`/coord/handoff/R-938/`). Deployed by folder: FixedAsset 8,806, Depreciation 3,514,
Reports 1,967, Insurance 1,682, Maintenance 425, Setup 52.

## What is expected

A hunt; nothing is predicted about verdicts or refusals. Firm expectations: the run is on serve (any fallback reason is a finding); a
window that ends at its budget exits 7 with the caveat `time-budget-reached` and the next window continues it with `--resume`. Report:
baseline green / red / refused by cause, transport, decided and executed mutants per hour (R-924's `rate.ts`), serve daemon closes by
reason (R939), peak RSS, refusals by cause, a false-kill sample (R-916's method), and what Jobs (Tests-Job, 1,308 tests; `Projects/**`
29,728 deployed) and Manufacturing (Tests-SCM-Manufacturing, 1,233 tests; `Manufacturing/**` 38,322 deployed) would cost from this
run's measured rates. Every al-runner refusal or difference gets an invented repro and an upstream issue; every LethAL gap a roadmap
item.
