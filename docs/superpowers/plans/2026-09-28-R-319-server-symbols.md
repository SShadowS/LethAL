# R-319: al-runner's `--server` daemon is started with the session's preprocessor symbols, so the server legs measure the same build as the one-shot leg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r1 (2026-09-28), draft for the orchestrator's review.**

**Goal:** With `serverMode` on, al-runner compiles and runs the build the session's `preprocessorSymbols` select, exactly as the one-shot path does. Today the daemon is started without them and every server verdict belongs to the no-symbol build, while the report records the symbols as used.

**Architecture:** One change, in the one place the daemon's argv is built. `AlRunnerServer` (`packages/runner/src/al-runner-server.ts`) takes the symbol list in its constructor and `start` appends one `--define <SYM>` per symbol after `--server`. `AlRunnerBackend`'s constructor (`packages/runner/src/al-runner-backend.ts`), the only product site that builds an `AlRunnerServer`, passes `cfg.preprocessorSymbols`. The symbols go on the daemon's COMMAND LINE, not in the `runTests` request, because that is the only place al-runner 2.11.0 reads them (measured, below). The resource selector leg runs through the same daemon, so the same change fixes it.

**Tech Stack:** Bun, TypeScript, `bun:test`, a local `al-runner` **v2.11.0** (`C:/Users/SShadowS/.dotnet/tools/al-runner.exe`, the version printed by `--version` at plan time). No container, no lease: every probe and gate in this plan runs al-runner locally.

**Spec:** `docs/roadmap/R319.md`, `H:/lethal-coord/tasks/R-319/task.md`. Precedent for structure and rigour: `docs/superpowers/plans/2026-09-28-R-316-preamble-member.md` and `2026-09-28-R-309-split-preamble.md` (fail-fast scripts, a checker with exactly-once and full id-map rules, red-checks of both the fix and the checker). History: [[R101]] (c) built `preprocessorSymbols` for the one-shot path and for LethAL's own `alc` step; [[R220]] added the server path later, and did not carry the symbols over.

---

## What was measured at plan time (2026-09-28)

`$S` is `C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r319`. Every repro is hand-written with invented names; no corpus source is quoted. Every probe ran serially, one al-runner session at a time.

### How al-runner's `--server` takes symbols (raw al-runner, no LethAL)

`$S/wire-probe.ts` drives al-runner directly against `$S/repro/w1-wire` and `$S/repro-tests-w1-wire`: the app's one procedure returns 1 under `CLEAN27` and 2 otherwise, and the one test asserts 1 with no `#if`. So the test PASSES only in the `CLEAN27` build. Log: `$S/logs/wire-probe.log` (`WIRE PROBE PASS`, every row as expected).

| mode | result | build measured |
| --- | --- | --- |
| one-shot, no symbols | 0 passed, 1 failed | no-symbol |
| one-shot, `--define CLEAN27` | 1 passed | `CLEAN27` |
| `--server`, no symbols | 0 passed, 1 failed | no-symbol |
| `--server --define CLEAN27` (at daemon start) | 1 passed | `CLEAN27` |
| `--server --preprocessor-symbols CLEAN27` (at daemon start) | 1 passed | `CLEAN27` |
| `--server`, request field `"preprocessorSymbols": ["CLEAN27"]` | 0 passed, 1 failed, no error | no-symbol |
| `--server`, request field `"defines": ["CLEAN27"]` | 0 passed, 1 failed, no error | no-symbol |

So: **the server takes symbols only as start-time CLI flags, fixed for the daemon's life. A symbols field in the request is silently ignored**, which is exactly how a client could believe it had fixed this and still measure the wrong build. The rows ran one after another in separate processes, and the no-symbol server row came right before the `--define` row, so al-runner's on-disk cache did not carry one build into the other.

The decompiled 2.11.0 binary agrees, read with `ilspycmd` into `$S/decomp/` and used only to explain the measurement, never instead of it: `ServerRequest` has eleven JSON fields (`command`, `sourcePaths`, `packagePaths`, `stubPaths`, `code`, `captureValues`, `coverage`, `perTestCoverage`, `iterationTracking`, `affectedOnly`, `testIsolation`) and none carries symbols; `--define` and `--preprocessor-symbols` are parsed before the server loop starts and stored process-wide through `BcCompiler.SetExtraPreprocessorSymbols`, which every compile then merges with the built-in `CLEANSCHEMA1..25` set. The usage line `al-runner --server [--package-cache PATH ...] [--cache DIR]` does not mention `--define`, although it works. al-runner also reads a bundle's own `app.json` `preprocessorSymbols`; that route is not used (Decision 1).

### Today (HEAD `fd000a7`), through the real pipeline

`$S/equal-probe.ts` runs one full `runSession` per leg per symbol subset, coverage ON as `itest:alrunner` has it, with three legs: `oneshot` (static selector), `server` (static selector, `serverMode: true`) and `server-resource` (`serverMode: true`, `selectorMode: "resource"`). It prints one `BASE`, one `MUT` line per mutant (code, verdict, killing test, `file:line`, operator) and one `END` per leg and subset, then `DONE`. `$S/check-equal.ts` decides PASS or FAIL (rules under Task 2).

The CLEAN-style repro `s1-clean-rate` (symbols `CLEAN27` and `A`, 7 mutants) has a `CLEAN27`-only early exit and an `A`/`#else` split of the final `exit`, and its tests assert each build's own values, so every subset has a green baseline and different builds give different verdicts. At HEAD (`$S/logs/head-s1.log`, 9 min): subset `[]` agrees in all three legs; in `[CLEAN27]`, `[A]` and `[CLEAN27,A]` both server legs disagree with the one-shot leg on 2, 4 and 6 of the 7 mutants, and every disagreement is the no-symbol build's verdict. For example, under `[A]` the one-shot leg kills the two mutants in the `A` arm and keeps the two `#else` mutants as survivors, and both server legs do the reverse. `check-equal.ts` exits 1: `server [CLEAN27]: M0001 is killed/RateSmall, oneshot says killed/RateBig`. The resource leg's rows are identical to the static server leg's in every subset: it has the same gap.

`p12-mixed-scope` at HEAD: subset `[]` agrees in all three legs (3 killed, 1 survived). Under `[CLEAN27]` the one-shot leg gives 4 `no-coverage` (the `local` arm: no test can call it), and both server legs give 3 killed and 1 survived, the no-symbol build, which is what R319 reported. `check-equal.ts` exits 1: `server [CLEAN27]: M0001 is survived/-, oneshot says no-coverage/-` (`$S/logs/eq-head-p12-mixed-scope.log`, 4 minutes).

### The fix, prototyped (`$S/proto`, detached at `fd000a7`, diff `$S/proto-full.patch`)

Task 1's two small product edits and its three tests. The prototype worktree is removed (`git worktree remove`) once this plan is accepted. `bun run typecheck` clean; `bun test packages/runner/tests/al-runner-backend.test.ts packages/runner/tests/al-runner-server.test.ts` 57 pass, 0 fail; `bunx biome check` on the three touched files clean (at HEAD they are clean too). Red-checks, each restored green afterwards (3 pass):

- the `--define` spread removed from `start`: both symbol tests FAIL (`$S/logs/redcheck-argv.log`), the no-symbol test passes;
- the backend passing `[]` instead of `cfg.preprocessorSymbols`: both symbol tests FAIL (`$S/logs/redcheck-wire.log`);
- an unconditional `--preprocessor-symbols <joined>` instead of the per-symbol spread: all three FAIL (`$S/logs/redcheck-unconditional.log`).

Equality, every repro and every subset, on the prototype (`$S/logs/equal-fix.summary`):

| repro | symbols | subsets | mutants | server-side per-mutant agreements (2 legs) | expectation file |
| --- | --- | ---: | ---: | ---: | --- |
| `s1-clean-rate` | `CLEAN27`, `A` | 4 | 7 | 56 | yes |
| `p12-mixed-scope` | `CLEAN27` | 2 | 4 | 16 | yes |
| `p2-elif-else` | `A`, `B` | 4 | 4 | 32 | no |
| `p8-nested-condvar` | `A`, `B` | 4 | 4 | 32 | no |
| `p3-elif-noelse` | `A` | 2 | 4 | 16 | no |
| `p1-if-else` | `CLEAN27` | 2 | 4 | 16 | no |
| `p14-arm-unparsed` | `CLEAN27`, `A` | 4 | 4 | 32 | no |

Seven `check=0 CHECK PASS` lines, 200 server-side agreements, 45 minutes serial (logs `$S/logs/eq-fix-*.log`).

`s1-clean-rate` and `p12-mixed-scope` are checked against expectation files (`$S/expect/`) written from the HEAD one-shot leg's verdicts, which were already correct. That is what makes their PASS non-vacuous: three legs that all measured the no-symbol build agree with each other and still FAIL. The other five repros differ between builds only in declarations, so their builds give the same verdicts; they are equality controls, with no expectation file.

The checker was red-checked on the REAL logs (`$S/redcheck.py`, outputs under `$S/redcheck/`, log `$S/logs/redcheck-checker.log`, `ALL AS WANTED`): the fixed `s1` and `p12` logs exit 0; HEAD's `s1` log exits 1; and eleven edited copies of the fixed `s1` log each exit 1 (one server verdict flipped; one killing test changed in the resource leg; two verdicts swapped with the totals unchanged; one mutant dropped; one mutant duplicated; a second `BASE` line; a missing `END`; a `THREW` line; no `DONE`; one mutant's line moved; and every leg of every subset replaced by HEAD's server rows, which agree with each other and fail only on the expectation file).

### Every construction site

- **The daemon's argv** is built in exactly one place, `AlRunnerServer.start`. Before the fix it holds `--server` and one `--package-cache` per package path, nothing else.
- **`AlRunnerServer`** is constructed in exactly one product place, the `AlRunnerBackend` constructor (under `cfg.serverMode === true`), and in `al-runner-server.test.ts`'s harness.
- **`start`** is called only from `AlRunnerBackend.ensureServerSuite`, and **the `runTests` request** is built only in `AlRunnerServer.runTests` from the `ServerRunRequest` that `ensureServerSuite` assembles. The request needs no change: it has no field that could carry symbols.
- **`AlRunnerBackend` with `serverMode`** is built by `cli.ts`'s backend builder (which already passes `preprocessorSymbols` beside `serverMode`, so the fix reaches `lethal run` with no CLI change), by `cli.ts`'s `alRunnerStatusFor` (no symbols, and it only calls `status()`, which spawns `--version` and never starts the daemon), by `itest:alrunner`'s `runOnce` (no symbols; no fixture defines one), and by tests. `scripts/probe-alrunner-tables.ts` never sets `serverMode`.
- **The one-shot path** already sends the symbols in both places it builds an argv: `run()` and `provisionOnce()`, both through `buildAlRunnerArgv`.

### The resource selector leg

It has the same gap, and only through the daemon. `selectorMode: "resource"` changes how the active mutant reaches the compiled AL (a resource file instead of a rebaked selector); it does not choose the transport. Under `serverMode` it compiles through the same `ensureServerSuite` and the same daemon, so it measured the no-symbol build (HEAD `s1` log: identical rows to the static server leg in every subset). Without `serverMode` it runs through `run()` and the one-shot argv, which already carries `--define`. `cli.ts` exposes no `selectorMode`, so today only `itest:alrunner` and tests reach it. The fix needs no resource-specific code, and Task 1 pins the resource leg by test anyway.

### `itest:alrunner` runs no container

`packages/runner/itest/al-runner.itest.ts` imports only the local backend, coverage support, the orchestrator, the in-memory store, the baseline guard and the gate receipt. Its four legs are `runOnce(scratchA)` and `runOnce(scratchB)` (one-shot, twice, for determinism), `runOnce(scratchC, true)` (`--server`) and `runOnce(scratchD, true, "resource")` (`--server` plus the resource selector); each compares per mutant (`mutantCode`, verdict, `killingTest`) against the first. It reads `LETHAL_ITEST_ALRUNNER` and `LETHAL_ALRUNNER_PATH`, plus the gate-receipt challenge, which only decides whether a receipt file is written. No BC container and no coord lease. `fixtures/sandbox-app` defines no symbol, so after the fix the daemon's argv on this gate is byte-identical to HEAD's. Measured at HEAD (`$S/logs/itest-alrunner-head.log`, about 5 minutes, alone): `al-runner build under test: al-runner v2.11.0`, `killed=3 survived=12 noCoverage=4 baselineGreen=true`, `--server leg: 3 killed, verdicts identical`, `resource-selector leg: 3 killed, verdicts identical`, `al-runner itest: PASS`.

---

## Decisions

### 1. Start-time flags, passed through the constructor

The server reads symbols only at start (measured), so they belong with the other things fixed for the daemon's life. They go into `AlRunnerServer`'s constructor beside `alRunnerPath`, not into `start` or `runTests`:

- not `runTests`: the request has no such field, and the server silently ignores one (measured). A request field would be a fix that looks right and changes nothing.
- not `start`: `start` returns early once the daemon is up, so a list passed there on a later call would be silently dropped. In the constructor it cannot vary for one daemon, so there is nothing to check.
- not the bundle's `app.json`: that would change one bundle only. The one-shot path's `--define` applies to the target and the test app alike, and the server legs must compile the same program.

### 2. One repeated `--define`, never `--preprocessor-symbols`

The same form `buildAlRunnerArgv` uses, for [[R101]] (c)'s reason: the comma form breaks on a symbol containing a comma. The test compares the daemon's `--define` list with the one-shot argv's, so the two cannot drift apart.

### 3. No refusal

The task allowed refusing `serverMode` together with `preprocessorSymbols` if the server could not take symbols. It can, so nothing is refused.

### 4. No new committed live leg in this task

`itest:alrunner`'s fixture defines no symbol, so the gate cannot see this defect, before or after. The two-build proof is the scratch equality probe (Task 2). A committed symbol leg would need a new fixture pair, `compile:fixtures` wiring and a new frozen baseline; that is left as an open question, not built here.

---

## Global Constraints

- Plain English, short sentences, no em dashes, in code comments, commits and roadmap text.
- No corpus source text in any committed file. Every repro is hand-written.
- No `!` non-null assertions; destructure and check `undefined`.
- No change to any argv, request or verdict for a session without `preprocessorSymbols`: the daemon's argv stays exactly `[<al-runner>, "--server", ...package caches]`. Pinned by Task 1's no-symbol test and by Task 3's gate.
- Tests assert only what this task owns: the daemon's argv and its agreement with the one-shot argv. No test here asserts a verdict, a coverage attribution or a report field.
- Build loop per CLAUDE.md: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test` from the repo root. Biome only on touched files: `bunx biome check <paths>` (clean at HEAD for this plan's three files). Edit with the Edit tool: the prototype's first biome run failed only because a script wrote CRLF line endings.
- Every fix is red-checked: revert the specific line, confirm the specific test goes red, restore, report both outputs.
- Every scratch shell block runs under `set -euo pipefail`, writes raw logs under `$S/logs/`, and never filters a command's output through `grep -v`.
- Probes run SERIALLY: one al-runner session at a time, never beside another probe or `itest:alrunner`. Parallel runs are a known source of false `wire contract UNMEASURABLE` throws (R-316). Any probe or gate failure is a STOP: report the al-runner version, the repro, the subset and the checker's line, with the raw log path, to the coordinator.
- No container, no lease. Nothing in this plan publishes to BC.
- Roadmap: never hand-edit `ROADMAP.md`; regenerate with `bun scripts/roadmap-index.ts`.

## Review Focus

1. **The symbols reach the daemon, every leg.** Expected: with symbols, the daemon's argv holds one `--define` per symbol, in order, the same list as the one-shot argv, for both selector modes. Pinned by Task 1's two symbol tests; red-checked twice (the argv half and the backend half).
2. **Nothing changes without symbols.** Expected: the daemon's argv is exactly `["al-runner", "--server"]`. Pinned by Task 1's no-symbol test (red-checked with an unconditional flag) and by `itest:alrunner` (Task 3).
3. **Equal per mutant, not per count.** Expected: all three legs give the same verdict AND killing test for every mutant, in every subset, with the same id map; and `s1` and `p12` hold each build's own verdicts. Pinned by Task 2's checker, red-checked on real logs, including the "all legs agree on the wrong build" case.
4. **No field that would silently do nothing.** The request is not given a symbols field. Measured: the server ignores one.

---

## File structure

- Modify `packages/runner/src/al-runner-server.ts`: the constructor takes `preprocessorSymbols`; `start` appends the `--define` flags; the header's "does NOT do" notes gain one line on symbols (Task 1).
- Modify `packages/runner/src/al-runner-backend.ts`: the constructor passes `cfg.preprocessorSymbols`; the `preprocessorSymbols` doc comment names both paths (Task 1).
- Modify `packages/runner/tests/al-runner-backend.test.ts`: three tests in the `AlRunnerBackend serverMode (R220)` describe (Task 1).
- Modify `docs/measurements/README.md`: one subsection under "al-runner v2" with the wire table (Task 5).
- Roadmap: `docs/roadmap/R316.md` gains the gate-evidence pointer (Task 4); `docs/roadmap/R319.md` is closed (Task 5); `ROADMAP.md` regenerated in both.
- Scratch, never committed: everything under `$S`, present at plan time.

---

### Task 0: Scratch tools and the BEFORE capture (no product change)

**Files:** scratch only.

- [ ] **Step 1: Tools.** Present at plan time in `$S`: `wire-probe.ts`, `equal-probe.ts`, `check-equal.ts`, `run-equal.sh`, `redcheck.py`, the repros `repro/s1-clean-rate`, `repro/w1-wire` (new, hand-written) and `repro/p12-mixed-scope`, `p2-elif-else`, `p8-nested-condvar`, `p3-elif-noelse`, `p1-if-else`, `p14-arm-unparsed` (copied from R-316's scratch dir) with their `repro-tests-*` twins, and `expect/s1-clean-rate.json`, `expect/p12-mixed-scope.json`. `equal-probe.ts` imports the backend, orchestrator and store from `$ROOT` (default `U:/Git/LethAL-wt/r319`) by dynamic import, so one tool serves HEAD and the build under test. Confirm nothing points at another worktree:

```bash
set -euo pipefail
S=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r319
if grep -n "LethAL-wt/r316\|LethAL-wt/r309" "$S"/*.ts "$S"/*.sh "$S"/*.py; then exit 1; fi
"C:/Users/SShadowS/.dotnet/tools/al-runner.exe" --version | tee "$S/logs/version-t0.log"
```

Expected: no grep hit, and `al-runner v2.11.0`. A newer version is not a STOP, but every expectation in this plan was measured on 2.11.0, so re-run Step 2 first and read the wire table again before building.

- [ ] **Step 2: The wire contract, re-measured.**

```bash
set -euo pipefail
S=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r319
cd "$S"
bun wire-probe.ts > "$S/logs/wire-probe-t0.log" 2>&1
tail -n 1 "$S/logs/wire-probe-t0.log"
```

Expected: `WIRE PROBE PASS`, exit 0 (the seven rows of the table above). If the request-field rows now read `passed=1`, the server has gained per-request symbols: STOP and tell the coordinator, since the design choice changes.

- [ ] **Step 3: BEFORE capture at HEAD.** On `lethal/r319` before Task 1, the equality probe must FAIL on the two discriminating repros:

```bash
set -euo pipefail
S=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r319
bash "$S/run-equal.sh" before U:/Git/LethAL-wt/r319 s1-clean-rate p12-mixed-scope | tee "$S/logs/equal-before.summary"
if grep -q "check=0" "$S/logs/equal-before.summary"; then exit 1; fi
```

Expected: two lines, both `check=1`; `s1` fails with `server [CLEAN27]: M0001 is killed/RateSmall, oneshot says killed/RateBig`; `p12` fails with `server [CLEAN27]: M0001 is survived/-, oneshot says no-coverage/-`. About 13 minutes. (Measured at plan time: `$S/logs/head-s1.log` and `$S/logs/eq-head-p12-mixed-scope.log`.)

---

### Task 1: Start the daemon with the session's symbols

**Files:**
- Modify: `packages/runner/src/al-runner-server.ts` (`AlRunnerServer` constructor, `start`, the module header)
- Modify: `packages/runner/src/al-runner-backend.ts` (`AlRunnerBackend` constructor, `AlRunnerConfig.preprocessorSymbols` doc comment)
- Test: `packages/runner/tests/al-runner-backend.test.ts`

- [ ] **Step 1: Write the failing tests.** In `al-runner-backend.test.ts`, inside `describe("AlRunnerBackend serverMode (R220)", ...)`, after the test `serverMode:false still constructs and uses the one-shot transport`, add:

```ts
  /** The values that follow each `--define` in one argv, in order. */
  function definesOf(argv: readonly string[]): string[] {
    const out: string[] = [];
    argv.forEach((a, i) => {
      const next = argv[i + 1];
      if (a === "--define" && next !== undefined) out.push(next);
    });
    return out;
  }

  for (const selectorMode of ["static", "resource"] as const) {
    test(`R319: the daemon is started with the SAME --define list the one-shot path sends (${selectorMode} selector)`, async () => {
      // al-runner 2.11.0's server takes preprocessor symbols ONLY as start-time flags. Its
      // `runTests` request has no symbols field and silently ignores one, measured. So a daemon
      // started without them compiles the no-symbol build for the whole session.
      const symbols = ["CLEAN27", "A"];
      const dir = await mkdtemp(join(tmpdir(), "lethal-alrunner-server-syms-"));
      const fake = fakeServerSpawn([{ name: "Codeunit79100.A", status: "pass" }]);
      const serverArgv: string[][] = [];
      const spy: ServerSpawnFn = (argv) => {
        serverArgv.push([...argv]);
        return fake.spawn(argv);
      };
      const server = new AlRunnerBackend(
        {
          alRunnerPath: "al-runner",
          instrumentedDir: dir,
          testDir: "/tests",
          selectorObjectId: 50000,
          serverMode: true,
          selectorMode,
          preprocessorSymbols: symbols,
        },
        okSpawn({ tests: [] }).spawn,
        spy,
      );
      const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "A" };
      await server.run(ref, { coverage: "none", timeoutMs: 1000 });
      await server.close();

      const oneShotSpawn = okSpawn({ tests: [] });
      const oneShot = new AlRunnerBackend(
        {
          alRunnerPath: "al-runner",
          instrumentedDir: dir,
          testDir: "/tests",
          selectorObjectId: 50000,
          preprocessorSymbols: symbols,
        },
        oneShotSpawn.spawn,
      );
      await oneShot.run(ref, { coverage: "none", timeoutMs: 1000 });

      expect(serverArgv.length).toBe(1);
      const [started] = serverArgv;
      const [sent] = oneShotSpawn.calls;
      if (started === undefined || sent === undefined) throw new Error("no argv captured");
      expect(definesOf(started)).toEqual(["CLEAN27", "A"]);
      expect(definesOf(started)).toEqual(definesOf(sent));
    });
  }

  test("R319: with no symbols the daemon's argv carries no --define at all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-alrunner-server-nosyms-"));
    const fake = fakeServerSpawn([{ name: "Codeunit79100.A", status: "pass" }]);
    const serverArgv: string[][] = [];
    const spy: ServerSpawnFn = (argv) => {
      serverArgv.push([...argv]);
      return fake.spawn(argv);
    };
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: dir,
        testDir: "/tests",
        selectorObjectId: 50000,
        serverMode: true,
      },
      okSpawn({ tests: [] }).spawn,
      spy,
    );
    await backend.run(
      { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "A" },
      { coverage: "none", timeoutMs: 1000 },
    );
    await backend.close();
    expect(serverArgv).toEqual([["al-runner", "--server"]]);
  });
```

These go through the real `AlRunnerBackend` and the real `AlRunnerServer`; only the two spawn functions are fakes, since a unit test cannot run al-runner. The two-build proof against the real binary is Task 2.

- [ ] **Step 2: Run, expect FAIL.** `bun test packages/runner/tests/al-runner-backend.test.ts -t "R319"`. Expected: 1 pass (the no-symbol test, which pins today's argv), 2 fail, each with `Expected - 4 / Received + 1`: the daemon's `--define` list is `[]`.

- [ ] **Step 3: Implement.** In `al-runner-server.ts`, change the constructor to:

```ts
  constructor(
    private readonly alRunnerPath: string,
    private readonly spawn: ServerSpawnFn,
    /**
     * R319. Fixed for the daemon's life, because that is where al-runner reads them: measured on
     * 2.11.0, `--define` at `--server` start selects the build, and a symbols field in a
     * `runTests` request is silently ignored. One `--define` per symbol, the same form the
     * one-shot argv uses (R101 (c)).
     */
    private readonly preprocessorSymbols: readonly string[] = [],
  ) {}
```

and in `start`, the argv to:

```ts
    const argv = [
      this.alRunnerPath,
      "--server",
      ...packagePaths.flatMap((p) => ["--package-cache", p]),
      ...this.preprocessorSymbols.flatMap((sym) => ["--define", sym]),
    ];
```

In the module header's "What this client deliberately does NOT do" list, add: `- **No symbols in the request.** The request has no such field and the server ignores one (measured on 2.11.0, R319); the symbols are start-time flags, see the constructor.`

In `al-runner-backend.ts`, in the `AlRunnerBackend` constructor, replace `this.server = new AlRunnerServer(cfg.alRunnerPath, serverSpawn ?? defaultServerSpawn);` with:

```ts
      this.server = new AlRunnerServer(
        cfg.alRunnerPath,
        serverSpawn ?? defaultServerSpawn,
        cfg.preprocessorSymbols ?? [],
      );
```

In `AlRunnerConfig.preprocessorSymbols`'s doc comment, after its first paragraph, add: `Both transports send them. The one-shot argv carries them per invocation; under serverMode they are the daemon's start-time flags, because al-runner's server reads symbols nowhere else (R319, measured on 2.11.0). Before R319 the server leg silently compiled the no-symbol build.`

- [ ] **Step 4: Run, expect PASS.** `bun test packages/runner/tests/al-runner-backend.test.ts -t "R319"`: 3 pass. Then the build loop: `bun run typecheck`, `rm -rf packages/*/dist`, `bun test` from the repo root: all green. `bunx biome check packages/runner/src/al-runner-server.ts packages/runner/src/al-runner-backend.ts packages/runner/tests/al-runner-backend.test.ts`: clean.

- [ ] **Step 5: Red-checks.** One at a time, each recorded red then restored green (measured at plan time on `$S/proto`, logs named):
  1. Delete the `...this.preprocessorSymbols.flatMap(...)` line in `start`. Expected: both symbol tests FAIL, the no-symbol test passes (`$S/logs/redcheck-argv.log`).
  2. Pass `[]` instead of `cfg.preprocessorSymbols ?? []` in the backend constructor. Expected: both symbol tests FAIL (`$S/logs/redcheck-wire.log`). This is the half a wiring-only review misses: the server is right and the backend never tells it.
  3. Replace the spread with the unconditional pair `"--preprocessor-symbols", this.preprocessorSymbols.join(",")`. Expected: all three FAIL; the no-symbol test catches the extra flags on a session that defines nothing (`$S/logs/redcheck-unconditional.log`).

- [ ] **Step 6: Commit.**

```bash
git add packages/runner/src/al-runner-server.ts packages/runner/src/al-runner-backend.ts packages/runner/tests/al-runner-backend.test.ts
git commit -m "fix(R319): start al-runner --server with the session's preprocessor symbols, one --define each, as the one-shot argv does"
```

---

### Task 2: Server and one-shot verdicts are equal per mutant, every repro, every subset (scratch, no container)

**Files:** scratch only. `check-equal.ts`'s rules, in order, each exiting 1 on the first failure: no `THREW` line; exactly one `DONE`; every `BASE`, `MUT` and `END` line names an expected subset and leg; exactly the 2^n subsets of the repro's symbols, each with exactly the three legs, each with exactly one `BASE` and one `END`; baseline green and `errors=0` in every leg; no mutant code twice in one leg and subset; at least one mutant per leg; the complete id map (code to `file:line operator`) identical across the three legs of a subset AND across subsets; the same mutant count as the one-shot leg; verdict AND killing test equal to the one-shot leg's for every mutant; and, with an expectation file, every listed mutant holding its listed verdict in every leg of that subset.

- [ ] **Step 1: The equality probe on the committed fix.**

```bash
set -euo pipefail
S=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r319
bash "$S/run-equal.sh" after U:/Git/LethAL-wt/r319 s1-clean-rate p12-mixed-scope p2-elif-else p8-nested-condvar p3-elif-noelse p1-if-else p14-arm-unparsed | tee "$S/logs/equal-after.summary"
test "$(grep -c "check=0 CHECK PASS" "$S/logs/equal-after.summary")" -eq 7
echo "R-319 equality: 7 repros, every subset, three legs CHECK PASS"
```

Expected: seven `check=0 CHECK PASS` lines, then the final line. About 45 minutes, serial. The per-repro figures are the prototype's, in the table under "The fix, prototyped".

- [ ] **Step 2: Red-check the checker on the real logs.**

```bash
set -euo pipefail
S=C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r319
cp "$S/logs/eq-after-s1-clean-rate.log" "$S/logs/eq-fix-s1-clean-rate.log"
cp "$S/logs/eq-after-p12-mixed-scope.log" "$S/logs/eq-fix-p12-mixed-scope.log"
python "$S/redcheck.py" | tee "$S/logs/redcheck-checker-after.log"
```

Expected: 14 `OK` lines and `ALL AS WANTED`, exit 0 (as measured at plan time; the cases are listed under "What was measured"). `redcheck.py` reads the fixed logs under their plan-time names, hence the two copies.

- [ ] **Step 3: Any FAIL is a STOP** (Global Constraints). Do not work around a failing repro here, and do not run Task 3.

---

### Task 3: `itest:alrunner` still passes, all four legs identical (local al-runner, no container)

**Files:** none changed.

- [ ] **Step 1: Run the gate, foreground, alone.** Nothing else may run al-runner at the same time.

```bash
set -euo pipefail
cd /u/Git/LethAL-wt/r319
LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner 2>&1 | tee C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL-wt-lane-bugs/01994069-c6e6-468b-ad23-4e5aa5c0d94f/scratchpad/r319/logs/itest-alrunner-after.log
```

Expected: its first line names al-runner v2.11.0; `--server leg: 3 killed, verdicts identical`; `resource-selector leg: 3 killed, verdicts identical`; `al-runner itest: PASS`; exit 0. The frozen figures (3 killed, 12 survived, 4 no-coverage, per mutant against the committed baseline, both one-shot legs identical) are unchanged, because the fixture defines no symbol and the daemon's argv is byte-identical to HEAD's. A differing verdict is a BLOCK, never "close enough". About 5 minutes (measured at HEAD, `$S/logs/itest-alrunner-head.log`).

---

### Task 4: Point R316's record at its archived gate evidence (carried item)

**Files:** Modify `docs/roadmap/R316.md`; regenerate `ROADMAP.md`.

- [ ] **Step 1: Add the pointer.** In `docs/roadmap/R316.md`, at the end of the bullet that begins `**Live gate, Cronus28**`, after `... was unchanged.`, add:

```markdown
  The evidence is archived at `H:/lethal-coord/tasks/R-316/gate-evidence/`: `run1/` (run 1's two
  reports `report-none.json` and `report-r316a.json`, the checker's `check-none.log` and
  `check-r316a.log` with the `GATE FAIL` on the two `Plain` rows, doctor logs, the inventory
  before and after with its empty diff, and the removal log), `run2/` (the same set for the passing
  run), `check-gate.ts` and `expect-gate.json` (the fixed checker and its pre-committed rows), and
  `redcheck-real/` with `redcheck-real.py`, which back the claim that the fixed checker was
  red-checked on the REAL run-1 reports: `real-good-none.out` and `real-good-r316a.out` are the
  fixed checker passing both unedited run-1 reports, and eight edited copies of them
  (`real-none-*.json` and `real-r316a-*.json`: the killer not reached, the negative control
  reached, the arm witness swapped) each exit 1. `check-gate-redcheck-run2.log` records all 28
  cases as wanted, the ten real ones and eighteen synthesized ones (`syn-*.out`).
```

- [ ] **Step 2: Regenerate and check.** `bun scripts/roadmap-index.ts`, then `bun test scripts/roadmap-index.test.ts`: green.

- [ ] **Step 3: Commit.** `git add docs/roadmap/R316.md ROADMAP.md && git commit -m "roadmap(R316): point at the archived gate evidence, including the checker's red-check on the real run-1 reports"`

---

### Task 5: Record the contract and close R319

**Files:** Modify `docs/measurements/README.md`, `docs/roadmap/R319.md`; regenerate `ROADMAP.md`.

- [ ] **Step 1: The measurement.** In `docs/measurements/README.md`, section "al-runner v2", add a subsection `### \`--server\` takes preprocessor symbols only at start (measured 2026-09-28, v2.11.0)` holding the wire table from "What was measured" above, the sentence that a request field is silently ignored, and the probe's location (scratch; the method is `$S/wire-probe.ts`'s: an app whose value differs by `CLEAN27` and a test with no `#if` that asserts one value).

- [ ] **Step 2: Close the item.** In `docs/roadmap/R319.md`, set `status: "done (<Task 1 commit>)"` and append a `**Closed 2026-09-28 (R-319).**` paragraph: the plan path; the measured contract (start-time `--define` works, a request field is ignored); the fix (the daemon's argv, one `--define` per symbol, passed from `AlRunnerBackend`'s constructor); that the resource selector leg had the same gap and needed no separate code; the three tests and their three red-checks; the scratch equality probe (7 repros, every subset, three legs, per mutant, `s1` and `p12` against each build's own verdicts, checker red-checked on real logs); and that `itest:alrunner` passed unchanged with four legs identical.

- [ ] **Step 3: Regenerate, check, commit.**

```bash
bun scripts/roadmap-index.ts
bun test scripts/roadmap-index.test.ts
git add docs/measurements/README.md docs/roadmap/R319.md ROADMAP.md
git commit -m "roadmap(R319): closed, al-runner --server now starts with the session's symbols; the server symbol contract recorded"
```

---

## Notes

### Upstream issue draft (for SShadowS/al-runner, not filed)

**Title:** `--server`: preprocessor symbols can only be set at daemon start, and a symbols field in `runTests` is silently ignored

**Body:** On v2.11.0, `al-runner --server --define SYM` selects the `SYM` build for every request, and so does `--preprocessor-symbols SYM`. A `runTests` request carrying `"preprocessorSymbols": ["SYM"]` (or any other unknown field) is accepted without an error and compiles the no-symbol build. Repro: an app whose one procedure returns 1 under `#if SYM` and 2 otherwise, and a test with no `#if` that asserts 1. `--server --define SYM` then `runTests`: 1 passed. `--server` then `runTests` with `"preprocessorSymbols": ["SYM"]`: 0 passed, 1 failed, no error. Two asks, either would do: (1) accept per-request symbols in `runTests` (and key the warm state on them), so one daemon can serve builds with different symbols; or (2) reject unknown request fields with an error, so a client that sends one learns it did nothing. Smaller: the usage line `al-runner --server [--package-cache PATH ...] [--cache DIR]` does not list `--define` or `--preprocessor-symbols`, though both work there.

### What this plan does not cover

- The server legs still receive no platform-app pin and no `--auto-provision` (CLAUDE.md's `itest:alrunner` notes, R235 and R242); unchanged.
- `al-runner-contract.ts` (R123's per-session probe) does not exercise `--server`; not widened here.

## Open questions for the orchestrator

1. **A committed symbol leg.** Should a later task add a symbol-defining fixture pair to `itest:alrunner` (a fifth leg under two symbol sets), so the gate itself would catch a regression of R319? It needs a new fixture, `compile:fixtures` wiring and a new frozen baseline. This plan leaves it out and files nothing; say if it should be filed.
2. **Filing the upstream issue.** The draft above is ready; say if and where to file it.
