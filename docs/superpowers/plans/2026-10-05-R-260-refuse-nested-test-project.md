# R-260 plan (r2)

## Finding (sol agrees, /coord/reviews/R-260-plan/sol-plan-r1.md #1)
A nested test project is not only hashed: the target build compiles it. `targetAlFiles` and
`generateMutationSet` read every `.al` under the target folder, and `prepareBatchProject` copies them all
into the batch that alc compiles (probe: `test/T.Codeunit.al` listed AND mutated). So the published target
contains the test codeunits. Leaving the test folder out of the hash alone would hide a real change to the
installed build. Leaving it out of the build too would change the mutant set and ids for that layout. Neither is small or safe.

## Fix: refuse up front, by name
1. `verify.ts`: one shared guard `assertTestProjectSeparate(projectPath, testDir)`, refusal
   `test-project-nested`. Both roots are `realpath`'d. If either cannot be resolved, it refuses (never a
   `resolve` fallback). On win32 the paths are compared lower-cased (this covers drive letters and UNC
   names). Containment: `rel = relative(a, b)` counts as inside when `rel === ""`, or when `rel` is not
   absolute, is not `..` and does not start with `..` + sep. So a child folder named `..tests` counts as
   inside, and `target-tests` does not. The check runs both ways. The pure part takes a `path` module, so
   tests can drive `path.win32` on Linux.
   Wording: "is / lies inside" → the target build compiles every .al under its folder, so these tests are
   part of the installed target app. "contains" → the target's code is part of the test build. In both
   cases: move the test project beside the target, run lethal run, then verify.
2. Placement (sol #3): in `verifyFromCli` right after `assertProjectReadable`, before config load and
   `buildBackend`. Also inside `assertSourceUnchanged`, before hashing (runVerify passes `testDir`; it
   becomes required). The whole hash comparison stays as it is.
3. Delete the now-unreachable nested sentence from `source-changed`.
4. Add the code to `VERIFY_REFUSALS` and bump `VERIFY_SCHEMA_VERSION` from 6 to 7 (the value domain grew).
   Regenerate the schemas, update schemas.test and the agent guide's refusal list.
5. File a roadmap item: `lethal run` on the nested layout mutates test code as if it were target code. It
   should warn or refuse. That is out of R260's scope; run's hashes stay untouched (sol #5).

## Tests (verify.test.ts), each red-checked by reverting the one named piece
- Nested test EDIT and test ADD, each measured against a recorded hash: refuses `test-project-nested`,
  nothing is compiled, and the error is NOT `source-changed`. Red: remove the guard from
  `assertSourceUnchanged` → `source-changed`.
- CLI entry: the nested layout refuses before `buildBackend` (fake counter at 0). Red: remove the CLI
  call → the counter goes up or the refusal is different.
- Target `.al` edit, sibling layout, in a folder whose name looks like a test folder: `source-changed`.
  Target `app.json` edit: `source-changed`. Red, for both: make the hash comparison a no-op → pass.
- Containment: a symlinked alias of the target (Linux), a trailing separator, a relative path, a
  `..`-through-parent path, tests that contain the target, the same folder, a child `..tests` (refused),
  and `target` vs `target-tests` (passes). Unresolvable roots refuse.
  Pure-function cases on `path.win32`: drive-letter case and UNC case. Red: the old `startsWith("..")` → the
  `..tests` case passes wrongly. Dropping realpath → the symlink alias passes wrongly.
- Sibling layout, unchanged: passes.

## Digest / identity impact
None. `hashTargetSource`, generation, mutant ids, test digests, the dependency fingerprint and
`testAppHash` keep their algorithms. Only the verify schema version moves (6 → 7). Moving the tests out
changes the source and ids, but that is the user's edit, not an algorithm change. Close R260 with the ruling:
"nested layout refused by name; move the tests beside the target".
