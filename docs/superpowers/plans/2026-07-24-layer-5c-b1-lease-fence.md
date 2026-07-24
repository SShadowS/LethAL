# Layer 5C-B1 — Machine-Global Lease + Fence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make two concurrent LethAL sessions safe against one BC container — a server-side machine-global lease + operation marker in the `LethAL Control` extension, and a required two-phase `leaseEpoch`/`leaseToken` fence on `RunMutant` — so a wrong/stale binary or a racing session can never ship a false verdict, closing 5C-A's two unenforced preconditions.

**Architecture:** `LethAL Control` gains an `LC Lease` table (server generation + epoch + token + operation marker + op-seq tombstone), pre-seeded at install/upgrade, with Acquire/Renew/Release/BeginPublish/EndPublish/GetOperationStatus/RecoverOp/ForceResetLease OData actions. `RunMutant` becomes three short critical sections around an unlocked run (claim → run → verify-and-conditional-clear), never holding the lease lock across a test. A hung/orphaned op is never stolen (no cancellation in 5C-B1) — it quarantines the container for an authenticated restart+ForceResetLease recovery. The runner acquires the lease before deploy, renews via a single-flight heartbeat, passes the token on every RunMutant, and invalidates the current batch's verdicts on lease-loss.

**Tech Stack:** Bun + TypeScript monorepo (`packages/runner`, `packages/schemata`); AL (`extensions/lethal-control`, runtime 16); `alc.exe`/`altool.exe`; live BC on Cronus281.

**Authoritative design:** `docs/superpowers/specs/2026-07-24-layer-5c-b1-lease-fence-design.md` (Revision 4, converged after a live spike + 3 two-model adversarial review rounds). Read it before starting; every task cites its sections.

## Global Constraints
- No `!` non-null assertions (biome `noNonNullAssertion: error`); destructure then check `undefined`.
- `exactOptionalPropertyTypes`: build optional props with `...(v !== undefined ? { k: v } : {})`.
- Typed error classes extend `Error` **directly**, never each other (`LeaseUnavailableError` joins `AlcCompileError`/`ArtifactPrepareError`/`DeploymentError`). Fail loudly on caller-contract violations; never a plausible empty default.
- Generated/AL: web-service `ObjectType` exactly `CodeUnit`; artifact id `/^[0-9a-f]{32}$/`; camelCase OData body keys.
- **AL has no unit-test harness** — verify AL by an offline `alc` compile (`/al-compile` or the `al-compiler` subagent) + live probes on Cronus281. NEVER `bun test` an AL change.
- Verify loop (TS): `bun run typecheck` (separate) → `rm -rf packages/*/dist` (dist trap) → `bun test <pkg>`. Biome only on touched files.
- Live is the authority: a differing frozen verdict (bcdev 3/10/3, al-runner 3/13/0) is a BLOCK. Live itests foreground, never polled.
- Red-check every fix by mutation (`mem:review_discipline`); the `mutation-red-checker` subagent.
- Shell: Git bash on Windows; never `2>nul`. BC container publish/unpublish via the PowerShell tool + `desktop-windows` docker context (`mem:bc_container_docker_access`).
- Preconditions the layer enforces/assumes: single-tenant container (enforced, §7); `workers === 1` for the authoritative backend (5C-A); no non-LethAL publisher.
- `LethAL Control` object ids stay in 71000–71099; the lease table is **71006**.
- Every fence validates `(epoch, token, serverGeneration)` — thread the server generation through EVERY action and every client call.

## File Structure
- `extensions/lethal-control/src/Lease.Table.al` — `LC Lease` (71006). Create. (Task 1)
- `extensions/lethal-control/src/Install.Codeunit.al` + `Upgrade.Codeunit.al` — pre-seed the lease row. Modify. (Task 1)
- `extensions/lethal-control/src/ControlState.Codeunit.al` — lease read/write helpers; `ClearActive` → `ClearActiveIf` (no internal Commit, unconditional in-memory reset). Modify. (Tasks 2–4)
- `extensions/lethal-control/src/ControlApi.Codeunit.al` — the 8 lease OData actions; two-phase `RunMutant`; `HarnessInfo(clientProtocol)`; tenant qualification. Modify. (Tasks 2–5)
- `packages/runner/src/lease.ts` — `LeaseClient` + `LeaseUnavailableError`. Create. (Task 6)
- `packages/runner/src/run-mutant-transport.ts` — pass lease tuple; map `lease-invalid`. Modify. (Task 7)
- `packages/runner/src/backend.ts`, `bcdev-backend.ts` — thread lease into `run()`; bind at deploy. Modify. (Task 7)
- `packages/runner/src/harness.ts` — v2 `clientProtocol` + tenant check. Modify. (Task 5 client side / Task 8)
- `packages/runner/src/orchestrator.ts` — acquire/renew/release, lease-lost invalidation + dispatch guards. Modify. (Task 8)
- `packages/runner/src/session-safety.ts` — lease-lost reason plumbing (reuse latch). Modify. (Task 8)
- `packages/runner/itest/bcdev.itest.ts` + a new `lease.itest.ts` — frozen-under-lease + blocking mid-run/lifecycle probes. (Task 9)
- `fixtures/README.md`, `design.md`, spec §11 evidence. (Task 10)

---

### Task 1: `LC Lease` table + pre-seed (install/upgrade) + server generation

**Files:** Create `extensions/lethal-control/src/Lease.Table.al`; modify `Install.Codeunit.al`, `Upgrade.Codeunit.al`. Verify: offline `alc`.

**Interfaces:**
- Produces: table `LC Lease` (71006) with fields `Primary Key` (Code[10]), `Owner` (Text[100]), `Server Generation` (Text[32]), `Epoch` (Integer), `Token` (Text[32]), `Expires At` (DateTime), `Client Nonce` (Text[64]), `Op Kind` (Option `none,publish,run`), `Op Attempt Id` (Text[64]), `Op Started At` (DateTime), `Op Seq` (BigInteger), `Last Completed Op Seq` (BigInteger). A `LC Control State.EnsureLeaseSeeded()` procedure the install/upgrade call.

- [ ] **Step 1: Create the table.**
```al
namespace LethAL.Control;

table 71006 "LC Lease"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Primary Key"; Code[10]) { }
        field(2; Owner; Text[100]) { }
        field(3; "Server Generation"; Text[32]) { }
        field(4; Epoch; Integer) { }
        field(5; Token; Text[32]) { }
        field(6; "Expires At"; DateTime) { }
        field(7; "Client Nonce"; Text[64]) { }
        field(8; "Op Kind"; Option) { OptionMembers = none,publish,run; }
        field(9; "Op Attempt Id"; Text[64]) { }
        field(10; "Op Started At"; DateTime) { }
        field(11; "Op Seq"; BigInteger) { }
        field(12; "Last Completed Op Seq"; BigInteger) { }
    }
    keys { key(PK; "Primary Key") { Clustered = true; } }
}
```

- [ ] **Step 2: Add `EnsureLeaseSeeded` to `LC Control State`** (mint a fresh generation only when first inserting; never reset an existing row):
```al
    procedure EnsureLeaseSeeded()
    var
        Lease: Record "LC Lease";
    begin
        if Lease.Get('') then
            exit;
        Lease.Init();
        Lease."Primary Key" := '';
        Lease."Server Generation" := NewToken();  // a shared 32-hex generator, see Task 2
        Lease."Op Kind" := Lease."Op Kind"::none;
        Lease.Insert();
        Commit();
    end;
```
Add the shared `NewToken(): Text` helper (32 lowercase hex from `CreateGuid`) to `LC Control State` now (Tasks 2–4 reuse it):
```al
    procedure NewToken(): Text
    begin
        exit(DelChr(LowerCase(Format(CreateGuid())), '=', '{}-'));
    end;
```

- [ ] **Step 3: Call `EnsureLeaseSeeded` from install AND upgrade.** In `LC Control Install.ReconcileWebService`'s trigger (`OnInstallAppPerCompany`) and `LC Control Upgrade`'s `OnUpgradePerCompany`, after the web-service reconcile, add:
```al
        State.EnsureLeaseSeeded();
```
(declare `State: Codeunit "LC Control State"` where needed).

- [ ] **Step 4: Offline compile.**
```bash
SP="C:/Users/SShadowS/AppData/Local/Temp/claude/.../scratchpad"; ALC=$(ls ~/.vscode/extensions/ms-dynamics-smb.al-*/bin/win32/alc.exe | sort | tail -1)
"$ALC" "/project:U:/Git/LethAL/extensions/lethal-control" "/packagecachepath:U:/Git/LethAL/extensions/lethal-control/.alpackages" "/out:$SP/lc-t1.app"; echo "EXIT=$?"
```
Expected: exit 0. Delete the scratch `.app`.

- [ ] **Step 5: Commit.** `git add extensions/lethal-control && git commit -m "feat(5cb1): LC Lease table (71006) + install/upgrade pre-seed + server generation"`

---

### Task 2: Lease core — `AcquireLease` / `RenewLease` / `ReleaseLease`

**Files:** Modify `ControlApi.Codeunit.al` (OData actions), `ControlState.Codeunit.al` (lease logic). Verify: `alc` + a live probe (bun client, mirrors the R1 spike).

**Interfaces:**
- Produces OData actions on `LC Control API`: `AcquireLease(owner, ttlSeconds, clientNonce, expectedGeneration): Text` → JSON `{granted, epoch?, token?, serverGeneration?, lastCompletedOpSeq?, expiresAt?, reason?, holder?, opAttemptId?, opStartedAt?}`; `RenewLease(epoch, token, generation, ttlSeconds): Text` → `{renewed, expiresAt?}`; `ReleaseLease(epoch, token, generation): Text` → `{released}`.

- [ ] **Step 1: `LC Control State` lease helpers** (all under `LockTable`, per design §4). `TryAcquire`, `TryRenew`, `TryRelease` returning a small record/JSON. Key logic (design §4):
  - Acquire: `Get('')`; if `expectedGeneration <> "Server Generation"` → reason `generation-changed`. Else if `Op Kind <> none`: if `CurrentDateTime <= "Expires At" + GraceMs()` → `operation-busy` (+ holder/expiresAt); else → `operation-orphaned` (+ opAttemptId/opStartedAt). Else if `(Token = '') or (CurrentDateTime > "Expires At")` (free/expired-idle): idempotent-nonce check (if `Token <> ''` and `"Client Nonce" = clientNonce` and generation matches → return the SAME grant); else grant (`Epoch += 1`, `Token := NewToken()`, set Owner/Expires At/Client Nonce, `Op Kind := none`). Else → `held`.
  - Renew: match `(epoch, token, generation)` → extend `Expires At` (even if momentarily past it); else `renewed:false`.
  - Release: match `(epoch, token, generation)` AND `Op Kind = none` → `Token := ''`, `Epoch += 1`, `Expires At := 0DT`, `"Client Nonce" := ''`; else refuse.
  - `GraceMs()`: a constant `>= 3 × renew period` (define e.g. `RENEW_PERIOD_MS` + `GRACE_MS := 3 * RENEW_PERIOD_MS`; document the client must renew faster than `RENEW_PERIOD_MS`).

- [ ] **Step 2: `LC Control API` actions** — thin OData wrappers over Step 1, returning the JSON. camelCase result keys.

- [ ] **Step 3: Offline compile** (as Task 1 Step 4).

- [ ] **Step 4: Live probe** (publish LethAL Control to Cronus281, then a bun client mirroring the R1 spike's `probe.ts`): fire 8 concurrent `AcquireLease` on a freed lease → exactly 1 `granted:true`; assert `RenewLease` extends; `ReleaseLease` frees + bumps epoch; a delayed `RenewLease` after release → `renewed:false` (credentials invalidated); an acquire with a stale `expectedGeneration` → `generation-changed`. Publish + probe are live (foreground); unpublish is NOT needed (this is the real extension — leave it, Task 10 gates it).

- [ ] **Step 5: Commit.** `feat(5cb1): AcquireLease/RenewLease/ReleaseLease — generation + credential-invalidating release + idempotent nonce`

---

### Task 3: Operation marker + publish state machine

**Files:** Modify `ControlApi.Codeunit.al`, `ControlState.Codeunit.al`. Verify: `alc` + live probe.

**Interfaces:**
- Produces: `BeginPublish(epoch, token, generation, attemptId, opSeq): Text` → `{begun, alreadyCompleted?}`; `EndPublish(epoch, token, generation, attemptId, opSeq, outcome): Text` → `{ended, alreadyCompleted?}`; `GetOperationStatus(epoch, token, generation, attemptId, opSeq): Text` → `{opKind, opAttemptId, opSeq, lastCompletedOpSeq, completed}`.

- [ ] **Step 1: State helpers** (design §4 publish state machine; under `LockTable`):
  - Begin: require `(epoch,token,generation)` match. `opSeq = "Last Completed Op Seq" + 1` AND `Op Kind = none` → set `Op Kind`, `Op Attempt Id`, `Op Seq`, `Op Started At`. Same active `(opSeq, attemptId)` → idempotent `begun:true`. `opSeq <= "Last Completed Op Seq"` → `{begun:false, alreadyCompleted:true}`. Different attempt at active seq → refuse.
  - End: match + `Op Kind = publish` + `Op Attempt Id = attemptId` + `Op Seq = opSeq` → `Op Kind := none`, `"Last Completed Op Seq" := opSeq`. `opSeq <= "Last Completed Op Seq"` → `{ended:true, alreadyCompleted:true}`.
  - Status: return the marker fields + `completed = opSeq <= "Last Completed Op Seq"`.
- [ ] **Step 2: API actions** (wrappers).
- [ ] **Step 3: `alc` compile.**
- [ ] **Step 4: Live probe:** begin (opSeq=N+1) sets `Op Kind=publish`; while set, a concurrent `AcquireLease` → `operation-busy`; end tombstones; a delayed duplicate begin of the tombstoned attempt → `alreadyCompleted`; a delayed end of a tombstoned attempt does NOT clear a later op.
- [ ] **Step 5: Commit.** `feat(5cb1): publish op state machine (BeginPublish/EndPublish/GetOperationStatus) + op-seq tombstone`

---

### Task 4: Two-phase `RunMutant` fence + `ClearActiveIf` + `RecoverOp` + `ForceResetLease`

**Files:** Modify `ControlApi.Codeunit.al` (RunMutant, RecoverOp, ForceResetLease), `ControlState.Codeunit.al` (`ClearActive`→`ClearActiveIf`, attestation reset). Verify: `alc` + live fence probe. **This is the correctness keystone.**

**Interfaces:**
- Produces: `RunMutant` gains required `LeaseEpoch: Integer; LeaseToken: Text; ServerGeneration: Text; OpSeq: BigInteger` params (attemptId already exists as `AttemptId`), new status `lease-invalid`. `RecoverOp(epoch, token, generation, attemptId, opSeq): Text`. `ForceResetLease(...) : Text`. `ClearActiveIf(targetAppId, artifactId, mutantId)` replaces `ClearActive` (conditional table clear, UNCONDITIONAL in-memory reset, NO internal Commit).

- [ ] **Step 1: `ClearActiveIf` in `LC Control State`.** Replace `ClearActive`:
```al
    procedure ClearActiveIf(TargetAppId: Text; ArtifactId: Text; MutantId: Text)
    var
        Active: Record "LC Mutation Active";
    begin
        // Table write is CONDITIONAL — clear only our own tuple (design §5).
        if Active.Get('') and
           (Active."Target App Id" = TargetAppId) and (Active."Artifact Id" = ArtifactId) and
           (Active."Mutant Id" = MutantId) then begin
            Active."Target App Id" := '';
            Active."Artifact Id" := '';
            Active."Mutant Id" := '';
            Active.Modify();           // NO Commit here — phase 3 owns the single Commit.
        end;
        // In-memory reset is UNCONDITIONAL (design §5 / fable F3) — never leave a stale attestation.
        ResetAttestationState();  // sets Cached* + Expected* + ObservedAny/Mismatch to empty/false
    end;
```
Add `ResetAttestationState()` (extract the in-memory clears from the old `ClearActive`). Update the old `ClearActive` call site in `RunMutant` (see Step 2). NOTE: the old `ClearActive` did `Commit()` — that Commit moves into phase 3's single final Commit.

- [ ] **Step 2: Two-phase `RunMutant`** (design §5). Restructure `ControlApi.RunMutant`:
  - Keep the reserved-param guard replaced by lease validation. **Phase 1** (`LockTable` on `LC Lease`, one txn): validate `(LeaseEpoch, LeaseToken, ServerGeneration)` + `Op Kind = none`; honor a match even if momentarily past `Expires At` (extend it); set `Op Kind := run`, `Op Attempt Id`, `Op Seq`, `Op Started At`; `State.SetActive(...)`; `Commit`. Mismatch → build `lease-invalid` status, exit.
  - **Phase 2:** run one method via a catchable boundary — `if not Codeunit.Run(Codeunit::"<runner>", ...) then` capture the error text as a terminal `error` outcome (extract `RunOneMethod` into a codeunit runnable via `Codeunit.Run`, or use a `[TryFunction]`). No lease lock held.
  - **Phase 3** (`LockTable`, one txn, NO internal Commit): re-`Get('')`; if `(epoch,token,generation)` match + `Op Kind = run` + `Op Attempt Id = attemptId`: `State.ClearActiveIf(...)`, set `Op Kind := none`, `"Last Completed Op Seq" := Op Seq`; single `Commit`; return `ran` + result. Else → `lease-invalid` (touch nothing).
- [ ] **Step 3: `RecoverOp`** — server-side: require `(epoch,token,generation,attemptId,opSeq)` match the ACTIVE marker; clear marker + active tuple + tombstone `opSeq` in one txn. (The client only calls this after a parsed app-level terminal — enforced client-side in Task 6/8.)
- [ ] **Step 4: `ForceResetLease`** — authenticated (bind to a newly-observed NST incarnation — e.g. require a `restartToken` the operator obtains post-restart, or a documented in-code check; if infeasible in AL, document the operational binding and gate via permission). In one txn: mint new `Server Generation`, `Op Kind := none`, `Token := ''`, `"Client Nonce" := ''`, `Epoch += 1`, AND clear the `LC Mutation Active` row.
- [ ] **Step 5: `alc` compile.**
- [ ] **Step 6: Live fence probe** (THE proof): acquire (epoch N), begin a run-fence with a valid tuple → passes; a `RunMutant` with a stale epoch → `lease-invalid`; the kill-interleaving shape (a `RunMutant` presenting an old epoch after a re-acquire) → `lease-invalid`; a catchable runner error → phase 3 clears the marker (subsequent acquire is not `operation-busy`), returns a typed error, NO recycle.
- [ ] **Step 7: Commit.** `feat(5cb1): two-phase RunMutant fence + ClearActiveIf + RecoverOp + ForceResetLease` — red-check the fence by a mutation probe where practical (a stale-epoch RunMutant must be rejected).

---

### Task 5: Protocol v2 handshake + tenant qualification (AL side)

**Files:** Modify `ControlApi.Codeunit.al` (`HarnessInfo`). Verify: `alc` + live probe.

**Interfaces:**
- Produces: `HarnessInfo(clientProtocol): Text` — a REQUIRED `clientProtocol` argument; reports `protocolVersion: 2` + `tenantCount` (or a `singleTenant` bool) + the existing appId/isolation/testTypes. A call without `clientProtocol` (v1 client sending `{}`) errors (missing required OData parameter).

- [ ] **Step 1:** Change `HarnessInfo()` → `HarnessInfo(ClientProtocol: Integer)`; if `ClientProtocol < 2` → return an incompatibility error. Add `protocolVersion := 2`, and a tenant-scope signal (count active tenants on the instance if reachable in AL, else expose what's available + document the client-side check). Live-probe that omitting the arg actually errors (not defaults) — sol#8.
- [ ] **Step 2: `alc` compile + live probe** (empty `{}` → error; `{clientProtocol:2}` → v2 info).
- [ ] **Step 3: Commit.** `feat(5cb1): HarnessInfo requires clientProtocol (v2 by construction) + tenant signal`

---

### Task 6: `LeaseClient` (runner)

**Files:** Create `packages/runner/src/lease.ts`. Test: `packages/runner/tests/lease.test.ts`.

**Interfaces:**
- Produces: `class LeaseClient` with `acquire(owner, ttlSeconds, nonce, expectedGeneration)`, `renew(lease, ttlSeconds)`, `release(lease)`, `beginPublish(lease, attemptId, opSeq)`, `endPublish(lease, attemptId, opSeq, outcome)`, `getOperationStatus(lease, attemptId, opSeq)`, `recoverOp(lease, attemptId, opSeq)`. `interface Lease { epoch: number; token: string; serverGeneration: string; lastCompletedOpSeq: number; expiresAt: string }`. `class LeaseUnavailableError extends Error`.

- [ ] **Step 1: TDD** — write `lease.test.ts` with a fake fetch (mirror `run-mutant-transport.test.ts`): acquire granted → parsed `Lease`; `granted:false, reason:"held"` → a typed refusal result; `generation-changed` surfaced; renew true/false; release; beginPublish/endPublish idempotent shapes; the request bodies carry the exact camelCase keys + the generation on EVERY call. Run → fail.
- [ ] **Step 2: Implement** `lease.ts` mirroring `RunMutantTransport`'s request-shaping (Basic auth, company/tenant params, manual AbortController timeout, single-parse OData scalar `value` → JSON). `recoverOp` requires a caller-supplied `terminalProof: true` flag it refuses without (the design's "parsed app-level terminal only" rule is enforced at the call site in Task 8; the client method just shapes the request).
- [ ] **Step 3:** typecheck → rm dist → `bun test packages/runner/tests/lease.test.ts` → biome. Red-check one mapping.
- [ ] **Step 4: Commit.** `feat(5cb1): LeaseClient (acquire/renew/release/begin-end-publish/status/recoverOp) + LeaseUnavailableError`

---

### Task 7: Transport + backend thread the lease tuple; map `lease-invalid`

**Files:** Modify `run-mutant-transport.ts`, `backend.ts`, `bcdev-backend.ts`. Test: `run-mutant-transport.test.ts`, `bcdev-backend.test.ts`.

**Interfaces:**
- Consumes: `Lease` (Task 6). Produces: `RunMutantRequest` gains `lease: { epoch; token; serverGeneration; opSeq }`; the OData body adds `leaseEpoch/leaseToken/serverGeneration/opSeq`; a result `status: "lease-invalid"` → `TestVerdict { outcome:"error", operation:"lease-lost" }` (a NEW `OperationOutcome` member). `BcDevMcpBackend` holds the session lease + a per-call op-seq and passes them.

- [ ] **Step 1: Add `lease-lost` to `OperationOutcome`** (`operation-outcome.ts`) and to `requiresUnsafeLatch`. TDD in the transport test: a `lease-invalid` result → `outcome:"error", operation:"lease-lost"` (NOT `in-flight-unknown`, NOT bare error).
- [ ] **Step 2:** `RunMutantTransport.run` includes the lease tuple in the body; parse `status === "lease-invalid"` → the lease-lost verdict. The backend binds the session `Lease` (set by the orchestrator via a setter or constructor) and increments the op-seq per RunMutant.
- [ ] **Step 3:** typecheck → rm dist → `bun test packages/runner/tests/run-mutant-transport.test.ts packages/runner/tests/bcdev-backend.test.ts` → biome. Red-check the lease-invalid mapping.
- [ ] **Step 4: Commit.** `feat(5cb1): transport passes lease tuple; lease-invalid -> operation:"lease-lost"`

---

### Task 8: Orchestrator integration — acquire/renew/release, lease-lost invalidation, dispatch guards

**Files:** Modify `orchestrator.ts`, `harness.ts` (client-side v2 arg + tenant check), `session-safety.ts` if needed. Test: `orchestrator.test.ts`. **The big TS integration task (like 5C-A Task 10).**

**Interfaces:**
- Consumes: `LeaseClient`, `Lease`, `lease-lost` operation. Produces: `runSession` (authoritative path) acquires a lease before deploy (with bounded backoff-with-jitter on `held`/`operation-busy`; `operation-orphaned` → re-check-once → durable `container-needs-recycle`; else `LeaseUnavailableError`), runs a single-flight renew heartbeat, passes the lease to the backend, releases in `finally` (op-gated), and on lease-loss invalidates the CURRENT batch's verdicts at session end + guards every dispatch.

- [ ] **Step 1: HarnessVerifier v2 + tenant check** (`harness.ts`): send `clientProtocol: 2`; require `protocolVersion >= 2`; fail on `tenantCount > 1` (typed error, before deploy).
- [ ] **Step 2: TDD** (`orchestrator.test.ts`, in-memory authoritative fake + a fake LeaseClient):
  - acquire-before-deploy: a fake that returns `held` then `granted` → backoff then proceed; a persistent `held` → `LeaseUnavailableError`.
  - renew heartbeat single-flight; `renewed:false` → latch lease-lost, stop scheduling.
  - a `RunMutant` returning `operation:"lease-lost"` → the current batch's verdicts become `error` at session end (before `buildReport`), `report.quarantined` set; an EARLIER clean batch's verdicts STAND.
  - every dispatch (`deploy`/`activate`/`run`) is guarded by `SessionSafety` (a latch mid-loop stops the next `run` before dispatch).
  - `operation-orphaned` → durable container-needs-recycle (distinct from a clean lease-lost).
- [ ] **Step 3: Implement.** Acquire wraps the batch loop; the heartbeat is a single-flight timer keyed off the session (clear on release/latch); the release is op-gated (skip if an op is unresolved). Lease-lost invalidation reuses `invalidateBatchVerdicts` (5C-A) scoped to `batchIdx`, called at session end after the loop breaks. `runOnce`/`activateOnce` gain the `SessionSafety` guard. Owner id = `host:pid:runId`.
- [ ] **Step 4:** typecheck → rm dist → `bun test packages/runner` (full) → biome. Red-check the lease-lost invalidation + the dispatch guard (revert each → the specific test reddens).
- [ ] **Step 5: Commit.** `feat(5cb1): runSession acquires/renews/releases the lease; lease-lost invalidates current batch + guards every dispatch`

---

### Task 9: itest probes — frozen-under-lease + blocking mid-run/lifecycle

**Files:** Modify `packages/runner/itest/bcdev.itest.ts` (acquire around the session); create `packages/runner/itest/lease.itest.ts` (the concurrency/lifecycle probes). Env-gated; run live in Task 10.

- [ ] **Step 1:** `bcdev.itest.ts` — wrap `runOnce` so the session acquires→beginPublish/endPublish→renews→runs(with lease)→releases; assert it still reproduces 3/10/3 + the existing 5C-A probes.
- [ ] **Step 2:** `lease.itest.ts` — the design §9 blocking probes, each driving `LeaseClient` + `RunMutantTransport` directly: slow-run-under-renew; healthy-contention-no-quarantine (B gets `operation-busy`, no durable record); orphaned-op → reconcilable quarantine → ForceReset recovery → stale-generation fence rejection; catchable-runner-error → no recycle; deterministic-rejected-publish → no recycle; delayed-EndPublish can't clear a later op; delayed-renew-after-release can't resurrect; lost-ack reconciliation via getOperationStatus; v1-empty-HarnessInfo → error; multi-tenant refusal (if a >1-tenant container is reachable, else document).
- [ ] **Step 3:** typecheck (itest in the tsc build) → biome. Commit. `test(5cb1): frozen-under-lease + blocking mid-run/lifecycle probes`

---

### Task 10: LIVE GATE + docs + housekeeping

**Files:** `fixtures/README.md`, `design.md` (§6 lease/fence), spec §11 evidence.

- [ ] **Step 1: Publish** the updated `LethAL Control` (version-bumped) to Cronus281 (`mem:bc_container_docker_access` / altool). Confirm HarnessInfo v2 + the lease actions live.
- [ ] **Step 2: LIVE GATE (foreground, do NOT poll):** `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` reproduces **3/10/3** under a held lease + all probes; the new `lease.itest.ts` passes all §9 blocking probes; `LETHAL_ITEST_ALRUNNER=1 … bun run itest:alrunner` unchanged **3/13/0**; `LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish` still green. Any differing verdict / failing probe → **BLOCKED**: diagnose (live is authority), fix in one commit, re-run.
- [ ] **Step 3: Docs** — `fixtures/README.md` (lease provisioning + the recovery procedure: restart + ForceResetLease + clear-quarantine); `design.md` §6 (the lease/fence model, quarantine-for-recycle, single-tenant precondition); spec §11 live evidence.
- [ ] **Step 4: Commit.** `docs(5cb1): live gate evidence (3/10/3 under lease) + lease/recovery docs`

---

## Self-Review
**Spec coverage:** §4 lease/marker → Tasks 1–3; §5 two-phase fence + ClearActiveIf + RecoverOp → Task 4; §7 v2 + tenant → Tasks 5,8; §6 client + lease-lost invalidation + quarantine taxonomy → Tasks 6,7,8; §8 errors/recovery → Tasks 4,8; §9 probes → Tasks 9,10; §10 exit → Task 10. Every §maps to a task.

**Placeholder scan:** the AL for `RunMutant`'s catchable phase 2 (Codeunit.Run vs TryFunction) is a real implementation choice to settle against alc in Task 4 (both paths named); the `ForceResetLease` NST-incarnation binding may be operational rather than fully in-AL (documented) — these are flagged decisions, not vague TODOs. All table fields, action signatures, and the client interface are concrete.

**Type/name consistency:** `Lease {epoch, token, serverGeneration, lastCompletedOpSeq, expiresAt}` identical across Tasks 6/7/8; the OData action names + camelCase body keys consistent Tasks 2–5 (AL) ↔ 6 (client); `lease-invalid` status (AL, Task 4) ↔ `operation:"lease-lost"` (transport, Task 7) ↔ latch reason (orchestrator, Task 8); `ClearActiveIf` defined Task 4, no other caller; table id 71006 + ids in 71000–71099 throughout.

**Ordering:** AL foundation (1–5) before the client (6) before the transport (7) before orchestration (8) before probes (9) before the live gate (10). Each AL task is alc-verified + live-probed; each TS task unit-tested + red-checked; the live gate is the authority.
