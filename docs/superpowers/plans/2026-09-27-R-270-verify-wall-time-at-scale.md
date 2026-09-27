# R270: verify's wall time against a full run at scale, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 1 (2026-09-27),** after review r1 (`H:/lethal-coord/reviews/R-270-plan/review-r1.md`) and the orchestrator's rulings 1 to 8. Changed: the gated workload is ALL survivors, fixed now (ruling 1); the boundary is strictly `< 0.20`; the gated time is the CLI path, `verifyFromCli`, and the library timing is labelled as such (ruling 2); B is checked by per-identity VERDICT equality plus the one expected baseline failure, never `diffMutants` (ruling 3); the timeline labels the interval after the mutants phase as mixed and Task 5 triggers only on an attributed phase (ruling 4); the gated verify runs three times (repeated, not interleaved, since Revision 2), under a pre-committed noise policy (ruling 5); the restore covers A, B1 and B2 (ruling 6); Task 5a keeps only with tests for both failure orders (ruling 7); the pre-commitment carries numeric ranges and the verdict/finding split, and the scratch AL is compiled offline first (ruling 8). See "Review responses" at the end.

**Revision 2 (2026-09-27),** after review r2 (`H:/lethal-coord/reviews/R-270-plan/review-r2.md`) and the orchestrator's final rulings. Changed: B1 and B2 run the SAME 74-test scratch suite verify ran, so the three verifies all use one source run A instead of chaining through B (facts 5 and 6, Task 3); `assertVerifyMeasured` compares result ids exactly, rejects duplicates and pins the five new-test names (Task 2); the noise limit is a gate assertion (Task 7A); Task 5a's both-fail tests are labelled as tests of the new behaviour; the ratio range is a coupled model estimate; the no-op workload limit is explicit.

**Goal:** Measure, on the largest committed fixture, whether `lethal verify` over EVERY survivor takes under 20% of a warm fresh full run, then either gate that on the fixture or report to the owner that it is not met, with numbers.

**Architecture:** Measure first, change no product code first. An offline probe times verify's pre-lease reads. One env-gated driver, `packages/runner/itest/verify-scale.itest.ts`, runs on `fixtures/sandbox-data`: a source full run A with the committed suite, then verify over all 63 survivors through `verifyFromCli` three times against A, then small-k scaling points and one labelled library timeline against A, then two fresh full runs B1 and B2 with the same 74-test scratch suite verify ran, then a restore. A pure helper module holds everything that can be tested offline. The last task is a gate (if met) or a report (if not).

**Tech Stack:** Bun + TypeScript, `bun:sqlite` store, Cronus28 through `BcDevMcpBackend`, `alc`.

**Spec:** `docs/roadmap/R270.md`. Inputs: `docs/superpowers/plans/2026-09-26-C02-08-verify-agreement-gate.md` (driver pattern, restore), `docs/superpowers/specs/2026-09-26-c02-08-agreement-precommitment.md` (pre-commitment style), `.claude/skills/measurement-campaign/SKILL.md`, `docs/superpowers/runbooks/autonomy/README.md`.

## What the code already tells us

From master at `4267d91`.

1. **`runVerify`'s `timings.totalMs` is not `lethal verify`'s wall time.** `runVerify` (`packages/runner/src/verify.ts`) returns `{ totalMs, compileMs?, publishMs? }` measured from its own first line. `verifyFromCli` (`packages/runner/src/cli.ts`) first opens the store, loads the config, resolves selector ids and calls `buildBackend` (which starts the bc-dev MCP subprocess), and closes the backend after. Only a clock around `verifyFromCli` is the command's wall time (ruling 2).
2. **`verifyFromCli` needs `selectorIds` in the config on sandbox-data (R261).** It resolves selector ids from the config file, and `fixtures/sandbox-data/lethal.config.local.json` has none, so the defaults (79199...) fail against the app's 79300-79399 range. The driver writes a TEMP copy of that config with `"selectorIds": { "selectorId": 79399, "controlId": 79398, "tableId": 79397 }` (the ids `tables.itest.ts` uses) and passes it as `configPath`. The committed and gitignored configs are not edited.
3. **Where verify's time can be attributed, and where it cannot.** `runNamedMutants` (`orchestrator.ts`) calls `scoreBatch`, which emits `phase-left` for `baseline` and `mutants` with `elapsedMs`. After that, the new-test reruns run (one `dispatchUnmutated` per new test, no event), then `closeLeaseScope` emits `phase-left` for `teardown`. So the interval from `mutants`' `phase-left` to `runVerify`'s return is reruns + teardown + return work, and the plan labels it `postMutantsMixedMs`, never "rerun". Pre-lease reads (`assertSourceUnchanged` via `hashTargetSource`, `loadInstalledArtifact`, `planVerify` via `discoverTests`) emit nothing; they are attributed OFFLINE by Task 1. Events carry only a `seq`, so the driver stamps `Date.now()` itself.
4. **Survivors are the costliest mutants.** A killed mutant stops at its first failing covering test; a survivor runs all of them. So all-survivor verify costs close to the survivors' share of the full run's mutant phase plus verify's fixed cost. The plan therefore predicts "not met" (Task 4).
5. **Verify's source must be the resident build, and the denominator must run the verified tests.** The full run verify replaces is a full run WITH the tests verify checked, so B1 and B2 run the same 74-test scratch suite (69 committed plus 5 no-op) that verify published. A B run with that suite cannot be a verify source (its baseline already holds the five tests, so they are no longer "new"). So the three verifies all name source run A: verify publishes only the test app, never the target, so A's build stays resident through V1 to V3, the scaling points and the library call. B1 and B2 come last. The gated verifies therefore run before the B runs, not interleaved: a warmer, later B only lowers the denominator, which makes the ratio conservative, and the spread comes from repeating V three times.
6. **The scratch app is resident when B runs, and B runs the scratch suite.** Verify published it; B's `testDir` is the scratch copy, so the server holds exactly the tests B discovers and R56's `StaleTestAppError` (a declared test missing from the server) cannot fire.
7. **The fixture.** `fixtures/sandbox-data` + `-tests`: 377 deployed mutants, 299 killed / 63 survived / 15 no-coverage (`packages/runner/itest/tables.baseline.json`), 69 tests in codeunit `79310 "Data Tests"`, exactly one expected baseline failure `Data Tests.PageActionComputesNonZero` (reported in `report.unsupportedTests`). The largest committed fixture, public source, served by Cronus28.

## Global Constraints

- `CLAUDE.md` build order: `bun run typecheck`, `rm -rf packages/*/dist`, `bun test`. Biome only on touched files.
- No `!` assertions; `exactOptionalPropertyTypes`; typed errors extend `Error` directly; throw on empty or ambiguous input.
- No em dashes in any file this work writes.
- Live runs ONLY on Cronus28, under `coord lease Cronus28 code`, heartbeat every 5 minutes, release right after. Check it is up first (`pwsh -File U:\Git\agent-coord\containers.ps1 status -Names Cronus28`).
- The pre-commitment spec is committed ALONE before either live session. Corrections are APPENDED.
- The denominator is a WARM fresh full run: it runs after A in the same lease, no container restart, no `resume` key (R247), and `assertFreshFullRun` (`packages/runner/itest/verify-agreement.ts`) passes on it.
- **The gated workload is every survivor of the source run (63), fixed now. Smaller k are scaling data only and are never gated. The line is strictly `< 0.20`.** A "not met" at 63 is reported as not met; it is never replaced by a smaller k.
- Never weaken a gate or frozen figure: `tables.baseline.json`, `itest:tables`, `itest:agreement` and `itest:verify` are untouched. A VERDICT difference is a BLOCK to the owner.
- No file or comment may say the 20% goal is met unless Task 7A's gate passed in both sessions.
- Re-check the next free roadmap id with `ls docs/roadmap/` before writing one.

## Review Focus

1. **A fast refusal or a partial verify read as a fast verify.** Every gated or scaling verify must have exit 5, a result-id SET exactly equal to the requested ids with no duplicate, every row `survived`, and exactly the five expected new-test names, all `stable` (`assertVerifyMeasured`, Task 2). Exit 5 alone also means "a new test is not stable" (`verifyExitCode`), and a count alone would pass a dropped survivor replaced by a duplicate row.
2. **A cold, resumed or broken denominator.** A runs first; each B passes `assertFreshFullRun`, per-identity verdict equality with `tables.baseline.json` (`verdictDiffs`), and `assertOnlyExpectedBaselineFailure`. An extra failing baseline test would change B's time without moving a verdict.
3. **A verify pointed at a build that is no longer resident.** Every verify names A's artifact and runs before B1 publishes (fact 5); the driver asserts A's store's last artifact id equals the one it passes, and that no full run began between A and the last verify.
4. **The scratch test app left on Cronus28.** The restore names the one resident artifact among A, B1 and B2 (including a B that began and deployed part way), compiles the committed suite against it, publishes, and compares a fresh read-back hash. `itest:tables` afterwards is NOT proof the scratch app is gone (its tests are a subset of the scratch app's); the read-back hash is.
5. **Noise near the line.** The gated ratio is the WORST pairing, `max(V1,V2,V3) / min(B1,B2)`, in each session; "met" needs `< 0.20` in both AND `max(V)/min(V) <= 1.5` in both. The gate asserts both (Task 7A).

## File map

| File | Status | Responsibility |
|---|---|---|
| `scripts/probe-verify-prepare.ts` | Create | Offline timing of `hashTargetSource` and `discoverTests`. |
| `packages/runner/itest/verify-scale.ts` | Create | Pure helpers (below). |
| `packages/runner/itest/verify-scale.test.ts` | Create | Their offline tests. |
| `packages/runner/itest/verify-scale.itest.ts` | Create | Env-gated driver (`LETHAL_ITEST_VERIFY_SCALE=1`). |
| `package.json` | Modify | `"itest:verify-scale": "bun packages/runner/itest/verify-scale.itest.ts"`. |
| `docs/superpowers/specs/2026-09-27-r270-verify-scale-precommitment.md` | Create | Predictions, committed alone; results appended. |
| `docs/roadmap/R270.md` | Modify (Task 7) | Close, or add numbers and keep open. |
| `packages/runner/src/verify.ts` | Modify ONLY in Task 5a, if triggered | |

The driver copies `connect`, `lease` and `restore` from `verify-agreement.itest.ts` and adapts them, as every itest here builds its own.

---

### Task 0: Preconditions (read only)

- [ ] **Step 1:** Confirm on master: `verify-agreement.ts` exports `assertFreshFullRun`; `mutant-equality.ts` exports `keyOf` and `NormalizedMutant`; `cli.ts` exports `verifyFromCli` and `VerifyCliConfig`.
- [ ] **Step 2:** Re-read the `StaleTestAppError` check in `scoreBatch` (`orchestrator.ts`) and confirm fact 6 (B's discovered tests equal the resident scratch app's).
- [ ] **Step 3:** Pick the scratch codeunit id: `grep -rhoE "^(codeunit|table|page|pageextension|tableextension|enum|query|report|xmlport) [0-9]+" fixtures/sandbox-data/src fixtures/sandbox-data-tests/src | sort -k2 -n`, take the highest free id below 79397, record it as `NOOP_CODEUNIT_ID`. None free: STOP, Open question 3.
- [ ] **Step 4:** Confirm `fixtures/sandbox-data/lethal.config.local.json` names `http://Cronus28`, that `fixtures/sandbox-data-tests/.alpackages` holds `.app` symbols, and read `MIN_CONTROL_VERSION` in `packages/runner/src/harness.ts`.

### Task 1: Offline probe of the pre-lease reads

**Files:** Create `scripts/probe-verify-prepare.ts`.

**Produces:** stdout JSON `{ projectAlFiles, projectBytes, tests, hashMs: number[5], discoverMs: number[5] }`.

- [ ] **Step 1: Write it** (CLI body under `import.meta.main`, R186):

```ts
#!/usr/bin/env bun
/** R270 Task 1: time verify's pre-lease reads offline. Prints numbers only, never source. */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { hashTargetSource } from "../packages/runner/src/baseline-snapshot";
import { discoverTests } from "../packages/runner/src/discovery";

async function timed(f: () => Promise<unknown>): Promise<number> {
  const t = performance.now();
  await f();
  return Math.round(performance.now() - t);
}

export async function probe(projectDir: string, testDir: string, symbols: readonly string[]) {
  const names = (await readdir(projectDir, { recursive: true })).filter((n) => n.toLowerCase().endsWith(".al"));
  let projectBytes = 0;
  for (const n of names) projectBytes += (await stat(join(projectDir, n))).size;
  const tests = (await discoverTests(testDir)).length;
  if (names.length === 0 || tests === 0) {
    throw new Error(`probe: ${names.length} .al files, ${tests} tests; refusing to time nothing`);
  }
  const hashMs: number[] = [];
  const discoverMs: number[] = [];
  for (let i = 0; i < 5; i++) {
    hashMs.push(await timed(() => hashTargetSource(projectDir, symbols)));
    discoverMs.push(await timed(() => discoverTests(testDir)));
  }
  return { projectAlFiles: names.length, projectBytes, tests, hashMs, discoverMs };
}

if (import.meta.main) {
  const [projectDir, testDir, ...symbols] = process.argv.slice(2);
  if (projectDir === undefined || testDir === undefined) {
    console.error("usage: bun scripts/probe-verify-prepare.ts <projectDir> <testDir> [symbol...]");
    process.exit(2);
  }
  console.log(JSON.stringify(await probe(projectDir, testDir, symbols), null, 2));
}
```

- [ ] **Step 2:** Run it on `sandbox-app`/`sandbox-tests`, `sandbox-harden`/`-tests`, `sandbox-data`/`-tests`. Keep the outputs for Task 4.
- [ ] **Step 3:** `bunx biome check scripts/probe-verify-prepare.ts`; `bun test scripts/importable-scripts.test.ts`: PASS.
- [ ] **Step 4:** `git add scripts/probe-verify-prepare.ts && git commit -m "R270: offline probe of verify's pre-lease reads"`

### Task 2: Pure helpers and their tests

**Files:** Create `packages/runner/itest/verify-scale.ts`, `packages/runner/itest/verify-scale.test.ts`.

**Interfaces (produces):**

```ts
export class VerifyScaleError extends Error {}

/** Every survivor of the report's LAST batch as `<batchIndex>/<mutantCode>`, ordered by keyOf.
 *  Throws when the report has more than one batch or the count differs from `expected`. */
export function allSurvivorIds(report: SessionReport, expected: number): string[];
/** The first k of allSurvivorIds (scaling points only). Throws when k < 1 or k > the pool. */
export function firstSurvivorIds(report: SessionReport, expected: number, k: number): string[];

/** Per-identity VERDICT differences only (never killingTest). Throws on a key present twice on
 *  either side. Returns one line per missing, extra or differing key. */
export function verdictDiffs(committed: readonly NormalizedMutant[], report: SessionReport): string[];

/** Throws unless unsupportedTests is exactly ["Data Tests.PageActionComputesNonZero"]. */
export function assertOnlyExpectedBaselineFailure(report: SessionReport): void;

/** Throws unless: exit 5; the result ids, with no duplicate, EQUAL `requestedIds` as a set; every
 *  row "survived"; the new tests' names EQUAL `newTestNames` as a set, all "stable". */
export function assertVerifyMeasured(
  out: VerifyOutput, requestedIds: readonly string[], newTestNames: readonly string[],
): void;

/** max(verify) / min(denominator). Throws on an empty list or a non-positive value. */
export function worstRatio(verifyMs: readonly number[], denominatorsMs: readonly number[]): number;

export interface StampedEvent { readonly at: number; readonly event: RunEvent }
/** Library-level timeline of ONE runVerify call. Labelled library, never "lethal verify". */
export interface LibraryTimeline {
  readonly totalMs: number; readonly compileMs: number; readonly publishMs: number;
  readonly baselineMs: number; readonly mutantsMs: number;
  /** reruns + teardown + return work, not separable from events (fact 3). */
  readonly postMutantsMixedMs: number;
  /** totalMs minus everything above: pre-lease reads, lease open, status. Never negative. */
  readonly unattributedMs: number;
}
export function foldLibraryTimeline(
  out: Pick<VerifyOutput, "timings">, events: readonly StampedEvent[], returnedAt: number,
): LibraryTimeline;

/** An AL test codeunit with n [Test] methods that touch no target object. */
export function noOpTestCodeunit(id: number, name: string, n: number): string;
```

- [ ] **Step 1: Write the failing tests.** Hand-built reports as `verify-agreement.test.ts` builds them (`mutant(overrides)`, `report(mutants, extra?)`). Each test asserts the exact value or `toThrow(VerifyScaleError)`:

```ts
describe("allSurvivorIds / firstSurvivorIds", () => {
  test("returns every survivor of the batch, ordered by keyOf, as <batch>/<code>", ...);
  test("killed and no-coverage mutants are never included", ...);
  test("a count other than expected throws (a moved fixture is not measured silently)", ...);
  test("a report with two batches throws", ...);
  test("firstSurvivorIds: k=2 gives the first two of allSurvivorIds; k=0 and k>pool throw", ...);
});
describe("verdictDiffs", () => {
  test("equal verdicts with DIFFERENT killingTest give no diff", ...);
  test("one differing verdict gives one line naming the key and both verdicts", ...);
  test("a key missing from the report, and an extra key in it, give one line each", ...);
  test("a key twice on either side throws", ...);
});
describe("assertOnlyExpectedBaselineFailure", () => {
  test("accepts exactly the TestPage test", ...);
  test("refuses none, a different one, and that one plus another", ...);
});
describe("assertVerifyMeasured", () => {
  test("accepts exit 5, rows for exactly the requested ids, five stable new tests with the expected names", ...);
  test("refuses a row set with one requested id missing and another id twice (same count)", ...);
  test("refuses an extra id not requested, and a duplicated id", ...);
  test("refuses five stable new tests whose names differ from the expected five", ...);
  test("refuses a refusal output (results: [], exit 6)", ...);
  test("refuses exit 0, 3 and 4", ...);
  test("refuses fewer rows than requested, and any row not survived", ...);
  test("refuses exit 5 caused by a flaky, red or infra-error new test, and a wrong new-test count", ...);
});
describe("worstRatio", () => {
  test("is max verify over min denominator", () => { expect(worstRatio([10, 30, 20], [200, 150])).toBe(0.2); });
  test("empty lists and non-positive denominators throw", ...);
});
describe("foldLibraryTimeline", () => {
  test("a stream with baseline, mutants AND teardown phase-left: postMutantsMixed runs from mutants' phase-left to return", () => {
    // baseline 400 at t=1000; mutants 2000 at t=3000; teardown 50 at t=3300; returnedAt 3500
    // timings { totalMs 4000, compileMs 700, publishMs 300 }
    // -> postMutantsMixedMs 500, unattributedMs 4000-700-300-400-2000-500 = 100
  });
  test("missing compileMs or publishMs throws (verify refused before measuring)", ...);
  test("zero or two phase-left events for baseline or mutants throw", ...);
  test("named parts larger than totalMs throw", ...);
});
describe("noOpTestCodeunit", () => {
  test("declares Subtype = Test and n uniquely named [Test] procedures", ...);
  test("names no Record, Codeunit.Run or target object", ...);
});
```

- [ ] **Step 2:** `bun test packages/runner/itest/verify-scale.test.ts`: FAIL, module not found.
- [ ] **Step 3: Implement.** The two non-obvious bodies:

```ts
export function verdictDiffs(committed: readonly NormalizedMutant[], report: SessionReport): string[] {
  const index = (pairs: ReadonlyArray<readonly [string, string]>, side: string) => {
    const m = new Map<string, string>();
    for (const [k, v] of pairs) {
      if (m.has(k)) throw new VerifyScaleError(`${side}: key ${k} occurs twice`);
      m.set(k, v);
    }
    return m;
  };
  const want = index(committed.map((c) => [c.key, c.verdict] as const), "baseline");
  const got = index(report.mutants.map((m) => [keyOf(m), m.verdict] as const), "report");
  const diffs: string[] = [];
  for (const [k, v] of want) {
    const g = got.get(k);
    if (g === undefined) diffs.push(`${k}: missing from the report`);
    else if (g !== v) diffs.push(`${k}: baseline ${v}, report ${g}`);
  }
  for (const k of got.keys()) if (!want.has(k)) diffs.push(`${k}: not in the baseline`);
  return diffs;
}

export function foldLibraryTimeline(
  out: Pick<VerifyOutput, "timings">, events: readonly StampedEvent[], returnedAt: number,
): LibraryTimeline {
  const { totalMs, compileMs, publishMs } = out.timings;
  if (compileMs === undefined || publishMs === undefined) {
    throw new VerifyScaleError("no compile or publish time: verify refused before measuring");
  }
  const one = (phase: "baseline" | "mutants") => {
    const hits = events.filter((s) => s.event.type === "phase-left" && s.event.phase === phase);
    const [hit] = hits;
    if (hit === undefined || hits.length !== 1 || hit.event.type !== "phase-left") {
      throw new VerifyScaleError(`${hits.length} phase-left ${phase} events, expected 1`);
    }
    return { at: hit.at, ms: hit.event.elapsedMs };
  };
  const baseline = one("baseline");
  const mutants = one("mutants");
  const postMutantsMixedMs = returnedAt - mutants.at;
  const unattributedMs = totalMs - compileMs - publishMs - baseline.ms - mutants.ms - postMutantsMixedMs;
  if (unattributedMs < 0) throw new VerifyScaleError(`named parts exceed totalMs by ${-unattributedMs} ms`);
  return { totalMs, compileMs, publishMs, baselineMs: baseline.ms, mutantsMs: mutants.ms, postMutantsMixedMs, unattributedMs };
}
```

The rest follow their doc comments directly (`assertVerifyMeasured` compares against `VERIFY_EXIT.notAllKilled`).

- [ ] **Step 4:** PASS.
- [ ] **Step 5: Red-check** with the `mutation-red-checker` subagent, reporting red and restored green for each: (a) make `verdictDiffs` also compare `killingTest`: "different killingTest gives no diff" goes red; (b) `Math.max` to `Math.min` on the denominator in `worstRatio`: its test goes red; (c) drop the new-test stability check: the flaky case goes red; (d) take the LAST `phase-left` instead of `mutants`' for `postMutantsMixedMs`: the teardown scene goes red; (e) drop the `expected` count check: its test goes red; (f) compare result COUNT instead of the id set in `assertVerifyMeasured`: "one missing and another twice" goes red; (g) drop the new-test name comparison: "names differ" goes red.
- [ ] **Step 6:** typecheck, dist clean, `bun test packages/runner`, biome on both files. Commit: `git commit -m "R270: pure helpers for the verify-at-scale measurement"`.

### Task 3: The driver, measurement mode

**Files:** Create `packages/runner/itest/verify-scale.itest.ts`; modify `package.json`.

Standalone like `verify-agreement.itest.ts`: skip receipt and exit 0 unless `LETHAL_ITEST_VERIFY_SCALE=1`; `LETHAL_VERIFY_SCALE_OUT=<path>` required when set (the JSON of every number below). Constants: `SURVIVORS = 63`, `NOOP_TESTS = 5`, `NOOP_NAMES` = the five `"Data Verify Scale NoOp.VerifyScaleNoOp<n>"` names as `newTests[].test` prints them, `SCALING_K = [1, 5, 16]`, `SELECTOR_IDS` as fact 2.

Order, all inside one lease session:

1. **Setup.** Config, `connect()`, `lease`, as `verify-agreement.itest.ts`, with `project: fixtures/sandbox-data`. Print control version and Base Application version. Write the temp config copy with `selectorIds` (fact 2).
2. **Scratch suite.** `cp` `fixtures/sandbox-data-tests` (with `.alpackages`) to a temp dir, add `src/DataVerifyScaleNoOp.Codeunit.al` from `noOpTestCodeunit(NOOP_CODEUNIT_ID, "Data Verify Scale NoOp", NOOP_TESTS)`, leave `app.json` byte-identical, assert 74 discovered tests.
3. **A** (committed suite, fresh store): timed around `connect` to `close`. Assert `verdictDiffs(tables.baseline.json, a)` is empty and `assertOnlyExpectedBaselineFailure(a)`. `ids = allSurvivorIds(a, SURVIVORS)`.
4. **V1, V2, V3,** each: `verifyFromCli({ mode: "verify", dbPath: A's store, artifact: A's last artifact id, testDir: scratch, survivors: ids, configPath: tempConfig }, { write })`, wall-clocked with `Date.now()` around the call. Parse the JSON, `assertVerifyMeasured(out, ids, NOOP_NAMES)`.
5. **Scaling points:** for each k in `SCALING_K`, `verifyFromCli` against A with `firstSurvivorIds(a, SURVIVORS, k)`, timed, `assertVerifyMeasured(out, thoseIds, NOOP_NAMES)`.
6. **Library timeline (labelled):** one `runVerify` against A over `ids` with `emit: [(e) => events.push({ at: Date.now(), event: e })]` and `SELECTOR_IDS`, then `foldLibraryTimeline`. Printed under the heading `library runVerify timeline (not lethal verify's wall time)`.
7. **B1, B2** (the SCRATCH suite, 74 tests, each a fresh store), timed as A. Each: `assertFreshFullRun`, empty `verdictDiffs` against `tables.baseline.json` (the no-op tests cover nothing, so no verdict may move), `assertOnlyExpectedBaselineFailure`, 74 baseline tests, and every id in `ids` (joined to B by `keyOf` through A) is `survived` in B.
8. **Print** per session: V1..V3 ms and `max(V)/min(V)`, B1/B2 `timings.totalMs` and outer ms, `worstRatio([V1,V2,V3], [B1outer, B2outer])` with ` (UNDER 0.20)` or ` (NOT under 0.20)`, the spread (min and max of V, min and max of B), scaling ratios, the library timeline. No 0.20 assertion in this task.
9. **Restore, in a `finally` once step 3 began.** Candidates: the last recorded artifact in each of A's, B1's and B2's stores, in that order, for every run that began; a run that began but whose store records no artifact means "resident artifact cannot be named", which throws without publishing. Check every candidate with `deploymentVerifier.verify`; exactly one must be `accepted`. Compile `fixtures/sandbox-data-tests` against it, publish it inside a lease through a `runNamedMutants` call as `verify-agreement.itest.ts`'s `restore` does, and compare the fresh read-back hash with the compiled one. On failure print both errors and: "The container may carry the scratch test app. Republish fixtures/sandbox-data-tests by hand and compare its read-back hash before any other gate."

- [ ] **Step 1:** Write the driver. `bun run typecheck`.
- [ ] **Step 2: Offline-compile the scratch AL before any lease** (ruling 8): add a `--compile-only` flag that runs step 2 and compiles the scratch suite with `ArtifactCompiler` against `fixtures/sandbox-data-tests/.alpackages`, then exits; run it and expect exit 0. (Or use the `al-compiler` subagent on the scratch dir.)
- [ ] **Step 3:** dist clean, `bun test`; run the driver without the env var: exit 0, skip receipt. Biome on touched files.
- [ ] **Step 4:** `git add packages/runner/itest/verify-scale.itest.ts package.json && git commit -m "R270: itest:verify-scale driver, measurement mode"`

### Task 4: Pre-commit, then two sessions

**Files:** Create `docs/superpowers/specs/2026-09-27-r270-verify-scale-precommitment.md`, committed ALONE before Step 3.

- [ ] **Step 1: Write the spec** with these sections, using the values below (and Task 1's offline numbers, which read no server):
  - **Workload (fixed):** verify over all 63 survivors, five no-op new tests, through `verifyFromCli`. Line: strictly `< 0.20`. Smaller k are scaling data only.
  - **BLOCK if missed:** A, B1, B2 each have zero `verdictDiffs` against `tables.baseline.json`; each has exactly the one expected baseline failure; each has one batch and 63 survivors; every verify has exit 5, 63 (or k) `survived` rows, five `stable` new tests; the restore's read-back hash matches.
  - **Findings if missed (recorded, not blocking):** `killingTest` of B equals the baseline's; every timing range below.
  - **Timing predictions, with derivations:**
    - B warm outer time: **100 to 400 s** (74-test scratch suite; the five no-op tests add five baseline runs and no mutant runs). Derivation: gift-card's warm run (`docs/campaign/2026-08-16-gift-card/rehearsal.report.json`) is 25.4 s for about 50 scored mutants (deploy 5.1 s, mutants 15.2 s, per-mutant median 204 ms, mean 310 ms); sandbox-data scores 362, so mutants 70 to 150 s at 200 to 400 ms each; deploy of 377 guards 10 to 40 s; baseline of 69 tests 2 to 10 s; plus about 5 to 20 s of backend start and lease. Cross-check: `itest:chunked` takes about 95 s for two legs over one 26-mutant file, so per-run overhead is tens of seconds.
    - Verify fixed cost F (the intercept of the four k points, not k = 1, which includes one survivor): **4 to 12 s** outer. Derivation: sandbox-harden's `runVerify` total was 5.7 to 5.8 s with four survivors (`compileMs` about 1 s, `publishMs` about 0.9 s); the CLI adds backend start, 1 to 4 s.
    - Verify over 63: **25 to 150 s** outer. Derivation: survivors are 63 of 362 scored (17%); a survivor runs every covering test, so it costs 1.5 to 3 times a mean mutant; that is 26% to 51% of the mutant phase, plus the 63-method baseline and F.
    - **Worst ratio at 63, a MODEL ESTIMATE, coupled rather than divided across independent ranges:** write B = M + D (M the mutant phase, 70 to 150 s; D deploy, baseline and overhead, 30 to 70 s) and V = f * M + F' (f the survivors' share of M, 0.26 to 0.51; F' verify's fixed cost plus its 63-method baseline, 4 to 12 s). Low corner f 0.26, M 70, F' 4, D 70: (18.2 + 4) / 140 = 0.16. High corner f 0.51, M 150, F' 12, D 30: (76.5 + 12) / 180 = 0.49. Midpoints (f 0.38, M 110, F' 8, D 50): 0.31. **Range 0.16 to 0.49, point about 0.31, so "not met" is the prediction.** A result outside the range is a finding, not a BLOCK.
    - Scaling: ratio rises with k; ratio at k = 1 below 0.10.
    - Spread: `max(V)/min(V)` within a session under 1.25.
  - **Noise policy (fixed):** the session's ratio is `worstRatio([V1,V2,V3], [B1,B2])` on outer times. Met only when it is `< 0.20` in BOTH sessions AND each session has `max(V)/min(V) <= 1.5`. A session above 1.5 is too noisy to decide, and the result is "not met" unless a third session, pre-committed by an appended note before it runs, decides it. Task 7A's gate asserts both conditions.
  - **Workload limit, stated here and in any R270 closing text:** the five new tests are no-ops on one fixture. The result says nothing about verify's wall time with real answer tests or on a real project.
  - **Stop rule:** any BLOCK stops the task and goes to the owner with the per-mutant diff.
- [ ] **Step 2:** `git add docs/superpowers/specs/2026-09-27-r270-verify-scale-precommitment.md && git commit -m "R270: pre-commitment for the verify-at-scale measurement"`. Confirm the Cronus28 control app is at least `MIN_CONTROL_VERSION`.
- [ ] **Step 3: Session 1.** Container status; `coord lease Cronus28 code`; heartbeat. Foreground: `LETHAL_ITEST_VERIFY_SCALE=1 LETHAL_VERIFY_SCALE_OUT=<scratchpad>/r270-s1.json bun run itest:verify-scale 2>&1 | tee <scratchpad>/r270-s1.log`. Then `LETHAL_ITEST_TABLES=1 bun run itest:tables` (its frozen figures must still hold; this is not the restore's proof). Release.
- [ ] **Step 4: Session 2,** a separate lease at another time, same commands with `s2`.
- [ ] **Step 5:** Append `## Results (appended <date>)`: both sessions' numbers, each prediction MATCHED or MISSED, the library timelines, `itest:tables` result. Commit.

### Task 5 (CONDITIONAL): 5a, overlap the source check with the artifact load

**Trigger, all three required, else drop this task and say so in Task 7:** (1) the result is "not met"; (2) the only reduction the code allows is the pre-lease reads, which the other phases rule out (`compileMs`: the test app changed, that is why verify runs; the reruns: decision 11 needs a fresh session per rerun; `baselineMs`: decision 13, owner only; backend start: `lethal run` pays it too); (3) Task 1's median `hashMs` on sandbox-data, divided by `min(B)`, is larger than the worst ratio minus 0.20, i.e. removing it entirely could cross the line. Given the prediction, this is not expected to trigger.

**Files:** Modify `packages/runner/src/verify.ts` (`runVerify`); test beside the existing `runVerify` tests (`grep -rln "runVerify" packages/runner/tests`). If `assertSourceUnchanged` and `loadInstalledArtifact` have no seam there, STOP: adding one is a design change for the orchestrator.

- [ ] **Step 1: Pins of today's behaviour, then tests of the NEW concurrent behaviour** (stateful fakes with call logs, never wall clock):

```ts
// Pins of existing behaviour (pass today and after):
test("5a: source fails, artifact would succeed -> source-changed", ...);
test("5a: artifact fails, source succeeds -> the artifact's error, unchanged", ...);
// Tests of the NEW concurrent behaviour. They cannot pass today: a failed source check never
// starts the artifact load, so "both fail" does not exist in the sequential code.
test("5a (new): the artifact load starts before the source hash finishes", ...);
test("5a (new): both fail, source's rejects FIRST -> source-changed", ...);
test("5a (new): both fail, artifact's rejects FIRST -> still source-changed", ...);
```

- [ ] **Step 2:** Implement with `Promise.allSettled`, rethrowing the source check's rejection before the artifact's. Note in the commit that the artifact is now read even when the source check refuses (a read of the store's own files, no server call).
- [ ] **Step 3:** All pass. Red-check: swap the rethrow order; both "both fail" tests go red; restore.
- [ ] **Step 4:** typecheck, dist clean, `bun test`, biome. Under a lease: `itest:verify`, `itest:agreement`. Then append a new pre-commitment to the Task 4 spec for the changed commit, commit it alone, and repeat BOTH sessions (Task 4 Steps 3 to 5) on that commit. The decision in Task 6 reads only those two sessions.

### Task 6: Decide

- [ ] Read the fixed noise policy against the two sessions that count. Met: Task 7A. Anything else: Task 7B.

### Task 7A: The gate (only if met)

- [ ] **Step 1:** Append the gate's pre-commitment (all 63, outer, worst pairing, `< 0.20`) and commit it alone.
- [ ] **Step 2:** In the driver, after step 8:

```ts
const spread = Math.max(...vMs) / Math.min(...vMs);
assert.ok(spread <= 1.5, `R270: verify spread max/min ${spread.toFixed(2)} is above 1.5; this session is too noisy to decide`);
assert.ok(worst < 0.2, `R270: worst ratio over all 63 survivors is ${worst.toFixed(3)}, not under 0.20`);
```
- [ ] **Step 3: Red-check live:** set the ratio line to `0.001`, run under a lease, see it fail with the ratio in the message, restore. Same for the spread: set its limit to `1.0001` in one run, see it fail, restore.
- [ ] **Step 4:** Two PASS runs on two leases. Mark R270 `done (<commit>)` with the numbers and what is not claimed: the workload is five no-op tests on one fixture, so nothing about real answer tests or a real project. `bun scripts/roadmap-index.ts`, commit. Tell the orchestrator CLAUDE.md could list the gate; do not edit it.

### Task 7B: Report (if not met)

- [ ] **Step 1:** Append to R270 `**Measured at scale (<date>, sandbox-data, 377 mutants, all 63 survivors).**`: worst ratio and spread per session, F from the intercept, the scaling points, the library timeline with its mixed interval labelled. Status stays `open`.
- [ ] **Step 2:** `bun scripts/roadmap-index.ts`, `bun test scripts/roadmap-index.test.ts`, commit.
- [ ] **Step 3:** Owner report in the coord handoff folder: "The epic's 20% criterion is not met on sandbox-data: verify over all 63 survivors took <V> s against a warm full run of <B> s (worst ratio <r>, both sessions)." No gate added, nothing frozen changed.

## Open questions for the orchestrator

1. **Is sandbox-data "at scale"?** 377 mutants is the largest committed fixture, but real modules measured slower tests (DO rung 1: median 2957 ms per mutant against about 200 ms here). A larger synthetic fixture would be a separate plan.
2. **May Task 1 run offline on a real project checkout** (numbers only, nothing committed that names it unless you say it is public)? A live real-project run needs an environment outside Cronus28/Cronus284 and is out of scope by default.
3. **The scratch codeunit id**, if Task 0 finds none free in 79300-79396.
4. **Cronus28 time:** each session is three full sandbox-data runs (A, B1, B2), seven verify calls (three gated, three scaling, one library) and one `itest:tables`, roughly 30 to 60 minutes; two sessions, two more if Task 5a or 7A runs.

## Review responses (r1)

- **Critical, gate passes on a small k:** ruling 1. The gated workload is all 63 survivors, fixed in Global Constraints and the spec before any session; k = 1, 5, 16 are scaling data only; the line is `< 0.20`; "not met" is reported, never replaced by a smaller k.
- **B check contradicts itself:** `verdictDiffs` compares verdict per identity key only (red-check (a)); `assertOnlyExpectedBaselineFailure` pins the one expected failure; `tables.baseline.json` and `itest:tables` are untouched.
- **Timeline misattributes reruns:** fact 3; `postMutantsMixedMs` is labelled mixed; the teardown scene is a unit test and red-check (d); Task 5 no longer reads the timeline's rest as pre-lease time and triggers only on Task 1's offline attribution.
- **Outside ratio is not the CLI:** ruling 2. The gated time wraps `verifyFromCli` with a temp config carrying valid selector ids (fact 2); `runVerify` appears only as a labelled library timeline.
- **Fragile decision:** three gated verifies per session (Revision 2: repeated against source run A, not interleaved; see fact 5), worst pairing, spread published, noise policy fixed in the spec; Task 5a repeats both sessions on its own commit.
- **Restore covers only A and one B:** Task 3's restore step covers A, B1 and B2, including a B that began without a recorded artifact (throws, no publish), with a read-back hash; `itest:tables` is no longer called proof the scratch app is gone.
- **Task 5a ordering:** tests for both failure orders plus the single-failure cases; the extra artifact read on a source refusal is stated; if no seam exists the task stops.
- **Minors:** numeric ranges with derivations and the BLOCK/finding split are in Task 4 Step 1; F is the intercept, not k = 1; the one-batch claim is now a BLOCK; the scratch AL compiles offline (Task 3 Step 2) before any lease.

## Review responses (r2)

- **Denominator ran a different suite:** ruling 1. B1 and B2 run the 74-test scratch suite verify ran (fact 5, Task 3 step 7). Such a B cannot be a verify source, so all three verifies use source run A and precede the B runs; that ordering is stated as conservative (fact 5).
- **Guard checked counts, not identities:** ruling 2. `assertVerifyMeasured` takes the requested ids and the five new-test names and compares both as exact sets, refusing duplicates; new unit cases and red-checks (f) and (g).
- **Noise rule not in the gate:** ruling 3. Task 7A asserts `max(V)/min(V) <= 1.5` beside the ratio, with its own live red-check.
- **Minors:** Task 5a's both-fail tests are labelled as tests of the new concurrent behaviour; the ratio range is a coupled model estimate with its corners shown (Task 4); the five-no-op, one-fixture workload limit is stated in Task 4's spec and in Task 7A's closing text.
