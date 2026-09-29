# R-321: a symbol-defining fixture pair and an `itest:alrunner` leg per symbol set, so the gate catches a transport that measures the wrong build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r3 (2026-09-29).** Folds in review r2 (`H:/lethal-coord/reviews/R-321-plan/review-r2.md`). I-a: Task 2 Step 5 deletes any old inventory first and stops on a non-zero compile exit before reading one. I-b: Tasks 6 and 8 compare every printed no-define row (13 per leg, six legs) with `EXPECTED_NO_DEFINE` through a scratch checker, so Task 9's claim of all 39 rows is backed live. Minor: Task 10 files R331 for the general self-recording baseline gap; no open questions remain.

**Revision r2 (2026-09-29).** Folds in review r1 (`H:/lethal-coord/reviews/R-321-plan/review-r1.md`) and the orchestrator's rulings. **Q1:** the receipt keeps its four sublegs. **Q2 / C:** the gate runs TWO non-empty sets, `[LETHALA]` and `[LETHALB]`, over an `#if LETHALA` / `#elif LETHALB` / `#else` fixture, so a transport that loses its defines builds the `#else` arm. The fixture was re-designed and re-listed with fresh scratch dry runs before any prediction; none of r1's nine rows carry over. The A table, the B table and the no-define table are pairwise different (8 of 13 mutants per pair). **Q3:** the compiled-out-arm mutants stay, and the pre-commitment says R214's fix needs a new pre-commitment and a re-freeze. **Q4:** the time was re-estimated from the new dry run. **I1:** two live red-checks, one per way defines can be lost: the daemon (`AlRunnerServer.start`) and the one-shot argv (`buildAlRunnerArgv`), each with its exact failing assertions; the symbol legs now collect every failing check instead of stopping at the first, so the daemon red-check also shows each resource leg failing, and the plan says what that does and does not prove. **I2:** `compile:fixtures --require-symbol-sets` refuses a SKIP for a project that declares symbol sets, the inventory records each set's result, the verification checks per-set OK lines AND the inventory, and every arm (A, B and `#else`) is red-checked in both the target and the test app, plus a dropped-`/define` check for A and for B separately. The staged target package the test app compiles against is documented as a staging input, not proof of freshness. **I3:** an absent symbol baseline is now REFUSED; recording needs an explicit one-time mode (`LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1`), which also refuses to overwrite an existing file and never counts as a pass. The pre-commitment names every verdict AND killing test for both sets and is committed alone before any run; a mismatch is a stop, never a re-record. **Minor:** the new legs do not assert or prove the R147 platform pin; `sandbox-app` stays 3 / 12 / 4; `CLAUDE.md` is proposed text only.

**Goal:** `itest:alrunner` gains a fixture pair whose builds differ by preprocessor symbol, runs it under `[LETHALA]` and `[LETHALB]` through all three transports (one-shot, `--server`, `--server` with the resource selector), and fails when any transport measures a different build. Today no fixture defines a symbol, so [[R319]]'s defect (the daemon started with no `--define`) passed this gate before its fix and would pass it again after a revert.

**Architecture:** A new target `fixtures/sandbox-symbols` (one codeunit, one procedure with three assignments and an `#if LETHALA` / `#elif LETHALB` / `#else` split of its `exit`) and a new test app `fixtures/sandbox-symbols-tests` (one test asserting each build's own value). Each project lists the builds it must compile in a committed `symbol-sets.json`; `scripts/compile-fixtures.ts` compiles every listed build. The itest gets a fifth part: per set, run the three transports, check each against the pre-committed per-mutant table, compare the one-shot leg with a committed baseline, and require the server legs to equal the one-shot leg per mutant. All three builds score 5 killed / 8 survived / 0 no-coverage over 13, and every pair of builds disagrees on 8 of the 13, so only a per-mutant check tells them apart.

**Tech Stack:** Bun, TypeScript, `bun:test`, `node:assert/strict` in the itest, a local al-runner **v2.11.0** (`C:/Users/SShadowS/.dotnet/tools/al-runner.exe`), `alc.exe` 18.0.2732683 for offline compiles. No BC container, no lease.

**Spec:** `docs/roadmap/R321.md`, `H:/lethal-coord/tasks/R-321/task.md`, review `H:/lethal-coord/reviews/R-321-plan/review-r1.md`. Context: `docs/roadmap/R319.md`, `docs/superpowers/plans/2026-09-28-R-319-server-symbols.md`. Pre-commitment style: `docs/superpowers/specs/2026-08-19-r161-branch-slot-precommitment.md`.

---

## What was measured at plan time (2026-09-29, HEAD `b8e1d70c`)

`$P` is `C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-code/a2d0a920-a34b-42d9-8875-ba97d0ae0889/scratchpad/r321`. It holds a scratch copy of the r2 fixture pair, byte for byte the text in Task 2. **No al-runner session was run on it.** Every verdict below is a prediction.

### The two places defines can be lost

- **Daemon** (`packages/runner/src/al-runner-server.ts`, `AlRunnerServer.start`, line 250 at HEAD), added by R319's fix commit `33cfc55a`:
  `      ...this.preprocessorSymbols.flatMap((sym) => ["--define", sym]),`
  Both server selector modes (static and resource) run through this one daemon (`AlRunnerBackend` builds one `AlRunnerServer`; `selectorMode` changes only how the active mutant reaches the compiled AL). There is no resource-specific define code.
- **One-shot** (`packages/runner/src/al-runner-transport.ts`, `buildAlRunnerArgv`, line 593 at HEAD), from R101 (c):
  `  for (const symbol of req.preprocessorSymbols ?? []) argv.push("--define", symbol);`
  It serves both `run()` and `provisionOnce()`.

`SessionReport.preprocessorSymbols` is NOT evidence that either path received the symbols: it comes from `RunSessionConfig.preprocessorSymbols` (`orchestrator.ts:1026`), a separate setting that compiles nothing. The only evidence is the verdicts.

### How symbols reach each leg

`AlRunnerConfig.preprocessorSymbols` feeds both al-runner paths above. The itest builds its backend directly, so a symbol set is a per-leg parameter, not a fixture edit. The fixture's `app.json` must NOT carry `preprocessorSymbols`: al-runner reads a bundle's own `app.json` symbols (R319, decompiled), which would define a symbol on every transport and hide exactly the loss this gate measures.

### `itest:alrunner` and its baseline guard today

`packages/runner/itest/al-runner.itest.ts` prints `al-runner build under test: <version>` first, checks the sandbox-app site count (19), and runs four legs through `runOnce(scratch, serverMode, selectorMode)`, which hard-codes the sandbox paths and passes no symbols. The first leg is compared with `al-runner.baseline.json` by `assertMatchesBaseline` (`itest/baseline-guard.ts`), which WRITES an absent baseline and returns, so a deleted baseline silently re-records and passes. The receipt's four sublegs (`one-shot`, `server`, `resource`, `platform-pin`) must match the challenge's `expectedSublegs` exactly (`scripts/agentflow/receipt.ts:143`). `runSymbolLegs()` will run before `emitPassed`, so any throw there fails the receipt with the same four names.

### `compile:fixtures` today

`scripts/compile-fixtures.ts` compiles every project with an `app.json` under `fixtures/` and `examples/`, once, with no symbols, and SKIPs a project with no `.alpackages` with exit 0. The `.claude/hooks/compile-fixtures-touched.ts` hook runs it after every `fixtures/**/*.al` edit in every worktree and BLOCKS on a non-zero exit. In this worktree 10 of 15 projects SKIP. This is why the new refusal is an opt-in flag (Decision 5).

### The r2 fixture, listed dry and compiled offline

`lethal run --project $P/sandbox-symbols --dry-run`, run from the main checkout `U:/Git/LethAL` at the same commit `b8e1d70c` (this worktree has no native parser binary, Task 0), log `$P/logs/dryrun-r2.log`:

```
  src\SymbolLogic.Codeunit.al  sites=13  deployed=13
  src\SymbolLogic.Codeunit.al:8  lethal.empty-block
  src\SymbolLogic.Codeunit.al:9  lethal.remove-assignment
  src\SymbolLogic.Codeunit.al:9  lethal.shift-integer
  src\SymbolLogic.Codeunit.al:10  lethal.remove-assignment
  src\SymbolLogic.Codeunit.al:10  lethal.shift-integer
  src\SymbolLogic.Codeunit.al:11  lethal.remove-assignment
  src\SymbolLogic.Codeunit.al:11  lethal.shift-integer
  src\SymbolLogic.Codeunit.al:13  lethal.return-value
  src\SymbolLogic.Codeunit.al:13  lethal.swap-additive
  src\SymbolLogic.Codeunit.al:15  lethal.return-value
  src\SymbolLogic.Codeunit.al:15  lethal.swap-additive
  src\SymbolLogic.Codeunit.al:17  lethal.return-value
  src\SymbolLogic.Codeunit.al:17  lethal.swap-additive
```

Site enumeration ignores `#if` ([[R214]], open), so all 13 exist in every build, with the same codes and identity keys. That is what makes one per-mutant table per build comparable.

`alc` matrix on the scratch pair (target first compiled into the tests' `.alpackages`), log `$P/logs/alc-matrix-r2.log`, exit codes:

| build | no `/define` | `/define:LETHALA` | `/define:LETHALB` |
| --- | ---: | ---: | ---: |
| target, clean | 0 | 0 | 0 |
| tests, clean | 0 | 0 | 0 |
| target, `LETHALA` arm broken (`exit(X + Missing)`) | 0 | **1** | 0 |
| target, `LETHALB` arm broken | 0 | 0 | **1** |
| target, `#else` arm broken | **1** | 0 | 0 |
| tests, `LETHALA` arm broken (`RateMissing(1)`) | 0 | **1** | 0 |
| tests, `LETHALB` arm broken | 0 | 0 | **1** |
| tests, `#else` arm broken | **1** | 0 | 0 |

Every broken arm fails in its own build only. So a compile check that does not pass `/define`, or passes the wrong one, reports a broken arm as OK.

### Why the predictions are what they are

Measured precedent, R-319's scratch repro `s1-clean-rate` (the same `#if` / `#else` split of a final `exit`, coverage on, all three transports, `eq-fix-s1-clean-rate.log` in R-319's scratch dir): an ACTIVE-arm mutant was killed by the test asserting that build's value; an INACTIVE-arm mutant was `survived`, not `no-coverage` (coverage is per procedure, the procedure ran, the statement was compiled out); the whole-body `empty-block` was killed.

This fixture adds three assignments outside the arms, `ForA := 10`, `ForB := 100`, `ForNone := 1`, each read by exactly one arm. Their mutants are killed in the build that reads them and are dead stores elsewhere. Operators, from source: `remove-assignment` deletes the statement (the Integer stays 0); `shift-integer` makes `n` into `n + 1`; `return-value` makes `exit(<expr>)` into `exit(0)`; `swap-additive` swaps `+` for `-`; `empty-block` empties the body (returns 0). `RateSmall` calls `Rate(1)` and expects 11 (`LETHALA`), 101 (`LETHALB`) or 2 (no symbol). No live mutated line returns its build's expected value: A gives 0, 1, 12, 0, -9; B gives 0, 1, 102, 0, -99; no symbol gives 0, 1, 3, 0, 0.

---

## Decisions

### 1. A separate fixture pair, not an edit to `sandbox-app`

`sandbox-app` is frozen at 3 / 12 / 4 in three gates. The new pair has its own ids (target 79600-79649, tests 79650-79699; free across `fixtures/` and `examples/` at plan time) and selector ids 79647-79649, the top of its own range (`fixtures/README.md`, "Object ids"). `runOnce` keeps the sandbox fixture as its default, so the existing legs, baseline and receipt are unchanged.

### 2. Two non-empty sets, and a third pre-committed table for the `#else` build (orchestrator ruling Q2)

`[LETHALA]` and `[LETHALB]` are the gate's sets. A transport that loses its defines builds the `#else` arm, which differs from both. The `#else` table is pre-committed too, but no gate leg runs it: it is what the red-checks must print, and the unit test pins that all three tables are pairwise different, so neither set can be measuring the fallback without a verdict moving. The symbol names are invented, so no toolchain default can define them.

### 3. `symbol-sets.json` lists all THREE builds, the gate runs two

Each project's `symbol-sets.json` is `[[], ["LETHALA"], ["LETHALB"]]`, so `compile:fixtures` compiles the `#else` arm too: it is the arm a define-losing transport runs, so it must stay compilable. The itest's `SYMBOL_SETS` is `[["LETHALA"], ["LETHALB"]]`; a unit test pins that each file equals `[[], ...SYMBOL_SETS]`.

### 4. Every failing symbol check is collected, then the gate fails once

Each leg's checks run inside a small collector, and the gate throws one error listing all of them after both sets. A session that crashes still throws at once. So one red-check run shows every leg that caught the wrong build, not just the first.

### 5. `compile:fixtures --require-symbol-sets`, opt-in

With the flag, a project that declares symbol sets and has no `.alpackages` FAILS instead of SKIPping. Without it, behaviour is unchanged. Making it the default would make the edit hook block every fixture AL edit in any worktree where nobody staged this pair's gitignored symbols. The R321 verification always passes the flag and also checks the inventory per build. (Open question 1.)

### 6. Explicit one-time baseline recording

`assertMatchesFrozenBaseline(report, path, label, record)` in `baseline-guard.ts`: without record mode an absent file THROWS; in record mode an existing file THROWS and an absent one is recorded. Record mode is `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1`, and a record-mode run ends as a failed receipt with exit 3, never a pass. It applies to the symbol baselines only; `al-runner.baseline.json` keeps its current behaviour (Open question 2).

### 7. Receipt keeps four sublegs (ruling Q1)

---

## Global Constraints

- Plain English, short sentences, no em dash character (U+2014) in code, comments, commits, specs or roadmap text.
- `CLAUDE.md` is owner-only. Task 9 proposes its new text; nobody edits the file.
- Local only: al-runner and `alc`, no BC container, no lease, no publish.
- al-runner sessions run SERIALLY. Before every gate run `tasklist | grep -i al-runner` must print nothing (parallel runs caused false `wire contract UNMEASURABLE` throws in R-316).
- Gate command: `LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner`, plus `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1` only where a task says so. Estimated 10 to 12 minutes. The Bash tool caps a foreground call at 10 minutes, so run it with `run_in_background: true`, writing a log, and wait for the single completion notification. Never poll.
- The pre-commitment spec (Task 3) is committed ALONE, before the first al-runner session on the fixture. No scratch al-runner probe on the fixture either.
- A per-mutant difference from the pre-commitment (verdict OR killing test) is a FINDING and a STOP: report the al-runner version, the set, the leg and the printed table to the coordinator. Never edit the table, the spec or the fixture to match, and never re-record.
- One object per `.al` file (a multi-object file disables al-runner coverage for the whole run, upstream #3713).
- The fixture's `app.json` files carry no `preprocessorSymbols` key.
- No `!` non-null assertions. Optional properties via `...(v !== undefined ? { k: v } : {})`.
- Build loop per CLAUDE.md: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test` from the repo root. Biome on touched files only: `bunx biome check <paths>`. After any `.al` edit under `fixtures/`: `bun run compile:fixtures`.
- Red-check every guard: revert the specific line, confirm the named assertion goes red, restore (`git diff --quiet <path>`), report both outputs.
- The new legs neither assert nor prove the R147 platform pin: only the sandbox one-shot legs do. `sandbox-app` stays 3 / 12 / 4.
- Roadmap: never hand-edit `ROADMAP.md`; regenerate with `bun scripts/roadmap-index.ts`. Commit on `lethal/lane-code`; do not push.

## Review Focus

1. **The daemon loses its defines.** Expected: four collected failures, the `--server` and resource equality checks in both sets. Pinned by Task 8's live red-check.
2. **The one-shot argv loses its defines.** Expected: `assertSymbolBuild(oneShot, ...)` fails against the PRE-COMMITTED table in both sets, and no baseline is written. Pinned by Task 6's live red-check, run before any baseline exists.
3. **Counts cannot see a wrong build.** All three builds score 5 / 8 / 0. Pinned by Task 4's pairwise non-vacuity test and wrong-build tests.
4. **A compile check that skipped or compiled the wrong build.** Pinned by Task 1's `--require-symbol-sets` tests and Task 2's six broken-arm and two dropped-define red-checks.
5. **A missing baseline that re-records itself.** Pinned by Task 5's four `assertMatchesFrozenBaseline` tests and their red-check.

---

## File structure

- Create `scripts/lib/symbol-sets.ts`, `scripts/lib/symbol-sets.test.ts` (Task 1).
- Modify `scripts/compile-fixtures.ts`, `scripts/tsconfig.json` (Task 1).
- Create `fixtures/sandbox-symbols/{app.json,symbol-sets.json,src/SymbolLogic.Codeunit.al}`, `fixtures/sandbox-symbols-tests/{app.json,symbol-sets.json,src/SymbolTests.Codeunit.al}`; modify `fixtures/README.md` (Task 2).
- Create `docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md` (Task 3, alone).
- Create `packages/runner/itest/symbol-fixture.ts`, `packages/runner/tests/symbol-fixture.test.ts` (Task 4).
- Modify `packages/runner/itest/baseline-guard.ts`, `packages/runner/tests/baseline-guard.test.ts`, `packages/runner/itest/al-runner.itest.ts` (Task 5).
- Create `packages/runner/itest/al-runner.symbols-lethala.baseline.json`, `packages/runner/itest/al-runner.symbols-lethalb.baseline.json` (Task 7, recorded by the gate).
- Modify `docs/roadmap/R321.md`, regenerate `ROADMAP.md`, update `README.md` and `.claude/skills/live-gate/SKILL.md` (Task 9).

---

### Task 0: Preflight (no commit)

- [ ] **Step 1: Tree and tools.**

```bash
set -euo pipefail
cd U:/Git/LethAL-wt/lane-code
git status --short
git log -1 --format=%h
"C:/Users/SShadowS/.dotnet/tools/al-runner.exe" --version
tasklist | grep -i al-runner || echo "no al-runner running"
```

Expected: clean tree; HEAD at or after `b8e1d70c`; `al-runner v2.11.0`; `no al-runner running`. A newer al-runner is not a STOP, but record it: every prediction was reasoned against 2.11.0's measured behaviour.

- [ ] **Step 2: Native parser binary.** This worktree has none, and every parse throws `NativeParserMissingError`. Copy it from the main checkout (same commit) and check its hash:

```bash
set -euo pipefail
mkdir -p U:/Git/LethAL-wt/lane-code/packages/engine/vendor/native
cp U:/Git/LethAL/packages/engine/vendor/native/lethal-parser.win32-x64.node U:/Git/LethAL/packages/engine/vendor/native/lethal-parser.win32-x64.provenance.json U:/Git/LethAL-wt/lane-code/packages/engine/vendor/native/
sha256sum U:/Git/LethAL-wt/lane-code/packages/engine/vendor/native/lethal-parser.win32-x64.node
grep '"sha256"' U:/Git/LethAL-wt/lane-code/packages/engine/vendor/native/lethal-parser.win32-x64.provenance.json
git -C U:/Git/LethAL-wt/lane-code status --short
```

Expected: equal hashes (`19f5d477...` at plan time); `git status` empty (both files are ignored). If the main checkout has no binary, `bun scripts/build-native-parser.ts`.

- [ ] **Step 3: Baseline suite.** `bun run typecheck && rm -rf packages/*/dist && bun test`. Expected 0 fail; note the pass count.

---

### Task 1: `compile:fixtures` compiles every declared build, and can refuse to skip

**Files:**
- Create: `scripts/lib/symbol-sets.ts`, `scripts/lib/symbol-sets.test.ts`
- Modify: `scripts/compile-fixtures.ts`, `scripts/tsconfig.json`

**Interfaces:**
- Produces: `readSymbolSets(project: string): string[][] | undefined` (`undefined` when the project has no `symbol-sets.json`; throws `Error` on a malformed file).
- Produces: inventory rows gain, only for a declaring project, `builds: { symbols: string[]; status: "compiled" | "failed" }[]`.
- Produces: CLI flag `--require-symbol-sets`.

- [ ] **Step 1: Write the failing test** `scripts/lib/symbol-sets.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSymbolSets } from "./symbol-sets.ts";

const made: string[] = [];
function project(json?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lethal-symbol-sets-"));
  made.push(dir);
  if (json !== undefined) writeFileSync(join(dir, "symbol-sets.json"), json, "utf8");
  return dir;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readSymbolSets (R321)", () => {
  test("no file means the project declares no sets", () => {
    expect(readSymbolSets(project())).toBeUndefined();
  });
  test("returns the sets in file order, the empty set included", () => {
    expect(readSymbolSets(project('[[], ["LETHALA"], ["LETHALB"]]'))).toEqual([[], ["LETHALA"], ["LETHALB"]]);
  });
  test("tolerates a UTF-8 BOM, as appVersion does", () => {
    expect(readSymbolSets(project('\uFEFF[["A"]]'))).toEqual([["A"]]);
  });
  test("refuses a file that is not an array of arrays", () => {
    expect(() => readSymbolSets(project('{"sets": []}'))).toThrow(/non-empty array/);
    expect(() => readSymbolSets(project("[]"))).toThrow(/non-empty array/);
    expect(() => readSymbolSets(project('["A"]'))).toThrow(/array of symbols/);
  });
  test("refuses a symbol alc's /define list form would split or mangle", () => {
    expect(() => readSymbolSets(project('[["A,B"]]'))).toThrow(/array of symbols/);
    expect(() => readSymbolSets(project('[["A B"]]'))).toThrow(/array of symbols/);
    expect(() => readSymbolSets(project('[[""]]'))).toThrow(/array of symbols/);
  });
  test("refuses the same set listed twice, in any order", () => {
    expect(() => readSymbolSets(project('[["A","B"],["B","A"]]'))).toThrow(/listed twice/);
  });
});
```

- [ ] **Step 2: Run it.** `bun test scripts/lib/symbol-sets.test.ts`. Expected: FAIL, cannot resolve `./symbol-sets.ts`.

- [ ] **Step 3: Write** `scripts/lib/symbol-sets.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Same refusal as `validatePreprocessorSymbols` in `packages/runner/src/cli.ts` (R101 (c)). */
const SYMBOL_SEPARATOR_RE = /[,;\s]/;

/**
 * R321: the preprocessor symbol sets an AL project must compile under, from its committed
 * `symbol-sets.json` (for example `[[], ["LETHALA"], ["LETHALB"]]`). `undefined` when the project
 * has no such file, which is every project but the symbol fixture pair.
 *
 * Refuses rather than sanitising, for R101 (c)'s reason: an undefined symbol does not fail a
 * compile, it silently selects another branch, so a dropped or split symbol would compile a build
 * nobody asked for and report it as fine.
 */
export function readSymbolSets(project: string): string[][] | undefined {
  const path = join(project, "symbol-sets.json");
  if (!existsSync(path)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${path}: must be a non-empty array of symbol lists, got ${JSON.stringify(raw)}`);
  }
  const seen = new Set<string>();
  return raw.map((set: unknown) => {
    if (
      !Array.isArray(set) ||
      set.some((s) => typeof s !== "string" || s === "" || SYMBOL_SEPARATOR_RE.test(s))
    ) {
      throw new Error(
        `${path}: every entry must be an array of symbols with no whitespace, comma or semicolon, got ${JSON.stringify(set)}`,
      );
    }
    const symbols = set as string[];
    const key = [...symbols].sort().join(",");
    if (seen.has(key)) throw new Error(`${path}: symbol set ${JSON.stringify(set)} is listed twice`);
    seen.add(key);
    return symbols;
  });
}
```

- [ ] **Step 4: Run it.** Expected: 6 pass.

- [ ] **Step 5: Wire it into `scripts/compile-fixtures.ts`.**

Import beside `sourceHash`:

```ts
import { readSymbolSets } from "./lib/symbol-sets.ts";
```

In the header's usage block add `bun scripts/compile-fixtures.ts --require-symbol-sets` with one line: `R321: a project that declares symbol sets (symbol-sets.json) may not be skipped for missing symbols.`

Add to `InventoryProject`, after `status`:

```ts
  /** R321: present only for a project with a `symbol-sets.json`, one entry per declared build. */
  readonly builds?: readonly { readonly symbols: readonly string[]; readonly status: "compiled" | "failed" }[];
```

After the `inventoryPath` parsing add:

```ts
/**
 * R321. Off by default: the fixture edit hook runs this script in every worktree, and a project's
 * `.alpackages` is gitignored, so refusing a skip by default would block every fixture edit where
 * nobody staged this pair's symbols. The R321 check always passes it.
 */
const requireSymbolSets = process.argv.includes("--require-symbol-sets");
```

Replace the whole `for (const project of projects) { ... }` loop with:

```ts
for (const project of projects) {
  const name = projectLabel(project);
  const packageCache = join(project, ".alpackages");
  const version = appVersion(project);
  // R321: a project that declares symbol sets is compiled once per set, because an `#if` arm that
  // only one set compiles is otherwise never compiled at all, and a broken one passes.
  const declaredSets = readSymbolSets(project);
  if (!existsSync(packageCache)) {
    if (declaredSets !== undefined && requireSymbolSets) {
      failed += 1;
      console.error(
        `  FAIL  ${name}: declares symbol sets but has no .alpackages, and --require-symbol-sets refuses a skip`,
      );
    } else {
      console.error(`  SKIP  ${name}: no .alpackages (symbols are gitignored; download them first)`);
    }
    inventory.push({ project: name, version, sourceHash: sourceHash(project), status: "no-symbols" });
    continue;
  }
  const builds: { symbols: readonly string[]; status: "compiled" | "failed" }[] = [];
  for (const symbols of declaredSets ?? [[]]) {
    const label = declaredSets !== undefined ? `${name} [${symbols.join(",")}]` : name;
    // Output to a scratch path, never into the fixture: a stray `.app` beside the source is exactly
    // what makes a stale published build hard to notice, which is the bug this script exists for.
    // The separator in `name` is flattened, because a `/` here would aim the compiler at a
    // subdirectory of the temp dir that nothing creates.
    const suffix = symbols.length > 0 ? `-${symbols.join("-")}` : "";
    const out = join(tmpdir(), `lethal-fixture-compile-${name.replace(/[\\/]/g, "-")}${suffix}.app`);
    const r = spawnSync(
      alc,
      [
        `/project:${project}`,
        `/packagecachepath:${packageCache}`,
        // Omitted for the empty set, as `ArtifactCompiler` does: `/define:` with no value is a
        // different thing to say to a compiler than not saying it.
        ...(symbols.length > 0 ? [`/define:${symbols.join(",")}`] : []),
        `/out:${out}`,
      ],
      { encoding: "utf8" },
    );
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const errors = output.split(/\r?\n/).filter((l) => /: error [A-Z]{2}\d+:/.test(l));
    try {
      rmSync(out, { force: true });
    } catch {
      // A leftover scratch artifact is not worth failing the check over.
    }
    if (r.status === 0 && errors.length === 0) {
      console.log(`  OK    ${label}`);
      builds.push({ symbols, status: "compiled" });
      continue;
    }
    builds.push({ symbols, status: "failed" });
    failed += 1;
    console.error(`  FAIL  ${label}: ${errors.length} error(s)`);
    for (const e of errors.slice(0, 15)) console.error(`          ${e.trim()}`);
    if (errors.length > 15) console.error(`          ... ${errors.length - 15} more`);
  }
  inventory.push({
    project: name,
    version,
    sourceHash: sourceHash(project),
    status: builds.some((b) => b.status === "failed") ? "failed" : "compiled",
    ...(declaredSets !== undefined ? { builds } : {}),
  });
}
```

In the final failure message change `${failed} fixture project(s) do not compile` to `${failed} fixture build(s) do not compile`. The SKIP and FAIL lines now use a colon where the old ones used a long dash; nothing parses that text (`artifact-freshness.ts` reads the `--inventory` JSON).

- [ ] **Step 6: Admit the files to typecheck.** In `scripts/tsconfig.json` `files`, directly after `"lib/source-hash.test.ts",` add `"lib/symbol-sets.ts",` and `"lib/symbol-sets.test.ts",`.

- [ ] **Step 7: Verify, lint, commit.**

```bash
set -euo pipefail
cd U:/Git/LethAL-wt/lane-code
bun run typecheck
rm -rf packages/*/dist
bun test scripts/lib/symbol-sets.test.ts scripts/importable-scripts.test.ts
bun run compile:fixtures
bun scripts/compile-fixtures.ts --require-symbol-sets
bunx biome check scripts/lib/symbol-sets.ts scripts/lib/symbol-sets.test.ts scripts/compile-fixtures.ts
git add scripts/lib/symbol-sets.ts scripts/lib/symbol-sets.test.ts scripts/compile-fixtures.ts scripts/tsconfig.json
git commit -m "feat(R321): compile:fixtures compiles every symbol set a project declares; --require-symbol-sets refuses a skip"
```

Expected: both `compile:fixtures` runs print the same OK/SKIP lines as before (no project declares sets yet) and exit 0.

---

### Task 2: The fixture pair, compiled under all three builds, every arm red-checked

**Files:**
- Create: `fixtures/sandbox-symbols/app.json`, `symbol-sets.json`, `src/SymbolLogic.Codeunit.al`
- Create: `fixtures/sandbox-symbols-tests/app.json`, `symbol-sets.json`, `src/SymbolTests.Codeunit.al`
- Modify: `fixtures/README.md`

- [ ] **Step 1: Re-check the ids are free** (other sessions commit concurrently):

```bash
cd U:/Git/LethAL-wt/lane-code
grep -rhoE "^(codeunit|table|page|tableextension|pageextension|enum|report|query) 79[67][0-9]{2}" fixtures examples --include=*.al
grep -rn '"from": 796\|"from": 797' fixtures/*/app.json examples/*/app.json
```

Expected: nothing. On a hit, move to the next free 100-id block everywhere in this task and in Task 5's `SYMBOL_SELECTOR_IDS`.

- [ ] **Step 2: The target.** `fixtures/sandbox-symbols/app.json`:

```json
{
  "id": "fda67638-2fee-4a1c-94bd-bc37c357f0d9",
  "name": "LethAL Sandbox Symbols",
  "publisher": "LethAL",
  "version": "1.0.0.0",
  "brief": "LethAL R321 fixture: a target whose three builds differ by preprocessor symbol.",
  "description": "One procedure with an #if LETHALA / #elif LETHALB / #else split. Run by itest:alrunner under [LETHALA] and [LETHALB] so a transport that compiles the wrong build moves a per-mutant verdict. Deliberately its OWN app and id range so no other frozen baseline moves. Not for production use, see fixtures/README.md.",
  "privacyStatement": "",
  "EULA": "",
  "help": "",
  "url": "",
  "logo": "",
  "dependencies": [],
  "screenshots": [],
  "idRanges": [
    {
      "from": 79600,
      "to": 79649
    }
  ],
  "resourceExposurePolicy": {
    "allowDebugging": true,
    "allowDownloadingSource": true,
    "includeSourceInSymbolFile": true
  },
  "runtime": "13.0",
  "features": []
}
```

`fixtures/sandbox-symbols/symbol-sets.json`:

```json
[[], ["LETHALA"], ["LETHALB"]]
```

`fixtures/sandbox-symbols/src/SymbolLogic.Codeunit.al` (line numbers are load-bearing: the tables name lines 8, 9, 10, 11, 13, 15 and 17):

```al
codeunit 79600 "Symbol Logic"
{
    procedure Rate(X: Integer): Integer
    var
        ForA: Integer;
        ForB: Integer;
        ForNone: Integer;
    begin
        ForA := 10;
        ForB := 100;
        ForNone := 1;
#if LETHALA
        exit(X + ForA);
#elif LETHALB
        exit(X + ForB);
#else
        exit(X + ForNone);
#endif
    end;
}
```

- [ ] **Step 3: The test app.** `fixtures/sandbox-symbols-tests/app.json`:

```json
{
  "id": "b747fe5d-4601-4a26-8242-9b88dd4bac0a",
  "name": "LethAL Sandbox Symbols Tests",
  "publisher": "LethAL",
  "version": "1.0.0.0",
  "brief": "LethAL R321 fixture: tests for the symbol-dependent target.",
  "description": "One test that asserts each build's own value of Symbol Logic.Rate. Asserts via Error(), no Library Assert. Not for production use, see fixtures/README.md.",
  "privacyStatement": "",
  "EULA": "",
  "help": "",
  "url": "",
  "logo": "",
  "dependencies": [
    {
      "id": "fda67638-2fee-4a1c-94bd-bc37c357f0d9",
      "name": "LethAL Sandbox Symbols",
      "publisher": "LethAL",
      "version": "1.0.0.0"
    }
  ],
  "screenshots": [],
  "idRanges": [
    {
      "from": 79650,
      "to": 79699
    }
  ],
  "resourceExposurePolicy": {
    "allowDebugging": true,
    "allowDownloadingSource": true,
    "includeSourceInSymbolFile": true
  },
  "runtime": "13.0",
  "features": []
}
```

`fixtures/sandbox-symbols-tests/symbol-sets.json`: the same `[[], ["LETHALA"], ["LETHALB"]]`.

`fixtures/sandbox-symbols-tests/src/SymbolTests.Codeunit.al`:

```al
codeunit 79650 "Symbol Tests"
{
    Subtype = Test;

    var
        SymbolLogic: Codeunit "Symbol Logic";

    [Test]
    procedure RateSmall()
    begin
#if LETHALA
        if SymbolLogic.Rate(1) <> 11 then
            Error('Rate(1) must be 11 in the LETHALA build');
#elif LETHALB
        if SymbolLogic.Rate(1) <> 101 then
            Error('Rate(1) must be 101 in the LETHALB build');
#else
        if SymbolLogic.Rate(1) <> 2 then
            Error('Rate(1) must be 2 in the no-symbol build');
#endif
    end;
}
```

- [ ] **Step 4: Stage symbols (gitignored, machine-local).** The test app compiles against a STAGED copy of the target's package, which is what this step makes. That compile proves the test source compiles against the staged package; it does not prove the staged package is fresh. So stage it from current source every time, right before the check, as below. The al-runner gate does not use it: al-runner compiles both apps from source.

```bash
set -euo pipefail
cd U:/Git/LethAL-wt/lane-code
ALC="$(ls -t ~/.vscode/extensions/ms-dynamics-smb.al-*/bin/alc.exe ~/.vscode/extensions/ms-dynamics-smb.al-*/bin/win32/alc.exe 2>/dev/null | head -n 1)"
mkdir -p fixtures/sandbox-symbols/.alpackages fixtures/sandbox-symbols-tests/.alpackages
cp fixtures/sandbox-tests/.alpackages/Microsoft_*.app fixtures/sandbox-symbols/.alpackages/
cp fixtures/sandbox-tests/.alpackages/Microsoft_*.app fixtures/sandbox-symbols-tests/.alpackages/
rm -f fixtures/sandbox-symbols-tests/.alpackages/LethAL_*.app
"$ALC" /project:fixtures/sandbox-symbols /packagecachepath:fixtures/sandbox-symbols/.alpackages "/out:fixtures/sandbox-symbols-tests/.alpackages/LethAL_LethAL Sandbox Symbols_1.0.0.0.app"
git status --short --ignored fixtures/sandbox-symbols fixtures/sandbox-symbols-tests
```

Expected: `alc` exit 0; the two `.alpackages/` directories listed as ignored (`!!`), the source files untracked. The target is staged without a define; its public surface (`Rate(Integer): Integer`) is the same in all three builds, so one package serves all three test builds.

- [ ] **Step 5: The R321 compile check.** Save this as the one command every later step reuses (not committed):

```bash
# r321-compile-check: strict compile plus a per-build inventory check. Exit 0 only if all six builds compiled.
# An old inventory is deleted FIRST, and a non-zero compile exit stops the check BEFORE any inventory is
# read, so a run that died before writing one (no alc, a malformed symbol-sets.json) can never be read
# as green through a previous run's file.
cd U:/Git/LethAL-wt/lane-code
rm -f $P/inventory.json
set +e
bun scripts/compile-fixtures.ts --require-symbol-sets --inventory $P/inventory.json > $P/logs/compile.log 2>&1
rc=$?
set -e
echo "exit=$rc" >> $P/logs/compile.log
cat $P/logs/compile.log
if [ "$rc" -ne 0 ]; then echo "COMPILE CHECK FAILED: compile-fixtures exited $rc"; exit "$rc"; fi
test -f $P/inventory.json || { echo "COMPILE CHECK FAILED: no inventory written"; exit 1; }
bun -e '
const inv = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const want = ["[]", "[LETHALA]", "[LETHALB]"];
let bad = 0;
for (const p of ["fixtures/sandbox-symbols", "fixtures/sandbox-symbols-tests"]) {
  const row = inv.projects.find((r) => r.project === p);
  const got = (row?.builds ?? []).map((b) => `[${b.symbols.join(",")}]=${b.status}`);
  const ok = want.every((w) => got.includes(`${w}=compiled`)) && got.length === want.length;
  console.log(`${p}: ${got.join(" ") || "NO BUILDS"} ${ok ? "OK" : "BAD"}`);
  if (!ok) bad++;
}
process.exit(bad);
' $P/inventory.json
```

Expected now: `exit=0`, and among the log lines exactly these six:

```
  OK    fixtures/sandbox-symbols []
  OK    fixtures/sandbox-symbols [LETHALA]
  OK    fixtures/sandbox-symbols [LETHALB]
  OK    fixtures/sandbox-symbols-tests []
  OK    fixtures/sandbox-symbols-tests [LETHALA]
  OK    fixtures/sandbox-symbols-tests [LETHALB]
```

then `fixtures/sandbox-symbols: []=compiled [LETHALA]=compiled [LETHALB]=compiled OK` and the same for `-tests`, and the `bun -e` exits 0.

- [ ] **Step 6: Red-check the skip refusal.** Move `fixtures/sandbox-symbols/.alpackages` aside (`mv` to `$P/alpackages-aside`), run the check. Expected: `  FAIL  fixtures/sandbox-symbols: declares symbol sets but has no .alpackages, and --require-symbol-sets refuses a skip`, `exit=1`, and the check stops with `COMPILE CHECK FAILED: compile-fixtures exited 1` before reading any inventory. (`--inventory` still writes the file on a failing run; reading it by hand shows `fixtures/sandbox-symbols: NO BUILDS BAD`.) Run plain `bun run compile:fixtures` too: it prints `SKIP  fixtures/sandbox-symbols: ...` and exits 0 (the default is unchanged). Move the directory back; the check returns to Step 5's result.

- [ ] **Step 7: Red-check every arm, in both apps.** Before starting, copy both `src/` directories to `$P/pristine/`. For each row: make the one edit with the Edit tool, run the check, confirm, restore the file, and confirm `diff -r` against `$P/pristine/` is empty. Measured at plan time on the scratch pair with raw `alc` (`$P/logs/alc-matrix-r2.log`):

| edit | expected FAIL line (only this one) | expected `exit` |
| --- | --- | --- |
| target: `exit(X + ForA);` to `exit(X + Missing);` | `FAIL  fixtures/sandbox-symbols [LETHALA]: 1 error(s)` (`AL0118`) | 1 |
| target: `exit(X + ForB);` to `exit(X + Missing);` | `FAIL  fixtures/sandbox-symbols [LETHALB]: 1 error(s)` | 1 |
| target: `exit(X + ForNone);` to `exit(X + Missing);` | `FAIL  fixtures/sandbox-symbols []: 1 error(s)` | 1 |
| tests: `Rate(1) <> 11` to `RateMissing(1) <> 11` | `FAIL  fixtures/sandbox-symbols-tests [LETHALA]: 1 error(s)` | 1 |
| tests: `Rate(1) <> 101` to `RateMissing(1) <> 101` | `FAIL  fixtures/sandbox-symbols-tests [LETHALB]: 1 error(s)` | 1 |
| tests: `Rate(1) <> 2` to `RateMissing(1) <> 2` | `FAIL  fixtures/sandbox-symbols-tests []: 1 error(s)` | 1 |

For each: the other five builds stay `OK`, and the check stops with `COMPILE CHECK FAILED: compile-fixtures exited 1`; reading `$P/inventory.json` by hand names the failed build as `=failed`. Do not re-stage the target package during these checks: no edit changes the target's public surface, so the package staged in Step 4 stays valid (and a broken `#else` arm would fail the staging compile itself). Save each output as `$P/logs/arm-redcheck-<n>.log`.

- [ ] **Step 8: Red-check the `/define` wiring, for A and for B separately.** With the A-arm target edit from row 1 in place, delete the line `...(symbols.length > 0 ? [\`/define:${symbols.join(",")}\`] : []),` from `scripts/compile-fixtures.ts` and run the check. Expected: all six `OK` lines and `exit=0`: the broken A arm is invisible without the define. Restore the A arm; apply row 2's B-arm edit instead, same dropped line, same expectation. Restore both files; `git diff --quiet scripts/compile-fixtures.ts`; the check returns to Step 5's result. Logs `$P/logs/define-redcheck-{a,b,restored}.log`.

- [ ] **Step 9: README.** In `fixtures/README.md`, "Object ids" table, after the `Harden Answer Key` row add:

```
| `Symbol Logic` | 79600 | `sandbox-symbols` | R321 target: one procedure with an `#if LETHALA` / `#elif LETHALB` / `#else` split. `itest:alrunner` runs it under `[LETHALA]` and `[LETHALB]`. |
| `Symbol Tests` | 79650 | `sandbox-symbols-tests` | One test, `RateSmall`, asserting each build's own value (11, 101, or 2 with no symbol). Asserts via `Error()`. |
```

Add `sandbox-symbols` 79647-79649 to the selector-ids sentence (`Every fixture here follows it ...`). Append before `## Tier-2 Phase 0`:

```markdown
## sandbox-symbols (R321)

A target and test app whose builds differ by preprocessor symbol: `#if LETHALA` / `#elif LETHALB` /
`#else`. Each project lists its builds in `symbol-sets.json` (`[[], ["LETHALA"], ["LETHALB"]]`), and
`compile:fixtures` compiles every one; `--require-symbol-sets` makes a missing `.alpackages` a
failure for these two instead of a skip. `itest:alrunner` runs `[LETHALA]` and `[LETHALB]` through
the one-shot, `--server` and server+resource transports. The `#else` build is what a transport that
lost its defines would run, so it is compiled and pre-committed, but no gate leg runs it on purpose.
Neither `app.json` defines a symbol: al-runner reads a bundle's own `app.json` symbols, which would
define one on every transport.

All three builds score 5 killed / 8 survived / 0 no-coverage over 13 mutants, and every pair of
builds disagrees on 8 of the 13. Only a per-mutant comparison can tell them apart. The tables were
pre-committed in `docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md`.

Six of the 13 sit in an arm a given build does not compile (the R214 shape). The six assignment
mutants outside the arms discriminate the builds without depending on that. When R214 is fixed, this
gate needs a new pre-commitment and a re-freeze.

`.alpackages` is gitignored. Copy `Microsoft_*.app` from `sandbox-tests/.alpackages` into both
projects, and `alc` the target into `sandbox-symbols-tests/.alpackages`, from current source, before
compiling. The test app compiles against that staged package, so its compile proves nothing about the
package being fresh; re-stage before checking. al-runner compiles both from source and needs neither.
```

- [ ] **Step 10: Commit.**

```bash
git add fixtures/sandbox-symbols fixtures/sandbox-symbols-tests fixtures/README.md
git status --short
git commit -m "fixture(R321): sandbox-symbols pair, #if LETHALA / #elif LETHALB / #else, all three builds compiled and every arm red-checked"
```

Expected: only the six source files and the README staged, nothing under `.alpackages`.

---

### Task 3: Pre-commit every verdict and killing test (committed ALONE, before any run)

**Files:**
- Create: `docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md`

- [ ] **Step 1: Re-list at the committed fixture** (offline; nothing executes):

```bash
cd U:/Git/LethAL-wt/lane-code
bun packages/runner/src/cli.ts run --project fixtures/sandbox-symbols --dry-run
```

Expected: exactly the 13 lines of "What was measured". If the list differs, STOP and report it; every prediction is keyed to it.

- [ ] **Step 2: Write the spec** with exactly this content:

````markdown
# R321 pre-commitment: `sandbox-symbols` under `[LETHALA]` and `[LETHALB]`, all three al-runner transports, and the `#else` build

Written **before** any al-runner session on this fixture. A verdict or killing test that differs
from this document is a finding and a stop. It is never re-recorded.

## The fixture

```al
codeunit 79600 "Symbol Logic"
{
    procedure Rate(X: Integer): Integer
    var
        ForA: Integer;
        ForB: Integer;
        ForNone: Integer;
    begin
        ForA := 10;
        ForB := 100;
        ForNone := 1;
#if LETHALA
        exit(X + ForA);
#elif LETHALB
        exit(X + ForB);
#else
        exit(X + ForNone);
#endif
    end;
}
```

The one test, `Symbol Tests.RateSmall`, calls `Rate(1)` and raises through bare `Error(...)` unless
it returns 11 (`LETHALA`), 101 (`LETHALB`) or 2 (no symbol). Every build has a green baseline, and
the test asserts that build's own value. The test app is compiled with the same symbols as the
target on every transport.

## The 13 mutants

From `lethal run --dry-run` at `b8e1d70c` and again at the fixture's commit. Site enumeration
ignores `#if` (R214, open), so all 13 exist in every build with the same codes and identity keys.

| code | line | operator | mutated line |
| --- | ---: | --- | --- |
| M0001 | 8 | `lethal.empty-block` | whole body; returns 0 |
| M0002 | 9 | `lethal.remove-assignment` | `ForA := 10` deleted |
| M0003 | 9 | `lethal.shift-integer` | `ForA := 11` |
| M0004 | 10 | `lethal.remove-assignment` | `ForB := 100` deleted |
| M0005 | 10 | `lethal.shift-integer` | `ForB := 101` |
| M0006 | 11 | `lethal.remove-assignment` | `ForNone := 1` deleted |
| M0007 | 11 | `lethal.shift-integer` | `ForNone := 2` |
| M0008 | 13 | `lethal.return-value` | `exit(0)`, `LETHALA` arm |
| M0009 | 13 | `lethal.swap-additive` | `exit(X - ForA)` |
| M0010 | 15 | `lethal.return-value` | `exit(0)`, `LETHALB` arm |
| M0011 | 15 | `lethal.swap-additive` | `exit(X - ForB)` |
| M0012 | 17 | `lethal.return-value` | `exit(0)`, `#else` arm |
| M0013 | 17 | `lethal.swap-additive` | `exit(X - ForNone)` |

Codes are the dry run's order. The gate keys its tables by line and operator, so a renumbering
alone is not a finding.

## Predicted verdict and killing test, per build

`K` = killed by `RateSmall`. `S` = survived, no killing test.

| code | line | operator | `[LETHALA]` | `[LETHALB]` | no symbol (`#else`) | why |
| --- | ---: | --- | --- | --- | --- | --- |
| M0001 | 8 | empty-block | K | K | K | returns 0, never 11, 101 or 2 |
| M0002 | 9 | remove-assignment | K | S | S | A: `Rate(1)` = 1. Elsewhere `ForA` is a dead store |
| M0003 | 9 | shift-integer | K | S | S | A: 12. Elsewhere dead store |
| M0004 | 10 | remove-assignment | S | K | S | B: 1. Elsewhere dead store |
| M0005 | 10 | shift-integer | S | K | S | B: 102. Elsewhere dead store |
| M0006 | 11 | remove-assignment | S | S | K | none: 1. Elsewhere dead store |
| M0007 | 11 | shift-integer | S | S | K | none: 3. Elsewhere dead store |
| M0008 | 13 | return-value | K | S | S | A: 0. Elsewhere compiled out |
| M0009 | 13 | swap-additive | K | S | S | A: -9. Elsewhere compiled out |
| M0010 | 15 | return-value | S | K | S | B: 0. Elsewhere compiled out |
| M0011 | 15 | swap-additive | S | K | S | B: -99. Elsewhere compiled out |
| M0012 | 17 | return-value | S | S | K | none: 0. Elsewhere compiled out |
| M0013 | 17 | swap-additive | S | S | K | none: 0. Elsewhere compiled out |

Every killed mutant's killing test is `RateSmall`; every survived mutant has none. A compiled-out
mutant is `survived`, not `no-coverage`: coverage is per procedure, `RateSmall` runs `Rate`, and the
mutated statement is simply not in the build. Measured, not reasoned: R-319's scratch repro
`s1-clean-rate` (same `#if` / `#else` split of a final `exit`, coverage on, al-runner v2.11.0)
scored every inactive-arm mutant `survived` on all three transports in every subset.

### Figures

| | `[LETHALA]` | `[LETHALB]` | no symbol |
| --- | ---: | ---: | ---: |
| killed | **5** | **5** | **5** |
| survived | **8** | **8** | **8** |
| no-coverage | **0** | **0** | **0** |
| mutants | **13** | **13** | **13** |
| baseline green | yes | yes | yes |

The counts are equal, and every pair of builds disagrees on exactly 8 of the 13 (the other build's
four and its own four; M0001 and the third build's four agree). A transport that compiled the wrong
build keeps every count and moves eight verdicts, so the gate compares per mutant.

## What the gate runs

`[LETHALA]` and `[LETHALB]`, each through one-shot, `--server` and server+resource. Every leg must
match its column above, verdict and killing test, and the two server legs must equal the one-shot
leg per mutant. The no-symbol column is not run by the gate: it is what a define-losing transport
measures, and the red-checks below must print it.

## The red-checks, predicted

**(a) Daemon.** Delete `...this.preprocessorSymbols.flatMap((sym) => ["--define", sym]),` from
`AlRunnerServer.start`. The sandbox legs pass. In each set the one-shot leg matches its column and
its committed baseline. Both server legs print the no-symbol column (baseline still green, since the
test app is also built without a symbol) and fail. The gate fails with four collected failures:
`R321 [LETHALA]: the --server transport must reach the SAME per-mutant verdicts as the one-shot one`,
`R321 [LETHALA]: the resource selector must reach the SAME per-mutant verdicts as the one-shot one`,
and the same two for `[LETHALB]`.

**(b) One-shot.** Delete `for (const symbol of req.preprocessorSymbols ?? []) argv.push("--define", symbol);`
from `buildAlRunnerArgv`. Run in record mode before any baseline exists. The sandbox legs pass. In
each set the one-shot leg prints the no-symbol column and fails
`R321 one-shot [LETHALA]: per-mutant verdicts differ from the pre-committed table (docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md)`
(and `[LETHALB]`), so no baseline file is written. The daemon still defines the symbol, so both
server legs build the right arm, match their column, and fail the equality check against the wrong
one-shot leg. Six collected failures in all.

## What would count as a finding

- Any verdict or killing test differing from its column, on any transport, in either set.
- Any `no-coverage` verdict, or a red baseline.
- A red-check failing anywhere other than the named assertions, or not failing.
- A dry-run list different from the 13 rows above.

A finding is a stop. It is reported, not re-recorded.

## What will change this later

When R214 is fixed (skip inactive arms per the configured symbols), each build emits only its own
arm's mutants: M0010 to M0013 disappear from `[LETHALA]`, M0008, M0009, M0012 and M0013 from
`[LETHALB]`. **That fix will need a new pre-commitment and a re-freeze of both baselines here.** The
six assignment mutants (M0002 to M0007) sit outside the arms and keep discriminating the builds after
it.
````

- [ ] **Step 3: Commit it ALONE.**

```bash
git add docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md
git commit -m "spec(R321): pre-commit all 13 sandbox-symbols verdicts and killing tests for [LETHALA], [LETHALB] and the #else build, and both red-checks"
git show --stat HEAD
```

Expected: exactly one file in the commit. No al-runner session has run on the fixture.

---

### Task 4: The pre-committed tables and the per-build assertion

**Files:**
- Create: `packages/runner/itest/symbol-fixture.ts`
- Test: `packages/runner/tests/symbol-fixture.test.ts`

**Interfaces:**
- Produces: `SYMBOL_SETS: readonly (readonly string[])[]` = `[["LETHALA"], ["LETHALB"]]`; `symbolSetLabel(symbols): string` (`"[LETHALA]"`); `interface SymbolRow { line; operatorName; verdict: "killed" | "survived"; killingTest? }`; `EXPECTED_BY_SET: Readonly<Record<string, readonly SymbolRow[]>>` keyed by label; `EXPECTED_NO_DEFINE: readonly SymbolRow[]`; `interface SymbolReport { baselineGreen; preprocessorSymbols; mutants: readonly ScoredMutant[] }` (a `SessionReport` is assignable); `printSymbolTable(report, symbols, leg): void`; `assertSymbolBuild(report, symbols, leg): void`.

- [ ] **Step 1: Write the failing test** `packages/runner/tests/symbol-fixture.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTED_BY_SET,
  EXPECTED_NO_DEFINE,
  SYMBOL_SETS,
  type SymbolReport,
  type SymbolRow,
  assertSymbolBuild,
  symbolSetLabel,
} from "../itest/symbol-fixture";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "fixtures");
const A: readonly string[] = ["LETHALA"];
const B: readonly string[] = ["LETHALB"];

function rowsOf(label: string): readonly SymbolRow[] {
  const rows = EXPECTED_BY_SET[label];
  if (rows === undefined) throw new Error(`no table for ${label}`);
  return rows;
}

/** A report whose mutants are exactly `rows`, as a leg that measured them would record them. */
function reportOf(rows: readonly SymbolRow[], symbols: readonly string[]): SymbolReport {
  return {
    baselineGreen: true,
    preprocessorSymbols: symbols,
    mutants: rows.map((r, i) => ({
      mutantCode: `M${String(i + 1).padStart(4, "0")}`,
      file: "src/SymbolLogic.Codeunit.al",
      line: r.line,
      operatorName: r.operatorName,
      verdict: r.verdict,
      ...(r.killingTest !== undefined ? { killingTest: r.killingTest } : {}),
    })),
  };
}

describe("R321 symbol fixture tables", () => {
  test("each build passes against its own table", () => {
    expect(() => assertSymbolBuild(reportOf(rowsOf("[LETHALA]"), A), A, "one-shot")).not.toThrow();
    expect(() => assertSymbolBuild(reportOf(rowsOf("[LETHALB]"), B), B, "one-shot")).not.toThrow();
  });

  test("a leg that lost its defines fails, although the report still names the symbol", () => {
    // The shape of both red-checks: the #else build's verdicts under a set's own label and symbols.
    expect(() => assertSymbolBuild(reportOf(EXPECTED_NO_DEFINE, A), A, "one-shot")).toThrow(
      /R321 one-shot \[LETHALA\]: per-mutant verdicts differ/,
    );
    expect(() => assertSymbolBuild(reportOf(EXPECTED_NO_DEFINE, B), B, "--server")).toThrow(
      /R321 --server \[LETHALB\]: per-mutant verdicts differ/,
    );
  });

  test("the other set's build fails", () => {
    expect(() => assertSymbolBuild(reportOf(rowsOf("[LETHALB]"), A), A, "x")).toThrow(/R321/);
    expect(() => assertSymbolBuild(reportOf(rowsOf("[LETHALA]"), B), B, "x")).toThrow(/R321/);
  });

  test("a missing, an extra, or a re-attributed mutant fails", () => {
    const rows = rowsOf("[LETHALA]");
    expect(() => assertSymbolBuild(reportOf(rows.slice(1), A), A, "x")).toThrow(/R321/);
    const first = rows[0];
    if (first === undefined) throw new Error("empty table");
    expect(() => assertSymbolBuild(reportOf([...rows, first], A), A, "x")).toThrow(/R321/);
    const renamed = rows.map((r) => (r.killingTest !== undefined ? { ...r, killingTest: "Other" } : r));
    expect(() => assertSymbolBuild(reportOf(renamed, A), A, "x")).toThrow(/R321/);
  });

  test("a red baseline, other recorded symbols, or another file fails", () => {
    const good = reportOf(rowsOf("[LETHALA]"), A);
    expect(() => assertSymbolBuild({ ...good, baselineGreen: false }, A, "x")).toThrow(/R321/);
    expect(() => assertSymbolBuild({ ...good, preprocessorSymbols: [] }, A, "x")).toThrow(/R321/);
    const moved = { ...good, mutants: good.mutants.map((m) => ({ ...m, file: "src/Other.Codeunit.al" })) };
    expect(() => assertSymbolBuild(moved, A, "x")).toThrow(/R321/);
  });

  test("a set with no pre-committed table is an error, the empty set included", () => {
    expect(() => assertSymbolBuild(reportOf(EXPECTED_NO_DEFINE, []), [], "x")).toThrow(/no pre-committed table/);
  });

  test("non-vacuity: three builds, same 13 mutants, 5/8 each, pairwise different on 8", () => {
    const tables = [rowsOf("[LETHALA]"), rowsOf("[LETHALB]"), EXPECTED_NO_DEFINE];
    const key = (r: SymbolRow) => `${r.line}|${r.operatorName}`;
    for (const t of tables) {
      expect(t).toHaveLength(13);
      expect(t.map(key)).toEqual(tables[0]?.map(key) ?? []);
      expect(t.filter((r) => r.verdict === "killed")).toHaveLength(5);
    }
    const differ = (x: readonly SymbolRow[], y: readonly SymbolRow[]) =>
      x.filter((r, i) => r.verdict !== y[i]?.verdict).length;
    const [ta, tb, tn] = tables;
    if (ta === undefined || tb === undefined || tn === undefined) throw new Error("missing table");
    expect([differ(ta, tb), differ(ta, tn), differ(tb, tn)]).toEqual([8, 8, 8]);
  });

  test("drift: both symbol-sets.json files are the #else build plus SYMBOL_SETS, and every set has a table", () => {
    for (const project of ["sandbox-symbols", "sandbox-symbols-tests"]) {
      const onDisk: unknown = JSON.parse(readFileSync(join(FIXTURES, project, "symbol-sets.json"), "utf8"));
      expect(onDisk).toEqual([[], ...SYMBOL_SETS.map((s) => [...s])]);
    }
    expect(Object.keys(EXPECTED_BY_SET).sort()).toEqual(SYMBOL_SETS.map(symbolSetLabel).sort());
  });
});
```

- [ ] **Step 2: Run it.** `bun test packages/runner/tests/symbol-fixture.test.ts`. Expected: FAIL, cannot resolve `../itest/symbol-fixture`.

- [ ] **Step 3: Write** `packages/runner/itest/symbol-fixture.ts`:

```ts
/**
 * R321: the `sandbox-symbols` fixture's pre-committed per-mutant verdicts, one table per build,
 * and the assertion every `itest:alrunner` symbol leg runs against them.
 *
 * Pre-committed in docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md before
 * any al-runner session on the fixture. A difference is a finding and a stop: never edit a row to
 * match a run.
 *
 * All three builds score 5 killed / 8 survived and each pair differs on 8 of 13 mutants, so a
 * transport that compiled the wrong build would pass any count check. Compared per mutant.
 *
 * Kept out of `al-runner.itest.ts` because that script runs its gate at import (R186).
 */
import assert from "node:assert/strict";

/** The gate's sets. Each fixture's symbol-sets.json is `[[], ...SYMBOL_SETS]` (pinned by test). */
export const SYMBOL_SETS: readonly (readonly string[])[] = [["LETHALA"], ["LETHALB"]];

export function symbolSetLabel(symbols: readonly string[]): string {
  return `[${symbols.join(",")}]`;
}

export interface SymbolRow {
  readonly line: number;
  readonly operatorName: string;
  readonly verdict: "killed" | "survived";
  readonly killingTest?: string;
}

const k = (line: number, operatorName: string): SymbolRow => ({
  line,
  operatorName,
  verdict: "killed",
  killingTest: "RateSmall",
});
const s = (line: number, operatorName: string): SymbolRow => ({ line, operatorName, verdict: "survived" });

const EB = "lethal.empty-block";
const RA = "lethal.remove-assignment";
const SI = "lethal.shift-integer";
const RV = "lethal.return-value";
const SA = "lethal.swap-additive";

/** Sorted by line, then operator name, the order `assertSymbolBuild` compares in. */
export const EXPECTED_BY_SET: Readonly<Record<string, readonly SymbolRow[]>> = {
  "[LETHALA]": [
    k(8, EB), k(9, RA), k(9, SI), s(10, RA), s(10, SI), s(11, RA), s(11, SI),
    k(13, RV), k(13, SA), s(15, RV), s(15, SA), s(17, RV), s(17, SA),
  ],
  "[LETHALB]": [
    k(8, EB), s(9, RA), s(9, SI), k(10, RA), k(10, SI), s(11, RA), s(11, SI),
    s(13, RV), s(13, SA), k(15, RV), k(15, SA), s(17, RV), s(17, SA),
  ],
};

/**
 * The `#else` build: what a transport that lost its defines measures. No gate leg runs it; the
 * red-checks print it, and the non-vacuity test pins that it differs from both sets' tables.
 */
export const EXPECTED_NO_DEFINE: readonly SymbolRow[] = [
  k(8, EB), s(9, RA), s(9, SI), s(10, RA), s(10, SI), k(11, RA), k(11, SI),
  s(13, RV), s(13, SA), s(15, RV), s(15, SA), k(17, RV), k(17, SA),
];

export const SYMBOL_FILE = "SymbolLogic.Codeunit.al";

export interface ScoredMutant {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly verdict: string;
  readonly killingTest?: string;
}

/** The slice of a `SessionReport` this check reads. */
export interface SymbolReport {
  readonly baselineGreen: boolean;
  readonly preprocessorSymbols: readonly string[];
  readonly mutants: readonly ScoredMutant[];
}

/** Printed BEFORE any assertion: a failure must show which mutant moved, and the gate is slow. */
export function printSymbolTable(report: SymbolReport, symbols: readonly string[], leg: string): void {
  const label = symbolSetLabel(symbols);
  for (const m of report.mutants) {
    console.log(
      `    ${leg} ${label} ${m.mutantCode} ${m.verdict} ${m.killingTest ?? "-"} ${m.file}:${m.line} ${m.operatorName}`,
    );
  }
}

const byLineThenOperator = (a: SymbolRow, b: SymbolRow): number =>
  a.line - b.line || a.operatorName.localeCompare(b.operatorName);

/**
 * `preprocessorSymbols` is checked but proves nothing about what was compiled: it comes from
 * `RunSessionConfig`, which compiles nothing. The per-mutant comparison is the evidence.
 */
export function assertSymbolBuild(report: SymbolReport, symbols: readonly string[], leg: string): void {
  const label = symbolSetLabel(symbols);
  const expected = EXPECTED_BY_SET[label];
  if (expected === undefined) {
    throw new Error(`R321: no pre-committed table for symbol set ${label}`);
  }
  assert.equal(report.baselineGreen, true, `R321 ${leg} ${label}: the baseline must be green`);
  assert.deepEqual(
    [...report.preprocessorSymbols],
    [...symbols],
    `R321 ${leg} ${label}: the report must record the symbols this leg was configured with`,
  );
  const actual = report.mutants.map((m): SymbolRow => {
    assert.ok(
      m.file.endsWith(SYMBOL_FILE),
      `R321 ${leg} ${label}: ${m.mutantCode} is in ${m.file}, every mutant must be in ${SYMBOL_FILE}`,
    );
    return {
      line: m.line,
      operatorName: m.operatorName,
      verdict: m.verdict as SymbolRow["verdict"],
      ...(m.killingTest !== undefined ? { killingTest: m.killingTest } : {}),
    };
  });
  assert.deepEqual(
    actual.sort(byLineThenOperator),
    [...expected].sort(byLineThenOperator),
    `R321 ${leg} ${label}: per-mutant verdicts differ from the pre-committed table (docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md)`,
  );
}
```

(If biome's formatter spreads the table rows one per line, accept its formatting.)

- [ ] **Step 4: Run it.** Expected: 8 pass.

- [ ] **Step 5: Red-check the checker.** Replace the final `assert.deepEqual(actual.sort(...), ...)` with a killed-count comparison:

```ts
  assert.equal(
    actual.filter((r) => r.verdict === "killed").length,
    expected.filter((r) => r.verdict === "killed").length,
    `R321 ${leg} ${label}: killed count`,
  );
```

Expected: `a leg that lost its defines fails ...`, `the other set's build fails` and the re-attributed case FAIL (counts are equal). Restore; 8 pass. Logs `$P/logs/checker-redcheck-{red,green}.log`.

- [ ] **Step 6: Verify and commit.**

```bash
set -euo pipefail
cd U:/Git/LethAL-wt/lane-code
bun run typecheck
rm -rf packages/*/dist
bun test packages/runner/tests/symbol-fixture.test.ts
bunx biome check packages/runner/itest/symbol-fixture.ts packages/runner/tests/symbol-fixture.test.ts
git add packages/runner/itest/symbol-fixture.ts packages/runner/tests/symbol-fixture.test.ts
git commit -m "test(R321): pre-committed sandbox-symbols tables for [LETHALA], [LETHALB] and #else, pairwise different, and the per-build assertion"
```

---

### Task 5: A frozen-baseline guard that refuses a missing file, and the symbol legs

**Files:**
- Modify: `packages/runner/itest/baseline-guard.ts`, `packages/runner/tests/baseline-guard.test.ts`
- Modify: `packages/runner/itest/al-runner.itest.ts`

**Interfaces:**
- Produces: `assertMatchesFrozenBaseline(report: SessionReport, baselinePath: string, label: string, record: boolean): Promise<void>`.
- Produces: `runOnce(scratchRoot, serverMode = false, selectorMode = "static", fixture: GateFixture = SANDBOX)`; existing calls unchanged.

- [ ] **Step 1: Write the failing tests.** Append to `packages/runner/tests/baseline-guard.test.ts` (reusing its `outcome`, `report`, `dir`), and add `assertMatchesFrozenBaseline` to its import from `../itest/baseline-guard`, plus `import { existsSync } from "node:fs";`:

```ts
describe("assertMatchesFrozenBaseline (R321)", () => {
  const r = () => report([outcome({ mutantCode: "M0001", verdict: "killed", killingTest: "RateSmall" })]);

  test("no committed baseline and no record mode: refuses, and writes nothing", async () => {
    const path = join(dir, "frozen.json");
    await expect(assertMatchesFrozenBaseline(r(), path, "t", false)).rejects.toThrow(/never records one silently/);
    expect(existsSync(path)).toBe(false);
  });

  test("record mode with no baseline: records it", async () => {
    const path = join(dir, "frozen.json");
    await assertMatchesFrozenBaseline(r(), path, "t", true);
    expect(existsSync(path)).toBe(true);
  });

  test("record mode with a baseline present: refuses to overwrite it", async () => {
    const path = join(dir, "frozen.json");
    await assertMatchesFrozenBaseline(r(), path, "t", true);
    const before = await readFile(path, "utf8");
    await expect(assertMatchesFrozenBaseline(r(), path, "t", true)).rejects.toThrow(/refuses to overwrite/);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("a committed baseline is compared, and a difference throws", async () => {
    const path = join(dir, "frozen.json");
    await assertMatchesFrozenBaseline(r(), path, "t", true);
    await assertMatchesFrozenBaseline(r(), path, "t", false);
    const moved = report([outcome({ mutantCode: "M0001", verdict: "survived" })]);
    await expect(assertMatchesFrozenBaseline(moved, path, "t", false)).rejects.toThrow(/per-mutant regression/);
  });
});
```

Run `bun test packages/runner/tests/baseline-guard.test.ts`. Expected: FAIL, `assertMatchesFrozenBaseline` is not exported.

- [ ] **Step 2: Implement** in `packages/runner/itest/baseline-guard.ts` (add `import { existsSync } from "node:fs";`):

```ts
/**
 * R321: like `assertMatchesBaseline`, but an absent baseline is REFUSED rather than recorded.
 *
 * `assertMatchesBaseline` writes an absent file and returns, so deleting a frozen baseline makes the
 * gate pass on whatever it measured next. For a baseline that was pre-committed and frozen, recording
 * must be a deliberate, one-time act: `record` is true only when the caller's explicit record mode
 * is on, and then an EXISTING file is refused, so record mode can never overwrite a frozen table.
 */
export async function assertMatchesFrozenBaseline(
  report: SessionReport,
  baselinePath: string,
  label: string,
  record: boolean,
): Promise<void> {
  const exists = existsSync(baselinePath);
  if (record && exists) {
    throw new Error(
      `${label}: record mode refuses to overwrite the committed baseline at ${baselinePath}. Recording is one-time: a change needs a new pre-commitment, then the file deleted deliberately, then one record run.`,
    );
  }
  if (!record && !exists) {
    throw new Error(
      `${label}: no committed baseline at ${baselinePath}. This gate never records one silently; after a pre-commitment, record once with LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1 and commit the file.`,
    );
  }
  await assertMatchesBaseline(report, baselinePath, label);
}
```

Run the test file: expected all pass.

- [ ] **Step 3: Red-check it.** Change `if (!record && !exists) { throw ... }` to do nothing (comment the `throw` out). Expected: `no committed baseline and no record mode: refuses, and writes nothing` FAILS (the call records and resolves). Restore; all pass. Logs `$P/logs/frozen-redcheck-{red,green}.log`.

- [ ] **Step 4: The itest, constants and fixture parameter.** In `al-runner.itest.ts`, add imports:

```ts
import { assertMatchesBaseline, assertMatchesFrozenBaseline } from "./baseline-guard";
import { SYMBOL_SETS, assertSymbolBuild, printSymbolTable, symbolSetLabel } from "./symbol-fixture";
```

(replacing the existing single-name `baseline-guard` import). After `const BASELINE_PATH = ...;` add:

```ts
// R321: the symbol fixture pair, its own app and id range (79600-79699), so no other gate moves;
// selector ids at the top of the target's range, per the `pickSelectorIds` convention.
const SYMBOL_PROJECT_DIR = join(REPO_ROOT, "fixtures", "sandbox-symbols");
const SYMBOL_TEST_DIR = join(REPO_ROOT, "fixtures", "sandbox-symbols-tests");
const SYMBOL_SELECTOR_IDS = { selectorId: 79649, controlId: 79648, tableId: 79647 };
/** R321 Decision 6: the ONLY way a symbol baseline is ever written. A record run is never a pass. */
const RECORD_SYMBOL_BASELINES = process.env.LETHAL_ITEST_RECORD_SYMBOL_BASELINES === "1";

/** `al-runner.symbols-lethala.baseline.json`, `al-runner.symbols-lethalb.baseline.json`. */
function symbolBaselinePath(symbols: readonly string[]): string {
  if (symbols.length === 0) throw new Error("R321: the symbol legs never run the empty set");
  return join(HERE, `al-runner.symbols-${symbols.join("-").toLowerCase()}.baseline.json`);
}

interface GateFixture {
  readonly projectDir: string;
  readonly testDir: string;
  readonly selectorIds: typeof SELECTOR_IDS;
  readonly symbols: readonly string[];
}

const SANDBOX: GateFixture = {
  projectDir: PROJECT_DIR,
  testDir: TEST_DIR,
  selectorIds: SELECTOR_IDS,
  symbols: [],
};
```

Change `runOnce`'s signature to add `fixture: GateFixture = SANDBOX` as the fourth parameter. In its body: `alRunnerCoverageSupport(PROJECT_DIR)` becomes `alRunnerCoverageSupport(fixture.projectDir)`; in the backend config `testDir: fixture.testDir`, `selectorObjectId: fixture.selectorIds.selectorId`, and after the `selectorMode` spread:

```ts
      // R321: the one-shot argv (`buildAlRunnerArgv`) and the daemon's start argv (R319) read this.
      ...(fixture.symbols.length > 0 ? { preprocessorSymbols: fixture.symbols } : {}),
```

in the `runSession` config `projectDir: fixture.projectDir`, `testDir: fixture.testDir`, `selectorIds: fixture.selectorIds`, and:

```ts
      // R321: compiles nothing; it is only what `SessionReport.preprocessorSymbols` records.
      ...(fixture.symbols.length > 0 ? { preprocessorSymbols: fixture.symbols } : {}),
```

With the default fixture, every sandbox leg builds exactly the config it builds today.

- [ ] **Step 5: Lift `shape` to module scope.** Delete it from inside `main` and put it above `runOnce`:

```ts
/** What two legs must agree on, per mutant. */
const shape = (r: SessionReport) =>
  [...r.mutants]
    .map((m) => ({ mutantCode: m.mutantCode, verdict: m.verdict, killingTest: m.killingTest }))
    .sort((a, b) => a.mutantCode.localeCompare(b.mutantCode));
```

- [ ] **Step 6: The symbol legs.** Add above `main`:

```ts
/**
 * R321: the symbol fixture under `[LETHALA]` and `[LETHALB]`, through all three transports.
 *
 * Every check is COLLECTED and the gate fails once at the end, so a run shows every leg that saw a
 * wrong build rather than the first. A session that crashes still throws at once. Per leg: the table
 * is printed first, then the server legs are compared with the one-shot leg per mutant, then every
 * leg with the pre-committed table. The one-shot leg alone is compared with the frozen baseline,
 * AFTER its table check, so record mode can never record a leg that disagrees with the table.
 *
 * These legs do not assert the R147 platform pin; only the sandbox one-shot legs do.
 */
async function runSymbolLegs(): Promise<void> {
  const failures: string[] = [];
  const check = async (what: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED ${what}: ${message}`);
      failures.push(message);
    }
  };
  for (const symbols of SYMBOL_SETS) {
    const label = symbolSetLabel(symbols);
    const fixture: GateFixture = {
      projectDir: SYMBOL_PROJECT_DIR,
      testDir: SYMBOL_TEST_DIR,
      selectorIds: SYMBOL_SELECTOR_IDS,
      symbols,
    };
    const oneShotDir = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-sym-oneshot-"));
    const serverDir = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-sym-server-"));
    const resourceDir = await mkdtemp(join(tmpdir(), "lethal-itest-alrunner-sym-resource-"));
    try {
      const oneShot = await runOnce(oneShotDir, false, "static", fixture);
      printSymbolTable(oneShot, symbols, "one-shot");
      await check(`one-shot ${label}`, async () => {
        assertSymbolBuild(oneShot, symbols, "one-shot");
        await assertMatchesFrozenBaseline(
          oneShot,
          symbolBaselinePath(symbols),
          `al-runner itest ${label}`,
          RECORD_SYMBOL_BASELINES,
        );
      });

      const viaServer = await runOnce(serverDir, true, "static", fixture);
      printSymbolTable(viaServer, symbols, "--server");
      await check(`--server ${label}`, () => {
        assert.deepEqual(
          shape(viaServer),
          shape(oneShot),
          `R321 ${label}: the --server transport must reach the SAME per-mutant verdicts as the one-shot one`,
        );
        assertSymbolBuild(viaServer, symbols, "--server");
      });

      const viaResource = await runOnce(resourceDir, true, "resource", fixture);
      printSymbolTable(viaResource, symbols, "resource");
      await check(`resource ${label}`, () => {
        assert.deepEqual(
          shape(viaResource),
          shape(oneShot),
          `R321 ${label}: the resource selector must reach the SAME per-mutant verdicts as the one-shot one`,
        );
        assertSymbolBuild(viaResource, symbols, "resource");
      });

      console.log(
        `  symbol set ${label}: one-shot killed=${oneShot.counts.killed} survived=${oneShot.counts.survived} noCoverage=${oneShot.counts.noCoverage}`,
      );
    } finally {
      await rm(oneShotDir, { recursive: true, force: true });
      await rm(serverDir, { recursive: true, force: true });
      await rm(resourceDir, { recursive: true, force: true });
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `R321: ${failures.length} symbol-leg check(s) failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
    );
  }
}
```

- [ ] **Step 7: Call it, and make a record run never a pass.** In `main`, after the sandbox legs' `try { ... } finally { ... }` and before `console.log("al-runner itest: PASS");`:

```ts
  await runSymbolLegs();
  if (RECORD_SYMBOL_BASELINES) {
    // Decision 6: recording is not a measurement against a frozen table, so it is never a pass.
    console.log(
      "al-runner itest: RECORDED the symbol baselines; NOT a pass. Review them against the pre-commitment, commit, and re-run without LETHAL_ITEST_RECORD_SYMBOL_BASELINES.",
    );
    await emitFailed("alrunner", "record mode: symbol baselines recorded, not a pass");
    process.exit(3);
  }
```

Keep `emitPassed`'s four sublegs. Add to the file header, after `never picked up by \`bun test\`.`: ` * R321: also runs fixtures/sandbox-symbols under [LETHALA] and [LETHALB], all three transports (symbol-fixture.ts).`

- [ ] **Step 8: Verify and commit.**

```bash
set -euo pipefail
cd U:/Git/LethAL-wt/lane-code
bun run typecheck
rm -rf packages/*/dist
bun test
bunx biome check packages/runner/itest/baseline-guard.ts packages/runner/tests/baseline-guard.test.ts packages/runner/itest/al-runner.itest.ts
LETHAL_ITEST_ALRUNNER= bun run itest:alrunner
git add packages/runner/itest/baseline-guard.ts packages/runner/tests/baseline-guard.test.ts packages/runner/itest/al-runner.itest.ts
git commit -m "itest(R321): symbol legs for [LETHALA] and [LETHALB] on every transport; a missing symbol baseline is refused, recording is explicit and one-time"
```

Expected: typecheck clean; `bun test` 0 fail, pass count = Task 0's plus 18 (6 + 8 + 4); biome clean; the itest without its env var prints `skipped (...)` and exits 0.

---

### Task 6: Red-check (b), the one-shot argv loses its defines (before any baseline exists)

- [ ] **Step 1: Revert the one line.** With the Edit tool, in `packages/runner/src/al-runner-transport.ts`, `buildAlRunnerArgv`, delete exactly:

```ts
  for (const symbol of req.preprocessorSymbols ?? []) argv.push("--define", symbol);
```

`git diff --stat` shows one line removed in that file only. No `al-runner.symbols-*.baseline.json` exists yet.

- [ ] **Step 2: The no-define row checker (scratch, not committed).** Both red-checks print the `#else` build on some legs. This checker compares EVERY row of each named leg with `EXPECTED_NO_DEFINE`, all 13 verdicts and killing tests, so the pre-committed `#else` table is checked live without an extra gate leg. Write `$P/check-no-define.ts`:

```ts
// R321 red-check: every printed row of each named leg must equal EXPECTED_NO_DEFINE, exactly 13 rows.
import { readFileSync } from "node:fs";
import { EXPECTED_NO_DEFINE } from "U:/Git/LethAL-wt/lane-code/packages/runner/itest/symbol-fixture.ts";

const [log, ...legs] = process.argv.slice(2);
if (log === undefined || legs.length === 0) throw new Error("usage: check-no-define.ts <log> <leg label>...");
// printSymbolTable: `    <leg> [<set>] <code> <verdict> <killer or -> <file>:<line> <operator>`
const ROW = /^ {4}(\S+) (\[[A-Z,]*\]) (M\d{4}) (\S+) (\S+) \S+:(\d+) (\S+)$/;
const rows = readFileSync(log, "utf8")
  .split(/\r?\n/)
  .flatMap((l) => {
    const m = ROW.exec(l);
    return m === null ? [] : [m];
  });
const want = EXPECTED_NO_DEFINE.map((r) => `${r.line} ${r.operatorName} ${r.verdict} ${r.killingTest ?? "-"}`).sort();
let bad = 0;
for (const leg of legs) {
  const got = rows
    .filter((m) => `${m[1]} ${m[2]}` === leg)
    .map((m) => `${m[6]} ${m[7]} ${m[4]} ${m[5]}`)
    .sort();
  const ok = got.length === 13 && JSON.stringify(got) === JSON.stringify(want);
  console.log(`NO-DEFINE ${leg}: ${got.length} row(s) ${ok ? "all 13 match EXPECTED_NO_DEFINE" : "MISMATCH"}`);
  if (!ok) {
    bad++;
    console.log(`  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
  }
}
process.exit(bad === 0 ? 0 : 1);
```

A leg printed twice, or with 12 or 14 rows, fails, because the count must be exactly 13. Red-check the checker on Task 6's real log once Step 3 has run: `bun $P/check-no-define.ts <log> "--server [LETHALA]"` must exit 1 (that leg printed the A build), and a copy of the log with one `one-shot [LETHALA]` row's verdict flipped must exit 1. Save as `$P/logs/no-define-checker-redcheck.log`.

- [ ] **Step 3: Run the gate in record mode**, backgrounded, after `tasklist | grep -i al-runner` prints nothing:

```bash
cd U:/Git/LethAL-wt/lane-code
LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1 LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner > $P/logs/itest-redcheck-oneshot.log 2>&1; echo "exit=$?" >> $P/logs/itest-redcheck-oneshot.log
```

Expected (pre-committed): the sandbox legs pass unchanged (no symbols, and the pin still engages). For each set, the `one-shot` table prints the no-symbol column (for example `one-shot [LETHALA] M0006 killed RateSmall ...:11 lethal.remove-assignment`), the `--server` and `resource` tables print the set's own column, and the combined error lists six failures:

- `R321 one-shot [LETHALA]: per-mutant verdicts differ from the pre-committed table (docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md)`
- `R321 [LETHALA]: the --server transport must reach the SAME per-mutant verdicts as the one-shot one`
- `R321 [LETHALA]: the resource selector must reach the SAME per-mutant verdicts as the one-shot one`
- the same three for `[LETHALB]`.

`exit=1` (the thrown error, not record mode's 3), and NO baseline file was written, because each set's one-shot check failed at its table before reaching the baseline. Check:

```bash
set -euo pipefail
L=$P/logs/itest-redcheck-oneshot.log
grep -q "^exit=1$" $L
grep -qF "R321: 6 symbol-leg check(s) failed" $L
grep -qF "R321 one-shot [LETHALA]: per-mutant verdicts differ from the pre-committed table" $L
grep -qF "R321 one-shot [LETHALB]: per-mutant verdicts differ from the pre-committed table" $L
grep -qE '^    one-shot \[LETHALA\] M0006 killed RateSmall .*:11 lethal.remove-assignment$' $L
grep -qE '^    --server \[LETHALA\] M0002 killed RateSmall .*:9 lethal.remove-assignment$' $L
if ls U:/Git/LethAL-wt/lane-code/packages/runner/itest/al-runner.symbols-*.baseline.json 2>/dev/null; then echo "BASELINE WRITTEN"; exit 1; fi
# every no-define row, live: both one-shot legs built #else
bun $P/check-no-define.ts $L "one-shot [LETHALA]" "one-shot [LETHALB]"
echo "RED (b) as predicted"
```

Expected from the checker: `NO-DEFINE one-shot [LETHALA]: 13 row(s) all 13 match EXPECTED_NO_DEFINE` and the same for `[LETHALB]`.

This is the check that `SessionReport.preprocessorSymbols` could not give: the report still says `["LETHALA"]` and the leg still fails, on verdicts.

- [ ] **Step 4: Restore.** Put the line back. `git diff --quiet packages/runner/src && echo restored`. `bun test packages/runner/tests/al-runner-transport.test.ts packages/runner/tests/al-runner-backend.test.ts`: 0 fail.

---

### Task 7: Record, confirm and freeze the two baselines

- [ ] **Step 1: Record run.** Same command as Task 6 Step 3, log `$P/logs/itest-record.log`. Expected: `exit=3`; first line after the script echo `  al-runner build under test: al-runner v2.11.0`; sandbox legs unchanged (`killed=3 survived=12 noCoverage=4`, both server-leg lines `verdicts identical`); for each set 13 `one-shot`, 13 `--server` and 13 `resource` lines matching its column; `recorded` lines for `al-runner.symbols-lethala.baseline.json` and `-lethalb`; `symbol set [LETHALA]: one-shot killed=5 survived=8 noCoverage=0` and the same for `[LETHALB]`; no `FAILED` line; then `al-runner itest: RECORDED the symbol baselines; NOT a pass.` Any `FAILED` line is a STOP (a finding against the pre-commitment): delete any file it wrote, report, do not re-record.

- [ ] **Step 2: Review the files against the spec.**

```bash
cd U:/Git/LethAL-wt/lane-code
for f in lethala lethalb; do echo "== $f"; bun -e "const b=require('./packages/runner/itest/al-runner.symbols-$f.baseline.json'); for (const m of b) console.log(m.key.split('|').slice(2,4).join(' '), m.verdict, m.killingTest, m.coverageFiltered, m.errorClass)"; done
```

Expected: 13 rows each, procedure `Rate`; 5 `killed RateSmall` and 8 `survived null`; the operator multiset matches the spec's column for that set; `coverageFiltered` false and `errorClass` null everywhere.

- [ ] **Step 3: Confirm run, no record mode.** Command without `LETHAL_ITEST_RECORD_SYMBOL_BASELINES`, log `$P/logs/itest-confirm.log`. Expected: `exit=0`, no `recorded` and no `FAILED` line, `al-runner itest: PASS`.

- [ ] **Step 4: Refusal check, locally.** Move `al-runner.symbols-lethalb.baseline.json` to `$P/`. Do NOT run the gate for this: Task 5's unit tests already pin the refusal. Instead confirm the path the gate would take, `bun test packages/runner/tests/baseline-guard.test.ts` passes, and move the file back. `git status --short` shows the two new baseline files only.

- [ ] **Step 5: Commit.**

```bash
git add packages/runner/itest/al-runner.symbols-lethala.baseline.json packages/runner/itest/al-runner.symbols-lethalb.baseline.json
git commit -m "itest(R321): freeze the sandbox-symbols baselines, [LETHALA] and [LETHALB] each 5/8/0 over 13, every verdict and killing test as pre-committed on every transport (al-runner v2.11.0)"
```

---

### Task 8: Red-check (a), the daemon loses its defines

- [ ] **Step 1: Revert the one line.** With the Edit tool, in `packages/runner/src/al-runner-server.ts`, `AlRunnerServer.start`, delete exactly:

```ts
      ...this.preprocessorSymbols.flatMap((sym) => ["--define", sym]),
```

- [ ] **Step 2: Run the gate, no record mode**, log `$P/logs/itest-redcheck-daemon.log`. Expected (pre-committed): sandbox legs pass; per set the `one-shot` table matches its column and its committed baseline; the `--server` and `resource` tables print the no-symbol column; four collected failures:

- `R321 [LETHALA]: the --server transport must reach the SAME per-mutant verdicts as the one-shot one`
- `R321 [LETHALA]: the resource selector must reach the SAME per-mutant verdicts as the one-shot one`
- the same two for `[LETHALB]`.

```bash
set -euo pipefail
L=$P/logs/itest-redcheck-daemon.log
grep -q "^exit=1$" $L
grep -qF "R321: 4 symbol-leg check(s) failed" $L
for s in LETHALA LETHALB; do
  grep -qF "R321 [$s]: the --server transport must reach the SAME per-mutant verdicts as the one-shot one" $L
  grep -qF "R321 [$s]: the resource selector must reach the SAME per-mutant verdicts as the one-shot one" $L
done
if grep -qF "R321 one-shot [" $L; then echo "UNEXPECTED one-shot failure"; exit 1; fi
grep -qE '^    --server \[LETHALB\] M0006 killed RateSmall .*:11 lethal.remove-assignment$' $L
grep -qE '^    resource \[LETHALB\] M0010 survived - .*:15 lethal.return-value$' $L
if grep -qF "al-runner itest: PASS" $L; then echo "UNEXPECTED PASS"; exit 1; fi
# every no-define row, live: all four server legs built #else
bun $P/check-no-define.ts $L "--server [LETHALA]" "resource [LETHALA]" "--server [LETHALB]" "resource [LETHALB]"
echo "RED (a) as predicted"
```

Expected from the checker: four `NO-DEFINE ... all 13 match EXPECTED_NO_DEFINE` lines. Across Tasks 6 and 8 the `#else` table is compared live on six legs, 78 rows.

**What this does and does not prove about resource mode.** Each resource leg fails here on its own, because failures are collected; so the resource legs do detect a wrong build. But both server selector modes share the one daemon and there is no resource-specific define code, so this single revert breaks both at once. Nothing red-checks a define loss confined to resource mode; no such code path exists today to lose it. R319's unit test (`al-runner-backend.test.ts`, the daemon argv carries the one-shot `--define` list for BOTH selector modes) pins the argv for each mode.

- [ ] **Step 3: Restore.** Put the line back; `git diff --quiet packages/runner/src && echo restored`; `bun test packages/runner/tests/al-runner-backend.test.ts`: 0 fail. The restored tree is byte-identical to Task 7 Step 3's, whose `PASS` is the green half of both red-checks. If the orchestrator wants a fresh green run on the restored tree, run the gate once more to `$P/logs/itest-restored.log` and expect `PASS`.

---

### Task 9: Docs, roadmap closure, and the proposed CLAUDE.md text

**Files:** `docs/roadmap/R321.md`, `ROADMAP.md` (generated), `README.md`, `.claude/skills/live-gate/SKILL.md`

- [ ] **Step 1: Gate figures in user-facing docs.** `README.md`, the `itest:alrunner` table row becomes `| ... | The al-runner backend, plus \`sandbox-symbols\` under \`[LETHALA]\` and \`[LETHALB]\` (R321) | 3 / 12 / 4; 5 / 8 / 0 per symbol set |`. `.claude/skills/live-gate/SKILL.md`, append to the `**al-runner**` bullet: `Since R321 it also runs \`fixtures/sandbox-symbols\` under \`[LETHALA]\` and \`[LETHALB]\`, each 5 / 8 / 0 over 13, one-shot, \`--server\` and resource legs matching the pre-committed table and equal per mutant; baselines \`al-runner.symbols-lethala.baseline.json\` and \`-lethalb\`, which the gate refuses to run without (record once with \`LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1\`, never a pass).`

- [ ] **Step 2: Close R321.** Front matter `status: "done (<Task 1 commit>..<Task 7 commit>)"`. Append:

```markdown
**Closed 2026-09-29 (R-321).** Built per `docs/superpowers/plans/2026-09-29-R-321-symbol-fixture.md`
(r2). `fixtures/sandbox-symbols` + `-tests` (ids 79600-79699): an `#if LETHALA` / `#elif LETHALB` /
`#else` split of `Rate`'s `exit`, three assignments outside the arms each read by one arm, and one
test asserting each build's own value. `compile:fixtures` compiles all three builds of both apps;
`--require-symbol-sets` refuses a skip; every arm of both apps was red-checked broken (fails in its
own build only), and dropping `/define` hid a broken A arm and, separately, a broken B arm.

`itest:alrunner` runs `[LETHALA]` and `[LETHALB]` through one-shot, `--server` and server+resource.
All 39 build-mutant verdicts and killing tests (both sets plus the `#else` build) were
pre-committed in `docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md`,
committed alone before any run, and every measured one matched, al-runner v2.11.0: the 26 set rows
by the gate on every transport, and the 13 `#else` rows by the red-checks, which printed that build
on six legs and compared every row with `EXPECTED_NO_DEFINE`. Frozen: each set
5 / 8 / 0 over 13, each pair of builds different on 8 of 13. A missing symbol baseline is refused;
recording is an explicit, one-time mode that is never a pass.

Red-checked live, both ways defines can be lost: removing the one-shot `--define` forwarding in
`buildAlRunnerArgv` failed `R321 one-shot [LETHALA]` / `[LETHALB]: per-mutant verdicts differ from the
pre-committed table` before any baseline existed, writing none; removing R319's daemon `--define`
failed the `--server` and resource equality checks in both sets. Six of the 13 mutants sit in a
compiled-out arm ([[R214]]); R214's fix will need a new pre-commitment and a re-freeze here.
```

Replace any claim the logs do not support.

- [ ] **Step 3: Regenerate and commit.**

```bash
set -euo pipefail
cd U:/Git/LethAL-wt/lane-code
bun scripts/roadmap-index.ts
bun test scripts/roadmap-index.test.ts
git add docs/roadmap/R321.md ROADMAP.md README.md .claude/skills/live-gate/SKILL.md
git commit -m "roadmap(R321): done, itest:alrunner measures a symbol-dependent fixture on every transport, red-checked for both ways defines can be lost"
```

- [ ] **Step 4: Proposed CLAUDE.md text (for the owner only; do not edit `CLAUDE.md`).** Send in the hand-off, to append to the `itest:alrunner` bullet:

> Since R321 it also runs `fixtures/sandbox-symbols` + `-tests` under `[LETHALA]` and `[LETHALB]`, each through the one-shot, `--server` and resource legs. Frozen per set: killed **5** / survived **8** / no-coverage **0** over 13; the two sets and the `#else` build each differ pairwise on 8 of 13 with identical counts, so only the per-mutant check separates them. Every leg must match the pre-committed table (`docs/superpowers/specs/2026-09-29-r321-symbol-fixture-precommitment.md`, verdict and killing test) and the server legs must equal the one-shot leg per mutant. Baselines `al-runner.symbols-lethala.baseline.json` and `-lethalb`: a missing one is REFUSED; record once with `LETHAL_ITEST_RECORD_SYMBOL_BASELINES=1`, which refuses to overwrite and exits 3, never a pass. RED-CHECKED both ways defines can be lost: dropping `buildAlRunnerArgv`'s `--define` fails `R321 one-shot [<set>]: per-mutant verdicts differ from the pre-committed table`; dropping R319's daemon `--define` fails the `--server` and resource equality checks. These legs do not prove the R147 pin. `compile:fixtures --require-symbol-sets` compiles all three builds of the pair and refuses a skip. The pair's `app.json` files must never define a symbol: al-runner reads a bundle's own `app.json` symbols. R214's fix will need a new pre-commitment and a re-freeze here.

---

### Task 10: File R331, the general self-recording baseline gap

R321 closes the hole for its two symbol baselines only. Every other gate's committed baseline still
goes through `assertMatchesBaseline`, which writes an absent file and returns
(`packages/runner/itest/baseline-guard.ts`, lines 60 to 61 at `b8e1d70c`:
`if (baselineRaw === undefined) { await writeFile(baselinePath, ...); ... return; }`). So deleting one
makes that gate pass on whatever it measured next. Filed here, not fixed, per the orchestrator.

**Files:** Create `docs/roadmap/R331.md`; regenerate `ROADMAP.md`.

- [ ] **Step 1: Read each call site**, so the item states what each does rather than what it is assumed to do. At `b8e1d70c` the callers are:
  - `packages/runner/itest/al-runner.itest.ts:408` (`al-runner.baseline.json`);
  - `packages/runner/itest/bcdev.itest.ts:696` (`bcdev.baseline.json`);
  - `packages/runner/itest/envtool.itest.ts:400` (`envtool.baseline.json`), which refuses to self-record while `UNVERIFIED_MOVES` is non-empty (per CLAUDE.md): read it and state exactly when it still records;
  - `packages/runner/itest/tables.itest.ts:1677` (`tables.baseline.json`);
  - `packages/runner/itest/harden.itest.ts:215`, guarded by `if (baselineExisted)`, and `packages/runner/itest/harden-expected.ts:398` (`harden.baseline.json`): read both and state which path records.

  Re-run `grep -n "assertMatchesBaseline(" packages/runner/itest/*.ts` and add any caller that has appeared since.

- [ ] **Step 2: Re-check the id immediately before writing**, across every worktree and every branch (`R330` is taken on `lethal/r302`):

```bash
cd U:/Git/LethAL-wt/lane-code
for w in $(git worktree list | awk '{print $1}'); do ls "$w/docs/roadmap" 2>/dev/null; done | grep -E '^R33[0-9]' | sort -u
git for-each-ref --format='%(refname:short)' refs/heads refs/remotes | while read -r b; do git ls-tree --name-only "$b" docs/roadmap/ 2>/dev/null; done | grep -E 'R33[0-9]' | sort -u
```

Expected: `R330.md` appears and `R331.md` does not. If `R331` is taken, STOP and ask the coordinator for the next id.

- [ ] **Step 3: Write** `docs/roadmap/R331.md`. Front matter in the style of `docs/roadmap/R321.md`: `id: "R331"`, `section: "backends-and-tooling"`, `status: "open, filed 2026-09-29"`, `order` one above the highest `order` in `docs/roadmap/`. Title: "A deleted live-gate baseline re-records itself on the next run and the gate passes, for every gate but R321's symbol legs". Body, plain English, no em dash: found by the R-321 plan review (r1 I3, r2 minor), `H:/lethal-coord/reviews/R-321-plan/`; the mechanism, quoting the `baseline-guard.ts` lines above; one bullet per gate from Step 1 with its file, line, baseline file and the exact condition under which it records; the R321 pattern that would close it (`assertMatchesFrozenBaseline`, an explicit one-time record mode that refuses to overwrite and is never a pass); and what would close it: every caller moved to a refusing guard with an explicit record mode, and one red-check per gate (delete the baseline, the gate must fail).

- [ ] **Step 4: Regenerate and commit.**

```bash
set -euo pipefail
cd U:/Git/LethAL-wt/lane-code
bun scripts/roadmap-index.ts && bun test scripts/roadmap-index.test.ts
git add docs/roadmap/R331.md ROADMAP.md
git commit -m "roadmap(R331): file the general gap, a deleted live-gate baseline re-records itself and the gate passes; found by R-321's plan review"
```

## Self-review

- **Review r1 coverage.** C: Tasks 2 to 9 use `[LETHALA]` / `[LETHALB]`; the fixture was re-listed (13 mutants, fresh dry run) before any prediction; the three tables are pairwise different on 8 of 13, shown in the spec and pinned by Task 4. I1: Task 6 (one-shot, against the pre-committed table, before baselines, names the assertion and output) and Task 8 (daemon, names four assertions); Task 8 states what resource mode is and is not red-checked by. I2: `--require-symbol-sets` (Task 1), per-set OK lines and inventory check (Task 2 Step 5), skip refusal red-check (Step 6), six broken arms across both apps and all three builds (Step 7), dropped `/define` for A and B separately (Step 8), staged-package caveat (Step 4 and README). I3: `assertMatchesFrozenBaseline` with explicit one-time record mode, refusal red-checked (Task 5); pre-commitment names every verdict and killing test and is committed alone (Task 3); a mismatch is a stop everywhere. Minor: R147 pin scope stated in Global Constraints and in `runSymbolLegs`'s comment; `sandbox-app` untouched; `CLAUDE.md` is proposed text.
- **Placeholders.** Only the two commit hashes in Task 9 Step 2, which exist only after Tasks 1 and 7, and R331's `order` value, read at write time.
- **Type consistency.** Task 4's names (`SYMBOL_SETS`, `EXPECTED_BY_SET`, `EXPECTED_NO_DEFINE`, `SymbolRow`, `SymbolReport`, `printSymbolTable`, `assertSymbolBuild`, `symbolSetLabel`) and Task 5's `assertMatchesFrozenBaseline(report, path, label, record)` are used with the same signatures in Tasks 5 to 8.

## Time

Measured basis: R-319's `s1-clean-rate` probe ran 12 sessions of 7 mutants (one test) in 9 min 6 s, about 45 s per session; the existing `itest:alrunner` took about 5 minutes in R-319. Re-estimated for 13 mutants: about 60 to 90 s per one-shot session and 30 to 45 s per server session, so 4 to 7 minutes for the six symbol sessions, and **about 9 to 12 minutes per gate run**. The plan runs the gate three times (Task 6, Task 7 record and confirm) plus Task 8 once: four runs, about 40 to 50 minutes of serial al-runner time, plus one optional restored-green run.

## Open questions for the orchestrator

None. Review r2 found `--require-symbol-sets` sound as opt-in (the edit hook runs plain `bun run compile:fixtures`), and the general self-recording baseline gap is filed as R331 by Task 10.
