# R-553 (+ R552): plan r2

Branch `lethal/r553` from master `08ec410e`, worktree `/work/lethal-wt/r553`. Measurements are in
`measure.md` and the predictions in `precommitment.md` (r2). Commit the pre-commitment first, as a
specs-only `[skip ci]` commit, before any live run.

## Changes from r1 (Opus review `review-plan-opus.md`, all findings accepted, with the coordinator's rulings)

- **C1:** Prediction 1 is leg A only (`ar-A.config.json`, coverage off), compared with `ar-A.report.json`
  (51 killed / 12 survived / 0 no-coverage). ar-B is removed: it differs from A on M0031–M0034.
- **I1:** R552's live evidence now has two steps (offline `compile-only.ts`; `itest:bcdev` with the
  stale symbol moved aside). The cache is compared by name, size, sha256 and mtimeMs. There is a new
  unit test with a pre-existing stale file.
- **I2:** the "drop `^`" red-check is replaced by a direct
  `screenMessageOf(wrapped, "al-runner") === killMessageOf(wrapped)` assertion, which does go red.
- **I3:** `unprefixed` (which picks the backend note) is computed over `verdict === "killed"` only, so
  a timeout kill cannot trigger it. There is a some-vs-every test.
- **I4:** the separator guard refuses `;` AND `,` in either path, with `ArtifactPrepareError` (never
  `AlcCompileError`).
- **I5:** the preconditions are pinned in the pre-commitment (numberingDigest, identityScheme 36,
  corpus fingerprint, and the three mutants named by identity), plus `backend` and the standard
  `partial` note.
- **I6:** one warning when a leftover `lethal-control.app` sits in the configured cache. It is never
  deleted or overwritten. Stated in R552.
- **Minor:**
  - a strip-once test;
  - `stageForCompile`'s body is wrapped so that a throw after the staged copy exists still cleans up
    (r1 wrongly claimed the existing `finally` covered it);
  - Windows alc is recorded as unmeasured, in R552;
  - Prediction 2 separates the gates that are run from the gates argued from source;
  - the prose files are listed;
  - the `buildReport` replay is done, and it agrees.

## R553: the assertion screen reads past al-runner's exception-type prefix

### Design

**`packages/runner/src/assertion-screen.ts`** gains new code and changes nothing that already exists:

```ts
/** R553: al-runner writes every failure as `{Type.Name}: {Message}` (R101(f)). One anchored .NET
 *  type name ending in `Exception`, optional namespace, then `: `. Stripped ONCE. */
export const AL_RUNNER_EXCEPTION_PREFIX = /^(?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*Exception: /;

/** The text R121's rule reads. bcdev: `killMessageOf`, unchanged. al-runner: minus the prefix. */
export function screenMessageOf(failure: string | undefined, backend: "bcdev" | "al-runner"): string {
  const m = killMessageOf(failure);
  return backend === "al-runner" ? m.replace(AL_RUNNER_EXCEPTION_PREFIX, "") : m;
}

export const ASSERTION_SCREEN_VACUOUS_AL_RUNNER_NOTE = "...";  // text below
```

- `killMessageOf`, `looksLikeAssertionFailure` and `looksLikeRunnerRefusal` stay byte-identical. So
  `scripts/r121-classify-eval.ts`, the 73-kill corpus test and `verify.ts` (bcdev-only) do not move.
- The module comment's "the rule's behaviour there is unmeasured" is updated with the R546/R553 result.

**`packages/runner/src/report.ts`**, in `buildReport`:

- Compute `const backend = input.caps.authoritative ? "bcdev" : "al-runner";` once, and reuse it at
  the existing `backend:` field.
- The two R121 predicates read `screenMessageOf(m.killingTestFailure, backend)`.
- Compute `unprefixed`:
  ```ts
  const unprefixed = backend === "al-runner" && killsWithText.some((m) =>
    m.verdict === "killed" &&
    !AL_RUNNER_EXCEPTION_PREFIX.test(killMessageOf(m.killingTestFailure)))
  ```
  (I3: `timeout-killed` texts are excluded.)
- Choose the note:
  ```ts
  discriminationNote: discrimination === "vacuous" && unprefixed
    ? ASSERTION_SCREEN_VACUOUS_AL_RUNNER_NOTE
    : ASSERTION_SCREEN_DISCRIMINATION_NOTES[discrimination]
  ```

Nothing writes to the outcome, to the store, or to `mutants[].killingTestFailure`.

**Why the key is the session's backend.**
- `MutantOutcome.runner` cannot serve: it is `fenced` or `client-services`, and reads `fenced` on both
  backends.
- Resume refuses to mix backends, so one key per session is sound.
- A bcdev text can contain a .NET type name (`verify.ts` looks for `NavNCLAssertErrorException` in
  bcdev texts), so a key based on the text could touch bcdev.

**The new note.** It is chosen on al-runner, when the result is vacuous, and when at least one KILLED
kill's text lacked the prefix:

> "EVERY kill carrying failure text was flagged, so this screen separated nothing on this run. The run
> used al-runner, and at least one kill's text did not start with the `<Type>Exception: ` prefix
> al-runner normally writes, so the rule read text in a shape it was not measured on. The backend, not
> only the suite's assertion style, may be the cause: run the same slice on bcdev before reading
> anything into the count."

When every killed text carried the prefix and the result is still vacuous, the suite has no `Assert.`
text, so the existing note is correct and stays.

**Not done (YAGNI):**
- no count field for stripped prefixes (it would ripple through events, the fold, the schemas and every
  sample report);
- `NavNCLAssertErrorException` (a failed `asserterror`) is not counted as an assertion on either
  backend, as today.

### Ripple

- No new `SessionReport` field and no new `Caveat`. So no `generate-schemas`, no `schemas.test.ts`
  change, and no regeneration of the sample reports.
- The `report-equality` snapshot holds one bcdev `no-text` screen, so it does not change. Check that
  `bun scripts/verify.ts` leaves every `.snap` unchanged.
- Docs:
  - `docs/roadmap/R553.md`: status `done (<commit>)`, and correct "once" to "3 kills" for
    `NavCSideDuplicateKeyException`;
  - one line in R121's "A limitation this row did not record";
  - regenerate `ROADMAP.md`;
  - run `bun test scripts/line-citations.test.ts`.

### Tests (`packages/runner/tests/assertion-screen.test.ts`): a red test for each direction

Add `AL_RUNNER_CAPS = { ...CAPS, coverage: "none", authoritative: false }` and a `caps` parameter to
`build`. All texts are synthetic.

1. **A prefixed assertion is now read.**
   - Input (al-runner): `M0001` = `NavNCLDialogException: Assert.AreEqual failed. ...`, `M0002` =
     `NavNCLDialogException: expected 2 rows, got 5`.
   - Expected: flagged `["0/M0002"]`, `partial`.
   - RED-CHECK: make `screenMessageOf` return `killMessageOf(...)` alone. The result becomes 2 flagged,
     `vacuous`.
2. **A prefixed non-assertion is still flagged.**
   - `NavCSideDuplicateKeyException: The record already exists.`, beside a prefixed `Assert.` kill: the
     duplicate-key kill is flagged. RED-CHECK: treat any prefixed text as an assertion. It unflags.
   - Not at the start: `screenMessageOf(wrapped, "al-runner") === killMessageOf(wrapped)` for the R534
     wrapped shape `An OnBeforeTestMethodRun subscriber (codeunit 50100) failed, so the test did not
     run: NavNCLDialogException: Assert.IsTrue failed.` (I2). RED-CHECK: drop the `^`. The equality
     fails, because the inner prefix is removed.
   - Not an `...Exception` name: `Total: Assert.AreEqual failed.` stays flagged. RED-CHECK: drop
     `Exception` from the regex. It unflags.
   - **Strip once:** `XException: YException: Assert.AreEqual failed.` stays flagged. RED-CHECK: use a
     global or repeated strip. It unflags.
3. **bcdev text is unchanged.**
   - With bcdev caps, `NavNCLDialogException: Assert.AreEqual failed.` IS flagged.
   - Direct check: `screenMessageOf(x, "bcdev") === killMessageOf(x)`.
   - RED-CHECK: strip on every backend. It unflags.
4. **The stored text is unchanged.**
   - In test 1's al-runner build, `r.mutants[i].killingTestFailure` equals the input string exactly,
     prefix and callstack included.
   - RED-CHECK: write the stripped text back into the outcome. The test fails.
   - The existing corpus test (23 of 73, 6/23) stays green, unchanged.
5. **The note names the backend, and only when it should.**
   - (a) al-runner, killed kills with no prefix and bare text: `vacuous`, and the note contains
     `al-runner`.
   - (b) al-runner, every killed kill prefixed with bare `Error` text: `vacuous`, and the note equals
     `ASSERTION_SCREEN_DISCRIMINATION_NOTES.vacuous`.
   - (c) bcdev, same texts as (a): the standard note.
   - (d) I3, some-vs-every: al-runner, killed kills all prefixed, plus one `timeout-killed` kill with
     `Test exceeded 5s timeout.`: `vacuous`, with the standard note.
   - (e) al-runner, one killed kill unprefixed among prefixed ones, all bare text: the al-runner note.
     This shows `some` and not `every`.
   - RED-CHECKS:
     - always use the al-runner note on al-runner: (b) and (d) fail;
     - never use it: (a) and (e) fail;
     - use it on any vacuous run: (c) fails;
     - drop the `killed` filter: (d) fails;
     - use `every` instead of `some`: (e) fails.
6. The existing `runnerRefusals` test, re-run under al-runner caps with
   `InvalidOperationException: out-of-scope: ...`: still counted.

Each red-check reverts only that one piece with the Edit tool, shows the named test red, restores it,
and shows it green (`mutation-red-checker`; never `sed -i`).

## R552: the control symbol no longer lands in the user's `packageCachePath`

### Choice: an extra cache path owned by LethAL, inside the staged copy

Measured (`measure.md` section 4, Linux alc): alc takes a list split on `;` or `,`, accepts the same
package in two paths, and picks the highest version whatever the order.

- **Where the symbol goes.** `lethal-control.app` is staged into `join(staging, ".lethal-symbols")`,
  where `staging` is the `${instrumentedDir}-staged` copy. `deploy()` and `compileCheck()` already
  `rm` that whole directory in a `finally`.
- **Throw-after-copy leak.** The leak predates this change. Wrap `stageForCompile`'s body after the
  `cp` of the project in `try { ... } catch (e) { await rm(staging, ...).catch(() => {}); throw e; }`.
  That is about four lines. If it turns out to be bigger, record it in R552 instead.
- **The user's cache.**
  - The `cp` into `this.cfg.packageCachePath` is removed. The `mkdir` stays (smallest change).
  - If `join(packageCachePath, "lethal-control.app")` exists, `console.warn` ONCE per backend
    instance (the backend's existing idiom). The warning names the file as a LethAL leftover, safe to
    delete, and says the compile now uses its own copy.
  - The leftover is never deleted or overwritten.
- **Compiler input.**
  - `CompileInput` gains `readonly extraPackageCachePath?: string` (set with the conditional spread).
  - `ArtifactCompiler.compile` sends `/packagecachepath:<cfg.packageCachePath>;<extra>`.
  - `compileProject` is unchanged and sends one path.
- **Fail loudly (I4).** If either path contains `;` or `,`, throw `ArtifactPrepareError` before any
  spawn. alc would split such a path silently.

**Why not delete the file after the compile:**
- two sessions sharing one cache would race;
- a user's own copy would be deleted;
- a killed process would still leave the file.

**Residual risk, stated in R552.** A leftover stays until the user deletes it (the warning says so).
alc takes the higher of the two versions, so an older leftover loses. A NEWER one in the user's cache
would win over `controlSymbolPath`. The selector uses only `LC Control State`, and the harness verifier
checks the server's control version before every deploy. The Windows host's alc (18.0.2668733) was
NOT measured with a two-path list; that is recorded in R552.

### Other paths

- **`scripts/campaign/compile-only.ts`** has the same `cp` into `--package-cache`.
  - Stage into `join(target, ".lethal-symbols")` instead. `target` is its own `mkdtemp`, removed in its
    `finally`.
  - Pass `extraPackageCachePath`, and print the same leftover warning.
  - In `compile-only-args.ts`, only the doc comment changes; the flags are unchanged.
- **`compileTestApp`** already uses its own temp cache: unchanged.
- **`compilePlainCheck`** never staged the symbol: unchanged. Its existing test (a single
  `/packagecachepath:`, no `lethal-control.app`) stays green.
- **The deployment verifier** reads the server, not the cache: unaffected. **al-runner:** unaffected.
- **Prose to update:**
  - `fixtures/README.md` (the staging sentence near "with the `LethAL Control` dependency injected");
  - `docs/do-trial-runbook.md` (`packageCachePath` no longer needs to hold `lethal-control.app`);
  - `.claude/skills/al-compile/SKILL.md` (the staging line);
  - the `bcdev-backend.ts` comments at `controlSymbolPath`, `packageCachePath` and `stageForCompile`.

### Tests (`bcdev-backend.test.ts`, `artifact.test.ts`): both ways

1. **Does not persist.**
   - Rewrite the assertion that currently reads `join(packageCachePath, "lethal-control.app")`.
   - Record the listing of `packageCachePath` before and after: name, size, sha256 and mtimeMs.
   - Expect it unchanged after `deploy()`, after a `compile()` that throws, and after `compileCheck()`.
   - RED-CHECK: restore the `cp` into `packageCachePath`. The test fails.
2. **A pre-existing stale file is untouched (I1).**
   - Pre-create `packageCachePath/lethal-control.app` with bytes different from `controlSymbolPath`,
     and set its mtime to a fixed past time.
   - After `deploy()`, its bytes and mtimeMs are unchanged, and exactly one warning names it.
   - RED-CHECK: restore the `cp`. Bytes and mtime change.
   - Second RED-CHECK: delete the leftover. The file is gone.
3. **The compile still sees the symbol.**
   - Use the real `ArtifactCompiler` with a fake `spawn`.
   - At spawn time there is exactly one `/packagecachepath:`, whose list split on `;` is
     `[packageCachePath, <dir>]`, and `<dir>` holds bytes equal to `controlSymbolPath`'s.
   - After `deploy()`, `<dir>` is gone.
   - RED-CHECKS: drop the new `cp`; drop `extraPackageCachePath`. Each fails.
4. **A throw inside `stageForCompile` after the copy** (for example an unreadable `app.json`) leaves no
   `-staged` directory. RED-CHECK: remove the wrap. The directory remains.
5. **`ArtifactCompiler` unit test.**
   - Without the extra path, the argv sends `/packagecachepath:A`, byte-identical to today.
   - With it, `A;B`.
   - A `;` or `,` in either path throws `ArtifactPrepareError` with a spawn count of 0.

## Build loop, review, CI

- `bun run typecheck`, then `rm -rf packages/*/dist`, then `bun scripts/verify.ts`, then
  `bunx biome check <touched>`.
- Rerun `scratchpad/r553/eval.ts` and `replay.ts` importing the SHIPPED `screenMessageOf` and
  `buildReport`. Expect ar-A to give M0044, M0045, M0051 `partial` with the standard note, and bc-A
  and bc-B unchanged.
- An Opus review of the built diff.
- CI: both jobs green.

## Live plan

1. **`itest:alrunner`**, run in the foreground. Every frozen figure and per-mutant table is unchanged.
2. **The R546 slice on al-runner: leg A only, no lease, about 1 h** (R546's leg A took 3803 s).
   - Same as leg A of `scratchpad/r546/ar-legs.sh`: run `gate.sh` first, then the same flags and
     `ar-A.config.json`, `timeout 6922`, and the copied build `scratchpad/r546/alr/`
     (`v2.12.0-main.43f76177`).
   - Use a fresh `--db`, `--out` and `--progress-out` under `scratchpad/r553/`, and run from the r553
     worktree.
   - This is a corpus job: the lane schedules it.
3. **R552 step 1, offline.**
   - Run `bun scripts/campaign/compile-only.ts` with Linux alc on `fixtures/sandbox-app`, against a
     scratch COPY of its `.alpackages` with every LethAL Control package removed. The copy is made with
     Bash into scratch; nothing is copied into the repo.
   - Expected: it compiles, and the copy's listing (name, size, sha256, mtimeMs) is identical
     afterwards.
4. **R552 step 2, `itest:bcdev` under a Cronus28 lease.**
   - Before the run, move `fixtures/sandbox-app/.alpackages/lethal-control.app` (1.0.0.19) to
     `scratchpad/r553/`, and record the move: sha256, and the time it was moved and restored.
   - Take the cache listing before and after the run.
   - Expected: identical listing, no new file, and the frozen 3/12/4 per mutant.
   - Restore the file after the run.
