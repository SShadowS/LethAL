# R236: TestPage baseline in-flight-unknown rate, pre-commitment

Task: `docs/roadmap/R236.md`. Plan: `docs/superpowers/plans/2026-09-26-R-236-testpage-baseline-in-flight-unknown.md`.
Owner decisions (2026-09-26, `H:/lethal-coord/tasks/R-236/task.md`): D1 no, D2 no, D3 no, D4 no.

Committed before any live probe session. Nothing above the `## OUTCOME` line at the end of this file changes
after that, except by filling `## OUTCOME` itself in Task 5.

## §1 Unit and counting

One probe session. A HIT is a session whose `quarantined` reason contains `baseline test in-flight-unknown
running PageActionComputesNonZero`. An arm's rate counts every session that returned a report (hits and
non-hits, including `afterHit` sessions); the rate is also reported without `afterHit` sessions. Thrown
sessions (exit 4) are not observations. After a recovery, the arm continues as a new segment with the
remaining count; segments are pooled for the arm, and the OUTCOME lists each segment's counts and
timestamps. Priors (not part of any test, unaudited, not assumed independent): 1 hit in store runs 308 to
341, 1 in 342 to 347; gates on 2026-09-26 reported roughly half of sandbox-data sessions hitting.

## §2 Arms

One lease. Timestamps of every arm boundary, smoke, publish, swap and recovery go into the OUTCOME.

| block | client tree | control app | planned sessions | runs when |
| --- | --- | --- | ---: | --- |
| A1 | lane worktree `U:/Git/LethAL-wt/lane-bugs` HEAD | 1.0.0.19 | 15 | always |
| B'1 | worktree at `7b7fff3` (first parent of GH-24 merge `5b9e12a`) | 1.0.0.19 | 15 | always |
| B | same worktree | 1.0.0.18 | 30 | does not run (D1=no, D2=no, D3=no, 2026-09-26) |
| B'2 | same worktree | 1.0.0.19 | 15 | always |
| A2 | lane worktree `U:/Git/LethAL-wt/lane-bugs` HEAD | 1.0.0.19 | 15 | always |

A = A1 + A2, B' = B'1 + B'2. The HEAD client refuses 1.0.0.18 twice over (`MIN_CONTROL_VERSION = "1.0.0.19"`
in `harness.ts`; the check that every `ran` answer carries a boolean `observedActive` in
`run-mutant-transport.ts`), so B would need the old tree. The old tree's minimum is 1.0.0.18, so it accepts
1.0.0.19 (B'); it emits no `Reached` markers. The fixture is HEAD's in every arm.

What each contrast answers:
- **A vs B'** (always, the only live contrast this cycle): same app, different client. GH-24's client half
  PLUS every other client commit between `7b7fff3` and HEAD; `git log --oneline 7b7fff3..HEAD --
  packages/` goes into the OUTCOME as the confound list.
- **B' vs B** (answers D2): NOT measured. B does not run (D1=no, D2=no, D3=no).
- **A vs B** (answers D1): NOT measured. B does not run (D1=no, D2=no, D3=no).

The OUTCOME states plainly that the combined contrast (A vs B) and the app-only contrast (B' vs B) were not
measured this cycle.

### Execution facts (controller rulings, 2026-09-26)

(a) The HEAD-client arms (A1, A2) run from the lane worktree `U:/Git/LethAL-wt/lane-bugs`, whose gitignored
fixture configs point at Cronus28 and which is the only branch carrying the probe, not from the main
checkout `U:\Git\LethAL`. The B' worktree is created at `7b7fff3` as the plan says, unchanged.

(b) The probe forces `Connection: close` on traced calls. This is a known difference from the untraced
client. Task 4 step 3's smoke only sanity-checks it (median `durationMs` over the 21 passing tests within
20% of the untraced run, and the TestPage row's outcome class matching); it is not proof of neutrality for
rare failures.

## §3 Tests, thresholds, and short arms

All tests are Fisher exact tests on the ACTUAL counts `(hits1, n1, hits2, n2)`, with p = the hypergeometric
tail `P(X >= hits1)` where X counts hits in arm 1 given the pooled hits, n1 and n2. The read-out computes p;
the tables below are convenience for the planned sizes only and are overridden by the formula on any other
size.

- **Main contrasts (A vs B', B' vs B, A vs B):** one-sided, "the newer side has MORE hits", declared
  "raised" iff p < 0.05. Planned 30 vs 30: newer-side hits must be at least T.

  | older-side hits | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
  | --- | --: | --: | --: | --: | --: | --: | --: | --: |
  | T (30 vs 30) | 5 | 7 | 8 | 10 | 11 | 12 | 13 | 15 |

  Not met: "this measurement does not show an increase", never "no increase".
- **Drift (A1 vs A2; B'1 vs B'2):** two-sided, p = min(1, 2 x the one-sided tail in the direction observed),
  flagged iff p < 0.05. Planned 15 vs 15: the higher half must have at least D hits for a flag.

  | lower-half hits | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
  | --- | --: | --: | --: | --: | --: | --: | --: | --: |
  | D (15 vs 15, two-sided) | 5 | 7 | 9 | 10 | 11 | 12 | 13 | 14 |

  A drift flag on either split arm marks every contrast using that arm "confounded by drift".
- **Short arms.** Any arm that ends below two thirds of its planned sessions (below 20 of 30, or below 10 of
  a 15 half) is reported as "short: planned P, ran R", and every contrast using it is reported as
  "underpowered: not decided", whatever p is. Its counts are still published.
- **Non-reproduction.** If all arms together have at most 2 hits, run arm A3 (10 sessions, HEAD, 1.0.0.19,
  WITHOUT `only`, i.e. the full sandbox-data run); if A3 has at most 1 hit, Phase A ends "not reproduced" and
  no fix is built.

## §4 Mechanism, per hit

Correlation uses the broken call's own `(attemptId, opSeq)` and the progress row's `sessionId`.

| evidence on the broken TestPage call | class |
| --- | --- |
| `actionEnded` true (Task 2 requirement 7c) | **H2-action**: the whole action ended on the server, the reply was lost on the way |
| marker completed, but `actionEnded` false or unknown | **H2-fence**: the fence completed; the post-fence stages (coverage stop, `CoverageArray`, serialisation) or the reply itself did not provably finish |
| both reads: `opKind: "run"` with OUR attemptId and opSeq, AND the progress row for our `(attemptId, opSeq)` in state `running` | **H3: hang inside the fence** |
| both reads idle with `lastCompletedOpSeq = opSeq - 1` | **H7-candidate**: not claimed as of the second read; not proof it never will be |
| `errorPhase: "fetch"` | wire failure before headers |
| anything else, or a failed read | unclassified, quoted verbatim |

A class is DECLARED only if at least 3 hits are classifiable AND at least 70% of them share it; otherwise
**inconclusive**. TestPage specificity: over all broken RunMutant calls, declared only with at least 5 broken
calls AND at least 80% on `PageActionComputesNonZero`. Post-fence cost: the OUTCOME reports the distribution
of `coverageRunMs` and `coverageSerializeMs` for the TestPage call against the other 21 tests.
**Truncation (H8)**: `bytesReceived < Content-Length` on a broken call shows the client saw a TRUNCATED body.
It does not by itself show BC wrote a wrong length (the connection may have died mid-body); it is reported
as "truncated as seen by the client" with its count, and declared only with at least 3 such calls.

## §5 What this measurement cannot say

It does not reproduce R225's fresh-tenant bootstrap; the probe restarts nothing except inside the recovery
procedure. It cannot tell a cold container from the first session after a swap or recovery; those sessions
are flagged in the OUTCOME. It cannot establish keep-alive socket reuse: no per-request socket identity is
recorded, so H7 can only be a candidate here. R225's cold-start claim stays open.

## §6 What each outcome licenses

- H2-action declared: Task 8a (a product-readable whole-action signal) and then Task 8, subject to D5. Also
  the cause question in Task 13 stays open unless the event log or truncation evidence explains WHY the
  reply was lost.
- H2-fence declared: no retry of any kind. The post-fence stages are the suspect: Task 9 (owner ruling), with
  the post-fence cost distribution and event log as evidence.
- H3 declared: Task 9.
- H7-candidate or wire failure declared: no code. File a roadmap item that needs a per-request
  socket-identity observable before any `Connection: close` change is proposed.
- A main contrast "raised" (not confounded, not underpowered): Task 11.
- Inconclusive: nothing; report to the owner.

Nothing above the OUTCOME line changes after the first live session.

## Addendum 2026-09-26, before any live session (probe review r1)

Written after the probe's adversarial review and before any live probe session ran.

- **(i) `actionEnded` needs a demonstrated id-space match.** A call's BC session id missing from
  `Get-NAVServerSession` counts as "ended" only when that list is non-empty AND a known session id appears
  in it: the latest finished op of the same session (its `LC Op Progress` row) or the `sessionId` a
  successful `ran` answer carried. An overlap with the `Active Session` table is recorded
  (`activeTableOverlap`) as a diagnostic only: that read has no tenant or instance filter, so it proves
  nothing (review r2). Without the match (for example a wrong tenant answering an empty list, or a list
  that lists neither control), `actionEnded` is false and the probe stops with exit 3. The probe records
  this control for every session as `sessionControl`.
- **(ii) Unproven session checks are "H2 undetermined".** A hit whose marker completed is filed
  **"H2 undetermined"**, never H2-fence, when ANY of these holds for its session:
  `sessionControl.idSpaceMatched` is false, `sessionControl.finishedOpListed` is true, or
  `sessionControl.ranAnswerListed` is true (a listed control means sessions outlive their op, so a
  still-listed session proves nothing). H2-fence is filed only when `idSpaceMatched` is true, neither
  control is listed, and `actionEnded` is false. Note, stated rather than hidden: with (i) as written,
  `idSpaceMatched` is true only when a control IS listed, so these two conditions cannot both hold and no
  hit can be filed H2-fence by this probe. Every completed-marker hit that is not H2-action is therefore
  "H2 undetermined", and H2-fence stays undeclarable until a control that does not rely on a listed
  session exists.
- **(iii) Exit 2 after a session started.** An exit 2 after any session started (a harness fault in the
  middle of an arm) is handled like exit 3 or 4: run the recovery procedure before anything else uses
  Cronus28, then resume as a new segment.

## Addendum 2026-09-26, calibration results and the rate path (before the smoke)

Written after three read-only calibrations and before any probe session, per the orchestrator ruling
q-160433 (`H:/lethal-coord/tasks/R-236/run001/ruling-calibration.md`). Where this addendum and the two
addenda above disagree, this one governs.

### C1. Calibration method

`scripts/r236-baseline-probe/calibrate.ts`, run on Cronus28 while the coord lease (`coord lease Cronus28
bugs`) was held, and before any probe session. It is read-only: it acquires no LethAL lease, makes no
RunMutant call and runs no `runSession`. Its only control-app call is `HarnessInfo`, which writes nothing.
Each round runs one PowerShell read inside the container while a burst of sequential `HarnessInfo` calls
runs for the whole read. The read collects:

- `Get-NAVServerSession -ServerInstance BC -Tenant default` (id, user, ClientType name, login time);
- `[Active Session]` rows in the TENANT database (resolved with `Get-NAVTenant`; on Cronus28 that is
  `localhost\SQLEXPRESS/default`), filtered to `[Server Instance Name] = N'BC'`;
- the 50 newest `LC Op Progress` rows in state done (session id, attempt id, opSeq, Started At);
- `Session Event` rows for those session ids, filtered by the BC instance's `Server Instance ID`.

The soundness test, exactly as `calibrate.ts` implements it. "Same session" means the same id AND a login at
or before the op's Started At (5 s tolerance). An id that logged in later is a reused id and counts as
absent; an id with no login time is ambiguous.

- **(a) Pooling**, from the cmdlet list. `pooled` if a done op from the last `--recent-minutes` (10) is still
  listed as the same session. `not pooled` if none is listed and none is ambiguous. Otherwise
  `not determinable` (no recent done op, an unread list, or an ambiguous row).
- **(b1) A finished session disappears**, from a NON-EMPTY scoped `[Active Session]` read. `not sound` if a
  finished op's session is present as the same session. `sound` if at least one is determinably absent and
  none is present. `not determinable` for an empty or unread table.
- **(b2) A live session stays.** `sound` only if an `[Active Session]` row of our user, logged in during the
  burst, is ALSO listed by the cmdlet under a web-service or OData ClientType name
  (`/odata|soap|web ?service/i`). Otherwise `not determinable`. It can never say `not sound`, because a
  per-request session can end between two reads.
- **(b3) Ids match.** For each finished op, the latest `Session Event` Logon for its session id, at or before
  the op started, must be our user. `not sound` on any mismatch, `sound` on at least one match with no
  mismatch, otherwise `not determinable`.
- **Aggregate over rounds.** For b1, b2 and b3: any `not sound` wins, then any `sound`, else
  `not determinable`. Pooling: any `pooled` wins, then `not pooled`. The tenant-scoped `[Active Session]`
  control is `sound` only if b1, b2 and b3 are all `sound`.

### C2. Measured verdicts

Files, all under `C:/Users/SShadowS/AppData/Local/Temp/r236/` (scratch, not committed):

- `calibrate-1.ndjson` (5 rounds): every SQL read targeted the APP database and failed, so every verdict is
  `not determinable`. This led to the tenant-database fix (commit 0da4db5).
- `calibrate-2.ndjson` (5 rounds): the database was right, but the Session Event read named a column that
  does not exist, and b2 read `sound` on a row that was the reader's own management session. This led to the
  instance-id scope and the stricter b2 (commit fad0306). Its verdicts are superseded by calibration 3.
- `calibrate-3.ndjson` (5 rounds, about 290 to 340 `HarnessInfo` calls per round) is the governing result:
  - The cmdlet and the scoped `[Active Session]` read listed ONLY the reader's own session in every round
    (ids -6574, -7060, -7508, -7958; table Client Type 2, cmdlet ClientType "Windows"; calibrations 1 and 2
    show the same pattern with other negative ids). No OData session from the burst was ever listed.
  - The four newest done ops (session ids 3433 to 3436) were about 98 minutes old and absent from both lists.
  - `Session Event` scoped by `[Server Instance ID] = 4084` returned no rows.
  - Verdicts: pooling `not determinable` (no op finished within 10 minutes); b1 `sound`, but only on a table
    whose one row was the reader, so it shows the read is live and correctly scoped and says nothing about
    OData sessions; b2 `not determinable`; b3 `not determinable`. **Control: `not determinable`.**

### C3. Consequence for the mechanism

- The tenant-scoped `[Active Session]` control is **NOT adopted**. Neither pooling nor that control was shown
  to be sound, so no session check on Cronus28 can prove that a broken call's whole action ended.
- Every hit whose action end is not proven is classified **`action-end unproven`**. In practice that is every
  hit: `actionEnded` needs a listed control (addendum r1 (i)), and calibration 3 saw no OData session listed,
  live or finished.
- **§4 cannot declare H2-action, H2-fence or "H2 undetermined" from this probe on Cronus28.** The mechanism
  verdict is **inconclusive** and licenses no fix; §6's H2-action and H2-fence lines cannot fire. This
  supersedes addendum r1 (ii): those hits are `action-end unproven`.
- The marker-state rows of §4 do not depend on the session check. They may still be REPORTED DESCRIPTIVELY,
  with counts, where the two marker reads decide them: H3 (both reads `opKind: "run"` with our attemptId and
  opSeq, and our progress row `running`), H7-candidate (both reads idle with `lastCompletedOpSeq = opSeq - 1`),
  and a `fetch`-phase wire failure. The same holds for "marker completed" (the fence ended) and for H8
  truncation as seen by the client. None of these licenses a fix from this probe.
- Correction to the §4 table: its first two rows (H2-action, H2-fence) do not apply on Cronus28. Rows 3 to 6
  and the H8 paragraph stand, as descriptive counts only; the "declared" thresholds of §4 are not used.

### C4. The rate path (implemented in commit 1294a62)

- A session whose quarantine or broken call does not have a proven action end is recorded with
  `actionEnd: "unproven"`. If its reason is the TestPage in-flight-unknown one, it is a COUNTED hit. There is
  no retry, and the arm continues (probe exit 0). This supersedes addendum r1 (i)'s "the probe stops with
  exit 3" for an unproven action end.
- Before the next session the probe runs a gate: `lethal doctor` on the fixture config must exit 0, and the
  harness check must pass; nothing force-resets. The lease acquire happens inside the session. If the gate
  fails the probe exits 3; if the lease acquire refuses, the session throws and the probe exits 4. Both mean:
  run the recover-tier sequence of Task 4, then resume with the next `--segment`. The first session of a
  resumed segment carries `postRecovery: true`.
- Sessions that follow an unproven hit carry `afterUnprovenHit: true`. The OUTCOME reports the rate three
  ways: all sessions (the §3 figure), excluding `afterUnprovenHit` sessions, and excluding `postRecovery`
  sessions, so a leftover action cannot silently bias the rate.

### C5. Power (ruling item 3)

The §3 main contrast A vs B' is a one-sided Fisher test on the actual counts, p = P(X >= a) with X
hypergeometric (60 sessions, a + b hits, 30 drawn for A), declared "raised" iff p < 0.05. Computed exactly
for the planned 30 vs 30: the minimum A hits T for each B' hit count b, with p at T and at T - 1.

| B' hits b | min A hits T | p at T | p at T - 1 | B' rate | A rate needed |
| --: | --: | --: | --: | --: | --: |
| 0 | 5 | 0.0261 | 0.0562 | 0% | 17% |
| 1 | 7 | 0.0262 | 0.0514 | 3% | 23% |
| 2 | 8 | 0.0399 | 0.0727 | 7% | 27% |
| 3 | 10 | 0.0287 | 0.0521 | 10% | 33% |
| 4 | 11 | 0.0358 | 0.0626 | 13% | 37% |
| 5 | 12 | 0.0420 | 0.0716 | 17% | 40% |
| 6 | 13 | 0.0473 | 0.0790 | 20% | 43% |
| 7 | 15 | 0.0298 | 0.0517 | 23% | 50% |
| 8 | 16 | 0.0320 | 0.0551 | 27% | 53% |
| 9 | 17 | 0.0336 | 0.0577 | 30% | 57% |
| 10 | 18 | 0.0346 | 0.0594 | 33% | 60% |
| 11 | 19 | 0.0349 | 0.0602 | 37% | 63% |
| 12 | 20 | 0.0346 | 0.0602 | 40% | 67% |
| 13 | 21 | 0.0336 | 0.0594 | 43% | 70% |
| 14 | 22 | 0.0320 | 0.0577 | 47% | 73% |
| 15 | 23 | 0.0298 | 0.0551 | 50% | 77% |
| 16 | 24 | 0.0269 | 0.0517 | 53% | 80% |
| 17 | 24 | 0.0473 | 0.0851 | 57% | 80% |
| 18 | 25 | 0.0420 | 0.0790 | 60% | 83% |
| 19 | 26 | 0.0358 | 0.0716 | 63% | 87% |
| 20 | 27 | 0.0287 | 0.0626 | 67% | 90% |
| 21 | 28 | 0.0210 | 0.0521 | 70% | 93% |
| 22 | 28 | 0.0399 | 0.0903 | 73% | 93% |
| 23 | 29 | 0.0262 | 0.0727 | 77% | 97% |
| 24 | 30 | 0.0119 | 0.0514 | 80% | 100% |
| 25 | 30 | 0.0261 | 0.0973 | 83% | 100% |
| 26 to 30 | none | | | 87% to 100% | not reachable |

The rows for b = 0 to 7 match §3's table. What this means:

- The gates on 2026-09-26 saw roughly half of sandbox-data sessions hit. At a B' rate near 50% (b = 15), A
  must reach at least 23 of 30 (77%) to declare "raised". Only a large increase, about 27 percentage points
  or more, is detectable; a smaller real increase will read "this measurement does not show an increase".
- At a B' rate of 87% or more (b >= 26) no A count can declare "raised".
- An arm that ends below 20 of 30 sessions is short under §3, and every contrast using it is reported as
  **"underpowered: not decided"**, whatever p is; its counts are still published. The table covers 30 vs 30
  only; on any other size the formula on the actual counts decides.
- The C4 rates that exclude `afterUnprovenHit` or `postRecovery` sessions are reported beside the §3 total
  and are not separately tested.

## OUTCOME
