# R-587 build plan r2: split `itest:alrunner` into independent legs

**r2 (2026-10-21), after review-opus-plan.md.** It overrides r1 below wherever they differ.
- **Narrowing: `--legs` takes GROUP names only** (sandbox, layout, multiobject, wrapped, names,
  symbols-lethala, symbols-lethalb).
  - Gone: per-leg selection, `requires`, `need()` and the auto-add banner.
  - Every cross-leg check is within a group, so no check can lose its partner.
  - The receipt and `ran` still carry the 23 leg ids.
  - The resolver's tests shrink to "group name → its legs; unknown or empty → throw with the list".
- **B1:**
  - one `leg(id: LegId, fn)` wrapper decides both "skip" and "ran";
  - it adds `id` only after `fn` resolves with a report holding at least one mutant;
  - `LegId` is a literal union from the registry;
  - each cross-check lives inside its checker leg's `fn`;
  - an offline wrapper test (unselected → not ran; throw → not ran);
  - plus a test that a group run's `ran` equals exactly that group's ids.
- **B2:**
  - `--reports` must be empty (refused otherwise), or a per-run `mkdtemp` subdir is used;
  - the supervisor mints a run nonce, and every `<id>.json` carries it;
  - each worker writes `<group>.done.json` (its `ran` ids plus the nonce) after its last check, including
    `unmeasuredReproductionFigures`;
  - the supervisor reads only that file and checks the nonce;
  - `alrunner-legs-diff` refuses a file without the run's nonce, and S and P each record their nonce.
- **I1:** the warm-up runs, serially, before fan-out:
  - one contract probe and one R551 `--test-exact` probe;
  - `provisionOnce` once per distinct (testDir, preprocessorSymbols) pair across the 7 groups.
  It refuses to fan out unless they all name the same platform-apps dir, and prints them. The r1 claim "keys
  never collide" is withdrawn.
- **I2:**
  - `realpath(LETHAL_ALRUNNER_PATH)` is resolved once at gate start (both modes) and passed to the workers;
  - the supervisor asserts every worker's build line equals its own;
  - the pre-commitment: S and P with different build lines are VOID.
- **I3:** `alrunner-legs-diff` gives VOID on `textUnverified > 0` for any leg.
- **I4:** an offline test of the REAL spawn and exit glue against a fake worker script: exit 4 with no
  done-file, SIGKILL, and exit 0 each fail, naming the group.
- **I5:**
  - workers turn SIGINT/SIGTERM into a throw, so `finally` runs;
  - workers exit when `process.ppid` changes (polled);
  - the supervisor exits non-zero after forwarding a signal (tested).
- **Minors:**
  - M1: `tick.ts` reads the registry list first, and refuses a number for a leg that has a list.
  - M2: workers print `worker <group>: done (<ids>)`, never PASS or PARTIAL.
  - M3: the `[group]` prefix is added in the supervisor's reader.
  - M4: worker `cwd` is pinned, with a test.
  - M5: `itest-timeline` uses the start and done markers and pid subtrees.
  - M6: fix the "cli-default last" prose in the itest header and the `runCliDefaultLeg` doc; tell R-592
    (`docs/gates/alrunner.md`).
  - M7: noted.
  - M8: refuse `--parallel` when `--version` is a release at or below 2.12.0.
  - M9: the PARTIAL line says "green".
- **Open questions 1, 2 and 5** are answered by the I1 warm-up and the equality gate (a race goes red, never
  silent). Q3: lower N, never loosen. Q4: the heavy-job rule goes to the orchestrator. Q7 goes to the
  orchestrator.

---

# r1

Drafted by an opus Plan agent (read-only; saved by lethal-preproc), 2026-10-21. Base: `lethal/r587`
(c8545c87 + d5ef2629). Measurement: `measure.md`, `run1/`.

## 0. Shape
- **Leg registry:** a new pure module, `packages/runner/itest/alrunner-legs.ts`, holds the ONE exact list of
  23 leg ids, their fixture groups and their partner legs (`requires`).
- **Modes:** `al-runner.itest.ts` keeps its sequential in-process path and gains:
  - `--legs <ids|groups>`: a subset, with partners auto-added and announced;
  - `--parallel[=N]`: a supervisor that does one serial warm-up, then one worker process per fixture GROUP,
    at most N at once.
- **Full PASS:** only a run in which all 23 ids ran and passed prints `al-runner itest: PASS`, exits 0 and
  writes a `passed` receipt. Anything else fails, is refused, or exits 4 with a `PARTIAL` last line.
- **Receipt consumers** (`scripts/agentflow/receipt.ts`) check the exact id set, not a count.

## 1. Leg ids (registry order = sequential order; partners are earlier, in the same group)

| group | ids (`requires` in brackets) |
|---|---|
| sandbox | sandbox-a, sandbox-b [a], sandbox-server [a], sandbox-resource [a], cli-default [a] |
| layout | layout-one-shot, layout-server [one-shot] |
| multiobject | multiobject-one-shot, multiobject-server [one-shot], multiobject-resource [one-shot] |
| wrapped | wrapped-one-shot, wrapped-server [one-shot], wrapped-resource [one-shot] |
| names | names-a1, names-a2 [a1], names-a3 [a1], names-a4 [a1, a2] |
| symbols-lethala | symbols-lethala-one-shot, -server [one-shot], -resource [one-shot] |
| symbols-lethalb | the same three, for LETHALB |

- `platform-pin` is dropped as a subleg name: it is a check inside `sandbox-a`/`sandbox-b`, not a leg.
- A and B get separate ids, and the six symbol legs are added.
- `cli-default` moves from last place to the end of the sandbox group (5th). R345 is closed, so the
  `runCliDefaultLeg` "one al-runner session at a time" doc comment is updated.

## 2. Decisions on the measurement's open questions
1. **Shared cache.** A serial warm-up, with the section 6 equality gate as the proof; no separate cold-cache
   measurement.
   - Workers compile different fixtures, so their `al-out` keys never collide.
   - A, B and cli-default share the sandbox worker.
   - A cold or moved `ncl-shadow` is created by the warm-up before any worker starts.
   - Ruled out by name: "upstream moves the BC build during the ~20 min run". Sequential runs carry the same
     exposure. The extra parallel exposure, two downloads into one directory at once, would show in the
     equality gate.
   - A per-leg cache directory is a follow-up only if the equality gate goes red.
2. **Concurrent `provisionOnce`.** Serialise it: the supervisor makes one `AlRunnerBackend.provisionOnce()`
   call first (sandbox config, a scratch `instrumentedDir`, `TEST_DIR`).
   - It prints the reported `platformAppsDir`, and REFUSES to fan out (exit 1) if no directory is reported.
   - Verify on the first run that it pins with an empty bundle dir; if not, use one deployed bundle.
3. **cli-default alone.** It always pulls in `sandbox-a` and keeps comparing `legShape(report)` with
   `expectedCliDefaultShape(legA)`. It NEVER compares with `al-runner.baseline.json`, because:
   - that file is a different identity space: `keyOf` rows at scheme 38, while cli-default's baseline is 40;
   - cli-default already compares with its own frozen baseline;
   - the claim is "the CLI default equals one-shot per mutant, on THIS build, in THIS run" (R387/R394);
   - the provenance lines need leg A's live report;
   - leg A costs 121 s.
4. **B, C and D determinism:** each is its own id, and `requires: [sandbox-a]` adds A.
5. **Server and resource legs alone:** the one-shot sibling is auto-added. "Table only" is rejected,
   because per-mutant equality with one-shot is the anti-inertness half of R220/R222/R321.
6. **Cross-leg checks under a subset:** add the partner automatically. Never refuse, never substitute the
   baseline.
   - The banner says `legs: <requested> -> <resolved> (added: <ids> for cross-leg checks)`.
   - Each cross-check calls `need(partnerId)`, which throws `R-587: <leg> ran without its partner <p>`. A
     registry bug therefore goes red, never silently skips.
7. **Isolation:** one process per fixture GROUP, with the legs inside a group in order, as today.
   - It avoids the global `console.warn` swap in `runWrappedLegs` and the shared `unmeasured` list.
   - All cross-checks stay in-process, cli-default included.
   - It reuses the `run*Legs` code.
   - Splitting inside a group saves at most 161 s on the critical path; not done.
   - Bun `Worker` threads are rejected: their isolation was never measured.
8. **Sharding the wrapped one-shot leg: OUT of scope.**
   - `workers > 1` is a different code path from the gated `workers = 1`.
   - Recombining shards needs per-shard handling of the R577 store check and the baseline comparison.
   - The floor would only fall from about 20 to about 16 min (names is 957 s).
   - A follow-up candidate, if any: an ADDITIONAL `workers > 1` leg, never a replacement.
9. **Slowdown:** measured inside the equality gate, with per-leg `leg <id>: done in <s>s` lines and the
   tree's peak PSS (`itest-timeline.ts run`).
   - Default N = 3, hard maximum 5. Longest-first scheduling (wrapped 1175, names 957, sandbox 423,
     symbols-a 161, symbols-b 151, multiobject 150, layout 148) reaches the 1175 s critical path already at
     N = 3.
   - Predicted peak: about 4 GB.
   - Watch for CPU contention pushing a test past `AL_RUNNER_TEST_TIMEOUT_SEC`.
10. **Busy container:** S and P run one after the other, never together, logging the other heavy jobs every
    30 s.
- **Heavy-job counting:** workers are spawned as
  `bun packages/runner/itest/al-runner.itest.ts --worker --legs <group ids> --reports <dir>`.
  - **Proposed rule:** a heavy job is a `bun packages/runner/itest/` process WITHOUT `--worker` in its argv,
    so the supervisor is the one counted job.
  - Until that rule is adopted, a parallel run shows as 1 + N; say so in status lines.

## 3. CLI, environment, printing, exit codes
- **Commands:**
  - `LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner`: the full sequential run, unchanged.
  - `... -- --legs wrapped-server,names` (ids or groups);
  - `... -- --parallel` or `--parallel=N` (1 to 5), combinable with `--legs`;
  - `--reports <dir>`: each leg writes `<dir>/<legId>.json` after its own checks pass. It is always set in
    parallel mode (a fresh temp dir, or the one given, printed at start). Worker logs go to
    `<dir>/<group>.log`, console lines get a `[<group>] ` prefix;
  - `--worker`: internal.
- **Refused at start (exit 2, `emitFailed` when a receipt was demanded):**
  - an unknown flag, an unknown id, or an empty `--legs`;
  - `--parallel` outside 1 to 5;
  - `--worker` without `--legs`, or with any `LETHAL_GATE_*` set;
  - `--legs` while a receipt challenge is set;
  - `LETHAL_ITEST_RECORD_BASELINE` or `..._SYMBOL_BASELINES` together with `--legs` or `--parallel`
    (recording stays full and sequential, R332).
  - The preflight of ALL baselines still runs in every mode.
- **Leg wrapper:** `leg <id>: start` / `leg <id>: done in <s>s`, and the id is added to `ran`.
- **Exit codes:** 0 = full PASS only; 1 = fail; 2 = refused; 3 = record (unchanged); 4 = partial pass. Workers
  exit 4, and the supervisor treats any other worker code as a failure.
- **Last lines:**
  - full: exactly `al-runner itest: PASS`;
  - partial: `al-runner itest: PARTIAL, <k> of 23 legs ran and passed (<ids>); NOT a gate pass, run without
    --legs for submit and merge`. It never contains `itest: PASS`;
  - parallel mode also prints `mode: parallel N=<n>` and a per-leg wall-time table.
- **Supervisor:**
  - warm-up, then a `Semaphore` (`packages/runner/src/pool.ts`) over the groups, longest first;
  - SIGINT and SIGTERM forwarded;
  - no fail-fast;
  - `ran` = the union of the assigned legs of workers that exited 4 AND wrote `<dir>/<id>.json` for every
    leg. A missing file is a named failure;
  - full only if `isFullRun(ran)`;
  - only the supervisor writes the receipt, and `workerEnv(env)` deletes the four `LETHAL_GATE_*` keys.
- **Receipt:** `emitPassed("alrunner", { sublegs: fullRunSublegs(ran) })`. `fullRunSublegs` returns
  `ALRUNNER_LEG_IDS` and throws unless `ran` equals it exactly.

## 4. Receipt consumers
- `scripts/agentflow/receipt.ts`: `ReceiptChallenge.expectedSublegs` becomes `number | readonly string[]`. An
  array must equal the receipt's ids exactly, naming any missing or extra id. Fix the "itest:alrunner has
  four" comment.
- `gate-table.ts`: export `EXPECTED_SUBLEGS = { alrunner: ALRUNNER_LEG_IDS }`.
- `tick.ts`: both call sites become `input.expectedSublegs?.[leg] ?? EXPECTED_SUBLEGS[leg] ?? 1`. Today's
  `?? 1` would REJECT the 17-name receipt and ACCEPT a 1-leg one.
- `fakes.ts`: return the array.
- `receipt-roundtrip.test.ts`: use `ALRUNNER_LEG_IDS`.
- `gate-receipt.ts`: doc comment only.
- No coord or kraken submit tooling reads receipts. `al-runner-update.sh` reads only a full run's exit code.

## 5. Offline tests (a red check each direction)
- **`alrunner-legs.test.ts`** (a pure module; passes `importable-scripts.test.ts`):
  - the 23 ids are pinned literally and unique; the `requires` map is pinned; partners are in the same group
    and earlier; every id appears as `leg("<id>"` in `al-runner.itest.ts`;
  - `resolveLegs`: names-a4 gives [a1, a2, a4] with added [a1, a2]; cli-default gives +sandbox-a; the group
    alias works; duplicates collapse; unknown or empty throws, listing the ids;
  - `isFullRun` / `fullRunSublegs`: 23 gives true; 22 gives false; 23 with one duplicate gives false; 22 plus
    an unknown id gives false; today's 17 names give false;
  - `finalLine` / `exitCodeFor`: full gives PASS and 0; partial does not match `/itest: PASS/` and gives 4;
  - `startupRefusal`: each refusal; `--legs` with a challenge refused, without one accepted;
  - `workerEnv`: strips the gate keys and keeps the others;
  - `combineWorkers`: all exited 4 with all files gives full; any exit 1 fails; any exit 0 fails; a missing
    file fails naming the leg;
  - `scheduleOrder` is pinned.
- **`receipt.test.ts`:** the exact array passes; a missing id throws; an extra id throws; the old 17 names
  throw; the count path is unchanged. **`tick.test.ts`:** the alrunner default uses the ids.
- **`alrunner-legs-diff.test.ts`:** equal gives 0; a swapped verdict gives 1; a missing leg gives 1; a
  different `killingTestFailure` on names or wrapped gives 1.

## 6. Gates
1. **Pre-commitment on master before any run:**
   - S (full sequential) and P (`--parallel=3`, challenged) both PASS, exit 0;
   - for each of the 23 ids, `compareReports(S/<id>.json, P/<id>.json)` is IDENTICAL per `keyOf`: verdict,
     `killingTest`, `coverageFiltered`, `errorClass` and the mutated-text hash; `killingTestFailure` is equal
     on the names and wrapped legs;
   - P's receipt passes `validateReceipt` with `ALRUNNER_LEG_IDS`;
   - P's peak tree PSS is at most 8 GB;
   - timing is predicted only (P about 1200-1500 s against S about 3000 s; one-shot slowdown ≤ 1.3x);
   - a mutant that turns timeout-killed under load is an equality FAIL.
2. **Run S:** `bun scripts/itest-timeline.ts run /coord/handoff/R-587/seq -- env LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner -- --reports /coord/handoff/R-587/seq/reports`.
3. **Run P:** the same under `/coord/handoff/R-587/par` with `--parallel=3` and the four `LETHAL_GATE_*` set.
   It runs after S.
4. **Compare:** `bun scripts/alrunner-legs-diff.ts seq/reports par/reports` gives 23 IDENTICAL and exit 0;
   then `validateReceipt`.
5. **Timing:** the table goes in `/coord/handoff/R-587/compare.md`.
6. **Live red checks (layout, about 150 s):**
   - `--legs layout-server` auto-adds one-shot, ends PARTIAL, exits 4, and writes no receipt;
   - the same run with a challenge gives exit 2 and a failed receipt.
7. **CLAUDE.md:** a PROPOSAL to the orchestrator, coordinated with R-592. The `--legs` and `--parallel`
   lines, the 23-id receipt line, and a runbook heavy-job line.

## 7. Files, in order
1. `itest/alrunner-legs.ts` (new) and its test.
2. `itest/al-runner.itest.ts`:
   - parse arguments after the skip check;
   - `runSandboxLegs(sel)` with cli-default at its end;
   - `sel` passed into each `run*Legs`, with `sel.has` and `need()`;
   - group baseline comparisons only when the reference leg ran;
   - `unmeasuredReproductionFigures` checked per process;
   - the `leg()` wrapper, worker mode and supervisor mode;
   - the end of `main` through `finalLine`/`exitCodeFor`/`fullRunSublegs`.
3. `scripts/agentflow/receipt.ts`, `gate-table.ts`, `tick.ts` and `fakes.ts`, and their tests.
4. `gate-receipt.ts` (doc).
5. `scripts/itest-timeline.ts`: uniform `leg <id>: done in` markers.
6. `scripts/alrunner-legs-diff.ts` (reuses `compareReports` from `scripts/report-diff.ts`) and its test.
7. The pre-commitment, then `compare.md`, and the CLAUDE.md and runbook proposal.

## 8. Risks
- **A worker writes the receipt:** `workerEnv` strips the keys and workers refuse while they are set
  (tested).
- **The 1 + N heavy-job count** until the `--worker` rule is adopted.
- **CPU contention moves a timing-sensitive verdict:** the equality gate catches it; lower N, never loosen
  the check.
- **Two downloads into `platform-apps` at once:** caught by the equality gate or R147.
- **The warm-up pin with an empty bundle:** verify on the first run.
- **Registry and code drift:** an unwired id makes a full pass impossible (fails safe); a wired-but-missing
  id is caught by the `leg("<id>"` test.
- **Orphaned daemons:** signals are forwarded, and `finally { backend.close() }` stays.
- **The order change breaks `itest-timeline`:** fixed in step 5.
- **R-592 is editing CLAUDE.md at the same time:** proposal only.
- **Dropping the `platform-pin` subleg name:** only `receipt-roundtrip.test.ts` and `receipt.test.ts` pinned
  it.
