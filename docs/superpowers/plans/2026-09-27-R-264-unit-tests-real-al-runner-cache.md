# R264: unit tests must never walk the real al-runner cache. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 2 (2026-09-27),** after review round 1 (`H:/lethal-coord/reviews/R-264-plan/review-r1.md`). Changed: the guard compares exact fake-home paths instead of "not under the real profile", because `tmpdir()` here IS under the real profile (Critical); the preload task now runs BEFORE the seam task, so the seam red-checks give a precise mismatch instead of a 5 s timeout; every doctor test goes through one isolation helper that also fakes alc discovery, the alc spawn and the package cache, and the audit is a grep, not a count (Important 1 and 2); the failure-set comparison parser is validated against Bun's own totals and keys on file plus test name, and the exit status is checked separately (Important 3). See "Review responses" at the end.

**Goal:** A full `bun test` on this machine has zero failures, because no unit test reads al-runner's real caches under the developer's home directory.

**Architecture:** Two layers. (1) A test preload, declared in a new root `bunfig.toml`, points the home directory at an empty temp directory for every `bun test` process, and a guard test fails if that redirect is not in force. (2) Close the seam that leaks: `buildDoctorDeps` and `doctorFromCli` inject only al-runner's FIRST cache root, and `readAlRunnerCache` silently falls back to the real SECOND root (`~/.cache/al-runner`). Add the second seam and route every doctor test through one helper that injects both roots and fakes the other real I/O doctor does. No timeout is raised.

**Tech Stack:** Bun 1.3.14, TypeScript, `bun test`.

**Spec:** `docs/roadmap/R264.md`.

## Root cause (measured and read, 2026-09-27, master `5f34f04`)

- `packages/runner/src/al-runner-cache.ts`, `readAlRunnerCache(dir?, secondaryDir?)`: the second argument defaults to `defaultAlRunnerSecondaryCacheDir()` = `join(homedir(), ".cache", "al-runner")`, and it is walked FIRST with `directoryBytes` (a recursive `readdir` plus one `stat` per file) before the first root is even listed.
- `packages/runner/src/cli.ts`, `buildDoctorDeps`: both closures call `readAlRunnerCache(opts.alRunnerCacheDir)` with ONE argument (the al-runner-only branch at about line 4162, the main path at about line 4353). There is no option for the second root, so every doctor test that reaches `runDoctor` walks the real `~/.cache/al-runner`.
- Doctor tests that pass NEITHER root, so they also walk the real FIRST root, `~/.local/share/al-runner/artifacts` (17 BC builds here): every `run(...)` and every `runJson(...)` call in the `doctorFromCli` describe of `doctor-cli.test.ts` (about lines 792 to 935), and the env-tool tool-paths test that calls `buildDoctorDeps(doctorConfigFile, ...)` at about line 704.
- `al-runner-cache.test.ts`: every `readAlRunnerCache(dir)` call (6 sites: about lines 42, 57, 82, 100, 110, 121) passes a temp first root and no second, so it walks the real `~/.cache/al-runner`. That is why R264's "an absent directory is a MEASURED absence" times out alone.
- Other real I/O in the same doctor tests, found in review (not the cause of the timeouts, but not isolated either): where `alToolPaths` is not injected, `defaultAlToolPaths` searches the real `~/.vscode/extensions`; where `alcSpawn` is not injected, the `alc-runtime` check spawns the found `alc.exe` with `/?`; and `readSystemRuntime` lists the fixture's `packageCachePath`, the literal `C:/pkg` in both `doctor-cli.test.ts` (line 62) and `doctor-al-runner.test.ts` (line 38). `C:/pkg` does not exist on this machine (measured), but nothing guarantees that elsewhere. `runDoctor` runs every check whose dependency exists, even when a test asserts only one.
- On this machine `du -sh` of both al-runner trees did not finish inside 100 s (measured 2026-09-27). That is the whole failure: a walk longer than bun's 5 s default test timeout. Raising the timeout would hide it and keep the suite's result tied to the developer's disk.
- `homedir()` on Bun 1.3.14 / Windows reads `USERPROFILE` at call time, not `HOME` (measured: setting `USERPROFILE` in-process changed `os.homedir()`; setting `HOME` did not). On POSIX it reads `HOME`. The preload sets both.
- `os.tmpdir()` on this machine is `C:\Users\SShadowS\AppData\Local\Temp` (measured), i.e. INSIDE the real profile. A fake home created under it is a descendant of the real home. So "is this path under the real home?" is the wrong test for isolation; "is this path exactly the fake one?" is the right one.
- There is no `bunfig.toml` anywhere in the repo today. Root `package.json`'s `test` script is plain `bun test`; CI (`.github/workflows/ci.yml`) runs `bun test` from the repo root on `windows-latest`. The `itest:*` scripts run `bun <file>`, not `bun test`, so a `[test]` preload does not reach them, which is intended: live gates keep the real home.
- Bun's failure line format, measured on 1.3.14 with a two-file probe: each file prints a header line `<path>.test.ts:`, each failure prints `(fail) <describe> > <test> [<n>ms]`, and the run ends with lines ` <n> pass` and ` <n> fail`.

## Global Constraints

- No `!` non-null assertions. Optional props via `...(v !== undefined ? { k: v } : {})` (`exactOptionalPropertyTypes`).
- Build/test order: `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun test`. Never `bun test` with a stale `dist`.
- Biome only on touched files: `bunx biome check <paths>`.
- Red-check every fix: revert the fix, show the named test go red, restore, show green. Report both outputs. The `mutation-red-checker` subagent can do it.
- Fail loudly: the preload must throw if it cannot create its temp home, never continue with the real one.
- No em dashes in code comments or docs.
- Do not raise any test timeout as part of this fix.
- Do NOT edit `CLAUDE.md` (owner-only). Task 3 proposes a line in the submit note instead.
- No live gate: nothing here touches a backend, a verdict, AL, or anything a live BC server runs. The change is confined to a doctor dependency seam (a report line that "can never fail", R131), test files and test configuration, and the `[test]` preload does not reach the `itest:*` scripts. Every behaviour it changes is observable offline.

## Review Focus

1. **A test run from `packages/runner` (not the repo root) does not load the root `bunfig.toml`.** Expected: Task 2's isolation helper still keeps the doctor and cache files fast and off the real disk; the guard test fails loudly there, which says "run from the root".
2. **A test that legitimately needs the real home** (for example one that discovers a real `alc` under `~/.vscode/extensions`) goes red under the preload. Expected: Task 1 Step 5 finds it by comparing failure sets, and it gets an explicit injection, never an exemption from the preload.
3. **A subprocess spawned by a unit test** inherits the fake `USERPROFILE`/`HOME`. Expected: desired (a child tool must not write to the real home either). An absolute tool path such as `C:/Users/SShadowS/.dotnet/tools/al-runner.exe` is not rewritten by the redirect; a child that breaks because its own home moved shows up in Task 1 Step 5's comparison.
4. **The injected second root exists and has content.** Expected: `describeAlRunnerCache` prints "Separately, al-runner keeps N B in <dir>". Task 2's `doctorFromCli` test uses that to prove the seam reaches the CLI end to end.
5. **Two `bun test` processes at once.** Expected: each creates its own fake home with `mkdtempSync`, and every "known-absent" test path carries a `randomUUID()`, so two runs never share a directory.

---

### Task 0: Measure the baseline, with a parser checked against Bun's own totals

**Files:** none changed. Work in the session scratchpad (`$SCRATCH` below), never in the repo.

- [ ] **Step 1: Run and keep the exit status.**

```bash
bun run typecheck && rm -rf packages/*/dist || { echo "typecheck or dist cleanup FAILED: stop, do not run or accept tests"; exit 1; }
echo "typecheck+cleanup ok" > "$SCRATCH/r264-before.pre"
bun test > "$SCRATCH/r264-before.log" 2>&1; echo $? > "$SCRATCH/r264-before.exit"
```

- [ ] **Step 2: Extract failures as `file | test`.** Bun prints a `<file>:` header before each file's results, so carry the last header onto each `(fail)` line and strip the timing:

```bash
awk '/^[^ ].*\.test\.(ts|js):$/ { f = substr($0, 1, length($0) - 1); next }
     /^\(fail\) / { t = substr($0, 8); sub(/ \[[0-9.]+m?s\]$/, "", t); print f " | " t }' \
  "$SCRATCH/r264-before.log" | sort > "$SCRATCH/r264-before-fails.txt"
```

- [ ] **Step 3: Validate the parser before trusting it.** `wc -l < "$SCRATCH/r264-before-fails.txt"` must equal the number on Bun's own ` <n> fail` summary line (`grep -E "^ [0-9]+ fail$" "$SCRATCH/r264-before.log"`), and every extracted line must carry a file (no line starting with ` | `). If either check fails, fix the parser against this log before going on; do not compare lists a parser has not been checked against. Record the pass and fail totals, the count of "Unhandled error between tests" blocks (`grep -c "Unhandled error" ...`) and the exit status.
- [ ] **Step 4:** Confirm the failing set is the R264 set (timeouts in `doctor-cli.test.ts`, `doctor-al-runner.test.ts`, `al-runner-cache.test.ts`, including `readAlRunnerCache`, `describeAlRunnerCache`, `doctorFromCli`, `issue #23: --tests`). If ANY other test fails, list it in the task report: it is either a separate bug (file a roadmap item, re-checking the next free id with `ls docs/roadmap/` immediately before writing) or something Task 1 Step 5 must explain.

### Task 1: A test preload that hides the real home, and a guard that proves it is on

Done first so that Task 2's red-checks read a fast, fake home instead of timing out on the real one.

**Files:**
- Create: `bunfig.toml` (repo root)
- Create: `scripts/test-preload.ts`
- Create: `packages/runner/tests/real-home-guard.test.ts`

**Interfaces:**
- Produces: env vars set only by the preload: `LETHAL_TEST_REAL_HOME` (the home directory as it was BEFORE the redirect) and `LETHAL_TEST_FAKE_HOME` (the temp directory it now points at). The guard reads both.

- [ ] **Step 1: Write the failing guard test.**

```ts
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultAlRunnerCacheDir,
  defaultAlRunnerSecondaryCacheDir,
} from "../src/al-runner-cache";

/**
 * R264: every default that resolves under the home directory (al-runner's two caches, the
 * quarantine dir, the env-tool state dir, the VS Code extensions dir) must resolve under a fake
 * home in a unit test. `scripts/test-preload.ts`, loaded by the root `bunfig.toml`, does the
 * redirect. The check is EXACT equality with the fake home the preload recorded, never "not under
 * the real home": on Windows `tmpdir()` is itself inside the real profile, so a correct fake home
 * IS a descendant of the real one. This test also fails when `bun test` is started outside the
 * repo root, where the preload does not load: run it from the root.
 */
test("unit tests run with the real home directory hidden (R264)", () => {
  const real = process.env.LETHAL_TEST_REAL_HOME;
  const fake = process.env.LETHAL_TEST_FAKE_HOME;
  expect(real, "the test preload did not run: start bun test from the repo root").toBeDefined();
  expect(fake, "the test preload did not run: start bun test from the repo root").toBeDefined();
  if (real === undefined || fake === undefined) return;
  const same = (p: string) => resolve(p).toLowerCase();
  expect(same(fake)).not.toBe(same(real));
  expect(same(homedir())).toBe(same(fake));
  expect(same(process.env.USERPROFILE ?? "")).toBe(same(fake));
  expect(same(process.env.HOME ?? "")).toBe(same(fake));
  expect(same(defaultAlRunnerCacheDir())).toBe(
    same(join(fake, ".local", "share", "al-runner", "artifacts")),
  );
  expect(same(defaultAlRunnerSecondaryCacheDir())).toBe(same(join(fake, ".cache", "al-runner")));
  // The two real roots, named, so the failure message says which one a regression reaches.
  expect(same(defaultAlRunnerCacheDir())).not.toBe(
    same(join(real, ".local", "share", "al-runner", "artifacts")),
  );
  expect(same(defaultAlRunnerSecondaryCacheDir())).not.toBe(same(join(real, ".cache", "al-runner")));
});
```

- [ ] **Step 2: Run it, expect FAIL** on "the test preload did not run".

- [ ] **Step 3: Implement.** `bunfig.toml`:

```toml
[test]
# R264: hide the developer's real home directory from every unit test. See scripts/test-preload.ts.
# Applies to `bun test` only; the itest:* scripts run `bun <file>` and keep the real home.
preload = ["./scripts/test-preload.ts"]
```

`scripts/test-preload.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * R264: unit tests must never read or write the developer's real home. Defaults such as
 * al-runner's caches (multi-GB here), `~/.lethal/quarantine` and `~/.vscode/extensions` all
 * resolve through `os.homedir()`, which on Bun/Windows reads USERPROFILE at call time (measured
 * 2026-09-27) and on POSIX reads HOME. Both point at a fresh empty temp dir for this process.
 * `mkdtempSync` throws if it cannot create one, so a failure stops the suite rather than
 * silently leaving the real home in place.
 */
process.env.LETHAL_TEST_REAL_HOME = homedir();
const fake = mkdtempSync(join(tmpdir(), "lethal-test-home-"));
process.env.LETHAL_TEST_FAKE_HOME = fake;
process.env.USERPROFILE = fake;
process.env.HOME = fake;
```

No `process.argv` and no `process.exit`, so `scripts/importable-scripts.test.ts` has nothing to flag.

- [ ] **Step 4: Run the guard.** From the repo root: `bun test packages/runner/tests/real-home-guard.test.ts`. Expected PASS.

- [ ] **Step 5: Full suite, compare with Task 0 in both directions.** Same commands as Task 0 Steps 1 to 3 into `r264-after-preload.*`, with the same parser validation (its line count equals Bun's ` <n> fail`). Then:

```bash
comm -23 "$SCRATCH/r264-before-fails.txt" "$SCRATCH/r264-after-preload-fails.txt"  # fixed
comm -13 "$SCRATCH/r264-before-fails.txt" "$SCRATCH/r264-after-preload-fails.txt"  # NEW failures
```

Expected: no NEW failures. Any new one relied on the real home: give it an explicit injection of the directory it needs, in this task, and name it in the report. Never exempt a test from the preload. The "fixed" list is recorded but not the acceptance: Task 2 is still needed, because a test run outside the root does not get the preload.

- [ ] **Step 6: Red-checks.**
  - Comment out the `preload` line in `bunfig.toml`: the guard goes red with "the test preload did not run". Restore.
  - Delete `process.env.USERPROFILE = fake;` from the preload (a redirect that only sets HOME, the easy Windows mistake): the guard goes red on `homedir()` and on `USERPROFILE`. Restore.
  - Record both red outputs and the restored green.

- [ ] **Step 7:** `bunx biome check scripts/test-preload.ts packages/runner/tests/real-home-guard.test.ts`.

- [ ] **Step 8: Commit.** `test: a bun test preload hides the real home directory, with a guard that it is on (R264)`.

### Task 2: Inject al-runner's second cache root, and route every doctor test through one isolation helper

**Files:**
- Modify: `packages/runner/src/cli.ts` (`buildDoctorDeps` opts and its two `readAlRunnerCache` calls; `doctorFromCli` deps and its `buildDoctorDeps` call)
- Modify: `packages/runner/tests/doctor-cli.test.ts`
- Modify: `packages/runner/tests/doctor-al-runner.test.ts`
- Modify: `packages/runner/tests/al-runner-cache.test.ts`

**Interfaces:**
- Produces: `buildDoctorDeps(configFile, { ..., alRunnerSecondaryCacheDir?: string })` and `doctorFromCli(parsed, { ..., alRunnerSecondaryCacheDir?: string })`. Absent means al-runner's own default, exactly as `alRunnerCacheDir` works today. `readAlRunnerCache`'s signature does not change.
- Produces (test-local, `doctor-cli.test.ts`): `NO_REAL_IO`, the isolation object; `depsOf(configFile, opts)`, which calls `buildDoctorDeps(configFile, { ...NO_REAL_IO, ...opts })`; and `run`/`runJson`, which now call `doctorFromCli(..., { ...NO_REAL_IO, ...deps })`.

- [ ] **Step 1: Write the failing tests.** In `doctor-cli.test.ts`, first replace the fixed-name constant with unique, known-absent paths:

```ts
import { randomUUID } from "node:crypto";
/** R264: directories that do not exist, unique per process, so a cache check reports a measured
 *  absence and this suite never walks whatever multi-GB cache the machine running it holds. */
const NO_CACHE_DIR = join(tmpdir(), `lethal-doctor-cli-no-al-runner-cache-${randomUUID()}`);
const NO_SECONDARY_DIR = join(tmpdir(), `lethal-doctor-cli-no-al-runner-second-${randomUUID()}`);
```

and change `BCDEV_RAW.packageCachePath` from `"C:/pkg"` to `join(tmpdir(), \`lethal-doctor-cli-no-pkg-${randomUUID()}\`)` (it is the only occurrence of `C:/pkg` in the file, so no assertion depends on the literal). Then add, in a new `describe("R264: doctor tests never reach the real disk", ...)`:

```ts
test("buildDoctorDeps reads al-runner's SECOND cache root from the injected dir (R264)", async () => {
  const { deps } = await depsOf(
    { bcdev: RESOLVED_BCDEV },
    {
      quarantineDir: await mkdtemp(join(tmpdir(), "lethal-doctor-r264-q-")),
      fetchFn: okFetch(info()),
    },
  );
  const read = deps.alRunnerCache;
  expect(read).toBeDefined();
  if (read === undefined) return;
  const report = await read();
  expect(report.dir).toBe(NO_CACHE_DIR);
  expect(report.secondaryDir).toBe(NO_SECONDARY_DIR);
  expect(report.secondaryBytes).toBeNull();
});
```

and in the `doctorFromCli` describe, using its `run` helper:

```ts
test("doctorFromCli threads BOTH al-runner cache roots to the report (R264)", async () => {
  const second = await mkdtemp(join(tmpdir(), "lethal-doctor-r264-second-"));
  await writeFile(join(second, "marker.bin"), "x".repeat(10));
  const { out } = await run(
    { bcdev: RESOLVED_BCDEV },
    {
      quarantineDir: await mkdtemp(join(tmpdir(), "lethal-doctor-fromcli-r264-q-")),
      alRunnerSecondaryCacheDir: second,
      fetchFn: okFetch(info()),
    },
  );
  expect(out).toContain(`no al-runner artifact cache at ${NO_CACHE_DIR}`);
  expect(out).toContain(`al-runner keeps 10 B in ${second}`);
});
```

In `doctor-al-runner.test.ts`: the same two unique constants (`NO_CACHE_DIR`, `NO_SECONDARY_DIR` with `randomUUID()`), `BCDEV_RAW.packageCachePath` to a unique absent temp path, and one test that calls `depsFor(AL_RUNNER_ONLY, v2Spawn().spawn)`, awaits `deps.alRunnerCache`, and expects `secondaryDir` to be `NO_SECONDARY_DIR` (this covers the al-runner-only branch, the other `readAlRunnerCache` call).

- [ ] **Step 2: Run them, expect FAIL.** `bun run typecheck` fails first (unknown property `alRunnerSecondaryCacheDir`, unknown `depsOf`): the expected red for a seam that does not exist. Note it in the report.

- [ ] **Step 3: Implement the seam.** In `cli.ts`:

```ts
// buildDoctorDeps opts, beside alRunnerCacheDir:
/** R264: al-runner's SECOND cache root (`~/.cache/al-runner`, R168). Injected by tests for the
 *  same reason as `alRunnerCacheDir`: a unit test must never walk the machine's real cache.
 *  Absent means al-runner's own default location. */
readonly alRunnerSecondaryCacheDir?: string;

// both closures:
readAlRunnerCache(opts.alRunnerCacheDir, opts.alRunnerSecondaryCacheDir)
```

In `doctorFromCli`'s `deps` type add the same field with the same comment, and in its `buildDoctorDeps` call add
`...(deps.alRunnerSecondaryCacheDir !== undefined ? { alRunnerSecondaryCacheDir: deps.alRunnerSecondaryCacheDir } : {}),`
next to the `alRunnerCacheDir` line.

- [ ] **Step 4: One isolation helper for every doctor test in `doctor-cli.test.ts`.** Near the top, after `fakeAlc18`:

```ts
/**
 * R264: everything doctor would otherwise read or spawn on the REAL machine, faked once. Spread
 * FIRST, so a test that is about one of these (tool-paths with `noExtension`, a cache with
 * content) overrides it by naming it. `runDoctor` runs every check whose dependency exists, even
 * when a test asserts only one, so every test needs all of these, not only the ones it asserts.
 */
const NO_REAL_IO = {
  alRunnerCacheDir: NO_CACHE_DIR,
  alRunnerSecondaryCacheDir: NO_SECONDARY_DIR,
  alToolPaths: async () => ({ alcPath: "C:/alc.exe", altoolPath: "C:/altool.exe" }),
  alcSpawn: fakeAlc18,
} as const;

function depsOf(
  configFile: LethalConfigFile,
  opts: Parameters<typeof buildDoctorDeps>[1] = {},
): ReturnType<typeof buildDoctorDeps> {
  return buildDoctorDeps(configFile, { ...NO_REAL_IO, ...opts });
}
```

Then:
  - Replace EVERY `buildDoctorDeps(...)` call that reaches `runDoctor` or awaits a dep with `depsOf(...)`, and delete the now-redundant `alRunnerCacheDir: NO_CACHE_DIR,` lines. That includes the `issue #23: --tests` helper `reportFor` (about line 1055) and the env-tool tool-paths test at about line 704, which today passes no cache root at all.
  - Leave `buildDoctorDeps` direct ONLY where the call is expected to reject before any check runs (the `rejects.toThrow` calls at about lines 134 to 151). Those never run the lazy cache closure.
  - Inside `run(...)` and `runJson(...)`, change the call to `doctorFromCli({ ... }, { ...NO_REAL_IO, ...deps })`, so every existing `run` AND `runJson` caller is isolated without editing each one. Remove the now-redundant `alToolPaths`/`alcSpawn` lines from their callers only where the value is identical to `NO_REAL_IO`'s.
  - `doctor-al-runner.test.ts`: add `alRunnerSecondaryCacheDir: NO_SECONDARY_DIR,` in `depsFor` (which already injects `alRunnerSpawn` and `alToolPaths`; the al-runner-only branch has no alc check) and at the `buildDoctorDeps({}, ...)` call.
  - `al-runner-cache.test.ts`: add `const NO_SECONDARY = join(tmpdir(), \`lethal-alrunner-no-secondary-cache-${randomUUID()}\`);` and pass it as the second argument at all six `readAlRunnerCache(...)` calls. Add `expect(report.secondaryBytes).toBeNull()` to the absent-directory test so it states what it reads.

- [ ] **Step 5: The audit is a grep, not a count.** Each must print exactly what is stated, and the output goes in the report:

```bash
grep -n "buildDoctorDeps(" packages/runner/tests/doctor-cli.test.ts
# only: the import, the depsOf body, and the rejects.toThrow calls
grep -n "doctorFromCli(" packages/runner/tests/doctor-cli.test.ts
# only: the import and the two calls inside run and runJson, both spreading NO_REAL_IO
grep -n "readAlRunnerCache(" packages/runner/tests/al-runner-cache.test.ts
# every call has two arguments
grep -n "C:/pkg" packages/runner/tests/doctor-cli.test.ts packages/runner/tests/doctor-al-runner.test.ts
# nothing
```

- [ ] **Step 6: Run.** `bun run typecheck && rm -rf packages/*/dist && bun test packages/runner/tests/doctor-cli.test.ts packages/runner/tests/doctor-al-runner.test.ts packages/runner/tests/al-runner-cache.test.ts`, from the repo root. Expected: all pass, the three files finish in seconds (record the wall time). Then run the same three files from `packages/runner` (no preload): they must also pass and stay fast, with only `real-home-guard.test.ts` excluded because it is not in the list. That is the proof Task 2 isolates the files on its own.

- [ ] **Step 7: Red-checks (precise, because Task 1's preload makes a reverted seam read the fake home quickly instead of timing out).**
  - Revert the `cli.ts` main-path call to `readAlRunnerCache(opts.alRunnerCacheDir)`: "buildDoctorDeps reads al-runner's SECOND cache root" goes red on `secondaryDir` (it shows `<fake home>/.cache/al-runner`). Restore.
  - Revert only the `doctorFromCli` threading line: "doctorFromCli threads BOTH" goes red (no `10 B` line). Restore.
  - Revert the al-runner-only closure: the new `doctor-al-runner` test goes red. Restore.
  - Remove `alRunnerSecondaryCacheDir` from `NO_REAL_IO`: the `secondaryDir` test goes red. Restore.
  - Record each red output and the restored green.

- [ ] **Step 8: Red-check the R264 symptom itself, once, by hand.** With the `preload` line commented out in `bunfig.toml`, delete the `NO_SECONDARY` argument from the absent-directory test in `al-runner-cache.test.ts` and run that one test: it times out at 5 s on this machine. That shows the fixed test was reading the real disk. Restore both.

- [ ] **Step 9:** `bunx biome check packages/runner/src/cli.ts packages/runner/tests/doctor-cli.test.ts packages/runner/tests/doctor-al-runner.test.ts packages/runner/tests/al-runner-cache.test.ts`.

- [ ] **Step 10: Commit.** `fix(runner): doctor injects al-runner's second cache root, and every doctor test fakes the real disk (R264)`.

### Task 3: Prove zero failures twice, propose the doc line, close R264

**Files:**
- Do NOT modify `CLAUDE.md` (owner-only): propose the line in the submit note instead
- Modify: `docs/roadmap/R264.md`, then regenerate `ROADMAP.md`

- [ ] **Step 1: Zero failures, twice.** From the repo root, twice back to back:

```bash
bun run typecheck && rm -rf packages/*/dist || { echo "typecheck or dist cleanup FAILED: stop, do not run or accept tests"; exit 1; }
echo "typecheck+cleanup ok" > "$SCRATCH/r264-final-N.pre"
bun test > "$SCRATCH/r264-final-N.log" 2>&1; echo $? > "$SCRATCH/r264-final-N.exit"
```

Each run must meet ALL of: its `.pre` file exists (typecheck and dist cleanup succeeded BEFORE the tests; orchestrator erratum after review r2); the exit status is `0`; Bun's summary line reads ` 0 fail`; the Task 0 parser, run on the log, yields zero lines; `grep -c "Unhandled error"` is `0`. Also compare with the baseline in both directions (`comm -23` fixed, `comm -13` new): the new list must be empty, and the fixed list must contain every R264 failure from Task 0. Twice, because R264's failures were first misread as random load noise, and one green run cannot tell a fix from luck. Record both totals, exit statuses and wall times.

- [ ] **Step 2: Propose the CLAUDE.md line (owner-only edit; do not edit the file).** Put this text in the submit note under "For the orchestrator", for the owner to add under step 3 of "Build / test loop": "Run `bun test` from the repo root: the root `bunfig.toml` preloads `scripts/test-preload.ts`, which hides the real home directory from every unit test (R264), and `real-home-guard.test.ts` fails if it did not load."

- [ ] **Step 3: Close R264.** Set `status: "done (<Task 1 commit>, <Task 2 commit>)"` in `docs/roadmap/R264.md` and add one line of evidence: the two zero-failure runs and the red-checks. Then `bun scripts/roadmap-index.ts` and `bun test scripts/roadmap-index.test.ts`.

- [ ] **Step 4: Commit.** `docs: close R264 (R264)`.

## Self-review notes

- Spec coverage: R264's fix direction ("every test passes an explicit second root, or the default is injected through the deps") is Task 2; "a test must never walk a real home directory" is Task 1's preload and guard, and Task 2's `NO_REAL_IO` for the doctor tests.
- Found here, not named in R264: the first-root leak in the `doctorFromCli` `run`/`runJson` tests and the env-tool tool-paths test; the real alc discovery, alc spawn and `C:/pkg` reads in the doctor tests. All fixed in Task 2.

## Review responses (round 1, `H:/lethal-coord/reviews/R-264-plan/review-r1.md`)

1. **Critical, the guard fails on this Windows machine.** Accepted and confirmed: `tmpdir()` here is `C:\Users\SShadowS\AppData\Local\Temp`, inside the real profile. The guard no longer asks "is it under the real home". The preload records `LETHAL_TEST_FAKE_HOME`, and the guard asserts `homedir()`, `USERPROFILE`, `HOME` and both al-runner default roots equal the fake-home paths exactly, and that the two roots differ from the two REAL roots by name (Task 1 Step 1).
2. **Important, Task 1 did not inject both roots everywhere.** Accepted. The missed calls are named in the root cause (the tool-paths test at about line 704, and `runJson` besides `run`). The per-line edit and the count are replaced by one helper: `depsOf` for every `buildDoctorDeps` call that reaches a check, and `NO_REAL_IO` spread inside `run` and `runJson`, so no caller can be missed. The audit is four greps with stated expected output (Task 2 Steps 4 and 5). Task 2 Step 6 also runs the three files WITHOUT the preload, which checks this finding directly.
3. **Important, the cache is not the only real I/O.** Accepted. `NO_REAL_IO` also fakes `alToolPaths` (no real `~/.vscode/extensions` search) and `alcSpawn` (no real alc spawn), and both fixtures' `packageCachePath` moves from `C:/pkg` to a unique absent temp path, so `readSystemRuntime` reads nothing real. The reviewer found no live OData call behind the timeouts; neither did I, and this plan claims none.
4. **Important, the failure-set comparison was not reliable.** Accepted. The parser keys on `file | test` (Bun's measured file-header format), its line count must equal Bun's own ` <n> fail` before any list is compared, the comparison runs both ways (fixed and new), and the exit status, the summary total and the unhandled-error count are checked separately (Task 0 Steps 1 to 3, Task 3 Step 1). On the red-check precision point: the preload task now runs first, so reverting a seam gives the named mismatch against the fake home, not a 5 s timeout; the timeout is shown once, on purpose, with the preload off (Task 2 Steps 7 and 8).
5. **Minor, scope and isolation.** Accepted. The `[test]` preload's scope (`bun test` only, not `itest:*`) is stated in `bunfig.toml`, the root cause and the Global Constraints; absolute tool paths are not rewritten, noted in Review Focus 3; the fixed-name absent paths are replaced by `randomUUID()` ones in all three test files.
