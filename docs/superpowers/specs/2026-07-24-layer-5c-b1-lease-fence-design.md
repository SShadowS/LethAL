# Layer 5C-B1 — Machine-Global Lease + Fence (Design)

> Status: **Revision 3** (after two rounds of two-model adversarial review — gpt-5.6-sol +
> claude-fable-5). R1 (both BLOCK): the one-transaction fence was impossible (BC `Commit` releases
> locks; a client abort doesn't cancel the server run). R2 reshaped to a two-phase fence + operation
> marker; both confirmed the core **directionally sound** but found the op-marker *lifecycle* leaks a
> false quarantine on healthy contention, that a restart doesn't clear the committed marker, and that
> publish/release/renew edges need idempotent state-machine transitions. R3 closes those. Predecessors
> 5A/5B/5C-A merged. Successors: 5C-B2 (`RunChunk`), 5C-B3 (cancel/preemption), 5D (pool). Full
> two-round disposition at the end.

## 1. Goal and honest framing

Make **two concurrent LethAL sessions safe against one container**. The `LethAL Control` extension
owns a **machine-global lease + a server-side operation marker + a server generation**. `RunMutant`'s
`leaseEpoch`/`leaseToken` become a **required two-phase fence**. Because 5C-B1 has **no cancellation**
(5C-B3), an operation that is *genuinely still in flight or of unknown termination* is never stolen —
it is either resolved by its still-alive owner, or (owner dead) it strands the container until an
**authenticated recover/recycle**. This enforces 5C-A's two stated-but-unenforced preconditions (§I).

**The fence, honestly (the R1/R2 corrections):**
- The lease lock is held only in **short critical sections**, never across a run.
- No-overlap is enforced by an **operation marker** (`Op Kind`): `AcquireLease` will not grant while
  another session's op is unresolved AND the holder is presumed alive.
- Stale-write rejection is enforced by **re-validating (epoch, token, generation) in a second short
  critical section at the end of `RunMutant`**, sharing ONE transaction with a **conditional
  `ClearActiveIf`** that clears only this attempt's tuple.
- Healthy contention (a holder alive and renewing) yields `operation-busy` → the caller backs off,
  **no durable quarantine**. Only an **orphaned** op (holder presumed dead) → durable
  `container-needs-recycle`.
- Recovery is an explicit authenticated sequence, because the marker is a **committed table row that
  survives a restart** (R2 finding): restart the NST (proves no AL op survives) → `ForceResetLease`
  (mints a new **server generation**, clears the marker) → `clear-quarantine`.

5C-B1 does not add `RunChunk`, cancel, or preemption. **Success** = frozen bcdev **3/10/3** with a
lease held+renewed+released around the session, al-runner **3/13/0**, PLUS the blocking mid-run /
lifecycle probes (§9).

## 2. Roadmap
| Layer | Delivers |
|---|---|
| 5C-A (done) | `RunMutant` (activate+run+clear) + per-run attestation fence; single-session |
| **5C-B1 (this)** | Lease + op marker + server generation; two-phase `RunMutant` fence + `ClearActiveIf`; publish op state machine; busy/orphaned taxonomy; authenticated recover/recycle; lease-lost verdict invalidation; single-tenant-container enforcement; bidirectional protocol v2 |
| 5C-B2 | Server-side batch runner (`RunChunk`) |
| 5C-B3 | Cancel + preemption (auto-recovery of a hung op, no recycle) |
| 5D | Pool + scheduling |

## 3. Non-goals
- No `RunChunk` (5C-B2). No cancel/preemption/auto-steal-of-an-in-flight-op (5C-B3).
- No al-runner changes (never calls `RunMutant`).
- No protection against a **non-LethAL** publisher to the container.
- No multi-tenant support: 5C-B1 **enforces a single-tenant container** (§7) rather than fencing
  service-instance-wide publication across tenants.

## 4. The lease + operation marker + server generation (`LethAL Control`)

Table **`LC Lease`** (id 71006, `DataPerCompany = false`, `InherentPermissions = RIMD`), single row,
constant PK. Fields:
- `Owner` (Text[100]) — `host:pid:runId`, diagnostics.
- `Server Generation` (Text[32]) — random; minted at pre-seed AND by every `ForceResetLease`. Baked
  into EVERY fence. Cross-recycle safety derives from this + token entropy, **not** from epoch
  monotonicity (which resets on rebuild — R2 minor).
- `Epoch` (Integer) — bumped on each acquire (and on release, see below).
- `Token` (Text[32]) — fresh nonce per acquire; cleared on release.
- `Expires At` (DateTime) — server-clock deadline. `Held` derived as `Token <> ''`.
- `Op Kind` (Option `none,publish,run`), `Op Attempt Id` (Text[64]), `Op Started At` (DateTime).
- `Last Completed Op Seq` (Integer) + `Op Seq` (Integer) — monotonic op sequence: a **tombstone** so
  a delayed `Begin*`/`End*` for a completed attempt cannot reopen/reclear a later op (sol#4).

**Pre-seed.** `LC Control Install` + `LC Control Upgrade` insert the row if absent (empty, `Op Kind =
none`, a fresh `Server Generation`). They do NOT reset an existing row (recovery is §8's job).

**`AcquireLease(owner, ttlSeconds, clientNonce) →`** under `LockTable`:
- `Op Kind <> none` (an op is marked):
  - AND lease **not** expired beyond a grace (`CurrentDateTime <= Expires At + graceMs`) → holder
    presumed alive → **`{granted:false, reason:"operation-busy", holder, expiresAt}`**. Caller backs
    off (bounded, jittered) — **no durable quarantine** (sol#1).
  - AND expired beyond grace → holder presumed dead → **`{granted:false, reason:"operation-orphaned"}`**
    → caller writes durable `container-needs-recycle` (§8).
- Else free (`Token = ''`) OR expired-and-idle (`Op Kind = none` AND `CurrentDateTime > Expires At`) →
  grant: `Epoch += 1`, new `Token`, set `Owner`/`Expires At`, `Op Kind = none`; store `clientNonce`.
  Commit; return `{granted:true, epoch, token, serverGeneration, expiresAt}`.
- Else (held, unexpired, idle) → `{granted:false, reason:"held", holder, expiresAt}`.
- **Idempotent (sol#7B):** a retried acquire with the SAME `clientNonce` that finds the lease already
  granted to that nonce returns the same `{epoch, token, serverGeneration}` — a lost acquire-ack never
  orphans a lease.

**`RenewLease(epoch, token, generation, ttl) →`** under `LockTable`: if `(epoch, token, generation)`
match the current row → extend `Expires At`, Commit, `renewed:true` — **even if momentarily past
`Expires At`** (a matching token proves no steal; and an op marker would have blocked a steal). Else
`renewed:false`. Idempotent; retry-once on a lost ack before concluding loss.

**`ReleaseLease(epoch, token, generation) →`** under `LockTable`: only if `(epoch, token, generation)`
match AND `Op Kind = none`. Then **invalidate renewal credentials (sol#5):** `Token = ''`, `Epoch +=
1`, `Expires At = 0DT` — so a delayed renew for the old `(epoch, token)` now fails and cannot
resurrect a released lease. Keep the pre-seeded row. If `Op Kind <> none` → refuse
(`released:false, reason:"op-in-flight"`). Idempotent via the epoch bump (a repeat finds a mismatched
token → no-op success).

**Publish op state machine (sol#4, fable R2-5):**
- `BeginPublish(epoch, token, generation, attemptId)` — under `LockTable`: require match + `Op Kind =
  none` AND `attemptId`'s seq `> Last Completed Op Seq`. Set `Op Kind = publish`, `Op Attempt Id =
  attemptId`, assign a new `Op Seq`. Idempotent: a repeat with the same live `attemptId` → success.
- `EndPublish(epoch, token, generation, attemptId, outcome)` — clear only if `Op Kind = publish` AND
  `Op Attempt Id = attemptId`. Set `Op Kind = none`, `Last Completed Op Seq = Op Seq`. Idempotent: a
  repeat when the attempt is already tombstoned → `{ended:true, alreadyCompleted:true}` (never
  reopens/reclears a later op). **Called on every confirmed terminal outcome — success OR a
  deterministic failure** (a compile/validation/HTTP rejection is server-known-terminal; only a
  genuinely-unknown publish result leaves the marker — §8).
- `GetOperationStatus(epoch, token, generation, attemptId) → {opKind, attemptId, completed}` — for
  lost-ack reconciliation of any op (publish or run).

**Time authority:** server-clock (`CurrentDateTime`). `graceMs` (a few × the renew period) absorbs
clock jitter so a briefly-late renew never flips a live holder to `orphaned`.

## 5. Two-phase `RunMutant` fence

`RunMutant` gains required `leaseEpoch`, `leaseToken`, `serverGeneration`, `attemptId`.

**Phase 1 — claim (short `LockTable` critical section, one transaction):** `Get('')`. Require
`(leaseEpoch, leaseToken, serverGeneration)` match AND `Op Kind = none`. **Like renew, a match is
honored even if momentarily past `Expires At`** (sol#6 — same holder the design lets renew recover);
if expired, atomically extend `Expires At`. Set `Op Kind = run`, `Op Attempt Id = attemptId`, assign
`Op Seq`, `SetActive(...)`. `Commit` (releases the lock — by design). On any mismatch → `status:
lease-invalid`, touch nothing.

**Phase 2 — run (no lease lock held), behind a catchable boundary (sol#3, fable R2-1):**
`RunOneMethod` is invoked via `Codeunit.Run`/`if TryFunction` so a **server-known terminal error**
(test-framework/AL exception) does NOT unwind past phase 3 — it is captured and flows to phase 3 as a
terminal `error` outcome. Attestation recorded here (5C-A §G).

**Phase 3 — verify-and-clear (short `LockTable` critical section, ONE transaction, no internal
`Commit` — sol#8):** `Get('')`. If `(leaseEpoch, leaseToken, serverGeneration)` match AND `Op Kind =
run` AND `Op Attempt Id = attemptId`: in the SAME transaction, `ClearActiveIf(targetAppId, artifactId,
mutantId)` (clears `LC Mutation Active` only if it equals this attempt's tuple; **`ClearActiveIf` must
not call `Commit`** — R2 fix) AND set `Op Kind = none`, `Last Completed Op Seq = Op Seq`; then exactly
one final `Commit`; return `status: ran` (with the terminal pass/fail/error from phase 2) + result +
attestation. Else → `status: lease-invalid`, do not touch `LC Mutation Active`, leave the result
unrecorded.

**Marker never stranded on a server-known outcome.** Because phase 2 is catchable, every terminal
pass/fail/error reaches phase 3 and clears the marker. The marker persists ONLY when termination is
genuinely unknown — a true hang, or a connection drop where the client cannot tell if phase 3 ran. For
the latter, the still-alive owner reconciles via `GetOperationStatus` and, if the server shows the op
uncleared but the owner knows the call returned, calls **`RecoverOp(epoch, token, generation,
attemptId)`** (clears only the owner's own marker; token match proves no interleaving) — recovering a
live container without a recycle. Only an owner that is truly dead leaves an orphaned marker → §8.

## 6. Client integration (runner)

`LeaseClient` (`packages/runner/src/lease.ts`): `acquire`, `renew`, `release`, `beginPublish`,
`endPublish`, `getOperationStatus`, `recoverOp`. Shaping mirrors `RunMutantTransport`/`HarnessVerifier`.

`runSession` (bcdev / authoritative):
1. **Acquire before deploy()** with a client nonce. `held`/`operation-busy` → bounded
   backoff-with-jitter (default, not optional — fable7), then `LeaseUnavailableError` if it never
   frees. `operation-orphaned` → durable `container-needs-recycle`, abort.
2. **Publication fence:** `beginPublish` → altool publish → `endPublish` on **every** confirmed
   terminal (success OR deterministic failure — sol#3). A publish of genuinely-unknown result +
   inability to reconcile via `getOperationStatus` → leave the marker → quarantine.
3. **Single-flight renew heartbeat** at `ttl/3`; retry-once on a lost ack; only `renewed:false` is loss.
4. Every `RunMutant` passes `(epoch, token, serverGeneration, attemptId)`.
5. **Release in `finally`** only when no op is in flight; a `RunMutant` that returned a clean terminal
   already cleared its own marker in phase 3, so a normal session releases cleanly. On a phase-3
   ambiguity, `getOperationStatus` + `recoverOp` first; only an unreconcilable marker is left.

**Lease-lost verdict invalidation — enforcement point + scope (fable R2-3, sol#6):** on lease-loss
(`renewed:false` unreconcilable, `RunMutant` `lease-invalid`, or a mid-session recycle), latch
`SessionSafety` (`reason: lease-lost`), stop scheduling, and **at session end — after the batch loop
breaks, before `buildReport` — invalidate the CURRENT batch's verdicts** (the artifact deployed under
the lost lease) via `invalidateBatchVerdicts`. Earlier batches stand: every `RunMutant` in them was
individually phase-1/phase-3 fence-validated, so their verdicts are sound (not over-invalidated). Do
NOT rely on the §G attestation gate (it skips an already-clean-attested artifact). **Guard every
work-plane dispatch — `deploy`, `activate`, AND `run`** with the latch (today `runOnce` doesn't check
it — sol#6).

**Quarantine taxonomy:**
- `container-needs-recycle` (durable, tier-keyed) — `operation-orphaned` on acquire, or a session
  ending with an unreconcilable marker. Cleared only by the §8 recovery sequence.
- `lease-lost` with a clean container (epoch mismatch, no stranded op) — latch + abort + invalidate
  THIS session's current batch; **no durable tier quarantine** (the container is fine — fable#4).

## 7. Single-tenant enforcement + protocol v2

**Single-tenant (sol#7/#9, the chosen fix).** App publication is service-instance-wide, so a
per-tenant lease cannot fence two tenants publishing to one container. 5C-B1 therefore **refuses a
multi-tenant / shared-publication container**: `HarnessInfo` (or a dedicated qualification action)
reports the container's tenant count / publication scope; the client's pre-deploy harness check fails
with a typed error if `> 1` tenant (or shared publication) — before any publish. With one tenant, the
per-`(tenant, container)` lease is exactly per-container. The itests use tenant `default` (one tenant),
so the gate is unaffected. Multi-tenant support (a split service-instance publication lease + tenant
execution lease) is deferred.

**Protocol v2 — incompatible by construction (sol#8).** v2 `HarnessInfo` **requires a `clientProtocol`
argument**. A v1 client sends `{}` (no arg) → the v2 server returns an incompatibility error → the v1
client's HarnessVerifier (Task 8 §H: required + unconditional BEFORE compile/publish) fails up front,
before any publish. A v2 client vs a v1 server: `protocolVersion: 1 < 2` → fails before deploy.
(Live-probe that a missing required OData parameter actually errors, not defaults — sol#8.)

## 8. Errors, statuses, recovery
- `RunMutant` status **`lease-invalid`** → transport `outcome:"error"`, distinct
  `operation:"lease-lost"` (NOT `in-flight-unknown`, NOT a bare error — avoids the
  two-consecutive-errors abort and the §G diagnosis). `requiresUnsafeLatch("lease-lost")` true.
- `LeaseUnavailableError` (extends `Error` directly) — acquire `held`/backoff-exhausted. Aborts.
- **Recovery sequence for `container-needs-recycle`** (R2#2): (1) restart the NST/container — this
  kills any surviving AL op (SingleInstance + the running session die); (2) `ForceResetLease` — an
  authenticated operator action that mints a NEW `Server Generation`, sets `Op Kind = none`, clears
  `Token`, bumps `Epoch`; safe because the restart proved no AL op survives; (3) `clear-quarantine`.
  A mere restart WITHOUT `ForceResetLease` does NOT clear the committed marker — the two steps are
  both required and must be documented as one procedure. A stale pre-recovery client (old
  `Server Generation`) is rejected by every fence after step 2.
- First-reason-wins for quarantine records.

## 9. Testing & the gate (blocking mid-run + lifecycle probes)
- **Frozen tables under a lease:** bcdev acquires→beginPublish→publish→endPublish→holds+renews→runs
  `RunMutant` with the full token tuple→releases, reproducing **3/10/3** + all 5C-A probes; al-runner
  **3/13/0**.
- **Slow-run-under-renew:** slow `RunMutant`, heartbeat renews, completes; no other acquire succeeds
  during it (`operation-busy`, no quarantine — sol#1).
- **Healthy-contention-no-quarantine:** B contends while A runs+renews; B gets `operation-busy`; A
  finishes+releases; B acquires; assert NO durable quarantine was written.
- **Orphaned-op:** A sets a marker then dies (no renew) past the grace; B gets `operation-orphaned` →
  quarantine; the §8 recovery (restart + ForceResetLease + clear) restores it; assert a stale-A fence
  call is rejected by the new server generation.
- **Catchable-runner-error:** a `RunMutant` whose test framework throws → phase 3 clears the marker,
  returns a typed error, NO recycle (sol#3).
- **Deterministic-rejected-publish:** a publish that altool rejects → `endPublish` clears the marker,
  NO recycle.
- **Delayed-EndPublish / delayed-renew-after-release:** a duplicate/delayed `EndPublish` cannot clear a
  later op (tombstone); a delayed renew after release cannot resurrect the lease (credentials cleared).
- **Lost-ack reconciliation:** drop a renew/publish/phase-3 ack; `getOperationStatus`/`recoverOp`
  avoids false quarantine.
- **v1-vs-v2 handshake:** empty `HarnessInfo` against v2 fails before publish. **Multi-tenant refusal:**
  a (simulated) >1-tenant container is refused before publish.
- **Unit:** LeaseClient shaping/mapping; idempotent acquire (nonce) + renew retry/single-flight +
  release credential-invalidation + publish state-machine/tombstone + getOperationStatus/recoverOp;
  busy/orphaned classification; lease-lost invalidation enforcement (session-end, current batch) +
  dispatch guards. Red-check each by mutation.

## 10. Exit criteria
- `LethAL Control`: `LC Lease` (with server generation + op marker + op-seq tombstone) +
  Acquire/Renew/Release/BeginPublish/EndPublish/GetOperationStatus/RecoverOp/ForceResetLease +
  pre-seed + `ClearActiveIf` (no internal Commit) + two-phase `RunMutant` (catchable phase 2, one-txn
  phase 3) + v2 `HarnessInfo(clientProtocol)` + tenant-count qualification.
- bcdev `runSession`: acquire (backoff) → beginPublish/endPublish → single-flight renew → run(token) →
  release; busy/orphaned + lease-lost + recovery handled; verdicts invalidated at session end for the
  current batch; every dispatch guarded.
- Live gate: 3/10/3 under a held lease + all mid-run/lifecycle probes green; al-runner 3/13/0.
  Differing verdict / failing probe → BLOCKED.
- typecheck clean, unit green, biome clean on touched files.

## 11. Evidence appendix — atomicity spike (2026-07-24, Cronus281, DONE)
Throwaway `LC Lease Spike`: 8 concurrent `AcquireLease` ×5 → exactly 1 grant/round, `Epoch = 1`;
insert-phantom caught (→ pre-seed); held-refusal + idle expiry-steal (epoch 1→2) confirmed. The spike
covered acquire-only serialization on an IDLE lease; the op-marker lifecycle, mid-run, publication,
recovery, and busy/orphaned paths are §9's new probes (not yet spiked).

## 12. Adversarial review disposition

### Round 1 (both BLOCK) → R2
| # | Finding | R2 disposition |
|---|---|---|
| sol1/fable1 | one-transaction fence impossible; unconditional ClearActive wipes stealer | two-phase fence + `ClearActiveIf` + op-marker |
| sol2/fable2 | lock across run starves renew/steal | lock only in short critical sections |
| sol3/fable3 | TTL false comfort; client abort doesn't cancel run | op-marker blocks steal of an in-flight op; hung → recycle |
| sol4 | publication not resource-fenced | beginPublish/endPublish op-marker exclusion |
| sol5 | releasing quarantined lease admits B over uncancelled op | release op-gated |
| sol6/fable5 | lease-loss doesn't invalidate verdicts; run() unguarded; lease-invalid collides | invalidate + guard + distinct lease-lost op |
| sol7/fable4 | lost renew/acquire ack → false quarantine/orphan | idempotent acquire nonce + renew-on-match |
| sol8 | v1→v2 not incompatible-by-construction | v2 `HarnessInfo(clientProtocol)` required arg |
| sol9 | per-tenant ≠ per-container | (deferred to R3) |
| sol10 | R1 probes miss mid-run | blocking mid-run probes |

### Round 2 (sol BLOCK, fable SHIP-WITH-FIXES) → R3
| # (sol/fable) | Finding | R3 disposition |
|---|---|---|
| sol1 | healthy contention writes a false durable recycle quarantine | **§4 busy/orphaned taxonomy** — `operation-busy` (alive) backs off, no quarantine; only `operation-orphaned` (expired past grace) quarantines |
| sol2/fableR2-2 | "recycle clears state" false — marker is a committed row surviving restart | **§8 recovery sequence** — restart + `ForceResetLease` (new **Server Generation**, §4) + clear-quarantine; documented as one procedure |
| sol3/fableR2-1 | phase-2 error / terminal-publish-failure strands the marker → false recycle | **§5 catchable phase-2 boundary** → phase-3 always clears on a server-known terminal; `endPublish` on every terminal; `RecoverOp` for the live owner; marker left only on genuinely-unknown termination |
| sol4/fableR2-5 | beginPublish/endPublish lack CAS + idempotency (delayed EndPublish clears a later op) | **§4 publish state machine** — attempt-id match + `Op Seq` tombstone + `GetOperationStatus`; idempotent begin/end |
| sol5 | delayed renew resurrects a released lease | **§4 Release invalidates credentials** (clear Token, bump Epoch) |
| sol6 | phase-1 rejects a momentarily-expired holder renew permits | **§5 phase-1 = renew semantics** (honor matching token past expiry, extend atomically) |
| sol7/fable | per-tenant markers don't fence service-instance-wide publish | **§7 enforce single-tenant container** (refuse >1 tenant before publish); split-lock multi-tenant deferred |
| sol8 | phase 3 must be one txn; `ClearActiveIf` must not internal-Commit; validate `Op Kind=run` | **§5 phase-3 one transaction, no internal Commit, validate Op Kind + attempt** |
| fableR2-3 | lease-lost invalidation enforcement point + scope unspecified | **§6 invalidate at session-end, current-batch scope**; earlier fence-validated batches stand |
| fableR2-4 | epoch-monotonicity-across-recycle over-claimed | **§4 cross-recycle safety = server generation + token entropy, not epoch** |
| fable7 | acquire has no waiter | **§6 bounded backoff-with-jitter is the default** |
| — | two-phase core, steal-refused-during-op, release-op-gated, v2-by-arg, recycle-mid-run-fails-closed | **Confirmed sound** by both models |
