# R-393: a timed-out test must not write a snapshot under the next test's name (short plan)

Task: `H:/lethal-coord/tasks/R-393/task.md`. Item: `docs/roadmap/R393.md`. Research, measured on this
machine with bun 1.3.14: `H:/lethal-scratch/R-393/research.md` (repro in `.../repro/`).

## What was measured
- **Which tests use snapshots:** four files, all with `toMatchSnapshot` and none with inline snapshots:
  `orchestrator.test.ts` (14 tests), `resume.test.ts` (1), `report-equality.test.ts` (1) and
  `compile.test.ts` (1 test, 6 calls). The slowest takes 53 ms; all use the default 5000 ms
  timeout. So the R393 timeouts were a stall of about 100 times normal under load. A larger
  timeout only narrows the window; it is not the root fix.
- **The bug reproduces.** Test A times out, its body keeps running, and its late `toMatchSnapshot` is
  written under test B's name. bun reports "+1 added", and a re-run passes. Nothing fails.
- **`CI=true` stops it at the root.** With `CI=true` or `CI=1`, bun refuses to CREATE a snapshot
  ("Snapshot creation is disabled in CI environments unless --update-snapshots"), and the run
  fails. A late write under another test's name is always a creation, so it is refused. A late
  write under a name that already has an entry is compared and fails. `--ci` is not a bun flag, and
  `[test] timeout` in bunfig.toml is ignored in 1.3.14.
- **A preload cannot see the write.** bun writes the `.snap` after the file's last `afterAll`,
  and `process.on("exit")` does not fire under `bun test`.
- **No wrong-name entries exist today.** All four committed `.snap` files map entry for entry to
  real `toMatchSnapshot` calls, on master and on this branch. The `orchestrator.test.ts.snap`
  rewrite seen on the R-214 trial merge was the same late-write effect and was not committed.

## The fix (two layers)
1. **Root: no snapshot is ever created by a plain `bun test`.** `scripts/test-preload.ts` sets
   `process.env.CI = "true"` unless `LETHAL_TEST_ALLOW_SNAPSHOT_CREATE=1` is set, with a comment
   naming R393. Adding a snapshot on purpose then means `bun test --update-snapshots <file>`,
   which CLAUDE.md already uses for report-equality. This covers every snapshot test, now and
   later, and a bare `bun test`, because bunfig.toml's preload applies to every `bun test`.
   **Gating measurement (Step 1):** confirm that bun reads `CI` when it writes a snapshot, not
   only at startup, by setting it in the repro's preload. If bun reads it only at startup, use
   bunfig.toml instead: `[test]` env, if bun supports it (measure that too). If neither works,
   report it and rely on layer 2 alone. Also grep for code that reads `CI` and might change
   behaviour; none found at plan time.
2. **Belt: `scripts/verify.ts` refuses a run that modified a tracked snapshot.** After `bun test`,
   run `git diff --exit-code --stat -- '*.snap'` (plus untracked new `.snap` files). On any
   difference it fails, naming the files, and prints how to add a snapshot on purpose. This
   catches whatever the env layer misses (for example a run started with `CI` cleared).

## Red-checks (the guard must fire on a REAL late write)
- **A committed reproduction test:** `scripts/snapshot-late-write.test.ts` spawns `bun test` on a
  committed fixture under `scripts/fixtures/r393/`. It holds the repro's A/B pair, with
  `--timeout 200` and a 400 ms sleep, so the whole check takes about 1 s. With the preload, the
  spawned run must FAIL with the snapshot-creation refusal and leave no new `.snap` file. With
  `LETHAL_TEST_ALLOW_SNAPSHOT_CREATE=1` (the control), the late write must happen, under B's name.
  The test reads that file to prove it.
- **Revert layer 1:** the reproduction test goes red, because the snapshot is written.
- **Revert layer 2:** a verify.ts unit test, which feeds the check a dirty `.snap`, goes red.
- No existing snapshot or expectation is changed or deleted.

## Out of scope
Raising timeouts (not needed at 53 ms). The R375 EBUSY cleanup, a different symptom of the same load.

## Done when
Both layers have landed with their red-checks; `scripts/verify.ts` is green; R393 is closed with the
commit; and CLAUDE.md's build loop gets one line on `--update-snapshots`, for the orchestrator,
since lanes cannot edit CLAUDE.md.
