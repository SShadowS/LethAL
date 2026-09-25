# R235: al-runner 2.11.0 names its platform-app search directory only in verbose output, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision r2 (2026-09-26)** answers review r1 (`H:/lethal-coord/reviews/R-235-plan/review-r1.md`) under the coordinator's five rulings. See the changelog at the end.

**Goal:** `itest:alrunner` passes on al-runner v2.11.0. All four legs stay at 3 / 12 / 4, per mutant. The platform-app pin engages on the two ONE-SHOT legs, which are the only legs that consume it today. Every sentence older builds print still pins.

**Roadmap:** R235. **This task starts after C02-04 is merged**, which brings `lethal/lane-code`'s R235 (`137d0b1`) to master. The task files nothing new for R235. It only flips R235's `status` when it lands.

**What the pin is, and what it is not.** Only the one-shot CLI path sends the pin (`buildAlRunnerArgv`, as `--package-cache <pin>` in place of `--auto-provision`). The `--server` path, which the server and resource legs use, starts the daemon with `cfg.packagesDir` alone and never with the pin. `runSession` still records `platformAppsDir` on those legs' reports. So on those legs the recorded value says what provisioning found, not what the runner searched. This task does not change that (see Out of scope).

**Tech stack:** Bun + TypeScript, `bun test`, one live gate.

## What was measured (2026-09-26, this machine)

`al-runner --version` prints `al-runner v2.11.0`.

The backend's one-time provisioning call (`AlRunnerBackend.provisionOnce`) was reproduced with its exact argv. The itest sets no `packagesDir`, so the argv is:

```
al-runner.exe --output-json --isolation test --test Codeunit0.__lethal_provision_only__ --auto-provision U:/Git/LethAL/fixtures/sandbox-tests
```

with `AL_RUNNER_TEST_TIMEOUT_SEC` set. Exit 0 every time.

### 1. Warm, the user's real cache (the R235 case)

Complete stderr, verbatim:

```
[expectations] no tests/expectations manifest found (probed ...\scratchpad\tests\expectations and the ancestor tree of 1 bundle path(s)) - expect-oos / expect-fail-known-gap / expect-divergence classification is OFF this run. Pass --expectations DIR to set it explicitly.
[bc] selected BC 28.1.49838.54487 (C:\Users\SShadowS\.local/share/al-runner/artifacts\28.1.49838.54487)
[bc] warning: the shipped 28.1 engine variant was built against 28.1.49838.54368, not the selected 28.1.49838.54487 - different BUILDS of the same minor can still fail to load Microsoft.Dynamics.Nav.CodeAnalysis (it's strong-named per build, not per minor). Expected: variants pin the newest build of a minor AT PACK TIME, so any user on a different build of that same minor hits this. See docs/limitations.md.
al-runner - running 1 bundle(s)
[1/1] U:\Git\LethAL\fixtures\sandbox-tests - 1 suites
   0P/0F/0E across 0 tests, 0 suite errors (1.0s)
```

No `[provision]` line at all, as on 2.10 (R200). So R200's fallback runs. It derives `<selected dir>\platform-apps`, and **that directory does not exist**. The selected build `28.1.49838.54487` holds the engine and `test-apps` only.

The real `provisionOnce`, run through a scratch Bun script against the same cache, returns this refusal verbatim:

```
al-runner printed no provisioning sentence, and the platform-app directory derived from its `[bc] selected` line, C:\Users\SShadowS\.local/share/al-runner/artifacts\28.1.49838.54487\platform-apps, cannot be read (R200) (ENOENT: no such file or directory, scandir '...\28.1.49838.54487\platform-apps'), so it is not pinned (R147). Every invocation keeps --auto-provision, as before.
```

**Root cause.** The regexes did not break. R200's assumption did: "the platform apps live under the selected build's directory". On 2.11.0 the runner takes them from a DIFFERENT build, the engine variant's (`28.1.49838.54368`). It names that directory only in verbose output. The same argv run with the environment variable `AL_RUNNER_VERBOSE=1` set, and no new flag, adds these lines, verbatim. (This measurement used the variable, not the flag. `al-runner --help` documents `AL_RUNNER_VERBOSE=1` as "Same as --verbose", and an earlier `--verbose` run on the same cache printed the same `[pkg-cache]` lines.)

```
[provision] BC 28.1.49838.54487 engine artifacts already complete at C:\Users\SShadowS\.local/share/al-runner/artifacts\28.1.49838.54487.
[bc] selected BC 28.1.49838.54487 (C:\Users\SShadowS\.local/share/al-runner/artifacts\28.1.49838.54487)
  package caches (requested): 2 dir(s)
  package caches (final search set): 2 dir(s)
    [pkg-cache] C:\Users\SShadowS\.local/share/al-runner/artifacts\28.1.49838.54487\test-apps
    [pkg-cache] C:\Users\SShadowS\.local/share/al-runner/artifacts\28.1.49838.54368\platform-apps
```

Note the MIXED separators (`\.local/share/al-runner/artifacts\`). Stdout stays the clean JSON envelope under `AL_RUNNER_VERBOSE=1` (measured: 10 lines, begins with `{`).

**What a `[pkg-cache]` line is.** The runner prints it under `package caches (final search set)`. It is the list of directories the runner SEARCHES for `.app` dependencies. It does not say which `.app` file won resolution. Neither does `readPlatformAppsPin`, which only checks that the directory holds at least one `.app`.

**What this does and does not prove.** The table below shows that this directory works for this fixture on this cache. It does not show that adding it leaves dependency resolution, or verdicts, unchanged for a project with other package caches. R147's old argument, "a wrong pin can only error", was measured for a directory that does NOT exist. It is not extended here to a directory that exists but holds a mismatched build. The verdict evidence for this change is the gate's per-mutant equality, and nothing else.

A real run of both fixture tests, same warm cache:

| argv | result | `wallSeconds` |
| --- | --- | --- |
| `--auto-provision`, no pin | 2 passed, exit 0 | 4.87 |
| `--package-cache ...\28.1.49838.54368\platform-apps`, no `--auto-provision` | 2 passed, exit 0 | 2.42 |

One sample each. An observation, not a claim.

### 2. Cold, a scratch cache (user cache untouched)

2.11.0 honours `AL_RUNNER_ARTIFACTS_ROOT`, so cold runs pointed it at `<scratchpad>/artroot`. The user's cache was listed before and after and did not change.

**A truly empty cache fails**, exit 2, before any platform-app step. Verbatim tail:

```
[provision] no cached BC 28.x - resolving latest full version from the CDN...
Resolved: 28 -> 28.5.54151.55147
...
[provision] BC 28.5.54151.55147 engine artifacts complete.
BC version selection failed: no shipped engine variant supports BC 28.5.54151.55147 (major 28). Available variants: 27.0.38460.53934, 27.3.44313.53909, 27.5.46862.53931, 28.0.46665.54371, 28.1.49838.54368, 28.2.50931.54349, 28.3.52162.54374, 28.4.53241.54387. Select a cached BC version this install ships an engine for (--bc-version), or update al-runner.
```

That is a separate problem (see Out of scope). To reach the platform-app step, the scratch root was seeded with the `28.1.49838.54368` engine files only. Then, non-verbose, the cold sentence is UNCHANGED in form and the old regex still matches it:

```
[bc] selected BC 28.1.49838.54368 (...\scratchpad\artroot\28.1.49838.54368)
[provision] note: a symbol-only platform app already in the package cache suggest(s) BC 28.0.x, which differs from the selected BC 28.1.x - provisioning platform R2R apps for the SELECTED version, not the cache's.
[provision] Resolved: 28.1 -> 28.1.49838.55191
[provision] platform R2R apps missing - downloading...
[provision] Downloaded 6 app(s) (116 MB total) to ...\scratchpad\artroot\28.1.49838.55191\platform-apps
```

The cold sentence names build `55191` while `[bc] selected` names `54368`. The directory is still the one the runner wrote, so reading the sentence stays right.

Cold again with `AL_RUNNER_VERBOSE=1` (platform-apps removed from the scratch `55191`), the two statements agree:

```
[provision] Downloaded 6 app(s) (116 MB total) to ...\scratchpad\artroot\28.1.49838.55191\platform-apps
  package caches (final search set): 1 dir(s)
    [pkg-cache] ...\scratchpad\artroot\28.1.49838.55191\platform-apps
```

A warm scratch run with `AL_RUNNER_VERBOSE=1` whose selected build DOES hold platform apps prints `[pkg-cache] ...\artroot\28.1.49838.55191\platform-apps`, the same place R200 would derive. So in all three measured states the `[pkg-cache]` line names a directory that exists and holds platform apps. R200's derivation does so in two of the three.

### 3. Is there another source?

- `al-runner provision --platform-apps` force-downloads into `<artifacts>/<version>/platform-apps` for "this binary's own built engine version, or the target bundle's app.json". It does not say which directory a RUN will search, which is the fact the pin needs. R207 already tracks switching to the subcommand; not this item.
- `[bc] warning: ... variant was built against 28.1.49838.54368` names the build, but turning it into a path is a second guess at layout. Rejected.
- `[pkg-cache] <dir>` is the runner stating a directory it searched. It is a search-set fact, not a resolution fact, but it is still the runner's own path rather than one LethAL builds. That is the principle R147 chose: read the path, do not construct it.

## The fix

One parser change and one environment change, both on the provisioning call only. Mutant invocations keep their argv and environment exactly.

1. `provisionOnce` spawns with `{ ...alRunnerEnv(PROVISION_TEST_TIMEOUT_SECONDS), AL_RUNNER_VERBOSE: "1" }`. It uses the environment variable, not the `--verbose` flag. An older al-runner that does not know the variable ignores it, where an unknown flag could make it refuse the whole call. No test here proves how 2.7 or 2.10 treat `--verbose`: fake spawns cannot. `buildAlRunnerArgv` and `alRunnerEnv` are untouched, so the mutant and canary calls do not change.
2. `parseAlRunnerPlatformAppsDir` also reads `[pkg-cache] <dir>` lines whose directory ends in `platform-apps`:

   ```ts
   const PLATFORM_APPS_PKG_CACHE =
     /^[ \t]*\[pkg-cache\] ((?:[A-Za-z]:[\\/]|[\\/]|~[\\/])[^\n]*platform-apps[\\/]?)[ \t\r]*$/gm;
   ```

   Indentation is allowed (the runner prints four spaces), but the tag must be the first thing on the line. A test's failure text that merely CONTAINS the tag mid-line does not match. A test that prints its own indented `[pkg-cache]` line at the start of a line WOULD match. That is accepted: the provisioning call selects no test (`AL_RUNNER_PROVISION_SENTINEL`), so no test output reaches this parser. Matches join the existing `seen` map, so a `Downloaded` or `already complete` sentence naming a different directory gives `conflicting`, as today.
3. New `basis: "package-cache"`, used when no provisioning sentence matched but a `[pkg-cache]` line did. `downloaded` still wins when present, because it carries the count. `already-complete` stays as today when only that sentence matched. The doc comment on `basis` says a `package-cache` pin is a SEARCH-set fact, not a resolution fact.
4. The R200 derivation runs ONLY when none of the three matched. It is unchanged, so a 2.10 binary that prints no `[pkg-cache]` still pins as before.
5. `readPlatformAppsPin`: an empty or unreadable `package-cache` directory is refused, naming `[pkg-cache]` and R235, under the same non-empty rule as `already-complete`. The `no-completion-line` refusal lists the `[pkg-cache]` line among what it looked for.
6. `downloaded` in `AlRunnerProvisionResult` is unaffected: verbose output adds no `downloading` or `fetching` word to a warm run (checked in the transcript above). `detail` becomes the tail of verbose stderr, which is noisier. That is acceptable, because it is diagnostic only.
7. **The gate asserts the pin only where it is consumed.** In `packages/runner/itest/al-runner.itest.ts`, the R147 `platformAppsDir` block moves out of `assertVerdictTable`, which runs on all four legs, into a helper that only the two one-shot legs (`first`, `second`) call. The server and resource legs keep their per-mutant equality checks and assert nothing about the pin. A comment there says why: `--server` never receives the pin, so asserting it there would check a value that was recorded but not used.

Files: `packages/runner/src/al-runner-transport.ts`, `packages/runner/src/al-runner-backend.ts`, `packages/runner/tests/al-runner-platform-apps.test.ts`, `packages/runner/itest/al-runner.itest.ts`. Nothing in the report changes (`basis` is internal), so there is no schema ripple.

## Steps

- [ ] **0. Precondition.** C02-04 is merged, so `docs/roadmap/R235.md` exists on master. If it does not, stop and ask the coordinator. File nothing for R235.
- [ ] **1. Tests first (red).** Add a `describe("R235: ...")` block to `al-runner-platform-apps.test.ts` with these fixtures. They are verbatim from the transcripts, with the home prefix shortened to `C:\x\` but the MIXED separators kept:

  ```ts
  const V211_SELECTED = String.raw`[bc] selected BC 28.1.49838.54487 (C:\x\.local/share/al-runner/artifacts\28.1.49838.54487)`;
  const V211_ENGINE = String.raw`[provision] BC 28.1.49838.54487 engine artifacts already complete at C:\x\.local/share/al-runner/artifacts\28.1.49838.54487.`;
  const V211_PKG_TEST = String.raw`    [pkg-cache] C:\x\.local/share/al-runner/artifacts\28.1.49838.54487\test-apps`;
  const V211_PKG_PLATFORM = String.raw`    [pkg-cache] C:\x\.local/share/al-runner/artifacts\28.1.49838.54368\platform-apps`;
  const V211_DOWNLOADED = String.raw`[provision] Downloaded 6 app(s) (116 MB total) to C:\x\artroot\28.1.49838.55191\platform-apps`;
  ```

  The spy spawn helper records `opts.env` beside the argv, so the env test can read it.

  Tests (Review Focus cites these names), each with its predicted state BEFORE the fix:
  - `R235: a warm 2.11 run pins the [pkg-cache] platform-apps dir, not the [bc] selected derivation`. The whole warm verbose block (engine line, selected, both pkg-cache lines) gives `{ kind: "found", dir: ...54368\platform-apps, appCount: 0, basis: "package-cache" }`. **RED**: today it derives `...54487\platform-apps` with basis `selected-artifact`.
  - `R235: a [pkg-cache] line that disagrees with a provisioning sentence conflicts`. `V211_DOWNLOADED` plus `V211_PKG_PLATFORM` (a different build) gives `conflicting` naming both directories. **RED**: today the `[pkg-cache]` line is unread, so it returns `found` on the `Downloaded` directory.
  - `R235: provisionOnce sets AL_RUNNER_VERBOSE=1 and a mutant run does not`. The spy's env on `provisionOnce` has `AL_RUNNER_VERBOSE: "1"`. On `run()` after `usePlatformAppsDir`, the env has no such key and the argv has no `--verbose`. **RED** on the first half.
  - `R235: the backend refuses an empty [pkg-cache] directory, naming it`. The refusal contains `[pkg-cache]` and `R235`. **RED**: today it refuses with the R200 wording instead.
  - `R235: the test-apps [pkg-cache] line and the 2.11 engine line are NOT pinned`. Each alone gives `no-completion-line`. **GREEN before and after**: a regression guard, not evidence of the fix.
  - `R235: a v2.11 line that is not the runner's own does not pin`. A failure text containing `[pkg-cache] C:\...\platform-apps` mid-line gives `no-completion-line`. **GREEN before and after**: a guard.
  - `R235: a cold 2.11 run keeps the counted basis when Downloaded and [pkg-cache] agree`. `V211_DOWNLOADED` plus a `[pkg-cache]` line naming the same directory gives `basis: "downloaded"`, `appCount: 6`. **GREEN before and after**: the existing `Downloaded` regex already produces this. It guards that the new scan does not demote a counted basis. It is NOT evidence that the new scan works.

  Run `bun test packages/runner/tests/al-runner-platform-apps.test.ts`. Exactly the four RED tests must fail and the three GREEN guards must pass. If any other pattern shows up, the prediction is wrong: stop and find out why before implementing.
- [ ] **2. Implement** the seven points under "The fix". Keep every existing test green without editing it: the R147 cold sentence, the 2.7 warm sentence, the 2.7 engine and toolkit siblings, and the R200 derivation tests are the proof that old versions keep matching.
- [ ] **3. Loop.** `bun run typecheck`, `rm -rf packages/*/dist`, `bun test`, `bunx biome check` on the four touched files.
- [ ] **4. Red-check** with the `mutation-red-checker` subagent, one revert at a time, and report red, then restored green:
  - drop the `[pkg-cache]` scan: `...pins the [pkg-cache] platform-apps dir...` and `...disagrees with a provisioning sentence conflicts` go red;
  - drop `AL_RUNNER_VERBOSE` from `provisionOnce`: `...provisionOnce sets AL_RUNNER_VERBOSE=1...` goes red;
  - loosen the regex to accept any `[pkg-cache]` path: `...test-apps [pkg-cache] line ... NOT pinned` goes red, and the whole-block warm test turns `conflicting`;
  - drop the `^[ \t]*` anchor: `...not the runner's own does not pin` goes red.

  The cold "agree" test is NOT a red-check target: no revert of this fix turns it red.
- [ ] **5. Sweep the prose** (CLAUDE.md: "When al-runner moves, sweep the prose, not only the code"). Run `grep -rn "al-runner" README.md docs/*.md fixtures/README.md .claude/skills` and read each hit. Known edits:
  - `CLAUDE.md` `itest:alrunner` paragraph: after the 2.7.0 sentence pair, add one sentence. On a warm cache 2.10 and 2.11 print no provisioning sentence. 2.11 searches the engine variant's build for platform apps, and names that directory only in the verbose `[pkg-cache]` line, which `provisionOnce` now requests through `AL_RUNNER_VERBOSE=1`. Say also that the pin is consumed by the one-shot legs only, and that the `--server` and resource legs do not receive it. Record "measured against v2.11.0, 2026-09-26, PASS, 19 verdicts identical" only after step 6 passes.
  - `docs/measurements/README.md` §"al-runner v2": a 2.11.0 entry with the verbatim lines above, including the search-set caveat. This also pays R200's "still owed" note (2.10's silence).
  - The R200 comment inside `parseAlRunnerPlatformAppsDir` ("both provisioning sentences ever measured put the platform apps at `<that>/platform-apps`"): now false for a mixed cache. Say so and point at R235.
  - `.claude/skills/live-gate/SKILL.md` still says al-runner is 3 / 16 / 0. That is stale against CLAUDE.md's 3 / 12 / 4 (R220). Fix the figure in the same sweep.
- [ ] **6. Live proof.** Foreground, one run:

  ```
  LETHAL_ITEST_ALRUNNER=1 LETHAL_ALRUNNER_PATH="C:/Users/SShadowS/.dotnet/tools/al-runner.exe" bun run itest:alrunner
  ```

  PASS means all of the following:
  - The first line reads `al-runner v2.11.0`. If it names another build, stop and re-measure before comparing.
  - All four legs (one-shot, the relabelling rerun, `--server`, `selectorMode: "resource"`) are at 3 / 12 / 4, with per-mutant verdicts equal to `al-runner.baseline.json`. This per-mutant equality is the ONLY verdict evidence for the change.
  - The two one-shot legs print `platform apps pinned at: ...\28.1.49838.54368\platform-apps`, or whichever build the variant names that day (the gate asserts only the `platform-apps` suffix), and emit no `al-runner-platform-apps-unpinned` warning.
  - The server and resource legs are NOT asserted on the pin, because they never consume it.

  A differing verdict is a BLOCK.
- [ ] **7. Close R235:** set `status: "done (<commit>)"` and regenerate the index. The row states that the pin engages on the one-shot path only.

## Review Focus

1. **A warm 2.11 run pins the directory the runner reports searching, not a derived path.** `R235: a warm 2.11 run pins the [pkg-cache] platform-apps dir, not the [bc] selected derivation`.
2. **Disagreement refuses rather than picks.** `R235: a [pkg-cache] line that disagrees with a provisioning sentence conflicts`.
3. **Only the provisioning call changes, and it changes through the environment, not the argv.** `R235: provisionOnce sets AL_RUNNER_VERBOSE=1 and a mutant run does not`, plus the existing `CONTROL: with no pin the argv is exactly what it was before R147`.
4. **Sibling lines stay non-matches**, including the 2.11 engine sentence with mixed separators and the `test-apps` cache line. `R235: the test-apps [pkg-cache] line and the 2.11 engine line are NOT pinned`, plus the existing `the ENGINE 'already complete' line is NOT pinned` and `the test-toolkit line is NOT pinned`.
5. **An empty searched directory is refused by name.** `R235: the backend refuses an empty [pkg-cache] directory, naming it`.

## Out of scope

- **Wiring the pin into `--server` mode.** The daemon starts with `cfg.packagesDir` only, so the server and resource legs never send the pin and keep al-runner's own resolution. This task does not change that. The gate stops asserting the pin on those legs rather than asserting a value they do not use. The report's `executionContexts[].platformAppsDir` on a server-mode session still records what provisioning found, although nothing consumed it. That is misleading on its own terms and worth its own roadmap item.
- **Proving that the pin leaves resolution unchanged for other projects.** `[pkg-cache]` is a search set, and a pin that exists but holds a mismatched build is not shown to be harmless. This task claims only this fixture's per-mutant equality.
- **A truly empty cache fails on 2.11.0** (exit 2: the CDN's latest 28.x, `28.5.54151.55147`, has no shipped engine variant). Every mutant would score `error`, which is R125's class. It does not affect this gate, because the cache is warm. It needs `--bc-version` or an upstream fix. File it as its own roadmap item (next free id; re-check `ls docs/roadmap/` first). Do not fix it here.
- Switching `provisionOnce` to the `provision` subcommand (R207).
- `--country` runs, whose platform apps live in `platform-apps-<code>`. LethAL sends no `--country`. The suffix rule would not match those directories, which is the safe direction (no pin).
- Pinning or downgrading al-runner. CLAUDE.md forbids it (R125).
- R123, the per-session contract probe that would catch the next rewording before the gate does.

## Submit note

R235: on al-runner v2.11.0 the warm provisioning call prints no `[provision]` sentence. R200's `<selected>\platform-apps` derivation then names a directory that does not exist, because 2.11 searches the engine variant's build (`28.1.49838.54368`, with `28.1.49838.54487` selected). The runner names that directory only in verbose output, as a `[pkg-cache]` search-set line. `provisionOnce` now sets `AL_RUNNER_VERBOSE=1` (an environment variable, so an older binary ignores it), and `parseAlRunnerPlatformAppsDir` reads that line (basis `package-cache`) before falling back to R200. The cold `Downloaded` and 2.7 `already complete` sentences still pin. The engine and toolkit lines still do not. The per-mutant argv and environment are unchanged. The pin is consumed by the one-shot path only, and the gate now asserts it only on the one-shot legs. `--server` never receives it, and that is left as is. Red-checked four ways. `itest:alrunner` on v2.11.0: PASS, four legs 3 / 12 / 4, per-mutant identical, which is the verdict evidence. Separately found: an empty cache fails on 2.11.0 before provisioning platform apps. Filed as R<next>, not fixed.

## Changelog

- **r2 (2026-09-26), answering review r1:**
  1. The pin claim is narrowed to the one-shot legs. `--server` never receives it, and wiring it there is out of scope. The gate asserts the pin on the two one-shot legs only (fix point 7).
  2. `[pkg-cache]` is described as a search set, not resolution. The "a wrong pin can only error" argument is no longer extended to a directory that exists but holds a mismatched build. Per-mutant equality is named as the only verdict evidence.
  3. The cold "agree" test is marked GREEN before and after, as a guard, and dropped from the red-check. The warm-different-build, disagreement, env and empty-directory tests are the four predicted RED.
  4. `provisionOnce` uses `AL_RUNNER_VERBOSE=1` instead of `--verbose`. The measurement quote records that the `[pkg-cache]` lines were captured with the variable.
  5. Step 0 no longer copies R235.md. The task starts after C02-04 is merged, and only flips R235's status.
- **r1 (2026-09-26):** first draft.
