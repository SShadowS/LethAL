# PR-309: a lease renew that does not lock during a run (R1138 option (b)) — pre-commitment DRAFT (rev 2)

Status: draft, revised after an adversarial review (HIGH-1..2, MED-3..5, LOW-6..9). Nothing here is built, published or
run yet.

**Open owner question:** the R658 trade-off (§3 I11, §6) is open as **q-20261121T212126-38e5c865**; the orchestrator
recommends accepting it. **Landing is held until it is answered. The red leg (§4) may run before.**

Owner's ruling (verbatim): "yes, build option (b), a server-side renew that does not lock during a run. This replaces the
11-19 'don't build' ruling for R1138. Show the 400->401 break reproduced and fixed (red then green) before landing."

Words used below:
- **The lease row:** the one cross-company `LC Lease` row (table 91006) every LethAL session shares on a server.
- **The run session:** the OData session that executes a `RunMutant` / `RunMutantMany` call (phase 1 claim, phase 2 the
  tests, phase 3 finish; design §5).
- **The renew:** `RenewLease` → `LC Control State.TryRenew`, sent by the client every ~5 s (ttl 15 s, ttl/3 heartbeat,
  design §6) from a second session.
- **Runway:** how far "Expires At" lies in the future.
- **Design §4/§5/§6:** `docs/superpowers/specs/2026-07-24-layer-5c-b1-lease-fence-design.md`.

## 1. What happened

- **PR-200 / PR-221 (company-commit test T3, bc4, BC 29):** with the renew, 2 of 2 runs broke the tier: the renew got no
  answer for ~30 s, then HTTP 400, then 401 on every call until a restart. Without the renew (scratch client): 1 clean,
  1 "rolled back every company create", no 401 break. BC's own runner once broke the tier with T3 and no LethAL in the
  path. Evidence: `/coord/handoff/PR-221/result.md`, R1113, R1138.
- **PR-300 (no company write, bc4, DO, company-write guard on):** mutant M0089
  (`src/Platform/Licensing/CDOSecurityModuleLicense.Codeunit.al` line 91, flip-boolean-literal) made its covering batch slow.
  `/coord/handoff/PR-300/bc/events.ndjson`, by atMs:
  - 4,498,929 group call a2110 ends `cap` (67/80); 4,592,363 a2111 ends `cap` (10/13). ~93 s each.
  - 4,619,938 `lease-renew-blip`: RenewLease HTTP 400 twice (during a2112, 3 methods, opened 4,592,363).
  - 4,619,973 a2112 fails HTTP 400 "An unexpected error occurred after a database command was cancelled".
  - Then 401 on GetOperationStatus, DependentCount, everything. Quarantined; bc4 restarted.
- **Today's renew** (`TryRenew`): `LockTable` on the lease row, `Get`, `Modify` ("Expires At" := now + ttl), `Commit`, every
  5 s, for the whole run. It is the only LethAL action that writes the lease row every few seconds while phase 2 runs.
- **Not measured:** why the renew's lock waited ~30 s (phase 2 holds no lease lock by design; `IsOwnRunActive` and the
  watchdog's `TryGetOperationProgress` are plain reads). So "the renew is causal" is a reading, not a fact. The red/green
  repro below is what tests it.

## 2. The change

### 2.1 Chosen design: (i) size the run claim's runway from the call's own bound, and let TryRenew answer from a read while that runway still covers it

Why (i) and not (ii) ("TryAcquire treats Op Kind = run as alive until Op Started At + a server maximum"):
- (i) keeps ONE liveness field, "Expires At", truthful for every reader: `TryAcquire`'s busy/orphaned rule,
  `CurrentLeaseSnapshot` (HarnessInfo), and `lethal doctor`'s "ALREADY EXPIRED / orphaned" advice (`doctor.ts`, which reads
  `expiresAt` client-side). (ii) would make "Expires At" lie during a run, so doctor would call a live long run orphaned
  unless the client changed too.
- (i) needs no change to `TryAcquire` and no client behaviour change.
- Correctness never depends on the runway being long enough: when a run outlives it, the renew falls back to the locked
  path. The runway only decides how long the renew stays lock-free.

### 2.2 Server changes (all in `extensions/lethal-control/src/ControlState.Codeunit.al` unless named)

1. **`TryBeginRun` gains one parameter, `RunBoundMs: Integer`** (an internal codeunit procedure, not an OData action; two
   call sites in `ControlApi.Codeunit.al`):
   - `RunMutantMany` passes `RequestCeilingMs + StopGraceMs` (already on the wire since R198; the client's own hard cap is
     the same sum, `run-mutant-transport.ts` `hardCapMs`).
   - `RunMutant` / `RunMutantWithCoverage` (no ceiling on the wire) pass `SingleRunBoundMs()` := `MaxRunBoundMs()` =
     600 000. Rationale: a single call carries the client's MUTANT budget, which is at least `MIN_MUTANT_BUDGET_MS`
     180 000 + `STOP_GRACE_MS` 30 000 = 210 s and can be more (budgets scale from baseline timings), or the baseline's
     120 000 + 30 000. Any smaller server constant would put a normal mutant call back on the locked renew for its tail.
     The client's budget is not on the wire, so the server takes the cap.
2. **`ExtendRunClaim(Lease, RunBoundMs)`:** runway := now + `RunClaimRunwayMs()` (grace 15 s + one period 5 s, unchanged)
   + clamp(`RunBoundMs`, 0, `MaxRunBoundMs()`), `MaxRunBoundMs()` = 600 000. Still "never inwards". Still called only from
   the fresh-claim branch, inside phase 1's lock.
3. **`TryRenew` fast path, first thing in the procedure:**
   - A SEPARATE record variable `Peek: Record "LC Lease"` with `Peek.ReadIsolation := IsolationLevel::ReadUncommitted`,
     then `Peek.Get('')` (missing row → the same `LeaseRowMissingErr()` error as today).
   - It applies only when ALL hold: `Peek.Epoch = Epoch`, `Peek.Token = Token`, `Peek."Server Generation" = Generation`,
     `Peek."Op Kind" = run`, and `Peek."Expires At" >= CurrentDateTime + TtlSeconds * 1000`
     (in words: a write would not move "Expires At" out).
   - It answers `Renewed := true`, `ExpiresAt := Peek."Expires At"` (the stored deadline), and exits.
     **No `LockTable`, no `Modify`, no `Commit`.**
   - Why a separate variable: an explicit `ReadIsolation` on a record instance overrides the table's lock state for that
     instance, so the locked path below must use its own `Lease` variable, exactly as today.
   - Why ReadUncommitted, not ReadCommitted: ReadUncommitted takes no lock at all, so it cannot wait on anything another
     session holds, which is the whole point. ReadCommitted (as `GetOpAnswer` uses) takes a short shared lock and would
     wait behind any exclusive lock on the row, i.e. it could block exactly where today's renew blocks. The dirty-read case
     is safe (§3, I5).
4. **Fallback = the locked path** whenever the fast path does not apply:
   - the lease is idle (`Op Kind = none`) — every renew between calls: today's code byte-for-byte ("Expires At" := now + ttl);
   - `Op Kind = publish` (the publish fence is unchanged): today's code byte-for-byte;
   - credentials do not match: `renewed:false`, as today; the fast path never answers false;
   - **`Op Kind = run`** (the fast path missed: a run past its runway, or a dirty read that did not match): "Expires At" :=
     **max("Expires At", now + ttl)**, so a locked renew during a run never pulls the claim's runway inwards (LOW-8).
5. **Trim when a run marker clears.** Inside the existing locked transaction, before its one Modify, "Expires At" :=
   min("Expires At", now + `RunClaimRunwayMs()`), in:
   - `TryFinishRun` (matched branch);
   - `TryRecoverOp` (recovering branch);
   - `TryStopHungRun` and `TryStopHungRunAt` (the branches that set `Op Kind := none` and call `RecordStoppedOp`; LOW-7).
   Without it, a client that dies right after a run ends leaves an IDLE lease held for up to ~10 min (a competing acquire
   reads `held`), where today it is ≤20 s. Safe: the next renew (≤5 s later, locked path since `Op Kind = none`) sets
   now + ttl (≤15 s) anyway.
6. **`TryBeginRun` and `TryFinishRun` still lock.** They must: phase 1 and phase 3 are the fence (design §5); they are short
   (one Get, one Modify, one Commit) and run in the run session itself, before and after phase 2, so they cannot contend
   with that session's own phase 2. They (with recover and the stops) are also the only writes that move "Op Kind", which
   is what lets the fast path trust a read.
7. **Version:** `extensions/lethal-control/app.json` 1.0.0.28 → 1.0.0.29 (re-check at build that no other branch took
   .29). `docs/gates/README.md` gets the "which feature arrived in which version" line.

### 2.3 Client change

- **Behaviour: none.** The wire contract is unchanged (`{renewed, expiresAt?}`; `renewed:false` is still the only loss;
  `RunMutantMany` already sends the ceiling). An old client against the new app gets the fix.
- **One constant:** `MIN_CONTROL_VERSION` in `packages/runner/src/harness.ts` → `"1.0.0.29"` (and its pinned test), so a
  client never runs on a server that still carries the trigger. The client refuses .28 by name, as it refuses any older
  build. Consequences: §5 step 10.
- **Unit guards** (`packages/runner/tests/control-app-source.test.ts`, which already pins the control app's source shape):
  - TryRenew's fast path sits before the first `LockTable`, uses its own record variable with `ReadUncommitted`, and
    contains no `Modify` / `Commit` / `LockTable`;
  - its condition names all five checks (epoch, token, generation, Op Kind = run, Expires At ≥ now + ttl);
  - the locked fallback still has `LockTable`, `Modify`, `Commit`, and uses max() when `Op Kind = run`;
  - `ExtendRunClaim` clamps to `MaxRunBoundMs()`; `SingleRunBoundMs()` returns `MaxRunBoundMs()`;
  - the min() trim exists in all four marker-clearing procedures.
  - Red-check each pin (revert that piece, the named test goes red, restore), one per direction: e.g. dropping
    `Op Kind = run` from the condition AND dropping the `Expires At` check must each go red.

## 3. Invariants kept (named)

- **I1 generation-first** (design §4 acquire step 1): `TryAcquire` untouched.
- **I2 a marked op is never stolen** (design §4 step 2): untouched; `Op Kind <> none` → busy/orphaned, never a grant.
- **I3 a live holder never reads orphaned** (design §4 `graceMs >= 3 x renewPeriod`, fable F1; R658's liveness): the fast
  path answers only while "Expires At" ≥ now + ttl, i.e. the deadline is already at least as far out as a locked renew
  would set it; the locked fallback during a run uses max(). At every moment of a run, "Expires At" is ≥ what today's
  heartbeat would have produced, so a competing acquire sees `operation-busy` at least as long as today. Past the runway,
  the locked path resumes the heartbeat.
- **I4 a matching renew is honoured even past expiry** (design §4 RenewLease, sol#6): kept by the locked fallback; the fast
  path cannot see an expired deadline (it requires ≥ now + ttl).
- **I5 only `renewed:false` is loss** (design §6 step 3): the fast path never answers false. Dirty reads (ReadUncommitted
  sees another transaction's uncommitted row):
  - The only writer that can put (match, run, covered) into the row uncommitted is our own `TryBeginRun` (phase 1), between
    its Modify and its Commit. If phase 1 commits, the skip was correct. If phase 1 rolls back (an error after Modify), the
    committed row is idle, holding the deadline our last locked renew wrote ≤ one period ago (≥ ttl − 5 s = 10 s left).
    One renew was skipped; the next tick (≤5 s) sees `Op Kind = none` and takes the locked path. So the error goes in the
    safe direction: one late renew, never a lapse past grace, never a steal, never a false `renewed:false`.
  - Every other uncommitted change (finish, recover, stop: run → none; release or force-reset: token or epoch changes)
    makes the dirty row FAIL the fast-path condition, so the renew takes the locked path and waits for the committed truth,
    as today.
- **I6 release only when idle, and release invalidates renewal credentials** (design §4 ReleaseLease, sol#5): untouched; a
  delayed renew after release finds `Token = ''` → no match → locked path → `renewed:false` (P3 in `itest:lease`).
- **I7 phase 1 and phase 3 are short locked transactions; phase 3 has exactly one Commit, no internal Commit** (design §5,
  sol#8, R2 fix): the only additions inside them are field assignments before the existing Modify (runway, trim).
- **I8 while `Op Kind <> none`, `Op Seq = Last Completed Op Seq + 1`** (TryBeginRun's cross-op invariant): untouched.
- **I9 lock order lease then progress; phase 2 holds no lease lock** (sol#1; RunMany's LOOP_READS_LEASE_ONLY): the fast
  path takes no lock, so it cannot create a new order. The stop procedures' trim is inside their existing lease lock.
- **I10 in-memory attestation reset is unconditional** (design §5, F3): untouched.
- **I11 R658: an abandoned run is eventually orphaned; unmutated runs are stopped at their budget; doctor advises a
  restart first:** kept, with ONE stated change (the owner question above): a run whose client died is classified
  `operation-orphaned` only after claim + bound + 20 s + grace 15 s, instead of ~35 s after its last renew.
  - `RunMutantMany`: bound = the call's ceiling + stop grace (default 330 s → ~6 min hold).
  - `RunMutant` / `RunMutantWithCoverage`: bound = 600 s for EVERY single call, however short → up to ~10.6 min hold.
  - Until then a competing acquire reads `operation-busy` and backs off to `LeaseUnavailableError` (no quarantine), and
    doctor shows "held, not expired: if no session is running, restart the NST first". Busy is the milder of the two
    refusals; no false verdict.
- **I12 the client ttl ≤ 15 s contract and `ExtendRunClaim` never inwards:** unchanged.
- **I13 `renewed.expiresAt` is truthful** (orchestrator's "container stays locked until ..." message): both paths return
  the stored deadline.
- **Not changed, stated so nobody assumes it:** `TryStopHungRunAt`, `TryStopHungRun` and `TryGetOperationStatus` still
  `LockTable` the lease row during a run. They fire only at a method's budget (a stop) or a lost-ack reconciliation, not
  every 5 s. If the repro shows one in a break window, file it rather than widen this change.

## 4. Red/green repro (the owner's condition)

All on **bc4** (BC 29), under a coord lease, the owner's standing yes (`/coord/owner/standing-yes.md`: scratch apps and
bcdev runs on a leased BC), in a bc4-only worktree (bc4's symbols must not overwrite a 28.4 worktree). Live steps run in
the lane's own session, never through a subagent.

### 4.1 Shapes, in order

- **S2 FIRST: PR-300's measured shape (MED-5).** The DO pair already used on bc4 by PR-300 (republish only if doctor says
  it is gone); `lethal run --backend bcdev --stop-hung-sessions` scoped to M0089's site (file
  `src/Platform/Licensing/CDOSecurityModuleLicense.Codeunit.al`, line 91, `lethal.flip-boolean-literal`), with
  `--tests-only` on the covering tests PR-300's events name for a2110-a2112 (no `--keep-company-tests`). Before counting,
  check the scoped run reproduces PR-300's shape: the same group calls ending `cap` at ~93 s. If it does not, the attempt is
  recorded but not counted. Cost per attempt: one baseline of those tests plus ~3-4 min for M0089.
- **S1, invented, only if S2 cannot be run or stays clean, and only after an UNCOUNTED smoke run on .28.** Scratch target +
  test pair, ids 91570-91579 (check free first), publisher `LethAL Scratch`:
  - table 91570 `PR309 Scratch Row`; target codeunit 91571 with one procedure that does the work below, so LethAL has a site
    to mutate and to scope, and the **tests call the target codeunit** (the work runs through it, not in the test body);
  - test codeunit 91572, `TestHttpRequestPolicy = BlockOutboundRequests`, no company write, no `Commit`:
    - `LongWrite`: calls the target, which loops for 90 s (`CurrentDateTime`): insert one row and modify one existing row
      per iteration, in one long uncommitted transaction;
    - `LongRead` (control): calls the target's read-only 90 s loop (only `Get`s);
    - `Quick`: one assert.
  - Run: `lethal run --backend bcdev --stop-hung-sessions --baseline-timeout-ms 180000` with `--only` on the target codeunit.
  - **The smoke run** (on .28, not counted) must show, in its events: the baseline and each mutant going through the
    intended calls (a RunMutantMany group or single RunMutant, named), each long method lasting ~90 s, and ~18 renews per
    long method. If it shows other shapes or durations, fix S1 before counting.
  - **Known weakness:** S1's row locks are all on table 91570; none touches `LC Lease`. If the renew's 30 s wait in PR-300
    came from something specific to DO's batch, S1 may not reproduce at all.
  - 90 s stays inside the new runway, so green exercises the fast path, not the fallback.
- **S3, PR-200's T3 — ONLY with the owner's yes first** (no company-commit tests on gate servers without the owner's
  say-so). Confounded: it also broke the tier through BC's own runner. Use only if S2 and S1 both stay clean.

### 4.2 Counting

- **Red** (control app 1.0.0.28, current master client): a **FIXED 3 attempts per shape that is run; all 3 run, no stop at
  the first break** (HIGH-2). A red break is ALL of: a renew error (`lease-renew-blip` or a renew HTTP error) inside the
  window, then a run call failing with HTTP 400, then HTTP 401 on every call, then `doctor` failing after. A 401 break
  WITHOUT a renew error first is recorded but does not count as a red break (it is not the renew trigger) — it is itself a
  finding to report.
  - p̂ = red breaks / 3, over all 3 attempts.
  - **If a shape gives 0 of 3:** move to the next shape. If no shape goes red: stop; do not build-and-land on the reading
    alone; report the counts to the owner (the trigger may not be the renew).
- **Green** (control app 1.0.0.29, branch client, the SAME shape and flags). **Any of these FAILS a green attempt, whatever
  the renew did** (HIGH-1): a run call answering HTTP 400 "An unexpected error occurred after a database command was
  cancelled"; any HTTP 401; `doctor` failing after; a restart needed. A green failure is a **BLOCK**, and it is the finding
  ("the renew was a victim, not the cause"). The "renew error first" rule applies to RED only.
  - Also required in every green run: 0 `lease-renew-blip` and no renew error.
  - **N** is set from p̂ so that (1 − p)^N ≤ 5%, treating a single break as p ≤ 1/3:
    - 1 of 3 → p ≤ 1/3 → **N = 8**;
    - 2 of 3 → use the conservative p = 1/2 → N = 5; 3 of 3 → N = 5 (floor, never fewer).
  - **Wording of the result:** "0 breaks in N green runs, consistent with a per-run break rate on the new app of at most
    x" (x from the 5% bound, e.g. N = 8 → x ≈ 0.31; N = 5 → x ≈ 0.45), next to the red p̂. Never "proven fixed".
- **Mechanism check (one extra green run, not counted; one red run for contrast)** (MED-4): the client logs EVERY renew's
  returned `expiresAt` and its round-trip time (a scratch log line in the evidence build; not a product change), and a side
  loop reads `HarnessInfo`'s lease snapshot every 10 s (plain read; never `AcquireLease`, which would itself lock) for the
  server's "Expires At" and Op Kind. All comparisons use SERVER time (the renew's returned `expiresAt`, the snapshot, the
  progress read's `ServerNow`), never the client clock. Required during each long run call on green:
  - every renew's returned `expiresAt` is the SAME value (the claim's deadline), and Op Kind reads run;
  - every renew's round-trip time is small (≤ 1 s; red's contrast is expected to show the ~30 s wait at its break);
  - at every sample, server now ≤ "Expires At" + 15 s (a competing acquire would read busy).
  - If green shows the deadline moving or a slow renew, the fast path is not being taken or is not lock-free: BLOCK,
    whatever the break count.

### 4.3 Rules every attempt follows

- **Doctor before:** `lethal doctor --config <bc4 config>` ok (control-version as expected, lease clear) or the attempt is
  not valid and is not counted.
- **Doctor after,** every attempt.
- **The driver stops on any baseline that is not a pass** (PR-221's miss: two runs ran on a damaged tier).
- **On a break (red or green):** keep the coord lease (release only when healthy); read the failed call's whole error and
  any recovery it prints first; file ONE `kraken coord ask --kind bc-restart --target bc4` (the owner restarts sql then bc);
  track its id each sweep. After the restart: `bun scripts/bc-linux-setup.ts --server bc4 --held-lease` (in-memory DB:
  republish the control app and fixtures), republish the DO or scratch pair, doctor ok, then the next attempt.
- Never signal-stop a live run. Record BOOTTIME − MONOTONIC at each run's start and end (server1 suspends).
- Evidence under `/coord/handoff/PR-309/{red,green,mechanism,smoke}/<shape>-<n>/` (events.ndjson, stderr, report, doctor
  before/after); the scratch apps' source under `/coord/handoff/PR-309/probe/`.

## 5. Gates and predictions (in order)

0. **This spec committed first** (specs-only `[skip ci]` to master), with any review deltas.
1. **Red on bc4** (§4) with the CURRENT control app, before anything is built or published. May run before the owner
   answers q-20261121T212126-38e5c865. Prediction: ≥1 break in S2's 3 attempts. (A miss is reported, not argued.)
2. **AL edit + `app.json` 1.0.0.29.** Offline `alc` compile (`/al-compile` on `extensions/lethal-control`): 0 errors, no
   new warnings. This also confirms `IsolationLevel::ReadUncommitted` on a record compiles at runtime 17.
3. **Source pins + red checks** (§2.3), `MIN_CONTROL_VERSION` → 1.0.0.29, `bun scripts/verify.ts` full: green.
4. **Stage the .app** at `/coord/handoff/PR-309/control/LethAL_LethAL Control_1.0.0.29.app`; update `CONTROL_APP` and
   `CONTROL_SHA256` in `scripts/bc-linux-setup.ts`.
5. **Opus build review**, fixes, then the gates on the final head.
6. **bc4:** `bc-linux-setup.ts --server bc4` (upgrade .28 → .29, read back by sha256), doctor control-version 1.0.0.29.
   **Green on bc4** (§4) and the mechanism run. Prediction: 0 failures in N, 0 renew blips, constant deadline, small RTT.
7. **`itest:hang`** — the only gate that exercises the control app's stop. On bc4 (400 form), then bc2 and bc3 (408 form)
   after step 8's setup. Prediction: every frozen figure unchanged (ON / SINGLE / BASELINE legs as on `docs/gates/hang.md`).
   The stop path changes only by the min() trim inside its existing transaction.
8. **bc1, bc2, bc3:** `bc-linux-setup.ts --server bcN` (one server at a time, under its own lease), doctor control-version
   1.0.0.29, then re-prove the proof table's set per server (`docs/gates/servers.md`):
   - `bc1`: the 13 (`bcdev`, `bcdev-names`, `bcdev-wrapped`, `tables`, `chunked`, `harden`, `lend`, `lease`, `verify`,
     `testapp`, `agreement`, `verify-scale`, `stale-publish`). No `itest:hang` (bc1 refuses it).
   - `bc2`, `bc3`: the same 13 and `itest:hang`.
   - `bc4`: the same 13 and `itest:hang` (400 form), after the green runs.
   - Prediction for every gate on every server: **frozen figures unchanged per mutant** (verdicts, killingTest, note and
     warning sets), because no verdict path changed. Any difference is a BLOCK.
   - **`itest:lease` is not a mechanism proof** (LOW-9): P3/P8/P9 use idle or publish markers and keep the locked renew.
     P9B holds a REAL run (Slow Run Probe, ~23 s) under renew, so it now goes through the fast path; but its assertion
     (a competing acquire reads `operation-busy` throughout) passes on EITHER path, so a pass shows the change did not
     break liveness, not that the fast path was taken. The mechanism run (§4.2) is the proof that it is.
   - **No gate exercises a run that outlives its runway** (the locked max() fallback during `Op Kind = run`). Only the
     source pins cover it. Stated as a gap; not filled here.
9. **Docs + roadmap:** new proof rows (1.0.0.29) in `docs/gates/servers.md` for bc1-bc4; `docs/gates/README.md` version
   line; R1138 `status: done (<commit>)` with the red/green counts in the §4.2 wording; regenerate `ROADMAP.md`. CI green.
10. **Rollout of MIN_CONTROL_VERSION 1.0.0.29** (LOW-9):
    - **Stranded until republished** (the client refuses them by name): the envtool environment (`itest:envtool`;
      `continia.exe` is host-only, so the owner must publish .29 there) and `bc-demo` (not a gate server; republish under
      its own holder check). Ask or file for each; do not leave them silent.
    - **Other lanes' worktrees** that pin .28 (`CONTROL_APP`/`CONTROL_SHA256` in their `bc-linux-setup.ts`, or a branch
      behind this head) will reinstall or expect .28: announce the bump through coord (kraken) BEFORE the merge, with the
      rule "merge origin/master and run setup for your server before your next gate".

## 6. Risks and open questions

- **The main risk: the renew may be a victim, not the cause.** Nothing measured explains the renew's ~30 s wait. If the DB
  as a whole stalls (a slow mutated batch, log growth), the tier would break anyway. §4.2 makes that a green BLOCK, not a
  pass with excuses.
- **Small samples.** 3 red attempts and 5-8 green runs bound the rate only loosely (§4.2 wording). Say so in the result.
- **S1 may not reproduce** (its locks never touch `LC Lease`). Hence S2 first; S3 only with the owner's yes. Budget: up to
  ~3 restarts per red shape.
- **R658 trade (I11)** — q-20261121T212126-38e5c865, open; landing held until answered. A dead client's run stays
  `operation-busy` up to bound + 35 s: ~6 min for a default group call, up to ~10.6 min for ANY single call (the 600 s cap
  applies to every single call, however short). The alternative (a short runway) would reintroduce the locked renew
  mid-run. A wire parameter on `RunMutant` carrying the real budget would shorten single-call holds but needs a client
  change and a refusal rule; not proposed.
- **`ReadIsolation` + `LockTable` on one instance:** the design uses two variables so it does not rely on which wins; the
  compile and the source pins enforce it.
- **Fast path only for `Op Kind = run`.** A long publish (altool) still gets the locked renew every 5 s. No break has been
  seen there; not in scope.
- **Stops and reconciles still lock during a run** (§3, last bullet). If a trace shows one in a break window, file it.
- **Version .29 collision:** re-check `app.json` on origin/master at build time.
