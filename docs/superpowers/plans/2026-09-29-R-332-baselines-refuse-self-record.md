# R-332: every frozen itest baseline refuses to self-record, Implementation Plan (revision r2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live gate whose committed `packages/runner/itest/*.baseline.json` is missing FAILS at startup and names the command that records it. Recording happens only under an explicit record mode, never overwrites a file, and a record run always exits 3 and is never a pass.

**Architecture:** Change the shared helper, not each gate. `packages/runner/itest/baseline-guard.ts` gains a registry of every frozen baseline, keyed by basename, with the command that records each one. On top of it sit three startup checks: `preflightGateBaseline`, `preflightReadOnlyBaseline` and `preflightFrozenBaseline`. There is also one refusing comparison, `assertGateBaseline`. Every baseline write goes through `writeBaselineOnce`, which uses `writeFile(..., { flag: "wx" })`, so the operating system refuses to overwrite. That covers R321's symbol files too. A gate record run throws `BaselineRecordedError`, and every writing gate's catch maps that to exit 3 and a failed receipt. An AST-based unit test pins the real call sites and forbids any other writer. The old record-or-diff `assertMatchesBaseline` stays for `campaign freeze` only.

**Tech Stack:** Bun, TypeScript 5.9 (`typescript` compiler API, already in root `node_modules`), `bun:test`, `node:fs/promises`.

**Spec:** `docs/roadmap/R332.md`, `H:/lethal-coord/tasks/R-332/task.md`, and review round 1 at `H:/lethal-coord/reviews/R-332-plan/review-r1.md`, with the orchestrator's rulings: Q1 keep `LETHAL_ITEST_RECORD_SYMBOL_BASELINES`; Q2 exit 3 for every record run; Q3 file envtool's missing receipt as its own roadmap item; Q4 every reader gets the startup preflight. Prior art: R321's `assertMatchesFrozenBaseline` (commit `6ec2bcd9`).

**Base:** written against branch `lethal/lane-code` at `e716a79b`. Between `0195de92` and `e716a79b`, only `CLAUDE.md` changed. Line numbers below are "around"; find each edit by the quoted content.

## Global Constraints

- Every committed baseline stays byte-identical. No live gate is run to completion and no baseline is re-recorded. Proven by sha256 before and after (Task 0, Task 9).
- CLAUDE.md is owner-only: this plan PROPOSES text only (section "Proposed CLAUDE.md text"). The executor never edits CLAUDE.md.
- No `!` non-null assertions. `exactOptionalPropertyTypes` is on. Error classes extend `Error` directly.
- Fail loudly. A missing baseline throws. An unknown name in the record variable throws. Nothing returns as if it had matched.
- Plain English, short sentences, no em dash character (U+2014) in any new text, code string or doc. Check with `LC_ALL=C grep -n $'\xe2\x80\x94'` (Task 9 Step 6).
- Build/test order (CLAUDE.md): `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test` FROM THE REPO ROOT. Run biome only on touched files: `bunx biome check <paths>`.
- Commit or push only if the orchestrator's execution brief says so. The commit steps give the intended grouping.
- Scratch files go to the session scratchpad, written below as `$P`.

## Decisions (and why)

1. **One env var for the five gate baselines. Its value is basenames, and the basename IS the whole contract (the I4 choice).** For example, `LETHAL_ITEST_RECORD_BASELINE=bcdev.baseline.json`, or a comma-separated list. Why basenames and not full paths:
   - Every frozen baseline lives in one directory, `packages/runner/itest/`, so its basename names exactly one file. A directory cannot hold two files with one name.
   - A full path forces the operator to type a Windows path into an env var. It would then need drive-letter, slash and case normalisation, and each of those is a new way to arm nothing, or the wrong thing.

   Uniqueness is ENFORCED three ways:
   - (a) The registry `GATE_BASELINES` is an object keyed by basename, so its keys are unique.
   - (b) `recordRequested` THROWS if any listed name is not a registered gate baseline. So `=1`, a typo, a wrong-case `BCDEV.baseline.json`, a path like `packages/runner/itest/bcdev.baseline.json`, or a symbol file name all fail loudly, and none arms anything.
   - (c) The AST wiring test asserts every `BASELINE_PATH` in the itest sources is `join(HERE, "<registered name>")` with `HERE` the itest directory. It also asserts the registry equals the set of committed files.

   `basename()` on Windows accepts both slash directions, which a test pins.

   Why one variable and not one per gate: a single `=1` switch would arm every gate at once. File names arm exactly the files listed, under one variable to remember.
2. **R321's symbol files keep `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1` (ruling Q1) and its two-file flow.** The fix is in how they are written, not in the variable. Their record branch writes with `wx` through `writeBaselineOnce`, so a file that appears after the existence check is still never overwritten (review finding C). Both symbol files are preflighted at the start of `al-runner.itest.ts`'s `main()`, before either is written. A symbol record run still records both files and exits 3 at the end, as today.
3. **Record mode never overwrites.** It is refused early by the preflight (`existsSync`) and again at write time by `wx` (`EEXIST`). The write-time check is atomic, so it holds even if another session restores the file mid-run.
4. **A record run exits 3 everywhere (ruling Q2, finding I1).** `assertGateBaseline` throws `BaselineRecordedError` after writing. Each writing gate's catch becomes `process.exit(err instanceof BaselineRecordedError ? 3 : 1)`, after `emitFailed`, whose reason carries "NOT a pass". The writing gates are `bcdev`, `al-runner`, `tables`, `harden` (its top-level `try/catch`) and `envtool` (whose catch has no receipt, see Task 7). `al-runner`'s existing symbol exit 3 is unchanged.
5. **Mismatch never re-records.** With record mode off, a difference throws, and nothing is written. The message names the record command and the pre-commitment step.
6. **envtool's `UNVERIFIED_MOVES`.** The new rule already refuses a missing file. `refuseSelfRecordWhileUnverified()` is unchanged in body. It moves to the first line of `main()`, before the preflight, so it still blocks RECORD mode while moves are unverified, and its more specific message wins.
7. **Readers get a startup preflight (ruling Q4, finding I2).** These are `verify.itest.ts` and `test-app-publish.itest.ts` (`bcdev.baseline.json`), `verify-agreement.itest.ts` (`harden.baseline.json`) and `verify-scale.itest.ts` (`tables.baseline.json`). Each calls `preflightReadOnlyBaseline(BASELINE_PATH, label)` as the first line of `main()`. A missing file is refused with the OWNING gate's record command. Readers never record and ignore the record variable. `verify-scale.itest.ts`'s `--compile-only` block runs at module top level and exits before `main()`, so it is untouched and keeps working offline.
8. **Campaign `freeze`/`compare` are out of scope.** `campaign freeze` is the explicit record verb for a stage baseline. `compare` already refuses an absent or uncommitted baseline before it calls the helper (`packages/runner/src/campaign-subcommands.ts` around lines 358 and 425). Both keep `assertMatchesBaseline`, whose behaviour does not change. The wiring test allows that import in `packages/runner/src/campaign-freeze.ts` only.
9. **The Edit/Write hook's advice goes stale, and is proposed to the owner, not edited.** `.claude/hooks/baseline-guard.ts` blocks hand edits to `packages/runner/itest/*.baseline.json` unless `LETHAL_RERECORD_BASELINE=1`. Its message tells the reader to run `LETHAL_RERECORD_BASELINE=1 bun run itest:<gate>`, which after this change records nothing: the gate would just refuse. Lanes may not edit hooks (runbook ruling), so the exact replacement text is proposed in "Proposed owner text", item 4 (Task 6).

## Inventory: every writer, found by search (finding I3)

Searches run at `e716a79b` from the worktree root, before this plan was written:

```bash
# 1. Any write-shaped call with "baseline" on the same line, repo code only
rg -n --glob '!**/dist/**' --glob '!node_modules' -g '*.ts' "baseline" packages scripts \
  | rg -i "writeFile|Bun\.write|copyFile|rename\(|appendFile|createWriteStream|cp\("
# result: packages\runner\itest\baseline-guard.ts:62  (the helper itself; nothing else)

# 2. Every file that names a baseline path
rg -n --glob '!**/dist/**' -g '*.ts' "\.baseline\.json|baseline\.json|BASELINE_PATH|baselinePath" packages scripts -l
# result, 23 files: scripts\c0204b-live-probe.ts, scripts\agentflow\merge-tree.test.ts,
#   scripts\r193-r197-baseline-proof.ts, packages\runner\src\{campaign-freeze,campaign-subcommands,cli}.ts,
#   packages\runner\tests\{campaign-freeze,baseline-guard,campaign-subcommands,mutant-equality}.test.ts,
#   packages\runner\itest\{baseline-guard,mutant-equality,harden-expected}.ts,
#   packages\runner\itest\{envtool,bcdev,al-runner,verify,harden,verify-scale,verify-agreement,tables,test-app-publish}.itest.ts,
#   packages\runner\itest\harden-fixture.test.ts

# 3. Every write-shaped call in the itest directory and the campaign writer, whatever its argument
rg -n --glob '!**/dist/**' -g '*.ts' "(writeFile|Bun\.write|copyFile|rename|appendFile)\(" \
  packages/runner/itest packages/runner/src/campaign-freeze.ts packages/runner/src/campaign-subcommands.ts
# result: baseline-guard.ts:62 (the helper); campaign-freeze.ts:99,106 (copyFile of <stage>.report.json,
#   not a baseline); verify.itest.ts:400 and test-app-publish.itest.ts:127 (a scratch codeunit);
#   verify-scale.itest.ts:120,235,506 (scratch suite, temp config, LETHAL_VERIFY_SCALE_OUT);
#   verify-agreement.ts:170 (scratch codeunit); gate-receipt.ts:123-124 (receipt tmp + rename);
#   stale-publish.itest.ts:311,326,685 (scratch project, control .app); *.test.ts files (temp dirs).

# 4. Whole repo, any file type except md/json, any mention of baseline.json
rg -n --hidden --glob '!node_modules' --glob '!**/dist/**' --glob '!.git' -g '!*.md' -g '!*.json' "baseline\.json" .
# adds: .claude\hooks\baseline-guard.ts (the Edit/Write guard, a READER of paths, no writer; Decision 9),
#   a comment in fixtures\sandbox-data-tests\src\DataTests.Codeunit.al, a campaign transcript .jsonl.
```

Conclusion: the only code that writes a `*.baseline.json` is `assertMatchesBaseline` in `baseline-guard.ts`. It is reached from the five gates, from `harden-expected.ts`, from R321's `assertMatchesFrozenBaseline`, and from `campaign-freeze.ts`. Task 5's AST test re-runs this search as code on every `bun test`, so a writer added later fails the suite.

Committed baselines (`ls packages/runner/itest/*.baseline.json`, 7 files):

| File | Writer after this plan | Startup preflight | Readers (preflight: `preflightReadOnlyBaseline`) |
|---|---|---|---|
| `al-runner.baseline.json` | `assertGateBaseline`, `al-runner.itest.ts` | `preflightGateBaseline` | none |
| `al-runner.symbols-lethala.baseline.json` | `assertMatchesFrozenBaseline` (now `wx`) | `preflightFrozenBaseline` | none |
| `al-runner.symbols-lethalb.baseline.json` | same | same | none |
| `bcdev.baseline.json` | `assertGateBaseline`, `bcdev.itest.ts` | `preflightGateBaseline` | `verify.itest.ts`, `test-app-publish.itest.ts`, `scripts/c0204b-live-probe.ts` (already checks existence first) |
| `envtool.baseline.json` | `assertGateBaseline`, `envtool.itest.ts` | `preflightGateBaseline` | none |
| `harden.baseline.json` | `assertGateBaseline`, via `recordAfterBothLegs` | `preflightGateBaseline` | `verify-agreement.itest.ts` |
| `tables.baseline.json` | `assertGateBaseline`, `tables.itest.ts` | `preflightGateBaseline` | `verify-scale.itest.ts` |

Gates with no committed baseline file (nothing to change): `chunked`, `hang`, `growth`, `lease`, `stale-publish`.

## Review Focus

1. `LETHAL_ITEST_RECORD_BASELINE=1` (the habit from R321's variable) must throw, naming the known baselines, and must never arm or silently ignore. Pinned in Task 1.
2. Record mode armed for ONE file while another gate runs: the other gate must refuse its missing file, not record it. Pinned in Task 1.
3. A baseline that appears between preflight and write (another session restored it) must never be overwritten, for gate baselines AND symbol baselines. Pinned in Task 1 by `wx` tests on both paths.
4. harden with record mode armed and leg B FAILING must leave no file behind. Pinned in Task 2.
5. A later change that writes a baseline some other way (direct `writeFile`, `Bun.write`, an aliased import, a namespace call) must fail `bun test`. Pinned in Task 5, including negative tests on synthetic sources.

---

### Task 0: Record the baselines' hashes

- [ ] **Step 1**

```bash
cd /u/Git/LethAL-wt/lane-code
P="<session scratchpad>"
sha256sum packages/runner/itest/*.baseline.json > "$P/r332-baselines.before.sha256"
wc -l < "$P/r332-baselines.before.sha256"
```

Expected: `7`.

---

### Task 1: The helper

**Files:**
- Modify: `packages/runner/itest/baseline-guard.ts` (header paragraph "No committed baseline yet at `baselinePath` ..." around lines 16-20; imports around 22-23; everything from the `assertMatchesBaseline` doc comment, around line 44, to end of file)
- Test: `packages/runner/tests/baseline-guard.test.ts`

**Interfaces (produced, used by Tasks 2-5):**

```ts
export const RECORD_BASELINE_ENV = "LETHAL_ITEST_RECORD_BASELINE";
export const GATE_BASELINES: Readonly<Record<string, string>>;      // basename -> record command
export const SYMBOL_BASELINES: readonly string[];                    // the two R321 basenames
export class BaselineRecordedError extends Error {}
export function recordHowFor(baselinePath: string): string;          // throws if unregistered
export function recordRequested(baselinePath: string, env?: NodeJS.ProcessEnv): boolean;
export function preflightGateBaseline(baselinePath: string, label: string, env?: NodeJS.ProcessEnv): void;
export function preflightReadOnlyBaseline(baselinePath: string, label: string): void;
export function preflightFrozenBaseline(baselinePath: string, label: string, record: boolean): void;
export async function assertGateBaseline(report: SessionReport, baselinePath: string, label: string, env?: NodeJS.ProcessEnv): Promise<void>;
export async function assertMatchesFrozenBaseline(report: SessionReport, baselinePath: string, label: string, record: boolean): Promise<void>; // signature unchanged
export async function assertMatchesBaseline(report: SessionReport, baselinePath: string, label: string): Promise<void>;                      // unchanged, campaign freeze only
```

- [ ] **Step 1: Write the failing tests**

In `packages/runner/tests/baseline-guard.test.ts`, change the `node:fs/promises` import to `import { mkdir, readFile, writeFile } from "node:fs/promises";` and the guard import to:

```ts
import {
  BaselineRecordedError,
  GATE_BASELINES,
  RECORD_BASELINE_ENV,
  assertGateBaseline,
  assertMatchesBaseline,
  assertMatchesFrozenBaseline,
  preflightFrozenBaseline,
  preflightGateBaseline,
  preflightReadOnlyBaseline,
  recordRequested,
} from "../itest/baseline-guard";
```

Append (the file already has `dir`, `report`, `outcome`, `existsSync`, `join`):

```ts
describe("R332: a frozen baseline never records itself", () => {
  const NAME = "bcdev.baseline.json"; // a registered gate basename, placed in a temp dir
  const r = () =>
    report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "RateSmall" })]);
  const arm = (v: string): NodeJS.ProcessEnv => ({ [RECORD_BASELINE_ENV]: v });
  const none: NodeJS.ProcessEnv = {};

  test("recordRequested: exact registered basenames only; slash direction does not matter", () => {
    const p = join(dir, NAME);
    expect(recordRequested(p, none)).toBe(false);
    expect(recordRequested(p, arm(""))).toBe(false);
    expect(recordRequested(p, arm(NAME))).toBe(true);
    expect(recordRequested(p, arm(`tables.baseline.json, ${NAME}`))).toBe(true);
    expect(recordRequested(p, arm("tables.baseline.json"))).toBe(false);
    expect(recordRequested(`${dir.replace(/\\/g, "/")}/${NAME}`, arm(NAME))).toBe(true);
    expect(recordRequested(`${dir.replace(/\//g, "\\")}\\${NAME}`, arm(NAME))).toBe(true);
  });

  test("recordRequested throws on =1, a typo, a wrong case, a path, or a symbol file", () => {
    const p = join(dir, NAME);
    for (const bad of [
      "1",
      "bcdev.json",
      "BCDEV.baseline.json",
      "packages/runner/itest/bcdev.baseline.json",
      "al-runner.symbols-lethala.baseline.json",
    ]) {
      expect(() => recordRequested(p, arm(bad))).toThrow(/not a gate baseline/);
    }
  });

  test("the registry names five gate baselines and their record commands", () => {
    expect(Object.keys(GATE_BASELINES).sort()).toEqual([
      "al-runner.baseline.json",
      "bcdev.baseline.json",
      "envtool.baseline.json",
      "harden.baseline.json",
      "tables.baseline.json",
    ]);
    for (const [name, how] of Object.entries(GATE_BASELINES)) {
      expect(how).toContain(`${RECORD_BASELINE_ENV}=${name} bun run itest:`);
    }
  });

  test("an unregistered basename is refused, not guessed", async () => {
    await expect(assertGateBaseline(r(), join(dir, "stray.baseline.json"), "t", none)).rejects.toThrow(
      /not a registered frozen baseline/,
    );
  });

  test("missing, record off: refused, names the command, writes nothing", async () => {
    const p = join(dir, NAME);
    const err = await assertGateBaseline(r(), p, "t", none).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/never records one silently/);
    expect((err as Error).message).toContain(GATE_BASELINES[NAME] ?? "unreachable");
    expect(existsSync(p)).toBe(false);
  });

  test("arming another file does not arm this one", async () => {
    const p = join(dir, NAME);
    await expect(assertGateBaseline(r(), p, "t", arm("tables.baseline.json"))).rejects.toThrow(
      /never records one silently/,
    );
    expect(existsSync(p)).toBe(false);
  });

  test("missing, record on: writes once, byte-identical to the old writer, then BaselineRecordedError", async () => {
    const p = join(dir, NAME);
    const ref = join(dir, "reference.json");
    await assertMatchesBaseline(r(), ref, "ref");
    const err = await assertGateBaseline(r(), p, "t", arm(NAME)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BaselineRecordedError);
    expect((err as Error).message).toMatch(/NOT a pass/);
    expect(await readFile(p, "utf8")).toBe(await readFile(ref, "utf8"));
  });

  test("present, record on: the write itself refuses (wx), bytes unchanged", async () => {
    const p = join(dir, NAME);
    await writeFile(p, "sentinel\n", "utf8");
    await expect(assertGateBaseline(r(), p, "t", arm(NAME))).rejects.toThrow(/refuses to overwrite/);
    expect(await readFile(p, "utf8")).toBe("sentinel\n");
  });

  test("present, match, record off: passes", async () => {
    const p = join(dir, NAME);
    await assertMatchesBaseline(r(), p, "seed");
    await expect(assertGateBaseline(r(), p, "t", none)).resolves.toBeUndefined();
  });

  test("present, mismatch: throws, names the command and the pre-commitment, never re-records", async () => {
    const p = join(dir, NAME);
    await assertMatchesBaseline(r(), p, "seed");
    const before = await readFile(p, "utf8");
    const moved = report([outcome({ mutantCode: "M0001", verdict: "survived" })]);
    const err = await assertGateBaseline(moved, p, "t", none).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/per-mutant regression/);
    expect((err as Error).message).toMatch(/pre-commitment/);
    expect((err as Error).message).toContain(GATE_BASELINES[NAME] ?? "unreachable");
    expect(await readFile(p, "utf8")).toBe(before);
  });

  test("preflightGateBaseline: refuses missing (off) and present (on); allows the other two", async () => {
    const p = join(dir, NAME);
    expect(() => preflightGateBaseline(p, "t", none)).toThrow(/never records one silently/);
    expect(() => preflightGateBaseline(p, "t", arm(NAME))).not.toThrow();
    await writeFile(p, "[]\n", "utf8");
    expect(() => preflightGateBaseline(p, "t", none)).not.toThrow();
    expect(() => preflightGateBaseline(p, "t", arm(NAME))).toThrow(/refuses to overwrite/);
  });

  test("preflightReadOnlyBaseline: refuses a missing file with the OWNING gate's command, ignores record mode", async () => {
    const p = join(dir, NAME);
    expect(() => preflightReadOnlyBaseline(p, "verify itest")).toThrow(
      GATE_BASELINES[NAME] ?? "unreachable",
    );
    await writeFile(p, "[]\n", "utf8");
    expect(() => preflightReadOnlyBaseline(p, "verify itest")).not.toThrow();
  });
});

describe("R332 finding C: the R321 symbol writer is exclusive too", () => {
  const SYM = "al-runner.symbols-lethala.baseline.json";
  const r = () => report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "T" })]);

  test("record mode never overwrites a symbol file, even with no preflight in front of it", async () => {
    const p = join(dir, SYM);
    await writeFile(p, "sentinel\n", "utf8");
    await expect(assertMatchesFrozenBaseline(r(), p, "t", true)).rejects.toThrow(/refuses to overwrite/);
    expect(await readFile(p, "utf8")).toBe("sentinel\n");
  });

  test("preflightFrozenBaseline covers both symbol files before either is written", async () => {
    const a = join(dir, SYM);
    const b = join(dir, "al-runner.symbols-lethalb.baseline.json");
    await writeFile(b, "[]\n", "utf8");
    // record run, a absent, b present: the preflight must stop it before a is written
    expect(() => {
      for (const p of [a, b]) preflightFrozenBaseline(p, "t", true);
    }).toThrow(/refuses to overwrite/);
    expect(existsSync(a)).toBe(false);
    expect(() => preflightFrozenBaseline(a, "t", false)).toThrow(
      /LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1/,
    );
  });
});
```

The four existing R321 tests (describe `assertMatchesFrozenBaseline (R321)`) use `join(dir, "frozen.json")`. Change that one constant in each to `join(dir, "al-runner.symbols-lethala.baseline.json")` so the path is registered. Their assertions stay as they are.

- [ ] **Step 2: Run, expect failure**

Run: `cd /u/Git/LethAL-wt/lane-code && bun test packages/runner/tests/baseline-guard.test.ts`
Expected: FAIL, the new exports do not exist.

- [ ] **Step 3: Implement**

Imports:

```ts
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
```

Header paragraph ("No committed baseline yet at `baselinePath` -> this run's normalized report BECOMES the new baseline ..."), replace with:

```ts
 * R332: an itest never records a frozen baseline silently. `assertGateBaseline` refuses a missing
 * file and records only when `LETHAL_ITEST_RECORD_BASELINE` names it; every write is exclusive
 * (`wx`), so nothing is ever overwritten; a record run always fails, with exit 3 in the gate.
 * `assertMatchesBaseline` still records an absent file, which is `campaign freeze`'s job alone.
```

Replace everything from the `assertMatchesBaseline` doc comment to end of file with:

```ts
/** Throws when `actual` differs from the committed baseline text. Never writes. */
function throwOnDiff(
  actual: readonly NormalizedMutant[],
  baselineRaw: string,
  baselinePath: string,
  label: string,
  remedy: string,
): void {
  const baseline = JSON.parse(baselineRaw) as NormalizedMutant[];
  const diffs = diffMutants(baseline, actual);
  if (diffs.length > 0) {
    throw new Error(
      `${label}: per-mutant regression against the committed baseline at ${baselinePath} (${diffs.length} mutant(s) differ):\n${diffs.map((d) => `  - ${d}`).join("\n")}\n${remedy}`,
    );
  }
}

/**
 * Record-or-diff. `campaign freeze` ONLY, where writing an absent `<stage>.baseline.json` is the
 * verb's job. R332: no itest may call it; `tests/baseline-wiring.test.ts` enforces that.
 */
export async function assertMatchesBaseline(
  report: SessionReport,
  baselinePath: string,
  label: string,
): Promise<void> {
  const actual = sortedForDisk(normalizeForComparison(report));
  let baselineRaw: string | undefined;
  try {
    baselineRaw = await readFile(baselinePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (baselineRaw === undefined) {
    await writeFile(baselinePath, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    console.log(
      `${label}: no committed baseline at ${baselinePath}, recorded this run's per-mutant verdicts as the new baseline. Review and commit this file.`,
    );
    return;
  }
  throwOnDiff(
    actual,
    baselineRaw,
    baselinePath,
    label,
    `If this difference is EXPECTED (the fixture or an operator legitimately changed), delete ${baselinePath}, re-run to record a new baseline, review the diff, then commit it.`,
  );
}

/** R332: lists the gate baselines a record run may write, by basename, comma-separated. */
export const RECORD_BASELINE_ENV = "LETHAL_ITEST_RECORD_BASELINE";

const gateHow = (enable: string, name: string, script: string): string =>
  `${enable} ${RECORD_BASELINE_ENV}=${name} bun run ${script}`;

/**
 * R332: every gate baseline, by basename, and the command that records it. The basename is the
 * whole contract: all frozen baselines live in `packages/runner/itest/`, so a basename names one
 * file, and `tests/baseline-wiring.test.ts` pins every gate's path to `join(HERE, <this key>)`.
 */
export const GATE_BASELINES: Readonly<Record<string, string>> = {
  "al-runner.baseline.json": gateHow(
    "LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<al-runner.exe>",
    "al-runner.baseline.json",
    "itest:alrunner",
  ),
  "bcdev.baseline.json": gateHow("LETHAL_ITEST_BCDEV=1", "bcdev.baseline.json", "itest:bcdev"),
  "envtool.baseline.json": gateHow("LETHAL_ITEST_ENVTOOL=1", "envtool.baseline.json", "itest:envtool"),
  "harden.baseline.json": gateHow("LETHAL_ITEST_HARDEN=1", "harden.baseline.json", "itest:harden"),
  "tables.baseline.json": gateHow("LETHAL_ITEST_TABLES=1", "tables.baseline.json", "itest:tables"),
};

/** R321's symbol baselines. Recorded only through `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1`. */
export const SYMBOL_BASELINES: readonly string[] = [
  "al-runner.symbols-lethala.baseline.json",
  "al-runner.symbols-lethalb.baseline.json",
];
const SYMBOL_HOW =
  "LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1 LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH=<al-runner.exe> bun run itest:alrunner";

/** R332: thrown after a gate record run wrote its baseline. The gate exits 3: never a pass. */
export class BaselineRecordedError extends Error {}

/** The command that records this baseline. Throws for a file that is not registered. */
export function recordHowFor(baselinePath: string): string {
  const name = basename(baselinePath);
  const gate = GATE_BASELINES[name];
  if (gate !== undefined) return gate;
  if (SYMBOL_BASELINES.includes(name)) return SYMBOL_HOW;
  throw new Error(
    `${baselinePath} is not a registered frozen baseline. Register its basename in GATE_BASELINES or SYMBOL_BASELINES (baseline-guard.ts).`,
  );
}

/** True when `LETHAL_ITEST_RECORD_BASELINE` lists this file's basename. Any unknown entry throws. */
export function recordRequested(
  baselinePath: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env[RECORD_BASELINE_ENV];
  if (raw === undefined || raw === "") return false;
  const listed = raw.split(",").map((s) => s.trim());
  for (const entry of listed) {
    if (GATE_BASELINES[entry] === undefined) {
      throw new Error(
        `${RECORD_BASELINE_ENV} lists ${JSON.stringify(entry)}, which is not a gate baseline. It takes exact basenames from: ${Object.keys(GATE_BASELINES).join(", ")}. The symbol baselines use LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1.`,
      );
    }
  }
  return listed.includes(basename(baselinePath));
}

function overwriteRefusal(baselinePath: string, label: string): Error {
  return new Error(
    `${label}: record mode refuses to overwrite the committed baseline at ${baselinePath}. Recording is one-time: a change needs a new pre-commitment, then the file deleted deliberately, then one record run.`,
  );
}

function missingRefusal(baselinePath: string, label: string): Error {
  return new Error(
    `${label}: no committed baseline at ${baselinePath}. This gate never records one silently; after a pre-commitment, record once with:\n  ${recordHowFor(baselinePath)}\nthen re-run without the record variable to confirm a pass, review the file and commit it.`,
  );
}

/** Startup check shared by every preflight: missing (record off) or present (record on) throws. */
export function preflightFrozenBaseline(baselinePath: string, label: string, record: boolean): void {
  recordHowFor(baselinePath);
  const exists = existsSync(baselinePath);
  if (record && exists) throw overwriteRefusal(baselinePath, label);
  if (!record && !exists) throw missingRefusal(baselinePath, label);
}

/** First line of every writing gate's `main()`: fails in seconds, before any live work. */
export function preflightGateBaseline(
  baselinePath: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  preflightFrozenBaseline(baselinePath, label, recordRequested(baselinePath, env));
}

/** First line of every READER's `main()`. Readers never record, so record mode is ignored. */
export function preflightReadOnlyBaseline(baselinePath: string, label: string): void {
  preflightFrozenBaseline(baselinePath, label, false);
}

/** The ONLY baseline write an itest performs. `wx`: the OS refuses if the file exists. */
async function writeBaselineOnce(
  actual: readonly NormalizedMutant[],
  baselinePath: string,
  label: string,
): Promise<void> {
  try {
    await writeFile(baselinePath, `${JSON.stringify(actual, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw overwriteRefusal(baselinePath, label);
    throw err;
  }
}

async function compareWithCommitted(
  actual: readonly NormalizedMutant[],
  baselinePath: string,
  label: string,
): Promise<void> {
  if (!existsSync(baselinePath)) throw missingRefusal(baselinePath, label);
  throwOnDiff(
    actual,
    await readFile(baselinePath, "utf8"),
    baselinePath,
    label,
    `If this difference is EXPECTED, write a pre-commitment, delete ${baselinePath}, record once with:\n  ${recordHowFor(baselinePath)}\nthen re-run without the record variable to confirm a pass, review the diff and commit it.`,
  );
}

/** R332: compare, or (record mode naming this file) write once and throw BaselineRecordedError. */
export async function assertGateBaseline(
  report: SessionReport,
  baselinePath: string,
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  recordHowFor(baselinePath);
  const actual = sortedForDisk(normalizeForComparison(report));
  if (!recordRequested(baselinePath, env)) {
    await compareWithCommitted(actual, baselinePath, label);
    return;
  }
  await writeBaselineOnce(actual, baselinePath, label);
  throw new BaselineRecordedError(
    `${label}: RECORDED ${baselinePath}; NOT a pass. Review it against the pre-commitment, re-run without ${RECORD_BASELINE_ENV} to confirm it passes, then commit it.`,
  );
}

/**
 * R321's symbol legs. Same refusals, exclusive write (finding C). Recording returns instead of
 * throwing, so one record run writes BOTH symbol files; al-runner.itest.ts then exits 3.
 */
export async function assertMatchesFrozenBaseline(
  report: SessionReport,
  baselinePath: string,
  label: string,
  record: boolean,
): Promise<void> {
  recordHowFor(baselinePath);
  const actual = sortedForDisk(normalizeForComparison(report));
  if (!record) {
    await compareWithCommitted(actual, baselinePath, label);
    return;
  }
  await writeBaselineOnce(actual, baselinePath, label);
  console.log(`${label}: recorded ${baselinePath}. Review it against the pre-commitment and commit it.`);
}
```

- [ ] **Step 4: Run, expect pass**

Run: `bun test packages/runner/tests/baseline-guard.test.ts`
Expected: PASS (new tests and the four R321 tests).

- [ ] **Step 5: Red-check each mechanism** (revert, named test goes red, restore; report both outputs)

| Mechanism | Revert | Test that must go red |
|---|---|---|
| Missing refusal at compare | in `compareWithCommitted`, delete `if (!existsSync(baselinePath)) throw missingRefusal(...)` | "missing, record off: refused ..." (it now fails with a raw ENOENT that lacks the command) |
| Missing refusal at startup | in `preflightFrozenBaseline`, delete the `!record && !exists` line | "preflightGateBaseline: refuses missing ..." and "preflightReadOnlyBaseline ..." |
| Overwrite refusal at startup | delete the `record && exists` line | "preflightFrozenBaseline covers both symbol files ..." |
| Exclusive write (gate and symbol) | `flag: "wx"` to `flag: "w"` | "present, record on: the write itself refuses (wx) ..." AND "record mode never overwrites a symbol file ..." |
| Record run is not a pass | delete the `throw new BaselineRecordedError(...)` | "missing, record on: writes once ... then BaselineRecordedError" |
| Mismatch never re-records | in `compareWithCommitted`, replace `throwOnDiff(...)` with `await writeFile(baselinePath, \`${JSON.stringify(actual, null, 2)}\n\`, "utf8")` | "present, mismatch: throws ..., never re-records" |
| Unknown names throw | in `recordRequested`, delete the `for (const entry of listed)` loop | "recordRequested throws on =1, a typo, ..." |
| Exact basename match | `listed.includes(basename(baselinePath))` to `listed.length > 0` | "arming another file does not arm this one" |

Each: `bun test packages/runner/tests/baseline-guard.test.ts -t "<name>"`, expect FAIL; restore; re-run the file, expect PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runner/itest/baseline-guard.ts packages/runner/tests/baseline-guard.test.ts
git commit -m "itest(R332): registry of frozen baselines; missing refused, record only when named, every write exclusive, record run never a pass"
```

---

### Task 2: harden's split record

**Files:**
- Modify: `packages/runner/itest/harden-expected.ts` (import on line 2; `recordAfterBothLegs`, around lines 387-399)
- Modify: `packages/runner/itest/harden.itest.ts` (import around line 37; `main` around lines 198-229; top-level `try/catch` around lines 240-246)
- Test: `packages/runner/itest/harden-fixture.test.ts` (describe "C02-03", around lines 284-322)

**Interfaces:** `recordAfterBothLegs(reportA: SessionReport, legB: () => Promise<void>, baselinePath: string, env?: NodeJS.ProcessEnv): Promise<void>`

- [ ] **Step 1: Failing test.** Replace the C02-03 describe. Add `mkdir` to the `node:fs/promises` import and `import { BaselineRecordedError, RECORD_BASELINE_ENV } from "./baseline-guard";`:

```ts
describe("C02-03 + R332: written only after leg B passes, and only in record mode", () => {
  const exists = (p: string) =>
    access(p).then(
      () => true,
      () => false,
    );
  const NAME = "harden.baseline.json";
  const armed: NodeJS.ProcessEnv = { [RECORD_BASELINE_ENV]: NAME };

  test("record mode: a leg-B failure leaves no file; a leg-B pass writes it and is NOT a pass", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-harden-baseline-"));
    try {
      const reportA = reportFrom(EXPECTED);
      await mkdir(join(dir, "fail"));
      const failPath = join(dir, "fail", NAME);
      await expect(
        recordAfterBothLegs(
          reportA,
          async () => {
            throw new Error("leg B failed");
          },
          failPath,
          armed,
        ),
      ).rejects.toThrow("leg B failed");
      expect(await exists(failPath)).toBe(false);

      await mkdir(join(dir, "ok"));
      const okPath = join(dir, "ok", NAME);
      let legBRan = false;
      const err = await recordAfterBothLegs(
        reportA,
        async () => {
          legBRan = true;
        },
        okPath,
        armed,
      ).catch((e: unknown) => e);
      expect(legBRan).toBe(true);
      expect(err).toBeInstanceOf(BaselineRecordedError);
      const written = JSON.parse(await readFile(okPath, "utf8")) as NormalizedMutant[];
      expect(written.length).toBe(EXPECTED.length);
      expect(diffMutants(written, normalizeForComparison(reportA))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("record mode off: a missing baseline is refused after leg B and nothing is written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-harden-baseline-"));
    try {
      const p = join(dir, NAME);
      await expect(recordAfterBothLegs(reportFrom(EXPECTED), async () => {}, p, {})).rejects.toThrow(
        /never records one silently/,
      );
      expect(await exists(p)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run, expect failure.** `bun test packages/runner/itest/harden-fixture.test.ts -t "R332"`. FAIL.

- [ ] **Step 3: Implement.** `harden-expected.ts` line 2: `import { assertGateBaseline } from "./baseline-guard";`. Replace `recordAfterBothLegs` and its doc comment:

```ts
/**
 * Compares or records the baseline only after legB() resolved. A leg-B throw propagates and leaves
 * no file behind. R332: recording happens only when `LETHAL_ITEST_RECORD_BASELINE` names the file,
 * and then this throws `BaselineRecordedError`, so a record run never passes.
 */
export async function recordAfterBothLegs(
  reportA: SessionReport,
  legB: () => Promise<void>,
  baselinePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await legB();
  await assertGateBaseline(reportA, baselinePath, "harden itest", env);
}
```

- [ ] **Step 4: Wire `harden.itest.ts`.** Import: `import { BaselineRecordedError, assertGateBaseline, preflightGateBaseline, recordRequested } from "./baseline-guard";`. In `main()`:
  - Make `preflightGateBaseline(BASELINE_PATH, "harden itest");` the first statement.
  - Delete the `baselineExisted` block.
  - Replace the comment and call `if (baselineExisted) await assertMatchesBaseline(a, BASELINE_PATH, "harden itest");` with:

```ts
    // Compare early so a mismatch names a mutant before leg B. In record mode the file is absent
    // (preflight) and is written only after leg B, by recordAfterBothLegs.
    if (!recordRequested(BASELINE_PATH)) await assertGateBaseline(a, BASELINE_PATH, "harden itest");
```

and change the call to `recordAfterBothLegs(a, async () => { ...unchanged leg B... }, BASELINE_PATH);`. Drop `access` from the import if `rg -n "access\(" packages/runner/itest/harden.itest.ts` finds no other use. Top-level catch: replace `process.exit(1);` with `process.exit(err instanceof BaselineRecordedError ? 3 : 1);`.

- [ ] **Step 5: Run, expect pass.** `bun test packages/runner/itest/harden-fixture.test.ts`: PASS.

- [ ] **Step 6: Red-check.** Restore the old body `await legB(); await assertMatchesBaseline(reportA, baselinePath, "harden itest");` with its import. `-t "record mode off"`: FAIL, a file was written. Restore; PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/runner/itest/harden-expected.ts packages/runner/itest/harden.itest.ts packages/runner/itest/harden-fixture.test.ts
git commit -m "itest(R332): harden refuses a missing baseline at startup, records only in record mode after leg B, exits 3 on a record run"
```

---

### Task 3: bcdev, al-runner (both kinds), tables, envtool

**Files:** `packages/runner/itest/{bcdev,al-runner,tables,envtool}.itest.ts`.

- [ ] **Step 1: bcdev.itest.ts.** Import line `import { assertMatchesBaseline } from "./baseline-guard";` becomes `import { BaselineRecordedError, assertGateBaseline, preflightGateBaseline } from "./baseline-guard";`. First statement of `main()`: `preflightGateBaseline(BASELINE_PATH, "bcdev itest");`. The call `await assertMatchesBaseline(first.report, BASELINE_PATH, "bcdev itest");` becomes `await assertGateBaseline(first.report, BASELINE_PATH, "bcdev itest");`. In `main().catch`, `process.exit(1);` becomes `process.exit(err instanceof BaselineRecordedError ? 3 : 1);`.

- [ ] **Step 2: al-runner.itest.ts.** Import: `import { BaselineRecordedError, assertGateBaseline, assertMatchesFrozenBaseline, preflightFrozenBaseline, preflightGateBaseline } from "./baseline-guard";`. `main()` begins, before `await stampRunnerVersion();`:

```ts
  preflightGateBaseline(BASELINE_PATH, "al-runner itest");
  // Finding C / I2: BOTH symbol baselines, before either leg runs and before either is written.
  for (const symbols of SYMBOL_SETS) {
    preflightFrozenBaseline(symbolBaselinePath(symbols), "al-runner itest symbols", RECORD_SYMBOL_BASELINES);
  }
```

The call `assertMatchesBaseline(first, BASELINE_PATH, "al-runner itest")` becomes `assertGateBaseline(first, BASELINE_PATH, "al-runner itest")`. The symbol call site and the end-of-main symbol exit 3 are unchanged. Catch: `process.exit(err instanceof BaselineRecordedError ? 3 : 1);`.

- [ ] **Step 3: tables.itest.ts.** Same import swap as bcdev. First statement of `main()`: `preflightGateBaseline(BASELINE_PATH, "tables itest");`. The call becomes `await assertGateBaseline(first.report, BASELINE_PATH, "tables itest");`. Make the same catch change. In comments, rename each prose mention of `assertMatchesBaseline` to `assertGateBaseline`. Replace "(semantic-identity keyed, and self-recording when the file is absent)" with "(semantic-identity keyed; since R332 a missing file is refused, never recorded silently)".

- [ ] **Step 4: envtool.itest.ts.**
  - Import: `import { BaselineRecordedError, assertGateBaseline, preflightGateBaseline } from "./baseline-guard";`.
  - Replace the comment above `BASELINE_PATH` ("Committed per-mutant baseline, see baseline-guard.ts. Absent on the first run: the guard RECORDS it ...") with: "Committed per-mutant baseline, see baseline-guard.ts. R332: a missing file is REFUSED at startup, and it is recorded only with `LETHAL_ITEST_RECORD_BASELINE=envtool.baseline.json`, never over an existing file, in a run that exits 3."
  - In the EXPECTED comment, change "`assertMatchesBaseline` below is what pins the per-mutant table down, on whatever the human's first real run records." to "`assertGateBaseline` below is what pins the per-mutant table down, against the file a deliberate record run wrote."
  - In `refuseSelfRecordWhileUnverified`'s doc comment, replace "`assertMatchesBaseline` RECORDS a baseline when the file is absent, which is right for a gate whose fixture legitimately grew." with "Since R332 every gate refuses a missing baseline and records one only in record mode. This guard refuses that record mode too while moves are unverified." The function body is unchanged.
  - `main()` begins:

```ts
  refuseSelfRecordWhileUnverified();
  preflightGateBaseline(BASELINE_PATH, "envtool itest");
```

  - The lines `refuseSelfRecordWhileUnverified(); await assertMatchesBaseline(report, BASELINE_PATH, "envtool itest");` and their comment become:

```ts
    // Per-mutant regression guard against the committed baseline, keyed on semantic identity.
    await assertGateBaseline(report, BASELINE_PATH, "envtool itest");
```

  - Catch: `process.exit(err instanceof BaselineRecordedError ? 3 : 1);`. envtool writes no receipt; that is Task 7's roadmap item, not this task.

- [ ] **Step 5: Typecheck this far.** `bun run typecheck` then `rm -rf packages/*/dist`. Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/runner/itest/bcdev.itest.ts packages/runner/itest/al-runner.itest.ts packages/runner/itest/tables.itest.ts packages/runner/itest/envtool.itest.ts
git commit -m "itest(R332): bcdev, al-runner, tables and envtool preflight their baselines (al-runner both symbol files too) and exit 3 on a record run"
```

---

### Task 4: Readers preflight at startup

**Files:** `packages/runner/itest/{verify,test-app-publish,verify-agreement,verify-scale}.itest.ts`.

- [ ] **Step 1.** In each file, add `import { preflightReadOnlyBaseline } from "./baseline-guard";`. Make this the first statement of `main()`:

| File | First statement |
|---|---|
| `verify.itest.ts` | `preflightReadOnlyBaseline(BASELINE_PATH, "verify itest");` |
| `test-app-publish.itest.ts` | `preflightReadOnlyBaseline(BASELINE_PATH, "testapp itest");` |
| `verify-agreement.itest.ts` | `preflightReadOnlyBaseline(BASELINE_PATH, "agreement itest");` |
| `verify-scale.itest.ts` | `preflightReadOnlyBaseline(BASELINE_PATH, "verify-scale itest");` (before the `LETHAL_VERIFY_SCALE_OUT` check) |

In `verify-agreement.itest.ts` and `verify-scale.itest.ts`, the comment "Read only. `assertMatchesBaseline` is never called: it WRITES a missing file." becomes "Read only, and refused at startup when missing (R332). This gate never writes it." Do not touch `verify-scale.itest.ts`'s `if (import.meta.main && process.argv.includes("--compile-only"))` block.

- [ ] **Step 2: Compile-only path still works.** Run `bun packages/runner/itest/verify-scale.itest.ts --compile-only` only if `alc.exe` and `fixtures/sandbox-data-tests/.alpackages` are present. That path is offline: `alc` only, no server. Expected: `compile-only PASS`, exit 0, exactly as before. If `alc` is absent, write down that it was not run. Either way, `rg -n "preflightReadOnlyBaseline" packages/runner/itest/verify-scale.itest.ts` must show the call inside `main()` only, and not in the compile-only block.

- [ ] **Step 3: Commit**

```bash
git add packages/runner/itest/verify.itest.ts packages/runner/itest/test-app-publish.itest.ts packages/runner/itest/verify-agreement.itest.ts packages/runner/itest/verify-scale.itest.ts
git commit -m "itest(R332): verify, testapp, agreement and verify-scale refuse a missing baseline at startup, before live work"
```

---

### Task 5: The wiring test, on the AST (finding I3)

**Files:** Create `packages/runner/tests/baseline-wiring.test.ts`.

Why an AST and not text: a comment, an unused import or a string in an error message all satisfy `toContain("preflightGateBaseline(")`. The TypeScript parser drops comments. The test looks at real `CallExpression` nodes, import specifiers and statement order. Two limits remain, and they are named in the file header: a path that flows through more than one variable, and a call in unreachable code. Task 9's offline runs are the behavioural proof for those.

- [ ] **Step 1: Write the test, including its negative cases**

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { GATE_BASELINES, SYMBOL_BASELINES } from "../itest/baseline-guard";

/**
 * R332: the live gates run and exit at module top level, so they cannot be imported. Their wiring
 * is checked on the AST: comments and unused imports do not count. Limits: a baseline path that
 * flows through more than one variable, or a call in unreachable code, is not seen here; the
 * offline runs in the R332 plan (Task 9) are the behavioural proof for the gates.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");
const ITEST = join(ROOT, "packages", "runner", "itest");
const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);

const WRITERS = new Set([
  "writeFile", "writeFileSync", "appendFile", "appendFileSync", "copyFile", "copyFileSync",
  "rename", "renameSync", "cp", "cpSync", "createWriteStream",
]);
const FS_MODULES = new Set(["node:fs", "node:fs/promises", "fs", "fs/promises"]);
const LOOKS_LIKE_BASELINE = /baseline/i;
const DEST_IS_SECOND = new Set(["copyFile", "copyFileSync", "rename", "renameSync", "cp", "cpSync"]);

/** Every way this source could write a baseline outside baseline-guard.ts. Empty is clean. */
function writeViolations(sf: ts.SourceFile, allowSelfRecordingImport = false): string[] {
  const out: string[] = [];
  const at = (n: ts.Node) => `${sf.fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const writerNames = new Set(WRITERS);
  const baselineVars = new Set<string>();
  const collect = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const bindings = n.importClause?.namedBindings;
      if (FS_MODULES.has(n.moduleSpecifier.text) && bindings && ts.isNamedImports(bindings)) {
        for (const s of bindings.elements) {
          if (WRITERS.has((s.propertyName ?? s.name).text)) writerNames.add(s.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (LOOKS_LIKE_BASELINE.test(n.initializer.getText(sf))) baselineVars.add(n.name.text);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const targetsBaseline = (a: ts.Expression): boolean =>
    LOOKS_LIKE_BASELINE.test(a.getText(sf)) || (ts.isIdentifier(a) && baselineVars.has(a.text));
  const visit = (n: ts.Node): void => {
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === "assertMatchesBaseline" && !allowSelfRecordingImport) {
      out.push(`${at(n)}: imports the self-recording assertMatchesBaseline (as ${n.name.text})`);
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === "assertMatchesBaseline" && !allowSelfRecordingImport) {
      out.push(`${at(n)}: calls <namespace>.assertMatchesBaseline`);
    }
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : "";
      const bunWrite =
        ts.isPropertyAccessExpression(c) && c.expression.getText(sf) === "Bun" && name === "write";
      const fsWrite = ts.isIdentifier(c) ? writerNames.has(name) : WRITERS.has(name);
      // The DESTINATION only: arg 1 for copy/rename/cp, arg 0 otherwise. Checking every argument
      // would flag `writeFile(out, JSON.stringify(baselineSnapshot))`, a false positive.
      const dest = n.arguments[DEST_IS_SECOND.has(name) ? 1 : 0];
      if ((bunWrite || fsWrite) && dest !== undefined && targetsBaseline(dest)) {
        out.push(`${at(n)}: ${bunWrite ? "Bun.write" : name}(...) targets a baseline`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function mainOf(sf: ts.SourceFile): ts.FunctionDeclaration {
  const m = sf.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "main",
  );
  if (m?.body === undefined) throw new Error(`${sf.fileName}: no function main()`);
  return m;
}

function calls(root: ts.Node, sf: ts.SourceFile, fn: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === fn) found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

const hasAwait = (n: ts.Node): boolean => ts.isAwaitExpression(n) || (ts.forEachChild(n, hasAwait) ?? false);

/** The statements of main() before the first one that awaits. */
function preAwait(sf: ts.SourceFile): ts.Statement[] {
  const stmts = mainOf(sf).body?.statements ?? [];
  const i = stmts.findIndex(hasAwait);
  return i < 0 ? [...stmts] : stmts.slice(0, i);
}

/** `const BASELINE_PATH = join(HERE, "<literal>")`, returning the literal. */
function baselineName(sf: ts.SourceFile): string {
  for (const s of sf.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== "BASELINE_PATH") continue;
      const i = d.initializer;
      if (i && ts.isCallExpression(i) && i.expression.getText(sf) === "join" && i.arguments.length === 2) {
        const [dir, lit] = i.arguments;
        if (dir && lit && dir.getText(sf) === "HERE" && ts.isStringLiteral(lit)) return lit.text;
      }
    }
  }
  throw new Error(`${sf.fileName}: BASELINE_PATH is not join(HERE, "<name>")`);
}

/** `process.exit(err instanceof BaselineRecordedError ? 3 : 1)` somewhere in the file. */
function exitsThreeOnRecord(sf: ts.SourceFile): boolean {
  let ok = false;
  const visit = (n: ts.Node): void => {
    const arg = ts.isCallExpression(n) ? n.arguments[0] : undefined;
    if (
      ts.isCallExpression(n) &&
      n.expression.getText(sf) === "process.exit" &&
      arg !== undefined &&
      ts.isConditionalExpression(arg) &&
      ts.isBinaryExpression(arg.condition) &&
      arg.condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      arg.condition.right.getText(sf) === "BaselineRecordedError" &&
      arg.whenTrue.getText(sf) === "3"
    ) {
      ok = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return ok;
}

const WRITING_GATES: Record<string, string> = {
  "al-runner.itest.ts": "al-runner.baseline.json",
  "bcdev.itest.ts": "bcdev.baseline.json",
  "envtool.itest.ts": "envtool.baseline.json",
  "harden.itest.ts": "harden.baseline.json",
  "tables.itest.ts": "tables.baseline.json",
};
const READERS: Record<string, string> = {
  "verify.itest.ts": "bcdev.baseline.json",
  "test-app-publish.itest.ts": "bcdev.baseline.json",
  "verify-agreement.itest.ts": "harden.baseline.json",
  "verify-scale.itest.ts": "tables.baseline.json",
};

describe("R332 wiring: real call sites, not text", () => {
  test("the registry equals the committed baselines, one directory, so basenames are unique", () => {
    const committed = readdirSync(ITEST).filter((f) => f.endsWith(".baseline.json")).sort();
    expect([...Object.keys(GATE_BASELINES), ...SYMBOL_BASELINES].sort()).toEqual(committed);
  });

  test("each writing gate: BASELINE_PATH, startup preflight, a real assertGateBaseline call, exit 3", () => {
    for (const [file, name] of Object.entries(WRITING_GATES)) {
      const sf = parse(join(ITEST, file));
      expect({ file, name: baselineName(sf) }).toEqual({ file, name });
      const head = preAwait(sf);
      const pre = head.flatMap((s) => calls(s, sf, "preflightGateBaseline"));
      expect({ file, preflight: pre.some((c) => c.arguments[0]?.getText(sf) === "BASELINE_PATH") }).toEqual({
        file,
        preflight: true,
      });
      const writerFile = file === "harden.itest.ts" ? "harden-expected.ts" : file;
      const wsf = parse(join(ITEST, writerFile));
      const root = file === "harden.itest.ts" ? wsf : mainOf(wsf);
      const asserted = calls(root, wsf, "assertGateBaseline").some((c) =>
        ["BASELINE_PATH", "baselinePath"].includes(c.arguments[1]?.getText(wsf) ?? ""),
      );
      expect({ file, asserted }).toEqual({ file, asserted: true });
      expect({ file, exit3: exitsThreeOnRecord(sf) }).toEqual({ file, exit3: true });
    }
    // harden: main() hands BASELINE_PATH to recordAfterBothLegs, whose body is checked above.
    const h = parse(join(ITEST, "harden.itest.ts"));
    expect(
      calls(mainOf(h), h, "recordAfterBothLegs").some((c) => c.arguments[2]?.getText(h) === "BASELINE_PATH"),
    ).toBe(true);
  });

  test("al-runner preflights BOTH symbol baselines before its first await", () => {
    const sf = parse(join(ITEST, "al-runner.itest.ts"));
    const pre = preAwait(sf).flatMap((s) => calls(s, sf, "preflightFrozenBaseline"));
    expect(pre.map((c) => c.arguments[0]?.getText(sf))).toEqual(["symbolBaselinePath(symbols)"]);
    const loop = preAwait(sf).find(ts.isForOfStatement);
    expect(loop?.expression.getText(sf)).toBe("SYMBOL_SETS");
  });

  test("each reader: BASELINE_PATH and a startup preflightReadOnlyBaseline", () => {
    for (const [file, name] of Object.entries(READERS)) {
      const sf = parse(join(ITEST, file));
      expect({ file, name: baselineName(sf) }).toEqual({ file, name });
      const pre = preAwait(sf).flatMap((s) => calls(s, sf, "preflightReadOnlyBaseline"));
      expect({ file, preflight: pre.some((c) => c.arguments[0]?.getText(sf) === "BASELINE_PATH") }).toEqual({
        file,
        preflight: true,
      });
    }
  });

  test("no source anywhere writes a baseline except baseline-guard.ts", () => {
    const roots = [ITEST, join(ROOT, "packages", "runner", "src"), join(ROOT, "scripts")];
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules" && e.name !== "dist") walk(p);
        } else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && e.name !== "baseline-guard.ts") {
          files.push(p);
        }
      }
    };
    for (const r of roots) walk(r);
    const found = files.flatMap((f) =>
      writeViolations(parse(f), relative(ROOT, f).replace(/\\/g, "/") === "packages/runner/src/campaign-freeze.ts"),
    );
    expect(found).toEqual([]);
  });
});

describe("R332 wiring: the checker catches alternate writers (negative tests)", () => {
  const src = (text: string) => ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);

  test.each([
    ["direct writeFile", `import { writeFile } from "node:fs/promises";\nawait writeFile(BASELINE_PATH, "x");`],
    ["aliased writeFile through a variable", `import { writeFile as w } from "node:fs/promises";\nconst p = join(HERE, "bcdev.baseline.json");\nawait w(p, "x");`],
    ["namespace fs", `import * as fsp from "node:fs/promises";\nawait fsp.writeFile(BASELINE_PATH, "x");`],
    ["Bun.write", `await Bun.write(BASELINE_PATH, "x");`],
    ["copyFile onto a baseline", `import { copyFile } from "node:fs/promises";\nawait copyFile(tmp, BASELINE_PATH);`],
    ["aliased self-recording helper", `import { assertMatchesBaseline as check } from "./baseline-guard";\nawait check(r, BASELINE_PATH, "x");`],
    ["namespace self-recording helper", `import * as g from "./baseline-guard";\nawait g.assertMatchesBaseline(r, BASELINE_PATH, "x");`],
  ])("%s is a violation", (_name, text) => {
    expect(writeViolations(src(text)).length).toBeGreaterThan(0);
  });

  test.each([
    ["a comment", `// await writeFile(BASELINE_PATH, "x");\nconst a = 1;`],
    ["a scratch write", `import { writeFile } from "node:fs/promises";\nawait writeFile(join(scratch, "out.json"), "x");`],
    ["reading a baseline", `const raw = await readFile(BASELINE_PATH, "utf8");`],
  ])("%s is clean", (_name, text) => {
    expect(writeViolations(src(text))).toEqual([]);
  });

  test("a preflight in a comment, or after an await, does not count", () => {
    const commented = src(
      `const BASELINE_PATH = join(HERE, "bcdev.baseline.json");\nasync function main(): Promise<void> {\n  // preflightGateBaseline(BASELINE_PATH, "x");\n  await go();\n}`,
    );
    expect(preAwait(commented).flatMap((s) => calls(s, commented, "preflightGateBaseline"))).toEqual([]);
    const late = src(
      `async function main(): Promise<void> {\n  await go();\n  preflightGateBaseline(BASELINE_PATH, "x");\n}`,
    );
    expect(preAwait(late).flatMap((s) => calls(s, late, "preflightGateBaseline"))).toEqual([]);
  });
});
```

Biome will format the long lines. Add one more negative case to the "is clean" table while there: `["a baseline in the CONTENT, not the destination", \`import { writeFile } from "node:fs/promises";\nawait writeFile(outPath, JSON.stringify(baselineSnapshot));\`]`.

- [ ] **Step 2: Run.** `bun test packages/runner/tests/baseline-wiring.test.ts`. Expected: PASS after Tasks 1-4. If "no source anywhere writes a baseline" reports a finding, read it. A real writer is a finding for the orchestrator. A false positive is also reported: do NOT loosen the regex on your own.

- [ ] **Step 3: Red-check the wiring** (each: edit, run, see the named test FAIL, restore)
  - (a) In `bcdev.itest.ts`, put back `import { assertMatchesBaseline as check } from "./baseline-guard";` and use `check(first.report, BASELINE_PATH, "bcdev itest")`. The test "no source anywhere writes a baseline" fails, naming `bcdev.itest.ts`.
  - (b) In `tables.itest.ts`, move the preflight below `const { files } = await generateMutationSet(PROJECT_DIR);`. "each writing gate ..." fails for `tables.itest.ts`.
  - (c) In `al-runner.itest.ts`, delete the symbol `for` loop. "al-runner preflights BOTH symbol baselines" fails.
  - (d) In `verify.itest.ts`, turn the preflight into a comment. "each reader ..." fails for `verify.itest.ts`.
  - (e) In `envtool.itest.ts`, change the catch back to `process.exit(1)`. "each writing gate ..." fails with `exit3: false`.
  - (f) Create an empty `packages/runner/itest/zz-r332.baseline.json`. "the registry equals the committed baselines" fails. Delete the file.

- [ ] **Step 4: Commit**

```bash
git add packages/runner/tests/baseline-wiring.test.ts
git commit -m "test(R332): AST wiring test; every baseline has a refusing writer and a startup preflight, no alternate writer anywhere"
```

---

### Task 6: Record the stale hook advice as an owner proposal (no hook edit)

The lane runbook forbids lanes to edit hooks, so the lane does NOT touch `.claude/hooks/baseline-guard.ts`. This task has no code step. The stale message and its exact replacement are in the section "Proposed owner text", item 4, next to the CLAUDE.md proposals. The executor copies that item unchanged into the task report, so the owner sees it with the rest of the owner-only text.

- [ ] **Step 1.** Check the hook file is untouched: `git diff --exit-code e716a79b -- .claude/hooks/baseline-guard.ts` exits 0.

---

### Task 7: File envtool's missing gate receipt as its own roadmap item (ruling Q3)

**Files:** Create `docs/roadmap/R<next>.md`; regenerate `ROADMAP.md`.

- [ ] **Step 1: Find the next free id across every worktree and every local and remote branch, IMMEDIATELY before writing.**

```bash
cd /u/Git/LethAL-wt/lane-code
git fetch --all --quiet || echo "fetch failed: remote ids may be stale, say so in the report"
{
  git worktree list --porcelain | sed -n 's/^worktree //p' | while read -r wt; do ls "$wt/docs/roadmap" 2>/dev/null; done
  git for-each-ref --format='%(refname)' refs/heads refs/remotes | while read -r ref; do git ls-tree --name-only "$ref" docs/roadmap/ 2>/dev/null | sed 's#.*/##'; done
} | grep -oE '^R[0-9]+' | sed 's/^R//' | sort -n | tail -1
```

Take that number plus one, zero-padded to three digits, as `R<next>`. At the time of writing, the highest here is `R335`. Do not trust that number: re-run the command right before Step 2, because other sessions commit ids concurrently. Also read the highest `order:` in section `backends-and-tooling` with `grep -h "^order:" docs/roadmap/R*.md | sort -t: -k2 -n | tail -1`, and use that plus one.

- [ ] **Step 2: Write the item**

```markdown
---
id: "R<next>"
title: "`itest:envtool` writes no gate receipt, so a challenged caller cannot tell its pass from a skip or a refusal"
section: "backends-and-tooling"
status: "open, filed <today>"
order: <max order + 1>
---

**Found during R332 (2026-09-29).** `packages/runner/itest/envtool.itest.ts` never imports
`gate-receipt.ts`: its skip branch exits 0 with no `emitSkipped`, its `main()` ends with no
`emitPassed`, and its catch exits 1 (3 for an R332 record run) with no `emitFailed`. Every other
gate with a live leg writes a receipt when `LETHAL_GATE_*` is set (R223), so a caller that demands
receipts reads envtool as "no statement", which it must treat as an error, and cannot tell a pass,
a skip, an R332 refusal and a record run apart.

**What would close it.** Wire `emitSkipped("envtool", ...)` (exit 1 when challenged),
`emitPassed("envtool", { sublegs: ["envtool"], artifacts: { reported: false } })` and
`emitFailed` in the catch, as `bcdev.itest.ts` does, and add `envtool` wherever the gate ladder's
`expectedSublegs` lists legs. Offline proof: run the gate with its enable variable unset and a full
challenge set, and read `status: "skipped"`.
```

- [ ] **Step 3: Regenerate and check.** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`: PASS.

- [ ] **Step 4: Commit.** `git add docs/roadmap/R<next>.md ROADMAP.md && git commit -m "roadmap(R<next>): itest:envtool writes no gate receipt"`

---

### Task 8: Full build and test loop

- [ ] **Step 1:** `bun run typecheck`. Expected: exit 0.
- [ ] **Step 2:** `rm -rf packages/*/dist`
- [ ] **Step 3:** `bun test` from the repo root. Expected: 0 fail. These must be green: `baseline-guard.test.ts`, `baseline-wiring.test.ts`, `harden-fixture.test.ts`, `mutant-equality.test.ts`, `campaign-subcommands.test.ts`, `campaign-freeze.test.ts` (campaign behaviour unchanged), `roadmap-index.test.ts` and `real-home-guard.test.ts`.
- [ ] **Step 4:** `bunx biome check` on every touched `.ts` file: `packages/runner/itest/{baseline-guard,harden-expected}.ts`, the nine `*.itest.ts` files edited, `packages/runner/itest/harden-fixture.test.ts`, and `packages/runner/tests/{baseline-guard,baseline-wiring}.test.ts`. No `.al` is touched, so `bun run compile:fixtures` is not needed.

---

### Task 9: Offline proof per gate, and byte identity

Each run starts a gate's script with its enable variable set. It must stop at the preflight, before any live work. Safety nets make a misplaced preflight fail locally, not on a server:
- `LETHAL_ITEST_CONFIG=lethal.config.r332-absent.json` is a valid name for a missing file. All of bcdev, tables, harden, verify, testapp, agreement and verify-scale read their config through `itestConfigPath`.
- `LETHAL_ALRUNNER_PATH=U:/r332-absent/al-runner.exe` points at no binary.
- `LETHAL_VERIFY_SCALE_OUT=$P/r332-vs.json` is set for verify-scale.
- envtool reads a fixed `fixtures/sandbox-app/lethal.config.envtool.json`, so Step 1 checks it is absent.

Every run has `timeout 90`. Each check ASSERTS the exit code and the refusal text, so a trailing `echo` cannot hide a wrong failure.

- [ ] **Step 1: Safety precheck**

```bash
cd /u/Git/LethAL-wt/lane-code
ENVTOOL_OK=1; test -e fixtures/sandbox-app/lethal.config.envtool.json && ENVTOOL_OK=0
echo "envtool dynamic proof allowed: $ENVTOOL_OK"
for d in sandbox-app sandbox-data sandbox-harden; do test ! -e fixtures/$d/lethal.config.r332-absent.json || { echo "ABORT: fixtures/$d/lethal.config.r332-absent.json exists"; exit 1; }; done
```

- [ ] **Step 2: Define the asserting runner** (paste into the same shell)

```bash
SAFE=(LETHAL_ITEST_CONFIG=lethal.config.r332-absent.json LETHAL_ALRUNNER_PATH=U:/r332-absent/al-runner.exe LETHAL_VERIFY_SCALE_OUT="$P/r332-vs.json")
FAILS=0
# expect <log-name> <want-exit> <want-regex> -- <env assignments...> -- <npm script>
expect() {
  local log="$P/r332-$1.log" want="$2" rx="$3"; shift 4
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  env "${SAFE[@]}" "${envs[@]}" timeout 90 bun run "$1" > "$log" 2>&1; local got=$?
  if [ "$got" = "$want" ] && grep -qE "$rx" "$log"; then echo "OK   $1 ($log): exit $got"
  else echo "FAIL $1 ($log): exit $got, want $want and /$rx/"; tail -5 "$log"; FAILS=$((FAILS+1)); fi
}
# with_missing <baseline basename> <command...>: moves the file aside, runs, ALWAYS restores
with_missing() {
  local f="packages/runner/itest/$1"; shift
  mv "$f" "$P/$(basename "$f").hold" || { echo "FAIL could not move $f"; FAILS=$((FAILS+1)); return; }
  "$@"
  mv "$P/$(basename "$f").hold" "$f" || { echo "FAIL NOT RESTORED $f"; FAILS=$((FAILS+1)); }
}
```

- [ ] **Step 3: Record mode over an existing file: exit 1 at preflight (no file moved)**

```bash
OW='record mode refuses to overwrite the committed baseline'
expect ow-bcdev    1 "$OW" -- LETHAL_ITEST_BCDEV=1    LETHAL_ITEST_RECORD_BASELINE=bcdev.baseline.json     -- itest:bcdev
expect ow-alrunner 1 "$OW" -- LETHAL_ITEST_ALRUNNER=1 LETHAL_ITEST_RECORD_BASELINE=al-runner.baseline.json -- itest:alrunner
expect ow-symbols  1 "$OW.*symbols-lethala" -- LETHAL_ITEST_ALRUNNER=1 LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1 -- itest:alrunner
expect ow-tables   1 "$OW" -- LETHAL_ITEST_TABLES=1   LETHAL_ITEST_RECORD_BASELINE=tables.baseline.json    -- itest:tables
expect ow-harden   1 "$OW" -- LETHAL_ITEST_HARDEN=1   LETHAL_ITEST_RECORD_BASELINE=harden.baseline.json    -- itest:harden
[ "$ENVTOOL_OK" = 1 ] && expect ow-envtool 1 "$OW" -- LETHAL_ITEST_ENVTOOL=1 LETHAL_ITEST_RECORD_BASELINE=envtool.baseline.json -- itest:envtool
expect badname     1 'is not a gate baseline' -- LETHAL_ITEST_BCDEV=1 LETHAL_ITEST_RECORD_BASELINE=1 -- itest:bcdev
```

The exit code is 1, not 3: nothing was recorded, so this is an ordinary failure.

- [ ] **Step 4: Missing baseline: exit 1 at preflight, naming the owning gate's record command**

```bash
MS='never records one silently'
with_missing bcdev.baseline.json     expect ms-bcdev    1 "$MS" -- LETHAL_ITEST_BCDEV=1    -- itest:bcdev
grep -q 'LETHAL_ITEST_RECORD_BASELINE=bcdev.baseline.json bun run itest:bcdev' "$P/r332-ms-bcdev.log" || { echo "FAIL ms-bcdev: record command not named"; FAILS=$((FAILS+1)); }
with_missing al-runner.baseline.json expect ms-alrunner 1 "$MS" -- LETHAL_ITEST_ALRUNNER=1 -- itest:alrunner
with_missing al-runner.symbols-lethalb.baseline.json expect ms-symbols 1 "$MS.*symbols-lethalb|symbols-lethalb.*$MS" -- LETHAL_ITEST_ALRUNNER=1 -- itest:alrunner
with_missing tables.baseline.json    expect ms-tables   1 "$MS" -- LETHAL_ITEST_TABLES=1   -- itest:tables
with_missing harden.baseline.json    expect ms-harden   1 "$MS" -- LETHAL_ITEST_HARDEN=1   -- itest:harden
[ "$ENVTOOL_OK" = 1 ] && with_missing envtool.baseline.json expect ms-envtool 1 "$MS" -- LETHAL_ITEST_ENVTOOL=1 -- itest:envtool
with_missing bcdev.baseline.json     expect rd-verify   1 "verify itest: no committed baseline.*$MS" -- LETHAL_ITEST_VERIFY=1  -- itest:verify
with_missing bcdev.baseline.json     expect rd-testapp  1 "testapp itest: no committed baseline.*$MS" -- LETHAL_ITEST_TESTAPP=1 -- itest:testapp
with_missing harden.baseline.json    expect rd-agree    1 "agreement itest: no committed baseline.*$MS" -- LETHAL_ITEST_AGREEMENT=1 -- itest:agreement
with_missing tables.baseline.json    expect rd-vscale   1 "verify-scale itest: no committed baseline.*$MS" -- LETHAL_ITEST_VERIFY_SCALE=1 -- itest:verify-scale
```

The `grep` line re-checks the command text in the log that the bcdev run wrote. If a symbol refusal prints the path on a different line from the phrase, the alternation regex covers either order.

- [ ] **Step 5: A challenged refusal writes a FAILED receipt (bcdev)**

```bash
with_missing bcdev.baseline.json expect rc-bcdev 1 "$MS" -- LETHAL_ITEST_BCDEV=1 LETHAL_GATE_NONCE=r332 LETHAL_GATE_SHA=e716a79b LETHAL_GATE_GENERATION=0 LETHAL_GATE_RECEIPT="$P/r332-receipt.json" -- itest:bcdev
grep -q '"status": "failed"' "$P/r332-receipt.json" && grep -q 'never records one silently' "$P/r332-receipt.json" && echo "OK receipt failed" || { echo "FAIL receipt"; FAILS=$((FAILS+1)); }
echo "TOTAL FAILS: $FAILS"
```

Expected: `TOTAL FAILS: 0`. Any other count stops the task. A wrong failure text (config, spawn or lease) means a preflight is not first: fix Task 3 or Task 4.

- [ ] **Step 6: Byte identity and no em dash**

```bash
sha256sum -c "$P/r332-baselines.before.sha256"
git status --porcelain -- 'packages/runner/itest/*.baseline.json'
ls packages/runner/itest/*.baseline.json | wc -l
git diff e716a79b -U0 | LC_ALL=C grep -n $'^+.*\xe2\x80\x94' || echo "no em dash added"
```

Expected: seven `OK`, empty porcelain, `7`, `no em dash added`.

**What is and is not proven offline**
- **Proven behaviourally offline:**
  - For every writing gate (envtool only if its config is absent here) and for both al-runner symbol files: a missing baseline and a record-over-existing run are both refused at startup, with exit 1, the owning record command named, and a bad record variable rejected.
  - For all four readers: a missing baseline is refused at startup.
  - A challenged refusal writes a failed receipt (bcdev).
- **Proven by unit test only:**
  - The record run itself: the exclusive write, then `BaselineRecordedError`, then exit 3 through the catch. The catch shape is pinned by the AST test.
  - harden's record-after-leg-B order, and mismatch never re-recording.
  - R321's two-file record flow ending in exit 3.
  - All of these need a live run, and would change a committed file.
- **Not proven dynamically:** envtool's `UNVERIFIED_MOVES` refusal in record mode. It needs that list to be non-empty, which is an edit to the gate. It is checked only by reading the code. envtool's receipt does not exist (Task 7).

---

### Task 10: Close R332

- [ ] **Step 1.** Take the sha of Task 5's commit: `git log -1 --format=%h -- packages/runner/tests/baseline-wiring.test.ts`. In `docs/roadmap/R332.md`, set `status: "done (<that sha>)"`, and append:

"**Closed.** One shared rule in `baseline-guard.ts`: a registry of every frozen baseline by basename; `assertGateBaseline` refuses a missing file, records only when `LETHAL_ITEST_RECORD_BASELINE` names it, and throws `BaselineRecordedError` so the gate exits 3; every itest write, R321's symbol files included, is exclusive (`wx`). Every writing gate and every reader preflights its baseline before live work. `campaign freeze` keeps the recording helper by design. An AST wiring test pins the call sites and forbids alternate writers. Red-checked per mechanism; every committed baseline byte-identical (sha256). envtool's missing receipt is filed separately as R<next>."

- [ ] **Step 2.** `bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts`: PASS.

- [ ] **Step 3.** `git add docs/roadmap/R332.md ROADMAP.md && git commit -m "roadmap(R332): close, every frozen itest baseline refuses to self-record (<sha>)"`

---

## Proposed owner text (owner-only: CLAUDE.md and the hook; the executor edits neither)

**1. New bullet** in "Integration tests", directly before "- A differing verdict is a BLOCK":

> - **A frozen baseline never records itself (R332).** Every gate that writes or reads a committed `packages/runner/itest/*.baseline.json` REFUSES to start when the file is missing, and prints the command that records it. Recording is deliberate and one-time. `LETHAL_ITEST_RECORD_BASELINE=<file>.baseline.json` (exact basenames, comma-separated; any other value is an error) arms exactly those files. It refuses to overwrite a file that exists, and the run EXITS 3 with a failed receipt after writing, so a record run is never a pass. To change a frozen baseline: pre-commit the change, delete the file, run once in record mode, re-run without the variable to confirm a pass, review the diff, commit. R321's symbol baselines keep `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1`, now also exclusive. The Edit/Write hook's `LETHAL_RERECORD_BASELINE=1` only lets a hand edit through; no gate reads it. `campaign freeze` is a separate mechanism and is unchanged.

**2. In the `itest:envtool` bullet**, replace:

> the next live envtool run should expect `killingTest`-only differences against its 2026-08-28 baseline, delete and re-record it, and treat any VERDICT difference as a regression.

with:

> the next live envtool run should expect `killingTest`-only differences against its 2026-08-28 baseline; after a pre-commitment, delete it, record it once with `LETHAL_ITEST_RECORD_BASELINE=envtool.baseline.json` (a record run exits 3, by design), re-run without that variable to confirm a pass, and treat any VERDICT difference as a regression.

**3. In the same bullet**, replace:

> The gate still REFUSES to self-record a baseline while `UNVERIFIED_MOVES` (in the itest) is non-empty: confirm each listed mutant by name against `itest:bcdev` on the same day and clear the list in the same commit that records the baseline.

with:

> Like every gate it refuses to start without its baseline (R332), and on top of that it refuses RECORD mode while `UNVERIFIED_MOVES` (in the itest) is non-empty: confirm each listed mutant by name against `itest:bcdev` on the same day and clear the list in the same commit that records the baseline.

Unchanged and still correct:
- "re-recorded for GH-24 in `f25d647`" and "the baseline needed no re-recording": history.
- "Re-freezing a stage ... delete `<stage>.baseline.json`, re-run `freeze`": campaign, out of scope.
- The owner-approved R321 sentence in the `itest:alrunner` bullet ("record once with `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1`, which refuses to overwrite and exits 3"): still true, and now stronger.

**4. `.claude/hooks/baseline-guard.ts` (hook; lanes may not edit it).** After R332 its block message gives stale advice: it tells the reader to run `LETHAL_RERECORD_BASELINE=1 bun run itest:<gate>`, but no gate reads that variable, so the command would just be refused. Proposed change, message text only; the matching logic, the escape variable and the exit codes stay as they are.

In the `console.error([...])` array, replace three entries: the one that starts `"moves verdicts` and ends `record it deliberately:",` (it contains an em dash in the source, so it is identified by its ends here), the empty `"",` after it, and `"    LETHAL_RERECORD_BASELINE=1 bun run itest:<gate>",`. Replace them with:

```
    "moves verdicts, as R30/R33 did), write a pre-commitment, delete the file, and record it",
    "once through the gate (R332; a record run always exits 3, never a pass):",
    "",
    "    LETHAL_ITEST_RECORD_BASELINE=<gate>.baseline.json <the gate's enable var>=1 bun run itest:<gate>",
```

In the header doc comment, after the `LETHAL_RERECORD_BASELINE=1 <command>` example, add one line:

```
 * That variable only lets a hand edit through this hook. A gate records only under R332's LETHAL_ITEST_RECORD_BASELINE.
```

Owner check after applying: `echo '{"tool_input":{"file_path":"U:/Git/LethAL/packages/runner/itest/bcdev.baseline.json"}}' | bun .claude/hooks/baseline-guard.ts; echo "exit=$?"` prints the new command and `exit=2`.

## Open questions for the orchestrator

None.
