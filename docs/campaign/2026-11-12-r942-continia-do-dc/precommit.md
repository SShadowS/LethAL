# R-942 pre-commitment: Continia Document Output (and then Document Capture) on al-runner v3

Committed before any run, 2026-11-12. Coord task R-942: the first live runs of the Continia corpora (R-878/R-879 only instrumented and
compiled them offline). Evidence goes to `/coord/handoff/R-942/`. **Customer code:** no DO/DC source text is committed or posted
anywhere (not in this file, reports, roadmap items or upstream repros): names, paths and counts only. A report is redacted with
`scripts/redact-campaign-report.ts` before any commit.

## Part 1: DO (this file pre-commits it)

- **Target:** `/work/src/DO/Cloud` (Continia Document Output 30.0.0.0, 589 files; corpus pinned per the source-corpora record),
  copied unchanged to `/coord/handoff/R-942/src/do-cloud`.
- **Test app:** `/work/src/DO/Test` (Continia Document Output 365 - Test 30.0.0.0, 158 files, 1,986 `[Test]`s in 112 test
  codeunits), copied unchanged to `src/do-test`.
- **Packages** (`pkgs-do/`, 36 files): Microsoft 28.4.53241.56646 (System 28.0.54946.56477, System Application, Business Foundation,
  Base Application, Application, and the test libraries Any, Library Assert, Library Variable Storage, Permissions Mock, Test Runner,
  Tests-TestLibraries, System Application Test Library, Application Test Library, Business Foundation Test Libraries) from R-881's
  set; Continia 30.0.0.0 symbol packages from R-862's set, without Document Output (the target replaces it); and the two the owner
  supplied for this task (answer to `q-20261112T153553-13d9eecb`), whose sha256 match the answer's prefixes:
  Continia Core Internal Activation App 30.0.0.35781 `29cd1ab9067f141e4eee9b5f6063cfcc7f5662c39ae619148b68eabf0c88c7b0`, Continia
  Core SMTP Connector 30.0.0.35783 `99e3d59ecc7cc4e41c26ae44039d42fcced19c806e9466fdd88832eba72697f7`.
  Smoke (plain alc, no LethAL): Cloud and then Test against it, both 0 errors.
- **Config** (`v3.do.json`): `alRunnerV3.environment: "saas"` (R938: stated, because the target's `app.json` says `target: Cloud`,
  so SaaS is the environment it ships to); no assembly probing paths (Cloud names no .NET assembly alc lacks: the smoke compiled
  without them); selector ids 6175468 / 6175467 / 6175466, the top of the target's only idRange, checked free against every codeunit
  and table in the target and the test app.
- **al-runner:** the explicit build path `edge-2bd87774f` (the gated `current` at this commit), never `current`, so an update cannot
  split a run across windows; the result names the build.
- **LethAL:** master at the time of the run; each report names the sha.
- **Command:** `lethal run --backend al-runner-v3 --allow-large-run`, whole target, all tests, default transport, auto isolation,
  `--time-budget 14400` per window and `--resume` for the next, **at most three windows (12 h)**. Each window in a **BaseApp-class**
  slot (`scripts/heavy-slot.sh baseapp`: Continia corpora count as BaseApp-class; at most two such jobs container-wide), at least
  10 GB available at start, retried only on exit 75.

| scope | files with mutants | sites | deployed | hang-refused |
|---|---|---|---|---|
| DO Cloud, whole app | 469 of 589 | 45,086 | 43,583 | 675 in 55 files |

Counts from `lethal run --dry-run` on master `bad3237a` (`/coord/handoff/R-942/dry-do.txt`). Three windows will not finish 43,583
mutants at any rate R-925 measured (161 to 5,380 executed per hour); the run reports how far it got and what the rest would cost.

## Part 2: DC (pre-committed by an amendment to this file before it runs)

DC's only test app with code is `/work/src/DC/Test` (Continia Document Capture Test Suite, 192 files); its target is DC Cloud. Its
dependencies need the same two owner packages plus `Email - SMTP API`, which no held set has (a read-only dev-endpoint download from a
leased bc server is the plan). The amendment states scope, packages, environment and figures before the first DC window.

## What is expected

A hunt; nothing is predicted about verdicts or refusals. Firm expectations: the run is on serve (any fallback reason is a finding); a
window that ends at its budget exits 7 with the caveat `time-budget-reached` and the next continues it with `--resume`. Report per
app: baseline green / red / refused by cause, transport, decided and executed mutants per hour (R-924's `rate.ts`), serve daemon
closes by reason, peak RSS, refusals by cause, a false-kill sample (R-916's method). Every al-runner refusal or difference gets an
invented repro with no Continia source text and an upstream issue; every LethAL gap a roadmap item.
