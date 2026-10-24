# R728 probe: the error a real `lethal run` gets when an altool upgrade publish is refused

**Status: built and compiled offline only, run on NO server.**

Question (R728): R-709b measured BC's 422 "could not be restored ... could not be reinstalled ... to do so:"
text over a DIRECT HTTP publish. A real run publishes through altool, via LethAL's own `ContainerDeployer`
(`packages/runner/src/publisher.ts`), built by `deployerFor(...)` in `packages/runner/src/cli.ts`. This probe
captures EXACTLY the Error that publish throws. Nothing is truncated: the full message goes to
`.kraken-local/r728-probe/error-3.txt` (sha256 and length in the step's JSON line).

Invented AL, no tables. Publisher `LethAL Probe`. Source dirs: `t1 t2 d1 d2`.

| App | Id | Object ids | Builds |
|---|---|---|---|
| R728 Probe Target (T) | `cd81e5cb-17c3-4a98-a12f-c03a41c5c517` | 93760-93769 | T1 (1.0.0.1, `Answer()` returns 1); T2 (1.0.0.2, `Answer` removed, `Other()` instead) |
| R728 Probe Dep One (D1) | `bcd962d9-58d6-4e7b-8f46-20d6087cfda2` | 93770-93774 | 1.0.0.1, depends on T >= 1.0.0.1, web service `R728DepOne` |
| R728 Probe Dep Two (D2) | `7fed51c2-9122-45ff-8786-35a299428e2e` | 93775-93779 | 1.0.0.1, depends on T, web service `R728DepTwo` |

Each dependent's `Call(): Integer` returns `T.Answer()`. D1 and D2 compile against T1.

## Run

Build once, offline (System symbols from `/coord/cache/bc-symbols/<server>`, no server call):

    bun scripts/r728-probe/drive.ts --build --server bc2

Output goes to `.kraken-local/r728-probe/` (gitignored), with `shas.json`. Do not rebuild after a
pre-commitment records the hashes: every alc build gets a fresh header id.

Under a lease on the server, from the worktree root:

    bun scripts/r728-probe/drive.ts --server bc2 --lane <lane> --step 1   # then 2, 3, cleanup
    bun scripts/r728-probe/drive.ts --server bc2 --lane <lane> --all

It refuses (exit 2) unless `kraken coord holder bc2` names `--lane`. Apps are read by id only (R433). Every call
times out at 120 s. Each step prints one JSON line.

## Steps

1. Publish T1, D1, D2 by direct dev-endpoint publish. Read each back (installed 1.0.0.1).
2. Call `R728DepOne_Call` and `R728DepTwo_Call` over OData. Expect HTTP 200, value 1.
3. Publish T2 THROUGH THE DEPLOYER: `fixtures/sandbox-app/lethal.config.<server>.json` is loaded with
   `itestConfigPath` + `readFixtureConfig` + `validateBcDevConfig`; the altool path follows `resolveAlToolPaths`
   (`bcdev.altoolPath`, else `defaultAlToolPaths()`); `deployerFor(bcdev, altoolPath).publish({ appPath, sha256 })`.
   The thrown message is saved whole (`error-3.txt`) with `restoreFailed`, `notReinstalledApps` and
   `new UpgradeNotRestoredError(msg).message` (`error-3-refusal.txt`). If publish does NOT throw, that is
   recorded as a finding. Then read T, D1, D2 and call both services.
- `cleanup`: uninstall then unpublish every row of D1, D2, T. Read back absent. Print what remained.

`--all` runs 1..3 then cleanup (cleanup also runs on failure, then the error is rethrown).

## After the run

bc2 keeps its installed-version record for T at 1.0.0.2 (R605) until a restart. Say so in the submit note.
