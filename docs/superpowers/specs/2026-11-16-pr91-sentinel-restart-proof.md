# PR-91: an opt-in sentinel proof for a restarted serve daemon (`alRunnerV3.restartProof: "sentinel"`), r2

Status: **CLOSED, NOT BUILT** (owner, q-20261116T214008-a938ded5, 2026-11-16). Lever 2 is closed as measured.

**The close note: do not reuse the old figure.**
- **The old estimate.** This spec (and R1092, PR-90) gave the restart warm-up as "~16-20 s of each ~25 s re-proving the
  codeunits' tests", 2,400-3,000 s per DO window. That was inferred by subtracting plain-source start costs (a cached compile
  of 2-5 s) from ~25 s. It was wrong.
- **The measured split** (r2 review finding 6, then `/coord/handoff/PR-91/p3.ts` on the FULL instrumented DO app: 43,518
  deployed mutants, edge-4ebfe7913, two fresh daemons in turn):

| part of a restarted daemon's cost | daemon 1 | daemon 2 |
|---|---|---|
| first request `compileMs` (the instrumented app, recompiled in full on every restart: upstream #8143) | 25,801 ms | 27,779 ms |
| first request `baselineMs` (install baseline) | 1,052 ms | 1,283 ms |
| first request `setupMs` | 730 ms | 631 ms |
| full proofs of 5 DO codeunits, 170 tests (`testsMs`, kept daemon) | 2,515 ms | 3,464 ms |
| the same as two-test `runSelectedOnly` sentinels | 661 ms | 742 ms |

- **What follows.** A warm-up is the recompile. The sentinel would save ~0.4-0.55 s per proven codeunit, ~2-3% of a
  ~29 s restart (~100-200 s per window). That does not pay for a weaker proof and its upkeep (owner; design mantra 4, 13).
- **The real levers:** upstream #8143 (keep the compiled app under test in the disk compile cache; its maintainer is
  drafting the design amendment; these numbers are on the issue, comment 6930199171), and fewer restarts (lever 1, R1095).

Kept below as the record: r2 after spec-adversary review r1 (2026-11-16, lethal-preproc). r1's findings are answered in §8.
r2's own review (finding 6) is what stopped it.

Owner ruling (q-20261116T202251-10c61454): build it as an opt-in profile; the default stays today's full proof. Conditions:
- (a) every run and verdict under the profile says so, in the report and the store;
- (b) spec and spec-adversary first, then a DO window comparison against a full-proof window, with 0 verdict moves committed
  before the run; a different result blocks;
- (c) any sentinel mismatch falls back to the full proof;
- (d) the 0-of-1,028 figure is recorded as evidence, not proof.

## 1. Today (PR-24, R1035) and what it costs
- **Today's proof.** A restarted daemon (`spawnRestarted`) proves each codeunit before its first use there (`proveOnDaemon`):
  1. it sends one NONE warm-up entry over the codeunit (all tests, minus `leftOutNames`);
  2. `judgeWarmup` checks the echo, agreement with this batch's baseline, and no unkept refusal row;
  3. a difference throws `al-runner-v3-entries-warmup-disagrees` and the session stops.
- **What it costs on DO.** ~16-20 s of each ~25 s DO warm-up are those tests (PR-90). That is an estimated 2,400-3,000 s of
  t10's 6,992 s mutant phase.
- **Evidence (not proof, (d)).** 1,028 DO warm-ups in t1-t10 and 0 failures (`/coord/handoff/PR-91/options.md`).

## 2. The measured fact the design rests on (probe, `/coord/handoff/PR-91/probe/`, edge-4ebfe7913, invented app)
- **`excludeTests` alone hides rows; it does not skip execution.** A codeunit entry with `excludeTests` still RUNS the
  excluded tests and only hides their rows:
  - 10 CPU-burning tests: all 10 took 124-140 ms;
  - with 8 excluded: 104-143 ms;
  - with 8 excluded and `runSelectedOnly: true`: 24-32 ms.
  - (v3: `run_only` is set only by `runSelectedOnly` or a single-method selection; `run.rs`.)
- **A `runSelectedOnly` PREFIX gives exactly the full run's first rows** (`carry.ts`, a codeunit whose OnRun sets state and
  whose tests carry a global forward):
  - full run: `C01 pass, C02 102, C03 103, C04 104`;
  - prefix of 2: `C01 pass, C02 102`;
  - prefix of 3: `C01, C02 102, C03 103`.
  - A selection with a GAP really skips the missing test (C01 and C03: C03 sees 102), so only a prefix is sound.

## 3. The profile
**Setting.** `alRunnerV3.restartProof`: `"full"` (default; today) or `"sentinel"`.
- Any other value is refused by name at config load.
- On a configured one-shot transport it is refused by name.
- A default-transport session that falls back to one-shot (R786/R960), and a codeunit that runs one-shot inside serve
  (R937), keep the label; the banner then states N = 0 sentinel proofs.

**Under `"sentinel"`, `proveOnDaemon` proves each needed codeunit `cu` like this:**
1. **Eligibility.** `cu` gets the sentinel only if all of these hold:
   - it is a plain codeunit call (a positive call id; a negative, isolated call id, R857/R896, is one test and gets
     today's proof, never counted through `Math.abs`);
   - after `leftOutNames`, its first two baseline rows are two DISTINCT methods that v3's discovery lists. Not two cases of
     one data-driven method (ADR-059), which v3 counts as one pick and would run alone (#7207);
   - `cu` has at least three runnable tests (with two or fewer, the sentinel is the full proof);
   - no later test's name is a prefix of either of the two (v3's case-insensitive match, #8059): such a test could not
     be excluded and would run after a gap.

   Otherwise `cu` gets today's full proof.
2. **The sentinel request.** One NONE warm-up entry for `cu` selecting exactly those two tests: `excludeTests` = every
   other test, and `runSelectedOnly: true` on that warm-up request only (as `aloneCall` sets it for its request, R895).
   - The expected rows are the baseline's rows of exactly those two methods, required non-empty and both returned.
   - It is judged by `judgeWarmup`'s rule on them: echo, agreement, no unkept row.
3. **A sentinel that agrees:** `cu` is proven on this daemon. It is counted (`sentinelProofs`).
4. **A sentinel that disagrees (c):**
   - today's full proof of `cu` runs on the same daemon and is judged as today;
   - if the full proof disagrees, today's refusal stops the session;
   - if the full proof agrees, its rows for the two sentinel tests are compared with the sentinel's own rows:
     - if they differ, the run_only path answered differently from the full path on the same daemon. That refuses by name
       (`al-runner-v3-entries-sentinel-path-disagrees`, naming both answers) and the session stops: the profile is not
       usable on this project, and the report says so;
     - if they are equal, LethAL built the sentinel's expected rows wrongly. That throws an internal error, never "goes on".
   - In both cases the mismatch is counted and named (`sentinelMismatches`).
5. **An unkept refusal row in the sentinel:** today's refusal (`warmup-dirty`, or R786's fallback on the default transport),
   as the full proof would give.

**Counters.** A sentinel warm-up and a fallback full proof each count in `stats.warmups` (R652's `boundChecks` invariant)
and add to `lastWarmupMs` (R785). Neither counts toward R952's request bound (as PR-24's lazy warm-ups).

**Unchanged:**
- the first mutant daemon of each lane and mode still warms the whole union;
- the baseline;
- echoes, kill pairs and R577's reproduction;
- R612;
- PR-89's lanes (each lane's daemons, the setting per lane).

## 4. What the sentinel gives up, honestly
- **The risk.** A daemon-specific wrong row in a test the sentinel did not run would be read by a mutant entry.
- **False kills are mostly guarded already.** v3 sessions run with `killsMustReproduce` (R577): a kill must reproduce, and
  its NONE confirm runs the killing test on NONE. A daemon-wide wrong `fail` makes that confirm fail, so no kill is scored.
  To check while building: whether the kill paths that are not re-sent (PR-43's cpu-stop kills, stored pairs, R778) keep
  that confirm.
- **The remaining risk is a false survival:** a wrong `pass` hides a kill. That is the safe direction, but it is still a
  wrong verdict.
- **The record.** 0 of 1,028 is evidence, not proof (d).

## 5. Labels (a)
**Design (b): `restartProof` is NOT in the session fingerprint.** A `--resume` may continue a full-proof store under
`"sentinel"`, or the reverse, and the per-mutant labels carry the difference. This is what makes the DO comparison (§6)
possible: resume two copies of the same store state.

**Report:**
- `SessionReport.restartProof` (`"full"` | `"sentinel"`), the session's value, always written, plus `sentinelProofs` and
  `sentinelMismatches`;
- a banner line under `"sentinel"`;
- every mutant SCORED in a `"sentinel"` session gets `restartProof: "sentinel"`. That is conservative: also those that ran
  only on fully proven daemons;
- carried verdicts keep the label of the run that scored them;
- the CLAUDE.md ripple: `events.ts`, `report-fold.ts`, `report.ts`, `generate-schemas.ts`, `tests/schemas.test.ts`,
  `report-equality` snapshots, the committed sample reports.

**Store:**
- `runs.restart_proof` and `mutants.restart_proof`, both NOT NULL after migration. The migration backfills `'full'`
  (today's only behaviour).
- Every insert takes the value as a required parameter.
- A carry copies the source row's value.
- A NULL read throws.
- `itest/lend-seed.ts` and every other path that copies run or mutant rows is listed and updated.

## 6. Pre-commitment (b), committed to master before the measured runs
**Fixture leg** (new, beside the v3 gate; the v3 gate itself unchanged and per mutant equal under the default):
- `sandbox-data` and `sandbox-data-tests` under `"sentinel"`, with a forced restart after every request (PR-24's leg shape);
- verdicts and `killingTest` per mutant equal to the same leg under `"full"`;
- `sentinelProofs` ≥ 1, `sentinelMismatches` 0;
- every scored mutant labelled.

**PR-90's scope** (k1, `"sentinel"`):
- verdicts and `killingTest` equal k1's;
- `sentinelProofs` ≥ 1 (it restarts on 3 refusal closes), `sentinelMismatches` 0.

**DO:**
- **The setup.** Two copies of the same R-984 store state, each resumed for one window of the same budget on the same
  build: one `"full"`, one `"sentinel"`.
- **The comparison.** By lethal-bugs' window agreement script, with equal verdicts AND `killingTest` per mutant scored by
  both.
- **Committed:**
  - 0 verdict or `killingTest` moves;
  - `sentinelMismatches` 0;
  - mean warm-up wall per warm-up (`warmupMs / warmups`, daemon starts included) under `"sentinel"` at most 50% of the
    `"full"` window's.
- A move blocks; the result is never re-recorded.

## 7. Tests (each red-checked in both directions)
1. `"full"` and no setting: today's full NONE warm-up; labels `"full"`.
2. `"sentinel"`: the sentinel request selects exactly the first two eligible tests and carries `runSelectedOnly: true`. The
   NEXT request on the daemon does not carry it.
3. Ineligible codeunits get the full proof:
   - a two-test codeunit;
   - a data-driven first method;
   - a prefix stay-in;
   - an isolated negative call id.
4. A disagreeing sentinel falls back:
   - full proof agrees, rows equal: internal error;
   - full proof agrees, rows differ: `sentinel-path-disagrees`;
   - full proof disagrees: today's refusal.
5. The expected rows must be non-empty and both returned: a fake returning no rows is a mismatch, never a pass
   (empty-vs-empty).
6. An unkept sentinel row gives today's refusal.
7. Labels:
   - report field, banner and counters;
   - every scored mutant labelled;
   - a resumed `"sentinel"` session over a `"full"` store keeps the carried rows `"full"` and labels its own scored rows
     `"sentinel"`;
   - the store columns are required and backfilled;
   - a NULL read throws.
8. Config:
   - an unknown value is refused by name;
   - `"sentinel"` with a configured one-shot transport is refused by name.

## 8. Review r1 (opus spec-adversary), answered
1. **Excluded tests still run.** Confirmed by probe (§2). Hence `runSelectedOnly` on the sentinel. Its path is argued by the
   probe's prefix result and guarded by step 4's sentinel-path check.
2. **A mismatch then an agreeing full proof must not just continue.** Step 4: compare the two answers; refuse or throw.
3. **The fingerprint and the DO resume contradicted each other.** Design (b) chosen (§5): no fingerprint key, per-row labels.
4. **The sandbox-app leg was vacuous.** Moved to `sandbox-data` (codeunits with more than two tests), with
   `sentinelProofs ≥ 1` pre-committed.
5. **Empty-vs-empty, data-driven methods, prefix stay-ins.** Eligibility rules and test 5.
6. **The unkept-refusal path.** Today's refusal; the per-session set and the `proven` kind are dropped.
7. **NULL read as `"full"`.** Required columns, a backfill, and a NULL read throws.
8. **Isolated ids, one-shot fallback, counters, a testable pre-commitment.** All in §3 and §6.
