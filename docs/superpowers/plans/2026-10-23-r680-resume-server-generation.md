# R680: a resume refuses when the server's generation changed since the run it resumes (plan r1)

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

1. **Read the generation once, before `resolveResume`,** when the session has a lease config (`cfg.lease !==
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
4. **The window between the read and the lease:** `acquireSessionLease` reads the generation again for
   `AcquireLease`. When the granted lease's `serverGeneration` differs from the value recorded in step 1, the server
   changed after the resume decision. The session then throws `ServerGenerationChangedError` before any batch is
   deployed, and the lease is released by the scope's normal `finally`. A fresh session (no resume) also throws in
   that case: its row would record a generation that is not the one it ran on.

**Not changed:**
- history lending (`--skip-known-survivors`) and the R192 baseline-snapshot reuse; they compare identities as before;
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
5. **The window:** the generation read before the resume and the granted lease's differ, and the session throws
   before any deploy. RED before.
6. **A lease-less session** (no `cfg.lease`) resumes as before, with no generation read. GREEN before and after.

In `store.test.ts`: `createRun` round-trips `serverGeneration`, and a row without it reads `null`.

**Red-checks after the build:** remove the differing-value check (1 and 2 go red); remove the missing-value check (3
goes red); remove the window check (5 goes red); make the rule apply without a lease (6 goes red).

## Gates

`selectLegs` on the diff: `orchestrator.ts` and `store.ts` give the runner set (bcdev, lease, tables, chunked,
alrunner-v3); `lend` covers `--resume`. bc2 is free (code holds bc1 and bc3). On the final head:
- bcdev, lend, tables and chunked on bc2 under a lease;
- `itest:alrunner-v3`, all legs, locally.

No gate restarts a server, so each one's resume must keep carrying: the same generation on both sides.
