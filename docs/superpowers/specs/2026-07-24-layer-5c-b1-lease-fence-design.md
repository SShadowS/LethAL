# Layer 5C-B1 — Machine-Global Lease + Fence (Design)

> Status: draft for review (pre-adversarial-pass). Predecessors: 5A (deployment identity), 5B
> (client-side hardening), **5C-A (server-side `RunMutant` primitive + attestation fence — merged)**.
> This is the first slice of 5C-B. Successors: 5C-B2 (server-side batch runner, `RunChunk`), 5C-B3
> (cooperative cancel + preemption), 5D (pool + scheduling).
>
> The server-side-lease atomicity assumption was **live-spiked on Cronus281 before this spec** (see
> §11) — the spike confirmed AL `LockTable` serializes concurrent acquires AND caught the
> insert-phantom race that §4 pre-seeds around.

## 1. Goal and honest framing

Make **two concurrent LethAL sessions safe against one container** by adding a **machine-global
lease** owned by the `LethAL Control` extension, and turning `RunMutant`'s reserved
`leaseEpoch`/`leaseToken` params into a **required, validated fence**: the resource *rejects* a stale
write instead of a client checking after the fact. This closes the two preconditions 5C-A stated but
did not enforce (§I): no-concurrent-publication and one-instrumented-target-per-container become
enforced-by-fence rather than assumed.

5C-B1 does **not** add the server-side batch runner (`RunChunk`), cooperative cancel, or preemption —
those are 5C-B2/B3, additive on top of the lease. Success = **the frozen bcdev verdict table (3
killed / 10 survived / 3 no-coverage) reproduced with a lease acquired, held, renewed, and released
around the whole session**, al-runner unchanged (3/13/0), PLUS the concurrency/fence probes (§9).

**The fence, precisely.** 5C-A's artifact guard is a *detector* (it reads the registry and compares).
The lease makes `RunMutant` a *fence*: at the top of the call, in the SAME `LockTable` transaction as
activation, it requires the presented `(leaseEpoch, leaseToken)` to equal the current lease row and
be unexpired. A stranded holder whose lease expired (and was stolen by another session, bumping the
epoch) is rejected — the killing interleaving from 5A's design (A hangs, lease expires, B steals, A's
late write must not land) cannot corrupt a verdict.

## 2. Position in the roadmap

| Layer | Delivers |
|---|---|
| 5C-A (done) | `LethAL Control` extension + `RunMutant` (activate+run+clear) + per-run attestation fence; single-session, no lease |
| **5C-B1 (this)** | Machine-global lease (epoch/token, server-side in LethAL Control) covering publication + `RunMutant`; `RunMutant` gains a required validated `(leaseEpoch, leaseToken)` fence; lease-lost latch; **protocol v2** |
| 5C-B2 | Server-side batch runner: mutant-plan table, `RunChunk` (many mutants per call) |
| 5C-B3 | Cooperative cancel + preemption |
| 5D | Container pool + scheduling |

## 3. Explicit non-goals (do NOT build here)
- **No server-side batch runner / `RunChunk`.** `RunMutant` stays one-method-per-call. The lease is
  validated per call; batching is 5C-B2.
- **No cooperative cancel or preemption.** A session that loses its lease latches and stops; it does
  not try to cancel an in-flight op (that needs 5C-B3's terminal signal, which 5B/5C-A do not have).
- **No al-runner changes.** al-runner is a different substrate (local files, its own process, no
  shared container) and never calls `RunMutant`. The lease is bcdev-only.
- **No protection against a non-LethAL publisher.** The lease serializes LethAL-vs-LethAL. A foreign
  altool publish to the container is out of scope (5C-A precondition 1 is *narrowed*, not removed:
  "no concurrent LethAL session" is now enforced; "no external tool" remains an assumption).
- **No cross-host coordination.** "Machine-global" = one host, many processes. The lease lives in the
  container (reachable by any process/host that can hit its OData), so cross-host is a free
  consequence, but it is not a designed requirement or tested.

## 4. The lease (server-side, in `LethAL Control`)

New table **`LC Lease`** (id 71006, `DataPerCompany = false`, `InherentPermissions = RIMD`), a single
row keyed by a constant `Primary Key` (`''`) — **one lease per container** (the container is the
contention unit; there is exactly one `LethAL Control` per container). Fields:
- `Owner` (Text[100]) — client-supplied `host:pid:runId`, diagnostics only.
- `Epoch` (Integer) — monotonic generation, `+1` on every successful acquire (including a steal).
- `Token` (Text[32]) — a fresh random nonce per acquire (32-hex from `CreateGuid`), the holder secret.
- `Expires At` (DateTime) — server clock (`CurrentDateTime`) deadline.

**Pre-seed (the spike's finding, §11).** `AcquireLease` must never `Insert` — a non-existent row
cannot be `LockTable`-locked, so concurrent inserts race (`Internal_EntityWithSameKeyExists`). The
`LC Control Install` AND `LC Control Upgrade` codeunits therefore **insert the singleton `LC Lease`
row (empty, `Expires At = 0DT`) if absent**, alongside the existing web-service reconcile. Then every
`AcquireLease` is a pure lock → read → modify of an existing row.

**Actions (OData, on `LC Control API`; camelCase body keys):**
- `AcquireLease(owner, ttlSeconds) → {granted, epoch, token, expiresAt}` — under `LockTable`: `Get('')`
  (row is pre-seeded, always present); if `Expires At = 0DT` OR `CurrentDateTime > Expires At`
  (free/expired) → grant: `Epoch += 1`, new `Token`, set `Owner`, `Expires At = CurrentDateTime +
  ttl`, `Modify`, `Commit`, return `granted:true` + epoch/token/expiresAt. Else `granted:false` +
  `holder`/`expiresAt` (never leak the token).
- `RenewLease(epoch, token, ttlSeconds) → {renewed, expiresAt}` — under `LockTable`: if `(epoch,
  token)` equal the current row AND not expired → extend `Expires At`, `Commit`, `renewed:true`. Else
  `renewed:false` (the holder lost the lease: it expired and was stolen, or the token is stale).
- `ReleaseLease(epoch, token) → {released}` — under `LockTable`: if `(epoch, token)` match → set
  `Expires At = 0DT` (free) — do NOT delete the row (keep it pre-seeded), `Commit`. Idempotent;
  a mismatched release is a no-op (`released:false`).

**Time authority.** Expiry is judged server-side against `CurrentDateTime`. The client's TTL/renew
timers are advisory; the BC server clock alone decides whether a lease is expired, so client-server
skew is irrelevant. (Spike confirmed: a 2s-TTL lease was stealable after 3.5s, epoch bumped 1→2.)

## 5. The fence — `RunMutant` validates the lease

`RunMutant`'s `leaseEpoch`/`leaseToken` params change from *reserved-and-rejected-if-nonempty* to
**required and validated**. At the top of `RunMutant`, in the SAME `LockTable`+transaction as the
activation (`SetActive` … `Commit`):
1. `LC Lease.LockTable(); Get('')`. Require `leaseEpoch = Epoch` AND `leaseToken = Token` AND
   `CurrentDateTime <= Expires At`. On any failure → `status: lease-invalid`, run nothing, do not
   activate, do not clear anything not ours.
2. Only then `SetActive` + run the one method + `ClearActive`, all before `Commit`.

Because acquire (which bumps `Epoch` under `LockTable`) and this validate-then-activate both take the
same table lock, a steal cannot interleave between validate and activate: either `RunMutant` holds
the lock first (validates the current epoch, activates, commits — the steal waits) or the steal holds
it first (bumps epoch — `RunMutant`'s subsequent validate sees the new epoch and returns
`lease-invalid`). This is the atomic fence.

`RegisterArtifact` stays **in-process** (target install/upgrade), no token — publication is serialized
by *exclusion* (only the lease-holder got to publish), and the existing artifact guard + attestation
(5C-A §G) already reject a replaced/stale binary. The lease does not add a second registry fence.

**Empty lease is rejected** (protocol v2, §7): a `RunMutant` with empty `leaseEpoch`/`leaseToken`
returns `lease-invalid`. There is no unfenced execution path.

## 6. Client integration (runner)

New `LeaseClient` (`packages/runner/src/lease.ts`) — `acquire(owner, ttlSeconds) → Lease {epoch,
token, expiresAt}`, `renew(lease, ttlSeconds) → boolean`, `release(lease)`. OData request-shaping
mirrors `RunMutantTransport`/`HarnessVerifier` (Basic auth, company/tenant params, manual
AbortController timeout); own methods, not `postOData`.

`runSession` (bcdev / authoritative only):
1. **Acquire before deploy()** — a session with no lease never publishes or runs. Acquire failure
   (`granted:false`) → the container is busy with another session → fail loudly (a typed
   `LeaseUnavailableError`), not a verdict. `owner = host:pid:runId`.
2. **Renew heartbeat** — a timer renews at `ttl/3` for the whole session (publish + all mutants can be
   minutes). `ttl` MUST exceed the longest single `RunMutant` (a slow-but-alive run must not lose the
   lease). Rec: `ttl = max(2 × baselineTimeout, 120s)`, renew at `ttl/3`. A `renew → false` is a
   lease-loss (§ latch).
3. **Pass `(epoch, token)` to every `RunMutant`** via `RunMutantTransport` (bound at deploy, like the
   artifact identity).
4. **Release in `finally`** — best-effort; even without it the lease expires. A quarantined session
   still releases (frees the container faster for the next session).

**Lease-lost latch** (analogous to 5B's in-flight-unknown): a `renew:false`, a `RunMutant`
`lease-invalid`, or an acquire lost mid-session → latch `SessionSafety` unsafe with reason
`lease-lost`, stop scheduling, quarantine. A `lease-invalid` `RunMutant` is NEVER a verdict — losing
the lease means another session may now own the container, so nothing observed after is trustworthy.
Interaction with the existing in-flight-unknown latch: both set `SessionSafety`; first reason wins
(the more specific stays). `workers === 1` for authoritative still holds (5C-A) — one lease, one
worker.

## 7. Protocol v2

`HarnessInfo.protocolVersion` → **2**. `HarnessVerifier` requires `>= 2` for a 5C-B client
(`MIN_PROTOCOL_VERSION = 2`). Consequences:
- A **v1 client** (5C-A, empty lease) against a **v2 server** → `RunMutant` returns `lease-invalid`,
  and `HarnessVerifier` fails the session up front (protocol too low) — a loud, correct failure, no
  silent unfenced run.
- A **v2 client** against a **v1 server** → `HarnessVerifier` fails (server protocol < 2). The
  operator must upgrade `LethAL Control`.
- The activate+run+clear body is unchanged (roadmap "reuses an internal RunMutantCore; adds token
  validation without changing activate+run+clear") — only the lease gate is added in front.

## 8. Error handling & new statuses/errors
- `RunMutant` status `lease-invalid` (new) — presented lease is empty/stale/expired; ran nothing.
  Transport maps it to `outcome: "error"` + `operation` that drives the **lease-lost latch**, never a
  verdict.
- `LeaseUnavailableError` (typed, extends `Error` directly) — `acquire` returned `granted:false` at
  session start. Aborts the session; distinct from `AlcCompileError`/`ArtifactPrepareError`/
  `DeploymentError` (the typed-errors-extend-Error-directly convention).
- A `renew`/`release` transport failure is classified by 5B's dispatch state: a post-dispatch failure
  during renew is treated as lease-lost (fail-safe: assume we no longer hold it).

## 9. Testing & the gate
- **Frozen tables hold under a lease.** bcdev `itest:bcdev` acquires a lease, holds+renews it across
  the session, runs `RunMutant` with `(epoch, token)`, releases — and still reproduces **3/10/3** +
  all 5C-A protocol/attestation probes. al-runner **3/13/0** unchanged (no lease path). A differing
  verdict = BLOCKED.
- **Concurrency probe** (the real proof, live): two `LeaseClient`s on one container — A acquires, B's
  acquire returns `granted:false`; a `RunMutant` presenting B's (non-current) token → `lease-invalid`.
- **Kill-interleaving / fence probe** (live): A acquires (epoch N), stops renewing, waits past TTL; B
  acquires (steals, epoch N+1); A's late `RunMutant` with `(N, oldToken)` → `lease-invalid`. This is
  THE fence proof.
- **Expiry/renew probe** (live): acquire short TTL; renew keeps it alive; stop renewing → it expires
  → re-acquire succeeds with a bumped epoch. (All three probe shapes already passed in the §11 spike.)
- **Unit**: `LeaseClient` request-shaping + response mapping; the lease-lost latch (renew:false /
  lease-invalid → SessionSafety unsafe, no verdict); protocol-version rejection; `LeaseUnavailableError`
  on acquire-busy.
- **AL**: offline `alc` compile of `LethAL Control` with the lease table + actions + pre-seed;
  live-probe the fence end-to-end.
- Red-check every fix by mutation (`mem:review_discipline`); two-model adversarial review (gpt-5.6-sol
  + claude-fable-5) of THIS spec before the plan; live gate on Cronus281 is the authority.

## 10. Exit criteria
- `LethAL Control` published with `LC Lease` + Acquire/Renew/Release + pre-seeded row + protocol v2;
  `RunMutant` requires+validates `(leaseEpoch, leaseToken)` atomically with activation.
- bcdev `runSession` acquires→renews→releases a lease around every session; the transport passes the
  token; a lost lease latches + quarantines, never a verdict.
- Live gate: bcdev 3/10/3 under a held lease + all 5C-A probes; al-runner 3/13/0; concurrency,
  kill-interleaving, and expiry probes green. Differing verdict / failing probe → BLOCKED.
- typecheck clean, unit suite green, biome clean on touched files.

## 11. Evidence appendix — atomicity spike (2026-07-24, Cronus281, DONE)
A throwaway `LC Lease Spike` extension (table `LCS Lease` + `AcquireLease`/`ResetLease` OData actions,
LockTable acquire logic identical to §4) was published to Cronus281 and driven by a bun client firing
**8 concurrent `AcquireLease`** at a free lease, ×5 rounds, plus held-refusal and expiry-steal checks:
- **LockTable serializes** — every round: exactly **1** of 8 granted, final `Epoch = 1` (not 8). The
  keystone assumption holds.
- **Insert-phantom caught** — round 1 (row absent) had 4/8 callers fail with
  `Internal_EntityWithSameKeyExists`: concurrent `Insert` of the singleton races because a
  non-existent row can't be `LockTable`-locked. Rounds 2-5 (row present) were clean. **Fix folded into
  §4: pre-seed the row at install/upgrade so `AcquireLease` never inserts.**
- **Held-lease refusal**: a second acquire while held → `granted:false`.
- **Expiry steal**: a 2s-TTL lease, after 3.5s, was re-acquired with `Epoch` bumped 1→2.
Spike unpublished after the run (`UnPublish-BcContainerApp`, `mem:bc_container_docker_access`).

## 12. Open items for the adversarial review to attack
- The validate-then-activate atomicity claim (§5): is there ANY interleaving — a steal between
  `RunMutant`'s `Get('')` and its `SetActive`, a renew racing an acquire, a release racing a steal —
  where a stale holder's run still lands as a verdict?
- The renew heartbeat vs the mutant loop: a renew that is dispatched but whose response is lost
  (in-flight-unknown) — does the fail-safe (assume lost) ever falsely quarantine a session that
  actually still holds the lease? Is that acceptable (fail-safe) or a liveness bug?
- TTL vs the longest `RunMutant`: if a single run legitimately exceeds `ttl` (a slow test), the lease
  expires mid-run and another session steals it — the honest run's `ClearActive`/result then lands
  under a stolen lease. Does the atomic fence catch this, or does the `ttl ≥ 2×baselineTimeout`
  bound need to be a hard precondition checked in-code?
- Release-does-not-delete (keep pre-seeded) vs a future migration that expects the row absent.
- Cross-tenant / cross-company: `DataPerCompany=false` means one lease across companies — correct for
  a container-scoped lease, but confirm a multi-company container can't strand it.
