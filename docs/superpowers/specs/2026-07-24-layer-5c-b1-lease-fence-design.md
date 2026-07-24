# Layer 5C-B1 — Machine-Global Lease + Fence (Design)

> Status: **Revision 2** (post two-model adversarial review — gpt-5.6-sol + claude-fable-5 both
> returned BLOCK on Revision 1). Predecessors: 5A (deployment identity), 5B (client-side hardening),
> **5C-A (server-side `RunMutant` primitive + attestation fence — merged)**. First slice of 5C-B.
> Successors: 5C-B2 (server-side batch runner `RunChunk`), 5C-B3 (cooperative cancel + preemption),
> 5D (pool + scheduling).
>
> Revision 1 modeled the fence as ONE `LockTable` transaction spanning validate+activate+run+clear.
> Both reviewers proved that impossible: the shipped AL `Commit()`s inside `SetActive`/`ClearActive`/
> the test framework, and in BC **any `Commit` releases all locks** — so the lease lock is gone
> before the test runs; holding it anyway would serialize every renew/acquire behind a minute-long
> run and deadlock the steal path. Deeper: a client abort does **not** cancel the server-side AL run
> (5B), so a lease cannot be safely stolen while an operation may still be executing. Revision 2
> reshapes around a **server-side operation marker** + a **two-phase fence** + **quarantine-for-
> recycle** (no auto-steal of an in-flight op). Full finding-by-finding disposition at the end.

## 1. Goal and honest framing

Make **two concurrent LethAL sessions safe against one container** by adding a **machine-global
lease + a server-side operation marker** owned by the `LethAL Control` extension, and turning
`RunMutant`'s reserved `leaseEpoch`/`leaseToken` into a **required, two-phase fence**: the resource
rejects a stale write, and — because there is no cancellation in 5C-B1 — an **unresolved operation
is never stolen; it quarantines the container for recycle**. This enforces 5C-A's two stated-but-
unenforced preconditions (§I): concurrent LethAL publication/execution against one container is now
fenced, not merely assumed.

**What "fence" means here, honestly (the R1 correction).** The lease lock cannot be held across a
test run. Instead:
- Ownership + no-overlap is enforced by a short-critical-section **operation marker**: a session
  claims the lease AND marks an active operation (`publish` or `run`) atomically; `AcquireLease`
  refuses to grant while another session's operation is unresolved, even if the lease clock expired.
- Stale-write rejection is enforced by **re-validating the epoch/token in a second short critical
  section at the end of `RunMutant`, before recording**, plus a **conditional `ClearActive`** that
  only clears the tuple this attempt set.
- A hung/crashed holder leaves its operation marker set → the container is **quarantined for
  recycle** (operator/host restarts it, clearing server state) — it is NOT auto-stolen (which would
  overlap the uncancellable server op). Automatic recovery via cooperative cancel is **5C-B3**.

5C-B1 does **not** add the server-side batch runner (`RunChunk`), cancel, or preemption.
**Success** = the frozen bcdev **3/10/3** reproduced with a lease held+renewed+released around the
session, al-runner **3/13/0** unchanged, PLUS the blocking concurrency/fence probes (§9) that
exercise a valid run crossing lease pressure.

## 2. Position in the roadmap

| Layer | Delivers |
|---|---|
| 5C-A (done) | `LethAL Control` + `RunMutant` (activate+run+clear) + per-run attestation fence; single-session |
| **5C-B1 (this)** | Machine-global lease + operation marker (server-side); two-phase `RunMutant` fence with conditional clear; publication fenced by op-marker exclusion; lease-lost verdict invalidation; quarantine-for-recycle of a hung op; bidirectional **protocol v2** |
| 5C-B2 | Server-side batch runner: mutant-plan table, `RunChunk` |
| 5C-B3 | Cooperative cancel + preemption (enables auto-recovery of a hung op instead of recycle) |
| 5D | Container pool + scheduling |

## 3. Explicit non-goals
- **No `RunChunk` / batch runner** (5C-B2). `RunMutant` stays one method per call.
- **No cancellation / preemption / auto-steal of an in-flight op** (5C-B3). A hung op → recycle.
- **No al-runner changes.** al-runner never calls `RunMutant`; lease is bcdev-only.
- **No protection against a non-LethAL publisher** to the container (a foreign altool). The lease
  fences LethAL-vs-LethAL only.
- **No cross-host coordination beyond what the shared container gives for free.** "Machine-global" =
  the contention unit is one (tenant, container); §7 handles the tenant-scoping honestly.

## 4. The lease + operation marker (server-side, in `LethAL Control`)

New table **`LC Lease`** (id 71006, `DataPerCompany = false`, `InherentPermissions = RIMD`), single
row, constant `Primary Key` (`''`), **one lease per (tenant, container)** — see §7 for the
tenant-scope caveat. Fields:
- `Owner` (Text[100]) — `host:pid:runId`, diagnostics.
- `Epoch` (Integer) — monotonic; `+1` on every successful acquire.
- `Token` (Text[32]) — fresh 32-hex nonce per acquire; the holder secret.
- `Expires At` (DateTime) — server-clock deadline.
- **`Op Kind`** (Option: `none,publish,run`) — the active operation, if any.
- **`Op Attempt Id`** (Text[64]) — client-generated attempt id of the active op.
- **`Op Started At`** (DateTime) — when the op marker was set (diagnostics / stale-op detection).

**Pre-seed (R1 spike finding).** The row is inserted empty (`Expires At = 0DT`, `Op Kind = none`) by
`LC Control Install` AND `LC Control Upgrade`. `AcquireLease` never `Insert`s — only lock/read/modify.

**Acquire semantics — the operation marker gates the steal (sol#1/#5, fable#1).**
`AcquireLease(owner, ttlSeconds, clientNonce) → {granted, epoch, token, expiresAt} | {granted:false,
reason}` under `LockTable` on the pre-seeded row:
- If `Op Kind <> none` → **refuse**, `reason: "operation-in-flight"` (regardless of `Expires At`). A
  session that gets this treats the container as **needs-recycle** (durable container quarantine,
  §8) — the prior holder has an unresolved op that cannot be safely cancelled.
- Else if free (`Expires At = 0DT`) OR expired (`CurrentDateTime > Expires At`) → grant: `Epoch += 1`,
  new `Token`, set `Owner`, `Expires At = now + ttl`, `Op Kind = none`. Commit; return granted.
- Else (held, unexpired, idle) → `{granted:false, reason:"held", holder, expiresAt}` (never leak the
  token).
- **Idempotent acquire (sol#7B):** `clientNonce` (client-generated) is stored on grant; a retried
  `AcquireLease` with the SAME nonce that finds the lease already granted to that nonce returns the
  same `{epoch, token}` rather than minting a second lease — so a lost acquire-ack can be reconciled
  and never orphans a lease.

**Renew (fable#4, sol#7A).** `RenewLease(epoch, token, ttlSeconds) → {renewed, expiresAt}` under
`LockTable`: if `(epoch, token)` equal the current row → extend `Expires At`, Commit, `renewed:true`
— **even if momentarily past `Expires At`**, because a matching `(epoch, token)` proves nobody stole
it (a steal would have bumped the epoch; and an op-marker would have blocked the steal anyway). Only
`{epoch,token}` MISMATCH → `renewed:false` (genuinely lost). Renew is idempotent (extending twice is
harmless), so the client retries once on a lost ack before concluding lease-loss.

**Release (sol#5).** `ReleaseLease(epoch, token) → {released}` under `LockTable`: if `(epoch, token)`
match **AND `Op Kind = none`** → set `Expires At = 0DT` (free; keep the pre-seeded row), Commit,
`released:true`. If an op is still in flight (`Op Kind <> none`) → **refuse** (`released:false,
reason:"op-in-flight"`): a container with a live server op must not be freed. Idempotent; a
mismatched release is a no-op.

**Time authority.** Expiry judged server-side against `CurrentDateTime`; client TTL/renew timers are
advisory. (R1 spike confirmed steal-after-expiry + epoch bump on an *idle* lease.)

## 5. The two-phase fence — `RunMutant`

`RunMutant` gains **required** `leaseEpoch`, `leaseToken`, `attemptId` (the client's op-attempt id).
Three short critical sections around an **unlocked** run (the R1 blocker fix):

**Phase 1 — claim (short `LockTable` critical section):** `LC Lease.Get('')`. Require `leaseEpoch =
Epoch` AND `leaseToken = Token` AND `CurrentDateTime <= Expires At` AND `Op Kind = none`. On failure →
`status: lease-invalid`, touch nothing. Else set `Op Kind = run`, `Op Attempt Id = attemptId`,
`Op Started At = now`; `SetActive(targetAppId, artifactId, mutantId)`; `Commit` (releases the lock —
by design now).

**Phase 2 — run (no lease lock held):** `RunOneMethod(...)`. Renew/acquire from other sessions can
take the lease lock during this window (they will see `Op Kind = run` and refuse to steal). The
attestation (5C-A §G) is recorded here as before.

**Phase 3 — verify-and-clear (short `LockTable` critical section):** `LC Lease.Get('')`. If
`(leaseEpoch, leaseToken) = (Epoch, Token)` AND `Op Attempt Id = attemptId` (still ours) → **conditional
`ClearActive`** (clear `LC Mutation Active` only if its tuple equals what phase 1 set — see below),
set `Op Kind = none`/`Op Attempt Id = ''`, `Commit`, return `status: ran` + result + attestation.
Else (epoch/token/attempt changed — impossible under the op-marker unless a recycle happened) →
return `status: lease-invalid`, do **not** touch `LC Mutation Active` (it is not ours), leave the
result unrecorded.

**Conditional `ClearActive` (fable#1 step 3).** `ControlState.ClearActive` becomes
`ClearActiveIf(targetAppId, artifactId, mutantId)`: clear the active row only if it currently equals
that tuple. This makes the unconditional-wipe interleaving impossible even as belt-and-suspenders
(the op-marker already prevents another session from setting the active row while ours is unresolved).

**Why this is fenced without holding a lock across the run.** A steal cannot occur while `Op Kind =
run` (Acquire refuses). So between phase 1 and phase 3, no other session can bump the epoch or set
the active row. Phase 3's re-validation is therefore normally trivially true; it exists to fail
**closed** if the only thing that could have changed the marker — a container recycle that cleared
server state — happened. A hung phase 2 (test never returns) leaves `Op Kind = run` set forever →
Acquire refuses all future sessions → **quarantine-for-recycle** (§8). No overlap, no false verdict.

`RegisterArtifact` stays in-process (target install/upgrade), no token; publication exclusion is the
op-marker (§6), not a per-write token.

## 6. Client integration (runner)

New `LeaseClient` (`packages/runner/src/lease.ts`): `acquire`, `renew`, `release`, plus
`beginPublish`/`endPublish` (set/clear `Op Kind = publish` around the altool publish). OData
request-shaping mirrors `RunMutantTransport`/`HarnessVerifier`.

`runSession` (bcdev / authoritative only):
1. **Acquire before deploy()** with a client nonce. `granted:false, reason:"held"` → another session
   owns it → typed `LeaseUnavailableError`, abort (optional bounded backoff-with-jitter, sol#7/fable#7).
   `granted:false, reason:"operation-in-flight"` → the container is stranded → durable **container
   quarantine** (needs recycle), abort. Never a verdict.
2. **Publication fence.** `beginPublish(epoch, token, attemptId)` (sets `Op Kind = publish`) →
   altool publish → `endPublish` on confirmed publish. While `Op Kind = publish`, no other session
   can acquire (steal refused), so a concurrent session cannot publish a racing artifact. A publish
   whose response is lost leaves `Op Kind = publish` set → the client cannot `endPublish` → container
   quarantined-for-recycle; recycle kills any truly-in-flight server publish too. (This fences
   publication by **exclusion + recycle**, not by an install-codeunit token — honest scope; sol#4.)
3. **Renew heartbeat** — single-flight (never overlap two renews), at `ttl/3`. On a lost renew ack,
   retry once; only `renewed:false` (epoch/token mismatch) is lease-loss.
4. **Every `RunMutant` passes `(epoch, token, attemptId)`.** The transport is bound at deploy.
5. **Release in `finally` only if no op is in flight** (§4). A session whose op is unresolved does
   NOT release (can't) → leaves the marker → recycle. A clean session releases, freeing the container.

**Lease-lost handling (both#6 — the verdict-safety fix).** A `renewed:false`, a `RunMutant`
`lease-invalid`, or a lost-and-unreconcilable renew → latch `SessionSafety` unsafe (`reason:
lease-lost`) AND **invalidate every accumulated verdict of the affected artifact/session**
(`invalidateBatchVerdicts` unconditionally — do NOT rely on the 5C-A §G attestation gate, which
skips invalidation once an artifact has one clean attestation; an already-recorded clean `survived`
must be voided on lease-loss). The report exposes only `error` outcomes + the quarantine marker;
never ordinary killed/survived counts for a lease-lost session.

**Scheduling-gap fix (sol#6).** `SessionSafety` must guard **every** work-plane dispatch —
`deploy`, `activate`, AND `run` (today `runOnce` does not receive/assert it). A heartbeat that
latches lease-loss between covering-test calls must stop the next `run()` before it dispatches.

**Quarantine taxonomy (both#4/#5).** Two distinct durable quarantine kinds, keyed to the tier:
- `container-needs-recycle` — an unresolved op-marker (hung run/publish) or an operation-in-flight
  acquire-refusal. Cleared only by recycling the container (server restart clears server state) +
  operator `clear-quarantine`.
- Lease-lost with **no** unresolved op (a clean epoch-mismatch, container is fine) → latch + abort
  THIS session, invalidate its verdicts, but **do NOT** write a durable tier quarantine (the
  container is clean; RunMutant clears per call). This corrects R1's blanket "quarantine" (fable#4).

## 7. Protocol v2 — incompatible by construction (sol#8)

A v1 verifier requires `protocolVersion >= 1` and would **accept** a v2 server, then publish
unfenced. So v2 must be incompatible for a v1 client BEFORE it can publish. Mechanism:
- v2 `HarnessInfo(clientProtocol)` **requires a `clientProtocol` argument**. A v1 client sends `{}`
  (no arg) → the v2 server returns an incompatibility error → the v1 client's HarnessVerifier
  (which Task 8 §H made required + unconditional **before compile/publish**) fails up front, before
  any publish. A v2 client passes `clientProtocol: 2`.
- A v2 client against a v1 server: `HarnessInfo` returns `protocolVersion: 1 < 2` → v2 verifier
  fails before deploy (this direction was already sound in R1).
- During rollout, do not target an upgraded container with a legacy client (operational note).

## 8. Errors, statuses, quarantine
- `RunMutant` status **`lease-invalid`** (new): empty/stale/expired lease or lost op-marker; ran
  nothing. Transport → `outcome:"error"` with a **distinct `operation: "lease-lost"`** (NOT
  `in-flight-unknown` — nothing is in flight; and NOT a bare error, which would trip the
  two-consecutive-transport-errors abort in `runMutantsOnBackend`). `requiresUnsafeLatch("lease-lost")`
  is true; the handler invalidates verdicts and abstains from the §G unattested-artifact diagnosis
  (emit a lease-lost note instead — both#5/#6).
- `LeaseUnavailableError` (typed, extends `Error` directly) — acquire refused (`held`). Aborts.
- `container-needs-recycle` durable quarantine — acquire `operation-in-flight`, or a session that
  ends with an unresolved op-marker. Distinct from a lease-lost abort.
- All quarantine records: first-reason-wins (one durable record), consistent with `SessionSafety`.

## 9. Testing & the gate (blocking mid-run probes — sol#10)
R1's probes could all pass while the mid-run failure survived, because none started a **valid** run
and let it cross lease pressure. R2's live gate requires:
- **Frozen tables under a lease:** bcdev `itest:bcdev` acquires→beginPublish→publish→endPublish→
  holds+renews→runs `RunMutant` with `(epoch,token,attemptId)`→releases, still reproducing **3/10/3**
  + all 5C-A probes; al-runner **3/13/0** unchanged.
- **Slow-run-under-renew:** a deliberately slow `RunMutant` while the heartbeat renews; assert it
  completes and no other acquire succeeds during it (op-marker held).
- **Steal-refused-during-op:** while A's `RunMutant`/publish op-marker is set (even past TTL), B's
  `AcquireLease` returns `operation-in-flight`; A completes and clears; then B acquires.
- **Abort-mid-AL-call:** abort A's client while the AL `RunMutant` is live; assert release cannot
  admit B (op-marker unresolved) and the container quarantines for recycle.
- **Lost-renew reconciliation:** drop a successful renew's ack; assert the single-flight retry proves
  ownership and no false quarantine.
- **Lost-publish safety:** dispatch a publish, lose its response; assert no stale completion can land
  after any steal (op-marker blocks B) and the container quarantines.
- **v1-vs-v2 handshake:** a v1-style empty `HarnessInfo` against the v2 harness fails before publish.
- **Unit:** LeaseClient shaping/mapping; idempotent acquire (nonce); renew retry/single-flight;
  lease-lost verdict invalidation + scheduling-guard on `run`; protocol handshake; the quarantine
  taxonomy. Red-check each by mutation.

## 10. Exit criteria
- `LethAL Control`: `LC Lease` + op-marker + Acquire/Renew/Release/BeginPublish/EndPublish + pre-seed
  + conditional `ClearActiveIf` + two-phase `RunMutant` fence + v2 handshake.
- bcdev `runSession`: acquire→beginPublish/endPublish→renew→run(with token)→release; op-in-flight and
  lease-lost handled per §6/§8; verdicts invalidated on lease-loss; every work-plane dispatch guarded.
- Live gate: 3/10/3 under a held lease + all blocking mid-run probes green; al-runner 3/13/0.
  Differing verdict / failing probe → BLOCKED.
- typecheck clean, unit green, biome clean on touched files.

## 11. Evidence appendix — atomicity spike (2026-07-24, Cronus281, DONE)
Throwaway `LC Lease Spike` (table + `AcquireLease`/`ResetLease`, LockTable logic per §4). 8 concurrent
`AcquireLease` ×5 rounds + held-refusal + expiry-steal:
- **LockTable serializes** — exactly 1 of 8 granted each round, final `Epoch = 1`.
- **Insert-phantom caught** — round 1 (row absent) had 4/8 `Internal_EntityWithSameKeyExists`; rounds
  2-5 (row present) clean → **pre-seed the row at install/upgrade** (§4).
- **Held-refusal** and **expiry-steal (epoch 1→2)** on an *idle* lease confirmed.
Spike unpublished. NOTE: the spike proved acquire-only serialization on an *idle* lease; it did NOT
cover the op-marker / mid-run / publication paths — those are §9's new blocking probes.

## 12. Adversarial review disposition (Revision 1 → 2; both models BLOCK)

| # (sol/fable) | Finding | Disposition in R2 |
|---|---|---|
| sol1 / fable1 | "Same-transaction" fence impossible (Commits release locks; unconditional ClearActive wipes a stealer's row → false survived w/ clean attestation) | **Adopted** — §5 two-phase fence (claim / run-unlocked / verify-and-clear) + §5 conditional `ClearActiveIf` |
| sol2 / fable2 | Holding LockTable across the run starves renew/expiry → deadlock/false-quarantine | **Adopted** — lock held only in the two short critical sections; renew/acquire run freely during phase 2 |
| sol3 / fable3 | TTL bound is false comfort; a client abort doesn't cancel the server run | **Adopted** — §4 op-marker blocks steal of an in-flight op; §5 phase-3 re-validation; hung op → recycle, never stolen |
| sol4 | Publication only cooperatively serialized, not fenced (late publish replaces B's binary) | **Adopted (scoped)** — §6 beginPublish/endPublish op-marker exclusion + recycle; honest that it's exclusion, not a per-publish install-token |
| sol5 | Releasing a quarantined lease admits B while A's uncancelled op runs | **Adopted** — §4 Release refuses while `Op Kind <> none`; §6 release only if no op in flight |
| sol6 / fable5 | Lease-loss doesn't invalidate accumulated verdicts; §G gate misses an already-clean-attested one; `run()` not safety-guarded; lease-invalid collides with abort/§G | **Adopted** — §6 unconditional verdict invalidation on lease-loss + guard every dispatch; §8 distinct `lease-lost` operation, skip §G diagnosis |
| sol7 / fable4 | Lost renew/acquire ack → false quarantine / orphaned lease | **Adopted** — §4 idempotent acquire (client nonce) + renew grants on matching epoch even if momentarily expired + retry-once; §6 single-flight heartbeat |
| sol8 | v1→v2 not incompatible-by-construction → old client publishes unfenced | **Adopted** — §7 v2 `HarnessInfo(clientProtocol)` required arg; v1 fails before publish |
| sol9 | `DataPerCompany=false` is per-tenant, not per-container | **Adopted (scoped)** — §4/§7 lease is per (tenant, container); multi-tenant-shared-app-state container needs a host-level lease (flagged out of scope; itests are single-tenant) |
| sol10 | R1 probes pass while the mid-run failure survives | **Adopted** — §9 blocking mid-run probes (slow-run-under-renew, steal-refused-during-op, abort-mid-AL-call, lost-renew/publish, v1-vs-v2) |
| fable6 / sol5 | Post-quarantine release contradicts the work-plane-latch contract | **Adopted** — §6 release is op-gated + treated as safe teardown only when no op in flight |
| — | Pre-seeded row; epoch+token; server-clock expiry; token never leaked; release-sets-0DT; lease-invalid-is-error-never-verdict principle | **Confirmed sound** by both models — kept |
