# PR-462 pre-commitment (R1170): LethAL Control 1.0.0.30, the Generation counter only

Coord PR-462 (lethal-preproc, 2026-11-26). Written before any server call. It builds step 2 of the owner-reviewed order in
`2026-11-22-pr325-client-session-harness.md` (§3, "Open for the owner" (c)): 1.0.0.30 on top of PR-309's 1.0.0.29,
headless-compatible and gate-provable on bc1-bc3. Evidence: `/coord/handoff/PR-462/`.

## What 1.0.0.30 is (and is not)
- **In it, as PR-314's probe measured (branch `lethal/pr-314`, never merged):**
  - `Generation` (field 5, BigInteger, so it cannot overflow) on `LC Mutation Active`. Every tuple write bumps it: phase 1's `WriteActive`, phase 3's
    tuple-conditional clear (`ClearActiveIf`) and the recovery clear (`ForceClearActive`).
  - `RefreshIfMoved` in `LC Control State`, called by `IsActive` and `NoteReached` where `EnsureLoaded` was. It reloads the
    cached tuple when the row's Generation differs from the cached one.
  - **The gate, as the PR-325 spec §3 asks (not PR-314's `ExpectedArtifactId` test):** an explicit `InOdataOp` flag. Phase 1
    in this session sets it (`WriteActive`); phase 3 and every recovery path clear it (`ResetAttestationState`, their one
    shared exit). Plus PR-314's `ResetSinceLoad`, set by `ResetAttestationState` and cleared by `WriteActive`, so the blank
    cache a phase 3 leaves stays fail-closed. No refresh while either is true.
  - `app.json` 1.0.0.30.
- **Not in it** (later steps): `ActivateForClient`, `DeactivateForClient`, the `client-run` op kind, the attestation rows,
  any driver. No new OData action, no API field: the wire surface is unchanged.

## What the client and every gate see
- **`MIN_CONTROL_VERSION` stays 1.0.0.29.** No client path needs 1.0.0.30 yet. The client-session driver will check for it
  itself (spec §1).
- **The headless path cannot refresh.** Every headless test run is inside its own op: `RunMutant` and `RunMutantMany` both
  call `TryBeginRun`, whose `WriteActive` sets `InOdataOp` in the same session before any test runs. After phase 3,
  `ResetSinceLoad` holds. So `IsActive` and `NoteReached` answer from exactly the cache they answer from on 1.0.0.29, and a
  hung session's guards make no database call (where a stop lands is unchanged). The one new cost is a single-field read
  per guard call OUTSIDE an op (PR-314: about 4 us).
- **The one exception: a background session a test starts** (`StartSession`, `TaskScheduler`, a job queue that really
  schedules, a page background task). It has its own single-instance state with neither flag set. On 1.0.0.29 it froze the
  tuple from its first guard call; on 1.0.0.30 it follows the row. If it outlives its op, it now runs the CURRENT mutant (or
  none) rather than a stale one. No gate fixture starts one; if a DO or DC test is found to, that is filed as its own item.
- **Expected moves: 0** on every gate, every leg, warning sets included. Any move is a BLOCK.
- **What the gates can and cannot show.** Inside an op the row's Generation never moves (every write is fenced), so the
  gates would show 0 moves even with the `InOdataOp` gate missing. The gate's EXISTENCE is pinned offline instead, by source
  tests in `control-app-source.test.ts`, each red-checked:
  - `WriteActive` sets `InOdataOp := true` and `ResetSinceLoad := false`; `ResetAttestationState` sets `InOdataOp := false`
    and `ResetSinceLoad := true`;
  - in `RefreshIfMoved`, `if InOdataOp or ResetSinceLoad then exit;` comes before its first `Active.Get`;
  - `IsActive` and `NoteReached` call `RefreshIfMoved`, never `EnsureLoaded` directly;
  - every `Active.Modify();` in `ControlState.Codeunit.al`'s three tuple writers is directly preceded by
    `Active.Generation += 1;` (exactly 3).
  The gates prove "no move"; the source tests prove the gate is there.

## How an older client is proved to work against 1.0.0.30
lethal-bugs' DOTests runs use the client at `ac413797d` (worktree `/work/lethal-wt/pr427-run`, committed 2026-11-25),
behind master by many commits. It checks a minimum of 1.0.0.29 and calls only actions 1.0.0.29 has, all unchanged.
- **The proof, live:** in a scratch worktree at exactly `ac413797d` (with the gate setup), against a server that runs 1.0.0.30
  (read back by sha256 first): `itest:bcdev` and `itest:lease`, each against that commit's OWN committed baselines.
  - `bcdev` is the frozen per-mutant gate. `lease` drives the fenced lease and op calls (acquire, renew, release, publish,
    run, finish, recover, force-reset). The STOP calls are not in `ac413797d`'s lease itest: they are covered,
    client-independently, by master's `itest:hang` on bc2 (the wire is the same for both clients).
  - The worktree's configs and symbols come from `gate-worktree-setup.ts`, never that commit's `bc-linux-setup.ts`, which pins
    1.0.0.29 and would try a downgrade publish.
  - The fixtures and `bcdev.baseline.json` are identical between `ac413797d` and master today, so a difference cannot come
    from fixture drift.
  - **Expected: both PASS.** Any difference is a BLOCK, and 1.0.0.30 is not published further.
- `doctor` from `ac413797d` must read 1.0.0.30 as `control-version` ok.

## Verify and publish, in this order
1. **Offline:** alc compile of the control app (0 diagnostics). VERIFY (the source tests). An Opus review of the AL diff
   and this pre-commitment.
2. **The pinned build:** the setup script's `CONTROL_APP` and `CONTROL_SHA256` move to the reviewed 1.0.0.30 build, which is
   kept under `/coord/handoff/PR-462/control/`.
3. **One server first, bc2** (it holds `itest:hang`, which `bc1` refuses):
   - setup under a lease publishes 1.0.0.30 as an upgrade from 1.0.0.29, and reads it back by sha256;
   - then PR-309's full proof row on bc2 under 1.0.0.30: the 13 gates and `itest:hang`;
   - then the older-client proof above, on bc2;
   - then the build is read back AGAIN (sha256 and `doctor`'s `control-version`) after the last gate. Every gate also passes
     on 1.0.0.29, so only a reading at both ends ties the figures to 1.0.0.30: a server1 restart mid-proof followed by a
     setup from an older tree would otherwise go unseen. Both readings go in the evidence, per server.
4. **Only if all of step 3 passes:** bc3 (the 13 and hang), then bc1 (the 13). Per CLAUDE.md, a control build change
   re-proves each server's gates. The proof table in `docs/gates/servers.md` gets the new row in this PR.
5. **CI, and `itest:alrunner-v3` (legs.ts):** unaffected by the AL, run on the final head.
- **bc4: not published in this task.** lethal-bugs' DOTests (PR-427) records "LethAL Control: 1.0.0.29" as a pin in every
  area, and its recovery re-runs setup from `ac413797d`, whose `CONTROL_APP` is 1.0.0.29. So bc4 stays on 1.0.0.29 for
  DOTests' whole pinned series (agreed with lethal-bugs, 2026-11-26). 1.0.0.30 adds nothing there: bc4 has no `/cs`, and no
  client needs it. It is published to bc4 when that series ends, at lethal-bugs' word.
  - **After this merges, master's setup script pins 1.0.0.30,** so a routine setup of bc4 from master (after a server1
    restart, or `--server all`) would publish it there. So the script keeps a per-server pin: bc4 gets PR-309's 1.0.0.29
    build (its own path and sha256), every other server 1.0.0.30. A unit test pins both. The bc4 entry is removed when
    the series ends, in the change that publishes 1.0.0.30 to bc4. R1170 records the trigger.
- **If bc2 fails:** stop; the lease is kept; nothing is published to bc1 or bc3. The setup script has no rollback.
  Republishing 1.0.0.29 is a downgrade, and over the kept data it drops field 5 (a destructive schema change a normal sync
  refuses); unpublishing LethAL Control also cascades to every app that depends on it (the instrumented targets, the test
  apps). So the clean way back is kraken resetting bc2's in-memory database, then setup at 1.0.0.29 from master, then bc2
  re-proved at 1.0.0.29 before the lease is released.

## Amendment 1 (2026-11-26, from the build review, before any server call)
- **`bc-republish.ts control` also reads the per-server pin** (`controlBytesFor(server)`): it read `CONTROL_APP` directly, so
  `--server bc4` would have upgraded bc4 to 1.0.0.30, which cannot be undone.
- **`bc-demo` stays on 1.0.0.29 too** (`DEMO_CONTROL`), kraken and laptop mode: 1.0.0.30 adds nothing there, and moving it
  would make the owner's laptop mode refuse until a new build is copied. It moves with bc4.
- **`older.sh` reads the build back** (master's `--predict`, "already-pinned LethAL Control 1.0.0.30") before its first gate
  and after its doctor, as `prove.sh` does, and starts only after `prove.sh bc2` ended ALL PASS.

## What this does not prove
- **The refresh itself** (a session outside any op following a new Generation) runs only in a client session. There is
  none on bc1-bc4 (no `/cs`). PR-314 measured it on Windows BC 28.4. On Linux it is first exercised by the driver's gate
  legs (spec §4, §7 (c) 4). These gates prove that the headless path did not change.
