# R680: a resume refuses when the server's generation changed since the run it resumes (plan r2)

## Changes from r1

Plan review (spec-adversary, Opus, on r1 3494d307): ADOPT with fixes. All applied:
1. **Important, the R192 baseline snapshot.** `findBaselineSnapshot` lends a baseline from ANY run (gated only on a
   resume). A run recorded before a restart could lend its baseline to a resumed run after it, and a test that is red
   on the restarted data would then score a false kill. r2 adds the generation to that query (step 5).
2. **Important, the window check.** The real server grants a lease only at the generation it holds now (`TryAcquire`
   never mints one), so a second read is always granted at the second value, and r1's comparison could only fail in a
   fake. r2 reads once, and hands `acquireSessionLease` that recorded value as its `expectedGeneration`. A change in
   between is then refused by the server itself (`generation-changed` → `LeaseUnavailableError`, before any deploy).
3. **Minor, where it is read:** before `testAppIdentity` (the first guard ask), as R680 says.
4. **Minor, tests:** the fresh-session window case; `instanceof` for the refusals, so an R486/R495 test-app refusal
   cannot pass them; test 3 sets the column NULL explicitly.
5. **Minor, history lending** (`--skip-known-survivors`) is not covered across a restart. It lends survivors only,
   so it can under-report, which is the safe direction. Recorded in R680 as a known gap.

Task: `/coord/tasks/R-680/task.md`. Item: `docs/roadmap/R680.md`. Background: R632 (the probe that measured
`serverGeneration`), R601 (a closed-world pending prior resumes when the guard answers the same now). All code is in
`packages/runner/src/` at master eabe7fd0.

## The gap

A resume (`--resume`, `--resume-run <id>`) carries the verdicts of a prior run when, among other checks, its
test-app identity and server key (`resource_key`) match. Neither sees a restart of the BC server inside the gap. On
bc1-bc3 (in-memory databases) a restart loses every app, and an app published again afterwards may not be the same
one. For a closed-world run (R389/R601) this is the case the R601 rule cannot see: a dependent published and removed
inside the gap.

R632 measured `serverGeneration` (LethAL Control's `HarnessInfo`). It stayed the same across reads, a lease release
and re-take, and a publish and an uninstall. By the control app's code it is re-minted only when the lease row is
created (an install into an empty database, as after a restart here) or by `ForceResetLease`. Both directions of a
change are an extra refusal: the safe direction.

## Where the session stands today (`orchestrator.ts`)

The order in `runSession` is:
1. `testAppIdentity`, which includes the closed-world guard ask;
2. `resolveResume` (`assertSameTestApp` per flag);
3. `createRun`;
4. later, `openLeaseScope`, which calls `acquireSessionLease`.

`acquireSessionLease` reads `cfg.lease.serverGeneration()` (production: `HarnessVerifier.verify().serverGeneration`)
and `AcquireLease` grants only at that current value. So the lease is taken AFTER the resume decision.

## The change

1. **Read the generation once, before `testAppIdentity` (r2),** when the session has a lease config (`cfg.lease !==
   undefined`: a bcdev session against a LethAL Control harness). An empty answer throws, as
   `acquireSessionLease` already does. A session with no lease (al-runner-v3, or a unit-test session) has no server
   generation and records none.
2. **Record it on the run row:** a new nullable column `runs.server_generation`, added the way R601 added
   `resource_key` (the `runCols` migration list in `store.ts`); `createRun`'s `serverGeneration?`; and
   `RunRow.serverGeneration: string | null`.
3. **The resume rule,** in `resolveResume`, next to `assertSameTestApp` for both `--resume` and `--resume-run`:
   `assertSameServerGeneration(row, flag, sessionGeneration)`. When this session HAS a generation:
   - the row has none (recorded before R680, or by a session with no lease): refuse;
   - the row's value differs: refuse.
   - The refusal throws `ServerGenerationChangedError` (extends `Error` directly). The message names both values
     (or "none recorded"), says the server was restarted or its lease force-reset since that run, carries nothing,
     and says to drop the flag. Nothing is carried, because the session stops before any index is built.
   - When this session has NO generation (no lease), the rule does not apply; a lease-less session's prior is
     lease-less too, because the config fingerprint must match.
   - **No back-compat before release:** an old row without the column's value refuses, by name.
4. **The window between the read and the lease (r2):** the lease config passed to `openLeaseScope` answers
   `serverGeneration` with the value recorded in step 1, so `AcquireLease` is asked at it. A server that changed in
   between answers `generation-changed`, and `acquireSessionLease` throws `LeaseUnavailableError` before any batch is
   deployed. This holds for a fresh session too: its row would otherwise record a generation it did not run on.
5. **The R192 snapshot (r2):** `findBaselineSnapshot` takes the session's generation. When the session has one, only
   a snapshot of a run with the same `server_generation` lends; a NULL never equals, so a run recorded before R680
   lends none. A session with no generation filters nothing, as before.

**Not changed:**
- history lending (`--skip-known-survivors`): it compares identities as before (the R192 snapshot reuse is changed,
  step 5);
- `lethal verify`.

R632 measured that a dependent published and removed inside the gap (0 → 1 → 0) leaves no readable history on the
dev endpoint; that stays R389's stated limit.

**The restart case rests on R632's restart confirmation (1c), still open.** bc2's "before" value is in
`/coord/handoff/R-632b/bc2-gen-baseline.txt`, and the confirmation needs the owner's next restart of bc2. R680 says
so.

## Tests (test-first)

In `orchestrator.test.ts`, on the existing resume harness with a `FakeLeaseClient` and a `serverGeneration` stub:
1. `--resume-run` with a differing generation refuses with `ServerGenerationChangedError`, naming both values; no
   verdict is carried and nothing is deployed. RED before.
2. The same for bare `--resume`. RED before.
3. A stored run with no generation (a row written without the column) refuses, naming "none recorded". RED before.
4. **The keeps direction:** an equal generation still resumes and carries its verdicts. GREEN before and after,
   asserted with the carried count.
5. **The window (r2):** `acquireArgs[0].expectedGeneration` equals the recorded value (RED before: today it is a
   second read). A seeded `generation-changed` refusal stops the session before any deploy, both for a resume and
   for a fresh session.
6. **A lease-less session** (no `cfg.lease`) resumes as before, with no generation read. GREEN before and after.
7. **The snapshot (r2):** run Z records a baseline snapshot under generation g1, and a resumed run under g2 does NOT
   reuse it (its baseline runs). Under the same g1 it does. RED before.
8. **The refusals assert `instanceof ServerGenerationChangedError`;** test 3 sets `server_generation` to NULL
   explicitly.

In `store.test.ts`: `createRun` round-trips `serverGeneration`, and a row without it reads `null`.

**Red-checks after the build:** remove the differing-value check (1 and 2 go red); remove the missing-value check (3
goes red); remove the window check (5 goes red); make the rule apply without a lease (6 goes red).

## Gates

`selectLegs` on the diff: `orchestrator.ts` and `store.ts` give the runner set (bcdev, lease, tables, chunked,
alrunner-v3); `lend` covers `--resume`. bc2 is free (code holds bc1 and bc3). On the final head:
- bcdev, lend, tables and chunked on bc2 under a lease;
- `itest:alrunner-v3`, all legs, locally.

No gate restarts a server, so each one's resume must keep carrying: the same generation on both sides.
