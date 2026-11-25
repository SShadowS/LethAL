# PR-414 (R1208): the update script runs the gated-builds file's reader tests before it pushes a row

## The problem
`scripts/al-runner-v3-update.ts` `publishToMaster` adds a row to `packages/runner/src/al-runner-v3-gated-builds.json` and
pushes it to master as `[skip ci]`, after checking only `parseGatedBuilds` and the pin digests. Unit tests read that file.
edge-e5176a9fd's row (f8185a042) was the first to read `stop-groups: matches`, and it turned master red (PR-256's pin)
unseen until the next VERIFY of a merge.

## The change
1. **The rule** (`scripts/gated-builds-readers.ts`), not a hand list:
   - start from the top-level declarations of the READER MODULES (`al-runner-v3-pins.ts`, which imports the file, and
     `al-runner-v3-pin.ts`) that name the file;
   - add each declaration of those modules that names one already found, until nothing grows;
   - a reader test is a test file (`packages/*/tests`, `packages/*/itest`, `scripts`) that names a reader.
   - Measured on master 53f80bb82: 13 readers and 15 test files, holding the three R1208 names
     (`pr256-stop-groups`, `pr402-login-replay`, `r814-gated-builds`).
   - An empty answer throws.
2. **Why bounded.** Followed through every module, the closure reaches all 625 test files, which is the whole suite. The
   bound is held by a guard: a test refuses any module outside the reader modules that imports the file.
3. **`publishToMaster`** takes a REQUIRED `readerTestsOf`.
   - It runs after the new rows are written and staged, and before the commit.
   - A failure throws `GatedBuildsReaderTestsError` (extends `Error` directly), naming the row ids and the failing output.
     Nothing is committed or pushed, and there is no retry.
   - The real one, `masterReaderTests`, builds the native parser in the publish worktree, then runs
     `CI=true bun test --timeout 15000 ./<files>` there: master's own tests, found by THIS checkout's rule on master's
     files (the daily update runs from a checkout of master). The `./` makes each argument a path, not a filter, and the
     15 s timeout is verify.ts's under io pressure. Its log goes to `<worktree>.reader-tests.log`.
   - **Only a red test blames the rows.** A red test throws `ReaderTestsRedError`, which becomes
     `GatedBuildsReaderTestsError`, naming the failing tests. A setup failure (the parser build, a missing reader module)
     propagates as itself.
   - `publishPending` logs `GatedBuildsReaderTestsError` as "rows REFUSED ...; a person decides", never as "next run
     retries".
   - No reader run happens when every row is already on master.
   - **Ceiling:** one bad row holds back the good rows published with it, until a person removes it. Isolating the bad row
     (re-testing without each one) can come when two pending rows actually collide.

## Predictions (red checks)
- **Unit tests:**
  - with the call removed, the "red reader test refuses by name" and "runs WITH the new row before any commit" tests go red;
  - with the call moved after the commit, the ordering test goes red;
  - with the fixpoint removed (direct readers only), the two-hop planted test and the "readers include findV3Pin,
    v3InstallHint" test go red;
  - with every error wrapped as the rows' fault, the setup-failure test goes red;
  - with the refusal logged as a retry, the refusal-log test goes red.
- **Real** (`/coord/handoff/PR-414/redcheck.sh`, the real `masterReaderTests`):
  - A, master as is: pass;
  - B, master plus a planted copy of the edge row reading `login-replay: matches`: fail, naming `pr402-login-replay`;
  - C, master at f8185a042 (the incident): fail, naming `pr256-stop-groups`.

## Not in scope
Pushing the row through a branch with CI (R1208's other option). Ceiling: a test that reads the rows only through a caller
outside the reader modules is not run.
