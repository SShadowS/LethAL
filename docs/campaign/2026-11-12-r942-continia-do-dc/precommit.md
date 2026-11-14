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

## Amendment 1 (2026-11-12, before the resumed DO run): window 1 voided, a license added

**What happened to window 1.** It spent 4 h 40 min in the baseline and decided no mutant; the lane stopped it (SIGTERM), and it wrote
no report. Cause (R956, diagnosed offline): al-runner refused every DO test before it started, because DO's code reads
`License Permission` during company initialization and al-runner had no license file; every codeunit then tied at 0 passes and was
re-baselined one test per process. Its time is not counted; no figure of it is used.

**What changes.** Nothing in scope, packages, environment, selector ids or windows. Two things are added:
- **LethAL** with R-944 (R955, R956): the time budget bounds the baseline, a stopped run writes its report, and
  `alRunnerV3.license` exists. Master at the time of the run, named per report.
- **License:** config `v3.do-lic.json` = `v3.do.json` plus `alRunnerV3.license: /coord/cache/bc28-service-windows/Cronus.bclicense`
  (sha256 `2bb4ea64ff31351d0c1ea3cc33d710eb72b7d419f581d655fe0386009bff76ad`, licensee Cronus, expires 2033-03-13). It is Microsoft's
  CRONUS demonstration/development license that ships in the BC 28 service folder and artifacts, and the license al-runner itself
  loads by default when the BC artifacts are present. It is used only inside this container, only for these local test runs; it is not
  copied, published or committed (al-runner reads it per run and caches nothing of it).
- **Measured before this run** (one al-runner process, the whole Test app, the license, no LethAL): 1,805 pass, 49 fail, 125 not run of
  1,979 in 14 s; 32 of the 49 fail "Document Output has not been activated" (the activation install path, not measured further here).
  So the resumed baseline is expected to be mostly green; the exact LethAL baseline is recorded, not predicted.

The resumed run is a fresh window 1 (no `--resume`: window 1 stored nothing usable), then windows 2 and 3 with `--resume`, as above.
The before/after baseline time on R956's diagnosis slice (three test files; before 287.5 s, every test refused) is measured first and
recorded in R956 and the result.

## Amendment 2 (2026-11-13, before the next DO window): the resumed window 1b was OOM-killed; transport one-shot

**What happened since amendment 1.** The fresh window 1b (license, master 81c59409) was OOM-killed 2 h 27 min into its baseline at a
30.8 GB tree (R961); no figure of it is used. R-944, R-948, R-949 and R-951 followed (time budget bounds the baseline; memory guard;
daemon baseline with an in-session cross-check). On DO the daemon baseline is not faster (R968: refusal restarts and per-request
uncached compiles; a 3,564 s fill reached 1 of 1,979 tests), so DO runs on the one-shot baseline.

**What changes.** Config `v3.do-lic-oneshot.json` = `v3.do-lic.json` plus `alRunnerV3.transport: "one-shot"` — the only switch that turns
the daemon baseline off, and it makes the mutant phase one-shot too (slower per mutant than serve; the reason is R968, the deviation is
named). Same al-runner build (edge-2bd87774f, explicit path), license, environment, selector ids, scope and tests. LethAL: master at the
run (it carries the memory guard and the R955 budget stop); each report names its sha. Every window runs under the external watchdog as
well (SIGTERM at a 20 GB tree or under 4 GiB container headroom; SIGKILL of its own tree at 26 GB) and the interim admission rule
(current + 12 GiB < 28 GiB).

**Windows.** A fresh window 1c (no `--resume`), then 2c and 3c with `--resume`, `--time-budget 14400` each. Expected from R-948's
one-shot fallback (1,201 of 1,979 tests in 3,526 s): the baseline alone about 1.6 h, so window 1c reaches the mutant phase. Purpose, per
the orchestrator: al-runner refusals and differences on real ISV code (each an invented repro and an upstream issue, no Continia source
text); throughput is reported, not predicted.

## Amendment 3 (2026-11-13, before window 1d): isolation "test"

**Window 1c** (one-shot, isolation auto, master e8bf6c18): the baseline completed, 1,580 of 1,979 green in 6,450 s; R896's `auto` then
re-baselined the cascade codeunits one process per test, 4 at a time; the run's tree reached 20 GB with the container at 2 GiB headroom
and the external watchdog stopped it (SIGTERM; R955 wrote the report; 0 mutants). LethAL's memory guard checks only at call boundaries
([[R970]]).

**Change.** Config `v3.do-lic-oneshot-test.json` = `v3.do-lic-oneshot.json` plus `alRunnerV3.isolation: "test"`: no auto re-baseline.
Named deviation: a codeunit whose later tests al-runner refuses by cascade ("an earlier test of this codeunit ... changed an isolated
storage key or a number series", R890) keeps those tests REFUSED — they are not run per test and cover no mutant; their mutants are
scored by the remaining tests only (a refused test is never a killing test). Reason: R970 (the per-test fill is not memory-safe yet).
**Fresh window 1d** (no `--resume`: `isolation` is part of the run fingerprint, so 1c's run is not resumable under "test"), then 2d and
3d with `--resume`, `--time-budget 14400` each, master at the run (now carrying R-952's memory-aware `heavy-slot.sh --peak baseline`),
the external watchdog and the same build, license, environment, scope and selector ids. Expected: the baseline (about 1.8 h, as 1c's)
then the mutant phase.

## Amendment 4 (2026-11-14, before the serve windows): serve-entries on edge 736fc7677, a fresh store

**Why.** Windows 1d and 2d (one-shot) scored 215 mutants in about 8 h: every one-shot call recompiles DO. Serve recompiled per
codeunit filter too ([[R968]], upstream #7978). Edge 736fc7677 (`current` since 2026-11-14) holds #7978's fix, measured on R-955's
invented app: per-codeunit requests on one daemon answer `cached: true` after the first, with coverage on and off
(`/coord/handoff/R-955/result.md`, last section).

**Change.** Config `v3.do-serve.json`: the default transport (serve-entries; no `transport` key), `isolation: "test"` (amendment 3,
R970), the same license, packages, environment and selector ids, al-runner `edge-736fc7677`, and `assemblyProbingPaths` naming the
BC service folder (R-966: Newtonsoft.Json loads from it). A **fresh store** (`dos.sqlite`): transport and build differ from 1d/2d,
so their run is not resumed. Windows of `--time-budget 14400`, the first fresh, later ones `--resume`; master at the run; heavy slot
`--peak 20` (orchestrator, interim until R-972: a v3 run over 10,000 deployed mutants); the external watchdog on the LethAL pid.

**Measured and reported, not predicted as figures:** the baseline's wall time, its `cached: false` count (expected: about one per
daemon start, not one per codeunit), daemon restarts and their reasons, dropped or refused rows by family, peak memory, mutants
scored per window. **Predicted:** (1) the baseline completes inside the first window; (2) the 23 Newtonsoft.Json refusals of 1d are
gone (the probing path), the other refusal families as in 1d (cascade, Company FindSet, activation, HTTP, ZipArchive, GoToKey);
(3) for every mutant 1d/2d scored, the serve verdict and killing test equal 1d/2d's (one-shot is serve's reference), compared per
mutant on a verified join; any difference is a BLOCK, read before anything else.
