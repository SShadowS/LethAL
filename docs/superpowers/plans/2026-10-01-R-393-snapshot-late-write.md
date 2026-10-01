# R-393: a timed-out test must not write a snapshot under the next test's name (short plan, r2)

Task: `H:/lethal-coord/tasks/R-393/task.md`. Item: `docs/roadmap/R393.md`. r1 review:
`H:/lethal-coord/reviews/R-393-plan/review-r1.md` (all six findings accepted). Measurements, bun 1.3.14 on
this machine: `H:/lethal-scratch/R-393/research.md` and `H:/lethal-scratch/R-393/r2/measure.md`.

## What was measured
- **Which tests use snapshots:** four files (`orchestrator`, `resume`, `report-equality`, `compile` tests). The slowest takes 53 ms, and all use bun's
  default 5000 ms timeout. A larger timeout only narrows the window, so it is not the fix.
- **The bug:** reproduced. A timed-out test keeps running, and its late `toMatchSnapshot` is written under the next test's
  key. bun reports "+1 added", and nothing fails.
- **`CI=true` set at launch (G3): stops it.** A's late call throws `Snapshot creation is disabled in CI
  environments unless --update-snapshots is used`, naming B's key `"B no snapshot, 2s 1"`. Nothing is written.
- **`CI` set in the preload (G1): does NOT stop it.** bun reads CI once, before the preload runs, so
  the late write still lands. The preload therefore cannot be the guard (r1 finding 1, confirmed).
- **`.env.test` with `CI=true` (G2): not measured.** A safety hook blocks agents from writing `.env*` files.
- **Existing entry (G4):** a different late value fails as a mismatch with or without CI, and an
  identical late value passes silently. That second case is undetectable but harmless, because the
  file does not change. So the guard stops CREATION only (r1 finding 2, corrected).
- **`--update-snapshots` with CI=true (G5):** it still writes. That is the opt-in path.
- **CI side effects (G6): none.** No repo code or direct dependency (biome, tsc, tree-sitter) reads
  CI, NO_COLOR, FORCE_COLOR or isTTY; Stryker does, but outside `bun test`. The 61 spawn sites mostly
  inherit the env, and the al-runner ones pass `alRunnerEnv` explicitly. The full suite gave 5187/7/0 identically
  with CI unset, CI=true, and CI unset again.
- **Discovery (G7):** bun discovers `*.test.ts` under `fixtures/`. A file with a non-`.test` name stays inert,
  but bun will not run it either, so the fixture must be copied to a `*.test.ts` name in a temp folder.

## The fix
1. **`scripts/verify.ts` runs its `bun test` child with `CI=true`** (the env is set before bun starts, which is what
   works), plus `LETHAL_TEST_ALLOW_SNAPSHOT_CREATE=1` as an explicit opt-out that drops it. This is the root guard
   for every verify.ts run, covering all snapshot tests now and later.
2. **The belt: verify.ts refuses a run that changed snapshots.** It checks tracked `.snap` files that are
   staged or unstaged, and new untracked `.snap` files, with `git status --porcelain -- '*.snap'` taken before and after
   the run. It reports only files that changed DURING the run, so an intended edit made earlier is not blamed. It
   names the files and says how to add a snapshot on purpose (`bun test --update-snapshots <file>`). Documented
   as protection for verify.ts users only.
3. **A plain `bun test` is NOT protected by this plan,** unless `.env.test` (`CI=true`) works. That is the
   only pre-start route left. **Ask:** may I create and measure `.env.test`? The hook blocks it, so it needs
   the owner's permission or someone else to run it. If it works, commit it and say so in R393. If not, ask that
   CLAUDE.md's build loop name `bun scripts/verify.ts` (or `CI=true bun test`) as the safe form.

## Red-checks (each on a REAL late write)
- **A committed test, `scripts/snapshot-late-write.test.ts`,** copies the inert fixture
  `scripts/fixtures/r393/late-write.fixture.ts` into a temp folder as `late.test.ts`, then spawns `bun test --timeout 200`
  there, with an A test that sleeps 400 ms and a B test. It asserts:
  - with `CI=true`: A's late-call marker; the timeout; bun's exact refusal naming B's key; and no `.snap` entry for B;
  - the control, with CI unset: the wrong entry under B's key DOES appear, which proves the case is real;
  - an existing-entry control: B's key is pre-seeded with a different value, and the run fails as a mismatch.
  The test runs in about 1 s.
- **Revert verify.ts's `CI=true`:** a verify.ts test, which drives the child through a stub runner and checks the child
  env, goes red.
- **Revert the belt:** a verify.ts test with a dirty `.snap` (staged, unstaged and new) goes red.
- No existing snapshot or expectation is changed.

## Out of scope
Timeouts; R375 (the EBUSY cleanup failures).

## Done when
Steps 1 and 2 have landed with their red-checks and verify.ts is green. Step 3 is either done or recorded, with the
CLAUDE.md line passed to the orchestrator. R393 is then closed, or narrowed to "plain `bun test` unprotected" if `.env.test` fails.
