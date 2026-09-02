# Design: reconciling a RunMutant the server provably never started (R194, second half)

Status: REVIEWED (adversarial, 2026-09-02, findings and responses at the end) and IMPLEMENTED the
same day. Amends design §5's lost-ack rules. Sections 2, 4 and 5 were rewritten after the review;
the review section records what the draft said and what was wrong with it.

## 1. The failure this closes

A fenced `RunMutant` whose answer could not be read is `in-flight-unknown`. Design §5 reconciles
it against the lease row's operation marker with three rules:

1. the attempt is **completed/tombstoned** (`completed`, or `opSeq <= lastCompletedOpSeq`): the
   whole fence ran, only the result was lost, retry once as a fresh attempt;
2. the marker is **ours and active** (`opKind = run`, same `attemptId`, same `opSeq`): poll until
   it clears, then as rule 1; if it never clears, quarantine;
3. **anything else** is `unresolved`: quarantine.

Measured 2026-09-02 on a hosted sandbox (R194): a keep-alive socket the gateway had closed failed on
the next WRITE, so the request never reached BC. The marker then read `opKind: none`,
`lastCompletedOpSeq: N-1` for our `opSeq N`. That is rule 3, and it quarantined a healthy tier,
cost a `force-reset-lease`, a `clear-quarantine`, a full resume (R192), and one mutant recorded as
stranded together with its twins (R193). The transport half of R194 makes the drop rare by sending
each request on a fresh connection; this half makes the reconciliation honest when it still
happens, for a drop or for a request a gateway queued past the budget.

## 2. What the server's marker can and cannot say

Five procedures write the marker or the tombstone counter on the `LC Lease` row
(ControlState.Codeunit.al): `TryBeginRun` (phase 1, the only CLAIM for a run), `TryFinishRun`
(phase 3, clears and tombstones in one transaction), `TryRecoverOp` (LethAL's own publish
recovery), `TryStopHungRun` (the R53 stop hook, fired from inside the still-open RunMutant; a
successful stop tombstones the op, so it reads as `completed`), and `TryForceResetLease` (an
operator's `force-reset-lease`, which clears the marker WITHOUT advancing the tombstone and mints a
new server generation). Phase 1 writes before any AL executes. Its branches, in priority order:

| # | condition | result | marker after |
| --- | --- | --- | --- |
| 1 | tuple mismatch | `lease-invalid` | untouched |
| 2 | artifact mismatch | `artifact-mismatch` | untouched |
| 3 | `opSeq <= lastCompleted` | `lease-invalid` | untouched |
| 4 | active run, same `opSeq` AND same `attemptId` | `op-in-flight` | untouched |
| 5 | `opSeq = lastCompleted + 1` and `opKind = none` | CLAIMED | `run / attemptId / opSeq` |
| 6 | anything else | `lease-invalid` | untouched |

Phase 3 (`TryFinishRun`) clears the marker and advances `lastCompleted` to `opSeq` in one
transaction, on an exact tuple match. (The draft said here that the other writers are never
concurrent with a run this session dispatched. `TryStopHungRun` is concurrent by construction, and
`TryForceResetLease` can be; the paragraph above names all five.)

So, for our attempt `(a, N)`, `GetOperationStatus` returning **`opKind = none` and
`lastCompletedOpSeq = N - 1`** says: **as of this read, phase 1 has not claimed our attempt.** The
histories that produce it:

- (A) the request never reached phase 1: written to a dead socket, refused by a gateway, or still
  in transit;
- (B) the request reached phase 1 and was REFUSED by branch 1, 2, 3, 4 or 6, which write nothing;
- (C) the request was claimed and is executing, and an operator ran `force-reset-lease` in the
  meantime, which cleared the marker and preserved the counter.

In (A) and (B) no AL of ours executed. (C) is the fourth history the draft claimed did not exist,
and it is closed by something other than the marker: the reset mints a new server generation, so
the retry this rule issues is refused by branch 1 (tuple mismatch) and classified as the genuine
lease loss it is. The load-bearing facts are therefore the monotonic `opSeq` (branches 3 and 5)
and the `(epoch, token, generation)` tuple check (branch 1), not an impossibility claim about the
marker.

## 3. The new rule, and where it sits

**Rule 2b, `not-started`.** After a lost ack for `(a, N)`, if `GetOperationStatus` reports
`opKind = none` and `lastCompletedOpSeq = N - 1` TWICE, a settling delay apart (a request still in a
gateway queue looks like "not yet"; a claim that lands between the two reads is caught as ours and
polled under rule 2), the attempt has not been claimed. Resync the op-seq counter (which lands on
`N` again, since nothing completed; checked in `resyncOpSeq`) and dispatch ONE fresh attempt
`(a', N)`. The resync is a lease call on the transport that just failed and is guarded: if it
throws, the lost ack is `unresolved` and the ordinary quarantine applies.

`not-started` is its own outcome, with its own warning (`lost-ack-not-started`); it never borrows
`completed`'s words ("confirmed COMPLETE server-side"), which would be false.

Placed after rule 1 and rule 2 and before rule 3, so a marker that is ours-and-active is still
polled, not retried. A retry whose own ack is lost and reconciles as `not-started` AGAIN is
`unresolved`: one retry that also vanished is evidence about the transport, and the counter the
retry consumed now sits one ahead of the server's, so continuing would refuse the next mutant as a
false lease loss.

## 4. The one hazard, and how the fence already closes it

History (A) includes "still in transit": a gateway that held the request and delivers it AFTER we
have concluded `not-started`. THREE orderings (the draft listed two; the review found the third,
which is the likely one), all closed by the fence with no client change, and two of which the
client must recognise:

- **Retry `(a', N)` arrives first.** It claims (branch 5), runs, tombstones `N`. The late original
  `(a, N)` then hits branch 3 (`N <= N`) and is refused. Nothing runs twice; its answer goes to a
  socket nobody holds.
- **Late original `(a, N)` arrives first and is still executing.** The retry `(a', N)` hits branch
  6 (active run, same `opSeq`, DIFFERENT `attemptId`): `lease-invalid`.
- **Late original `(a, N)` arrives first, runs, and tombstones `N` before the retry.** The retry
  hits branch 3: `lease-invalid`.

In the second and third orderings `classifyLeaseVerdict` would read the answer as a GENUINE lease
loss: the batch's already-recorded verdicts invalidated, the session stopped. Safe (no verdict is
fabricated) and wrong (the lease was never lost), and worse than today's outcome, which loses one
mutant and keeps the batch.

**Rule 2c, the late-original check.** When a retry issued under rule 2b answers `lease-invalid`,
whatever `leaseInvalidReason` it carries (the draft keyed on the reason being ABSENT, which is
exactly backwards: every phase-1 refusal carries `reason: "lease-invalid"`, and only the phase-3
refusal, a run that DID execute, carries none), read the marker for the ORIGINAL attempt's
coordinates BEFORE classifying it as loss:

- `completed`, or `N <= lastCompletedOpSeq`: the original ran and tombstoned `N` (ordering 3).
  Its result went to a closed socket; record this mutant `error`, cause `result-lost` (whose
  published meaning, "the run completed on the server, only the result was lost", is true here),
  no latch, no quarantine, continue.
- marker is `run / a / N`, our original attempt id (ordering 2): poll until TOMBSTONED, with the
  mutant's own budget rather than rule 2's 8 s (a late original is running a real test). Cleared:
  as above. Not cleared: a strand, quarantine as rule 2 would.
- anything else: the lease loss is genuine; classify as today.

This check reads only. It never calls `RecoverOp`, never re-dispatches, and its only new action
is the poll rule 2 already performs. The confirmation rerun (the kill-confirmation call site) gets
the same check.

## 5. What must NOT change

- A marker that is ours and active is still polled, never retried (rule 2). The poll now requires
  the TOMBSTONE (`lastCompletedOpSeq >= N`) and not merely an idle marker, because `force-reset-lease`
  leaves the marker idle without advancing it.
- The baseline loop is out of scope. It calls `runOnce`, not `runFenced`, and a baseline test's
  `in-flight-unknown` still quarantines with no reconciliation: its verdict feeds `greenTests`.
- No unclaimed `opSeq` is left outstanding while the session continues: the only path that could
  do so, a second consecutive `not-started`, is `unresolved`.
- `unresolved` still quarantines for every other shape: a failed status read, a marker naming a
  different attempt or a different `opSeq` with no `lastCompleted = N - 1`, `lastCompleted` beyond
  `N` (which is rule 1's `completed` anyway), or `opKind = publish`.
- At most ONE retry per lost ack, as today. A retry whose own answer is lost is reconciled once more
  and never retried again.
- No verdict is recorded from an attempt whose ack was lost. Only the retry's answer, when it is
  readable, becomes a verdict.

## 6. What refuses this design

- A history not in §2's table under which `opKind = none` and `lastCompleted = N - 1` while our AL
  executed or is executing. The reviewer's job is to find one in `ControlState.Codeunit.al`.
- A path by which the late-original ordering in §4 produces a VERDICT from either attempt's lost
  result. The original's result is never read (dead socket); the retry's `lease-invalid` is not a
  verdict.
- A second retry anywhere.

## 7. Tests that must exist before the gate

All in `orchestrator.test.ts`, "R194: a lost ack the marker shows was NEVER CLAIMED":

- rule 2b: never claimed (read twice) dispatches exactly one fresh attempt whose real verdict is
  recorded, no quarantine, the `lost-ack-not-started` warning and NOT `lost-ack-retry`;
- an idle marker with a hole below ours is unresolved and quarantined as before, with no retry;
- a claim that lands between the two reads is polled under rule 2, not retried over;
- a second consecutive never-claimed is unresolved and bounded at one retry;
- rule 2c: a refused retry whose marker shows the original completed is `result-lost` and the
  session continues with earlier verdicts intact; the original still executing is polled and a
  strand is a strand, still without invalidating the batch; a marker naming a stranger is a
  genuine lease loss and invalidates the batch as before;
- a resync that throws is unresolved, not an escaped exception.

Red-checked: disabling rule 2b fails four of the eight; disabling rule 2c's completed arm fails one.

- Live: bcdev 3/12/4 and tables 299/63/15 unchanged (no lost ack occurs on a container gate; the
  proof is that nothing else moved).

---

## REVIEW

(appended by the adversarial review)

### Findings (2026-09-02, spec-adversary agent), and what was done with each

- **F1, 2c's trigger was backwards.** "lease-invalid with no `leaseInvalidReason`" matches only the
  phase-3 refusal of a run that executed; every phase-1 refusal carries the reason. Fixed: 2c keys
  on a marker read after ANY `lease-invalid` answer to a 2b retry (§4), and `FencedRunOutcome` now
  carries the original attempt's coordinates and what its lost ack reconciled to.
- **F2, a third ordering.** The late original completing before the retry made the retry's branch-3
  refusal a false, batch-invalidating lease loss. Fixed: 2c's `completed` arm (§4).
- **F3, a second `not-started` desynchronises the counter.** Fixed: `unresolved` (§3, §5).
- **F4, folding into `completed` borrowed a false diagnosis.** Fixed: own outcome member, own
  warning; the only `MutantErrorCause` written on this path is `result-lost`, and only where the op
  did complete.
- **F5, the writer enumeration was incomplete and `force-reset-lease` produces the shape.** Fixed:
  §2 names all five writers, the conclusion is stated as "not claimed as of this read", and the
  generation check is named as what closes history (C). The rule-2 poll now requires the tombstone.
- **F6, late delivery is asserted, not measured.** NOT measured today. The design is never worse
  than today's quarantine in any ordering (traced in §4 and by the review), and better in two; a
  probe on the hosted sandbox that abandons one real request and watches the tombstone for minutes
  is the measurement that would say how long a queued request can take to land, and it is owed on
  the row.
- **F7, the 8 s poll.** Fixed: 2c polls with the mutant's budget (§4).
- **F8a, an unguarded resync.** Fixed: guarded, `unresolved` on throw (§3). **F8b**: the baseline
  loop is stated out of scope (§5).
