# R-612 live pre-commitment: the v3 serve keep rule on the table fixture, and leg C's `serve-keep-reasons`

Written on 2026-10-22 by lethal-code, BEFORE anything live ran, and committed to master before any leg started.
Nothing below is measured.

## 0. What is under test

- **Product head:** `lethal/r612` at **8e4aec5b** (plan r3 plus build review r1 fixes I-1, M-2, M-3).
- **Tap:** `lethal/r612-tap` at **d4cbe1ce**, one commit on 8e4aec5b, never merged. Worktree `/work/lethal-wt/r612-tap`.
  - `scripts/r586-probe/run-fixture.ts`, one line at the `AlRunnerBackend` construction:
    `...(process.env.R612_SERVE_RULE === "v3" ? { serveDaemonRule: "v3" as const } : {}), // R612 TAP`.
    Both legs run this SAME commit: the close leg leaves `R612_SERVE_RULE` unset (the v2 rule), the keep leg sets
    it to `v3`. (Plan r2 item 4 placed the line in `cli.ts`; the measurement driver is `run-fixture.ts`, which builds
    the backend itself, as R-586 and R-606 did, so the line is there.)
  - `scripts/r586-probe/v2-shim.sh`, the one measurement-only addition plan r2 item 4 names: on `--server`, a
    `tee` of the daemon's stdout through `grep -o '"cached":[a-z]*'` into `<tag>.cached.txt`, one line per summary.
    `exec` keeps the daemon's pid, and the bytes reaching LethAL are unchanged (smoke-tested with a fake
    `serve` script: every line passed through, one `cached` line per summary; no al-runner ran).
- **Binary:** `/work/tools/al-runner-v3/current/al-runner`, `alrunner 3.0.0-alpha.2 (91253f2d6)`, sha256
  `b23f831575f0a4f33346682766b6e06f8376ac2682861bc8fb91342592e15d45` (`.gated`). Checked before each leg and logged.

## (a) The live proof (plan r3, item 4 of r2)

**Fixture and settings, both legs:** `fixtures/sandbox-data` + `fixtures/sandbox-data-tests` (406 mutants), the
static selector over serve (`--leg server`; v3 refuses the resource selector), coverage `al-runner`, `--isolation
test` (LethAL's own), one backend (one worker, so one daemon at a time), a fresh scratch store per leg, never
`--resume`, `ALRUNNER_CACHE=/work/tools/al-runtime-rs/cache`, no `--packages` (as R-606 tables).

**Before the first leg** (in `/work/lethal-wt/r612-tap`): `bun install --frozen-lockfile`, then
`bun scripts/build-native-parser.ts`, then `mkdir -p /coord/handoff/R-612/live`.

**L-close** (the v2 rule), run first:

```
cd /work/lethal-wt/r612-tap
ALRUNNER_CACHE=/work/tools/al-runtime-rs/cache bun scripts/r586-probe/run-fixture.ts \
  --alrunner /work/tools/al-runner-v3/current/al-runner --out /coord/handoff/R-612/live \
  --leg server --tag close --coverage al-runner \
  --project fixtures/sandbox-data --tests fixtures/sandbox-data-tests \
  --oracle packages/runner/itest/al-runner-v3.tables.baseline.json \
  > /coord/handoff/R-612/live/close.log 2>&1
```

**L-keep** (the v3 rule), compared per mutant against L-close's own report:

```
cd /work/lethal-wt/r612-tap
R612_SERVE_RULE=v3 ALRUNNER_CACHE=/work/tools/al-runtime-rs/cache bun scripts/r586-probe/run-fixture.ts \
  --alrunner /work/tools/al-runner-v3/current/al-runner --out /coord/handoff/R-612/live \
  --leg server --tag keep --coverage al-runner \
  --project fixtures/sandbox-data --tests fixtures/sandbox-data-tests \
  --oracle /coord/handoff/R-612/live/close.report.json \
  > /coord/handoff/R-612/live/keep.log 2>&1
```

**Read-outs:** daemon starts = `grep -c '^serve' <tag>.shim.tsv`; requests answered = `wc -l < <tag>.cached.txt`;
`cached:true` = `grep -c true <tag>.cached.txt`; per mutant = `<tag>.compare.txt` and the `oracle=... mutants
oracle=406 run=406 sameScheme=...` line of the log.

**Pre-committed figures:**
1. **Per mutant, L-keep equals L-close on all 406:** verdict, killing test and coverage filter, with all 406
   mutated texts verified (`keep.compare.txt` lists 0 differences; `oracle=406 run=406 sameScheme=true`).
2. **L-close:** daemon starts = requests answered (every suite run carries the 3 Commit `notRun` rows, #5607, so the
   v2 rule closes after each).
3. **L-keep starts EXACTLY 1 daemon.** Why: on alpha.2 the only non-pass/fail rows this fixture produces are the
   Commit refusals (the `commit` entry) and, through #5610 (still present on alpha.2), the cascade rows after them,
   whose tail embeds the Commit reason, which holds none of the rejected tail words. The 7 #5603 rows PASS on alpha.2
   (no deferred duplicate-key refusal), no table fixture site can hang (R164), and no panic is expected.
4. **Recorded, not predicted:** L-keep's request count and its `cached:true` count (the static selector changes
   source per activation, so `cached:true` is expected to be low; the figure is for R635). L-close's request count.
   L-close against the alpha.2 one-shot record R-A2 (`al-runner-v3.tables.baseline.json`): the per-mutant
   differences, if any, are recorded with a cause, not judged here (R-A2 is one-shot; the v3 table fixture on
   alpha.2 serve was never recorded).

**What the proof claims, and what it does not:** this fixture exercises ONE allowlisted reason, the Commit refusal
(#5607, the 3 Commit tests of the unmutated suite), plus the cascade wording #5610 attaches after it. It is evidence
for those two entries only. `http`, `onrun-failed` and `no-callee` rest on the R-612 probe (`measure.md`) and on
leg C's `serve-keep-reasons` below, not on this run. Timeouts and panics close by rule and are not exercised.

## (b) Leg C of the al-runner-v3 update gate, on 8e4aec5b

Closes build review M-1: `serve-keep-reasons` has never run against a real binary.

```
cd /work/lethal-wt/r612        # at 8e4aec5b, clean
LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_LEGS=C bun run itest:alrunner-v3 \
  > /coord/handoff/R-612/live/legC.log 2>&1
```

- `LETHAL_ALC_DIR` is already set in the container; the binary is the gated alpha.2 above (not a candidate).
- **Pass conditions, both required:**
  1. `leg C: PASS`, with 24 facts (15 contract `matches`, 8 defect `defect-present`, 1 warn);
  2. **the line `C: serve-keep-reasons = matches` — EXPLICITLY.** For this run, any other reading is a STOP, even
     though the gate itself would pass with a warning (the warn kind exists for FUTURE pins, not for this proof).
- The overall gate outcome of a C-only run is `infra-fail` (the other legs did not run). That is expected and is
  not read; no receipt is written (no nonce), so `.gated` does not change.

## (c) STOP rules (each is reported as found, never reinterpreted, never retried into a pass)

- any per-mutant difference between L-keep and L-close (verdict, killing test, coverage filter), or fewer than 406
  verified texts;
- L-keep starting more than 1 daemon (each extra start is named: the suite before it and the row that closed it, read
  from `keep.log` and the report), or L-keep starting 0;
- L-close starts != L-close requests;
- `serve-keep-reasons` reading anything but `matches`, or leg C not `PASS`, or a fact count other than 24;
- a binary sha256 other than the one in section 0, or a dirty worktree other than the tap's own commit.

A leg is never signal-stopped (lane rule). A STOP ends the proof; the next step is the lane's ruling.

## (d) Heavy jobs

Each leg (L-close, L-keep, leg C) is a local al-runner job: at most 2 heavy jobs container-wide, counting this one.
Before each leg: `ps` shows at most 1 other al-runner / itest / corpus job, and `free -g` shows at least 10 GB
available; otherwise wait. The legs run one at a time, in this order: L-close, L-keep, leg C; each in its own
background job, logging as it runs. No BC server and no lease are involved.
