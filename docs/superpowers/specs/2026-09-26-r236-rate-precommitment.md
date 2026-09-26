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

## Addendum 2026-09-26, Cronus284, warm-up, smoke facts and the truncation check (before any arm session)

Written before any arm session, on orchestrator rulings received after the Cronus28 smokes. Where it
disagrees with the addenda above, this one governs.

### D1. Container

- All arms (A1, B'1, B'2, A2) run on **Cronus284**, a container dedicated to R236 (owner allocation
  2026-09-26). No arm session ran on Cronus28. The Cronus28 smokes below are pre-arm observations only and
  count toward nothing.
- The probe and calibrate scripts take the container name from the config's `bcdev.server` host (commit
  aa41a22) and record it as `container` in every NDJSON record.
- The read-only calibration (C1, same method and rules) is re-run on Cronus284 before any probe session there,
  and its verdicts govern. None of the Cronus28 facts is assumed for Cronus284: not the multitenant layout,
  not the tenant database name, not the session listing. C3 is re-decided from that run: the tenant-scoped
  `[Active Session]` control is adopted for the mechanism only if Cronus284's calibration shows it `sound`,
  and adopting it needs a probe change committed before any arm session. Otherwise C3 stands as written.

### D2. Warm-up sessions

R225 reported that the first TestPage baseline on a fresh container tends to be lost. So:

- The first TWO probe sessions run on Cronus284, whatever their arm label, and the first session after every
  container restart (the `postRecovery: true` session), are **warm-up** sessions.
- A warm-up session is recorded and reported separately (its counts and outcomes are published). It is
  EXCLUDED from every rate, every §3 contrast, every drift test and every C5 figure.
- A warm-up session does not count toward its arm's planned sessions: an arm of 15 needs 15 non-warm-up
  sessions, so each recovery adds one session to the arm's remaining count.
- The short-arm rule of §3 counts non-warm-up sessions only.

### D3. Smoke facts (Cronus28, 2026-09-26, pre-arm observations)

Sources, under `C:/Users/SShadowS/AppData/Local/Temp/r236/`: `smoke-traced.ndjson`, `smoke-untraced.ndjson`,
`log.txt` (and the matching `.log` files). Control app 1.0.0.19 in every session.

Traced smoke, 5 sessions in two segments, **4 of 5 hits**. For each, the TestPage call
(`RunMutantWithCoverage`, `PageActionComputesNonZero`):

| session | headers after | transfer | bytes received | ended | how | next |
| --- | --: | --- | --: | --: | --- | --- |
| seg 1 #1, hit | 701 ms | chunked, no Content-Length | 6534 | 120 007 ms | AbortError (client timer) | preflight FAILED (doctor: HarnessInfo unreachable), restart 1 |
| seg 2 #1, hit (post-recovery) | 1610 ms | chunked | 6641 | 27 093 ms | socket closed unexpectedly | preflight passed |
| seg 2 #2, hit | 614 ms | chunked | 6528 | 120 004 ms | AbortError (client timer) | preflight passed |
| seg 2 #3, clean | 283 ms | chunked | 6615 (full answer) | body complete at 283 ms | answered `fail` with the expected CLR text | |
| seg 2 #4, hit | 846 ms | chunked | 6534 | 120 013 ms | AbortError (client timer) | last session, no preflight |

Untraced smoke, **2 of 2 hits**: #1 `error` after 27 803 ms (socket closed unexpectedly, preflight passed);
#2 `deadline-exceeded` after 120 008 ms (preflight before #3 FAILED, restart 2). No byte counts exist for
untraced sessions.

Wedges: of the 5 hits that were followed by a preflight, 2 failed it (the container stopped answering
`HarnessInfo`) and needed a container restart. Recovery 1 ran 18:43 to 18:49 and recovery 2 ran 19:00 to
19:06 local time, each by the full recover-tier sequence.

These smokes kept no body BYTES (the capture landed afterwards, commit ec8384d), so none of the D6 checks can
be run on them. The byte COUNTS above were seen before D6 was written, and D6 is written knowing them.

### D4. Correction: baseline row counts

A clean session records **68** baseline rows (every test of `sandbox-data-tests`); the TestPage test is the
22nd. A hit session stops at that call and records **22**. Wherever the plan or Task 4 says "22 baseline rows"
as a pass condition, read it as **22 rows on a hit, 68 rows on a clean session**.

### D5. Risk stated before running, and the stop rule

- The smokes hit about 80% of the time (6 of 7 sessions), and about 2 in 5 of the hits followed by a
  preflight wedged the container. With the plan's rule "an arm that stops three times ends short", arms are
  likely to end short, and every contrast using a short arm reads **"underpowered: not decided"** (§3, C5).
- The three-stops rule is kept unchanged (orchestrator ruling). An arm that ends short is reported as such,
  with its counts published.
- **Wedges are their own reported result.** For each arm and overall: the number of hits followed by a
  preflight, the number of those whose preflight failed (a wedge, which leads to recovery), and that ratio.
  Warm-up sessions are included in the wedge counts but marked.
- **"Truncated reply"** is a descriptive observation class: response headers arrived, then part of the body,
  then an abort (client timer) or a socket close, with no complete body. It is reported per hit with the
  headers-after time, bytes received, the ending (AbortError or socket close) and its time. Every smoke hit
  above is of this class. It replaces §4's H8 "`bytesReceived < Content-Length`" test, which cannot be
  evaluated: these answers use chunked transfer encoding and send no Content-Length.

### D6. The truncation decision (pre-committed before any Cronus284 data is looked at)

Inputs, from the probe's answer captures (commit ec8384d): for every hit, the partial bytes of the TestPage
answer and its offset (the number of bytes that arrived; equal to `bytesReceived`); for every clean session,
the full bytes of the same call's answer. Warm-up sessions are included and marked. Hits without a capture
(untraced, or a failed write) are listed and left out of both conditions.

- **Consistent offset** holds iff, over all captured hits, (max offset - min offset) <= 256 bytes AND every
  hit's offset is smaller than the smallest captured full clean answer.
- **Otherwise identical** holds iff every captured hit's partial bytes equal EVERY captured clean answer up to
  the hit's offset, after this masking and nothing more:
  1. Decode both as UTF-8; drop an incomplete final character of the partial.
  2. Replace every JSON number value whose key name ends in `Ms`, `At`, `timestamp` or `duration` (matched on
     the key text as it appears, escaped quotes included, so it applies inside the OData `value` string) with
     `#`. String values of such keys are NOT masked.
  3. Replace every GUID (8-4-4-4-12 hex digits, with or without braces) with `GUID`.
  4. Replace the value (number or string) of every key named exactly `attemptId`, `opSeq`, `sessionId`,
     `serverGeneration` or `epoch` with `#`.
  5. Compare the masked partial, minus its last 64 characters (a token cut by the break may mask
     differently), as a prefix of the masked clean answer.
  If the clean answers differ from one another after this masking, "otherwise identical" is reported as
  failed on that ground. If a field outside the mask differs, the field and both values are REPORTED; the
  mask is not widened after looking.
- **Reading.** If both conditions hold: the loss is on the server's send or serialize side, not the client's.
  If either fails: report which, with the numbers (min, max and spread of offsets, the smallest clean size,
  and the first differing position and field for each failing pair).
- **Descriptive only, not a prediction:** whether the offsets fall on a buffer or chunk boundary, or at a
  payload position such as inside the CLR callstack text.

## Addendum 2026-09-26, incident: the calibration read the wrong container (before any Cronus284 session)

### E1. What happened

- At about 17:17 UTC on 2026-09-26, the read-only calibration meant for Cronus284 ran against **Cronus28**,
  without the Cronus28 lease. The cause: `probe.ts` hard-coded
  `PROJECT_DIR = "U:/Git/LethAL/fixtures/sandbox-data"`, the MAIN checkout, so both scripts read the main
  checkout's gitignored config, whose `bcdev.server` still named Cronus28, instead of this worktree's config
  (`http://Cronus284`). The container-from-config change (D1) then correctly derived Cronus28 from the wrong
  config.
- The calibration makes no writes: `HarnessInfo` calls, `Get-NAVServerSession`, and SELECT statements in the
  tenant database. The orchestrator checked Cronus28 afterwards and found it clean.
- That run's output is discarded. It is not a Cronus284 calibration and governs nothing.
- The Cronus28 smokes of D3 were run under the Cronus28 lease, from the main checkout, and so used the main
  checkout's fixture copy at master 7b51d1f. D3's facts stand as pre-arm observations of that tree.

### E2. The fix (commit 9661386)

- `PROJECT_DIR`, `TEST_DIR`, `CONFIG_PATH` and the launch config now resolve from the script's own location
  (two levels up is the repo root). A copy of the scripts in the 7b7fff3 worktree (Task 4 step 5) therefore
  resolves to THAT worktree's fixture, and that worktree needs its own copy of the gitignored
  `fixtures/sandbox-data/lethal.config.local.json` naming Cronus284 before it runs.
- Every probe record and calibration line carries `projectDir`, `server` and `container`, and both scripts
  print them at start.
- No other absolute path remains in the probe folder: scratch directories, the scratch store and the scratch
  quarantine directory are under the OS temp directory; the control app comes from the config or
  `--control-app`; the only absolute defaults left are the coord script and root below, both flags.

### E3. The lease guard (commit 9661386)

- Before ANY network call, `probe.ts` and `calibrate.ts` derive the container from the config's server host
  and run `coord holder <container>` (`deno run --allow-all <coord-script> holder <container>` with
  `CG_COORD_ROOT=<coord-root>`; defaults `U:/Git/agent-coord/coord.ts` and `H:\lethal-coord`, flags
  `--coord-script` and `--coord-root`).
- They proceed only if the holder is lane **"bugs"**. A null holder, another lane, a coord that exits non-zero
  or cannot be spawned, or output that is not the expected JSON all REFUSE with exit 2 and a message naming the
  container and what coord showed. The first network call happens only after the guard passes.

## OUTCOME

Filled 2026-09-26 in Task 5, offline, from the NDJSON under `C:/Users/SShadowS/AppData/Local/Temp/r236/`
(scratch, not committed) and its `log.txt`. Tabulated by a one-off `bun` script that is not committed. Times
are local (UTC+2) unless marked Z. Every arm ran on **Cronus284** (D1), control app **1.0.0.19** in every
session, fixture tree HEAD's, test app `LethAL Sandbox Data Tests` 1.0.0.18.

### O1. Counts (§1, §2, D2)

Warm-up sessions (D2) are excluded from every rate and test below and listed separately.

| block | segment | time | counted n | counted hits | hits at | warm-up sessions |
| --- | --- | --- | --: | --: | --- | --- |
| A1 | 1 | 19:34:51 to 19:47:27 | 15 | 2 | #1, #8 | none |
| B'1 | 1 | 19:48:30 to 19:57:52 | 10 | 2 | #9, #10 | none |
| B'1 | 2 | 20:04:20 to 20:10:16 | 5 | 1 | #4 | #1 (post-recovery), a hit |
| B'2 | 1 | 20:10:23 to 20:19:01 | 15 | 0 | | none |
| A2 | 1 | 20:19:13 to 20:29:37 | 15 | 1 | #4 | none |

- **A = 3 of 30** (A1 2 of 15, A2 1 of 15). **B' = 3 of 30** (B'1 3 of 15, B'2 0 of 15).
- Excluding `afterUnprovenHit` sessions (C4): A1 2 of 13, A2 1 of 14, B'1 2 of 12, B'2 0 of 15; A 3 of 27,
  B' 2 of 27. Excluding `postRecovery` sessions: unchanged from the §3 figure (A 3 of 30, B' 3 of 30), because
  the one post-recovery session is a warm-up and is already out. Neither alternative is tested (C5).
- Warm-up sessions, reported separately: `warmup-284` #1 **hit**, #2 clean (the first two probe sessions on
  Cronus284, 19:31:42 to 19:34:44); B'1 segment 2 #1 **hit** (first session after restart 284-1). 2 of 3 warm-up
  sessions hit. The first warm-up attempt (`warmup-284-publishfail`, 19:28:24) threw before any test ran and is
  not an observation.
- Every counted session returned a report; no session threw during an arm. The client commits recorded are
  `69a3a85` (A1, A2) and `7b7fff3` (B'1, B'2).
- Hits by position in their block: a hit was followed by another hit once (B'1 #9 then #10); the other 6
  sessions that followed a hit were clean.

### O2. Main contrast (§3, C5)

- **A vs B'**: Fisher exact, one-sided "A (newer client) has MORE hits", p = P(X >= 3) with X hypergeometric
  (60 sessions, 6 hits, 30 drawn for A) = **0.6646**. Not below 0.05: **this measurement does not show an
  increase.** Neither split arm is flagged for drift and neither is short, so this contrast is neither
  "confounded by drift" nor "underpowered". C5's power note applies: at B' = 3 of 30, A needed at least 10 of 30
  to read "raised".
- **B' vs B** and **A vs B**: NOT measured this cycle. B did not run (D1 = no, D2 = no, D3 = no). The combined
  contrast and the app-only contrast remain unmeasured.

### O3. Drift and short arms (§3)

- **A1 vs A2**: 2 of 15 vs 1 of 15, two-sided p = min(1, 2 x P(X >= 2)) = min(1, 2 x 0.5000) = **1.0000**. Not
  flagged.
- **B'1 vs B'2**: 3 of 15 vs 0 of 15, two-sided p = min(1, 2 x P(X >= 3)) = min(1, 2 x 0.1121) = **0.2241**. Not
  flagged.
- **Short arms: none.** Every arm reached 15 non-warm-up sessions. B'1 stopped once (1 of the 3 allowed) and
  resumed as segment 2 with the remaining 5 plus one warm-up session (D2).
- **Non-reproduction (§3):** the arms together have 6 counted hits, more than 2, so A3 did not run.

### O4. Mechanism (§4 as amended by C3 and D1)

- Cronus284's calibration (`calibrate-284.ndjson`, 5 rounds, 19:26:56) read pooling `not determinable`, b1
  `sound`, b2 `not determinable`, b3 `not determinable`: **control `not determinable`**. The control was not
  adopted, so C3 stands: every hit is `action-end unproven` (all 8 records say `actionEnd: "unproven"`,
  `actionEnded: false`, `idSpaceMatched: false`), and **the mechanism verdict is inconclusive**. H2-action,
  H2-fence and "H2 undetermined" are not declared.
- Descriptive marker-state counts (C3), over all 8 hits (6 counted, 2 warm-up):
  - **marker completed: 7** (6 counted, 1 warm-up). Both reads: `opKind: "none"`, `completed: true`,
    `lastCompletedOpSeq` equal to the broken call's own `opSeq`, our `opAttemptId`, and our progress row in
    state `done`. The fence ended on the server.
  - **failed read: 1** (B'1 #10, counted). Both reads (at 0 ms and 45 032 ms) ended `TimeoutError: The
    operation timed out.` Unclassified.
  - H3: 0. H7-candidate: 0. `fetch`-phase wire failure: 0. Every broken call got status 200 headers and failed in
    phase `body`.
- **Broken calls by `testMethod`**, all Cronus284 sessions: `PageActionComputesNonZero` **8**, any other test
  **0** (no other call errored). This meets §4's specificity numbers (at least 5 broken calls, at least 80%);
  under C3 it is a descriptive count and licenses nothing by itself.
- **NST event log**, one excerpt per class seen (the probe reads the Application log for
  `MicrosoftDynamicsNav*` since the session started):
  - marker completed (all 7): the read returned **no** BC event at all; the section after `----` is empty.
  - failed read (B'1 #10): five warnings, Id 705, from 17:56:16Z to 17:57:14Z, each reading "Request was
    throttled. It either timed-out or was cancelled.The OData operation was canceled by the user.", with
    `CustomParameters` `"Max Active Request Count": "100","Requests running": "5","Requests waiting": "8"`
    (the first) falling to `"6"` (the last). The TestPage call had been dispatched at 17:55:43.8Z and its
    socket closed at +30 829 ms.

### O5. The TestPage call, per hit

| session | warm-up | headers after | bytes received | ended | at | marker |
| --- | --- | --: | --: | --- | --: | --- |
| warmup-284 #1 | yes | 1484 ms | 6528 | AbortError (client timer) | 120 004 ms | completed |
| A1 #1 | | 614 ms | 6536 | AbortError (client timer) | 120 010 ms | completed |
| A1 #8 | | 717 ms | 6530 | AbortError (client timer) | 120 005 ms | completed |
| B'1 #9 | | 606 ms | 6544 | AbortError (client timer) | 120 014 ms | completed |
| B'1 #10 | | 644 ms | 6616 | socket closed unexpectedly | 30 829 ms | failed read |
| B'1 seg 2 #1 | yes | 1689 ms | 6642 | socket closed unexpectedly | 27 840 ms | completed |
| B'1 seg 2 #4 | | 683 ms | 6533 | AbortError (client timer) | 120 008 ms | completed |
| A2 #4 | | 618 ms | 6533 | AbortError (client timer) | 120 016 ms | completed |

- Every hit is a **"truncated reply"** (D5): `Transfer-Encoding: chunked`, no `Content-Length` (so §4's H8
  `bytesReceived < Content-Length` test cannot be evaluated, as D5 says), headers arrived, part of the body
  arrived, then an abort or a socket close with no complete body. 8 of 8.
- The same call in the 57 clean sessions (arms, warm-up #2, `smoke-Bp`, `restore-check`): `headersAt -
  dispatchedAt` min 271, median 320, p90 360, max 543 ms; the body completed 0 to 1 ms after the headers;
  6616 to 6618 bytes; chunked, no `Content-Length` in any of them. **Every hit's headers came later (606 ms or
  more) than every clean answer's (543 ms at most).**

### O6. Truncation decision (D6)

Captures: 8 of 8 hits have a partial capture (none left out), 57 clean sessions have a full capture. Warm-up
sessions are included and marked above.

- **Consistent offset: FAILS.** Offsets: 6528, 6536, 6530, 6544, 6616, 6642, 6533, 6533. Min 6528, max 6642,
  **spread 114** (at most 256: holds). Smallest captured full clean answer: **6616** (full sizes seen 6616, 6617,
  6618). Not every offset is smaller than 6616: B'1 #10 at **6616** (equal) and the warm-up B'1 segment 2 #1 at
  **6642** (larger). The second condition fails.
- **Otherwise identical: FAILS**, on the ground D6 names first: the 57 clean answers differ from one another
  after the D6 masking (57 distinct masked texts). The fields that differ are outside the mask: `artifactId`
  (32 hex digits, random per artifact, not a GUID), and the string values of `startTime` and `finishTime` (D6
  masks only number values of time-like keys). Every hit/clean pair (8 x 57) fails, and for every pair the first
  differing position is `artifactId`, at character 145 or 146 of the masked text; for example A1 #1's partial
  has `a8e82fbcbf523657f52ec61a8af38418` where the first clean answer has `f82ef7fd2289f187e14e20abaab82e39`. The
  mask is not widened.
- **Reading:** both conditions fail, so D6 does not license "the loss is on the server's send or serialize
  side, not the client's".
- **Descriptive only, not part of the decision** (a comparison that also masks `artifactId`, `startTime`,
  `finishTime` and every digit, chosen after looking):
  - The 57 clean answers are then identical. 6 of the 8 partials are then exact prefixes of every clean
    answer. The two that are not are the two warm-up hits: their CLR callstack has a
    `System.RuntimeMethodHandle.InvokeMethod(...)` frame where every clean answer has
    ``InvokeStub_ITestClientSession.CreatePage(Object, Span`1)``. That longer callstack is why the warm-up hit
    B'1 segment 2 #1 received 6642 bytes, **more than any clean answer**.
  - **Where the offsets sit:** none inside the callstack text (it ends near character 5357 to 5384). All are in
    the last part of the payload, in or after the `coverage` array. The six timer-ended hits are about 73 to
    116 bytes short of a complete answer (estimated against one clean answer's digit widths): the warm-up
    `warmup-284` #1 stops inside the `coverage` array, and the other five stop between the end of that array and
    `coverageSerializeMs`; four of those five carry the TestPage call's own `coverageRunMs` (254, 265, 267,
    315 ms), and A1 #8's cut falls just after that key. The two socket-closed hits lack only the **final `}`**
    of the OData envelope, **1 byte**, and carry `coverageRunMs` (287 ms; 1326 ms on the warm-up) and
    `coverageSerializeMs` (2 and 3 ms).
    The offsets fall on no 4096 or 8192 boundary. Nothing here says whether the missing bytes were the last
    chunk the server wrote or something the connection dropped.

### O7. Post-fence cost (§4)

`coverageRunMs` / `coverageSerializeMs` over all 65 Cronus284 sessions:

| call | n | coverageRunMs min / median / p90 / max | coverageSerializeMs min / median / p90 / max |
| --- | --: | --- | --- |
| TestPage call (clean sessions only) | 57 | 245 / 289 / 331 / 494 | 1 / 2 / 3 / 15 |
| the other 21 tests of the first 22 | 1365 | 144 / 286 / 341 / 809 | 1 / 3 / 5 / 47 |
| all 67 other tests | 3987 | 144 / 286 / 336 / 809 | 1 / 3 / 4 / 47 |

Hits record no `postFence` row for the TestPage call; the values in their partial answers are in O6. On a
clean session the TestPage call's post-fence cost is not larger than the other tests'.

### O8. Wedges (D5)

| arm | hits followed by a preflight | preflight failed (wedge) | ratio |
| --- | --: | --: | --- |
| warm-up (`warmup-284`) | 1 (warm-up) | 0 | 0 of 1 |
| A1 | 2 | 0 | 0 of 2 |
| B'1 | 3 counted + 1 warm-up | 1 (after #10, counted) | 1 of 4 |
| B'2 | 0 | 0 | |
| A2 | 1 | 0 | 0 of 1 |
| **overall** | **8** (6 counted, 2 warm-up) | **1** | **1 of 8** (counted: 1 of 6) |

Every hit was followed by a preflight (none was the last session of its run). The one wedge: after B'1 #10 the
preflight's `lethal doctor` exited 1, the probe exited 3, and recovery 284-1 ran (restart 19:58:09, healthy
20:03:59, force-reset and clear-quarantine done 20:04:20).

### O9. Timeline (Cronus284, local time)

- 19:17:16 Cronus284 lease 003. 19:19:15 incident E1 (the calibration read Cronus28; discarded).
- 19:26:56 calibration on Cronus284 (O4).
- 19:28:24 to 19:28:38 first warm-up attempt threw: publish refused, `AL0132 ... 'NoteReached'`, because a
  tenant-scoped LethAL Control 1.0.0.16 was resident. 19:31:09 to 19:31:29 cleanup (orchestrator option a):
  unpublished old residents `LethAL Sandbox Tests` 1.0.0.2, `Sandbox Probes` 1.0.12.0, `Sandbox Hang Tests`
  1.0.0.2, `Sandbox App` 1.0.20714.30801, `Sandbox Hang` 1.0.20714.28315, `LethAL Control` 1.0.0.16 and 1.0.0.18
  (both uninstalled). Left: Sandbox Data Tests 1.0.0.18, Control 1.0.0.19 (Global), Sandbox Data.
- 19:31:42 to 19:34:44 warm-up (2 sessions). 19:34:51 to 19:47:27 A1.
- 19:47:43 the lane config's `packageCachePath`/`packagesDir` moved to the lane's own `.alpackages` (A1 had used
  the main checkout's). 19:47:43 to 19:48:18 `smoke-Bp` (1 session, clean, `clientCommit` 7b7fff3).
- 19:48:30 to 19:57:52 B'1 segment 1 (10 sessions, exit 3). 19:58:09 to 20:04:20 recovery 284-1.
- 20:04:20 to 20:10:16 B'1 segment 2 (1 warm-up + 5). 20:10:23 to 20:19:01 B'2. 20:19:13 to 20:29:37 A2.
- 20:30:02 restore check: Sandbox Data Tests 1.0.0.18, Sandbox Data 1.0.20722.33272, Control 1.0.0.19, all
  installed. 20:30:09 to 20:30:44 `restore-check` session clean. 20:30:52 lease released.
- No app swap (B did not run). Pre-arm Cronus28 smokes and their two recoveries are in D3.

### O10. Confound list (§2)

Outside `packages/`: arm order A1, B'1, B'2, A2 on one container; A1 read the main checkout's `.alpackages`
(O9); the B' probe is a copy of this tree's probe run against the old client API (no `b-tree.diff` was saved,
so it compiled unchanged). `git log --oneline 7b7fff3..HEAD -- packages/`, 37 commits:

```
1d14262 fix(explain): carried rows never decide reach; refuse contradictory reach on carried and false-with-reachers (GH-24b r1)
73b0844 Merge master into lethal/lane-bugs
30e4d68 fix(explain): refuse reached with no reachedBy; pin the reachGrain enum to runtime (GH-24b review)
83c5839 feat(explain): reach decided per mutant, EXPLAIN_SCHEMA_VERSION 5 (GH-24b)
7f84ff2 Merge C02-06 (part a): lethal verify's store columns, source hash and offline resolution
0a4a106 fix(runner): generation parses the snapshot the source hash is taken over (C02-06)
b74af12 fix(runner): a resume across a preprocessor-symbol change starts fresh (C02-06)
57f066f fix(runner): verify refuses an empty request instead of planning it as all skipped (C02-06)
4321e5d style(runner): no em dashes in the moved loadEquivalenceMarks doc (C02-06)
79ee766 test(runner): measured namespaced coverage rows resolve under base 1 (GH-09)
d79c2b6 feat(runner): verify matches covering tests by codeunit id and skips reader-marked survivors (C02-06)
4916119 Merge master into lethal/lane-bugs
d89cd07 fix(runner): a duplicate artifact record is refused as unknown-artifact (C02-06)
e8adfe0 feat(runner): verify resolves its source by artifact id and refuses changed source (C02-06)
3f8a926 test(runner): pin the CLI's preprocessor symbols reaching the source hash (C02-06)
9c6f09f feat(store): record the installed files, source hash, carried verdicts and test codeunit names that lethal verify reads (C02-06)
2fc92fe test(explain): the resumed-report test asserts its projected survivor count (C02-01)
024d510 fix(explain): validate a survivor's batchIndex whether or not artifacts exists (C02-01)
ccab705 fix(report): a row's readerMark follows the run-level matched list (C02-01)
cb4dbdb test(runner): a real namespaced SymbolReference declares both objects (GH-09)
f0492fd Merge master (GH-24 reach) into lethal/lane-code
87e24f7 fix(explain): refuse a malformed readerMark; tidy C02-01 comments (C02-01)
2fd4da8 fix(explain): refuse a malformed survivor batchIndex when the report names artifacts (C02-01)
af6f3ae feat(explain): survivors name the artifact they were scored against, or why not (C02-01)
20d2c4e feat(explain): survivors carry batch, trigger, span, equivalence risk and reader mark (C02-01)
32e91c8 fix(schemata): the reach latch takes a name free in its scope (GH-24)
56282f7 Merge master into lethal/lane-bugs (orchestrator.test.ts: keep both appended blocks, GH-24 reach and C02-04b/C02-05)
0a3a38a feat(report): each row carries its own equivalence risk and reader mark (C02-01)
fd72825 feat(report): each mutant row names its enclosing member's line span (C02-01)
0a9cc84 fix(schemata): the reach latch declaration skips comments before begin (R246)
2304074 fix(schemata,control): the reach marker latches after its first hit, reset with ObservedActive (R246)
75c59de test(itest): assertReachControl on itest:tables (GH-24)
9c86b79 test(itest): pre-commit reach evidence on the gates (GH-24)
d2a8cc5 feat(runner): guardReached, reachedBy and reachGrain per mutant (GH-24)
eb27ee1 feat(runner): the transport carries per-test reach and refuses an answer without it (GH-24)
f154643 feat(schemata): reach grain per mutant, and a marker at its own statement (GH-24)
d6dd50f feat(control): ObservedActive, the active mutant's own statement reached, per test (GH-24, 1.0.0.19)
```

### O11. What this licenses (§6)

- Mechanism **inconclusive** (C3): **nothing**; report to the owner. H2-action (Task 8a, Task 8) and H2-fence
  (Task 9) cannot fire on this probe. H3, H7-candidate and wire failure were not seen (0 each), so neither Task 9
  via H3 nor the socket-identity roadmap item is licensed.
- Main contrast A vs B' **not raised** (p = 0.6646): Task 11 is not licensed. **This measurement does not show
  an increase** from the client commits between `7b7fff3` and HEAD on control app 1.0.0.19.
- Truncation (D6): neither condition holds; no reading about the send side is licensed.
- Stated plainly (§5): the fresh-tenant bootstrap was not reproduced, R225's cold-start claim stays open, and
  socket reuse cannot be established. The rate on Cronus284 (6 of 60 counted, 2 of 3 warm-up) differs sharply
  from the Cronus28 smokes (6 of 7, D3); this cycle cannot say why.

## ERRATUM 2026-09-26 (review r1, written after the run; nothing above this line is edited)

- **Execution facts (a)/(b) correction.** §2's "Execution facts" said the probe forces `Connection: close` on
  traced calls. It does not: `traceFetch`'s `freshConnection` hook (`scripts/r236-baseline-probe/fetch-trace.ts`)
  is what sets that header, and `probe.ts`'s `sessionHooks` never sets `freshConnection` on the hooks object it
  builds, so it stays undefined and the check `hooks.freshConnection === true` is false on every call this probe
  made. Every traced call in this run used the same connection handling as the untraced client. This changes no
  result in the OUTCOME: O2's contrast, O4 through O8's descriptive counts and O11's licensing all stand
  unchanged, since none of them relied on `Connection: close` being forced.
- **`afterUnprovenHit` correction and fix.** `afterUnprovenHit` is a per-process variable (`probe.ts`, `main()`):
  it starts `false` at the top of every invocation, so a new invocation (a new `--segment`, a new arm script, the
  smoke scripts) cannot know whether the PREVIOUS invocation's last session ended on an unproven hit, and the C4
  preflight (doctor + harness check) was skipped at such a boundary. Fixed in
  `scripts/r236-baseline-probe/probe.ts` (commit `d222663`): a new `shouldPreflight(index, afterUnprovenHit)`
  helper also gates a run's first session (`index === 1`) unconditionally, so every invocation now preflights
  at its own start regardless of what the prior invocation's last session did.
  - **Timeline check, verified against `C:/Users/SShadowS/AppData/Local/Temp/r236/log.txt` and the NDJSON files.**
    In the counted arms, no invocation boundary followed an unproven hit: A1 ended on #15, no hit; B'1 segment 1
    ended on the failed preflight and the recovery it triggered (session #10 hit, the in-process preflight ran
    and failed, exit 3, then recovery 284-1 restarted the container and ran its own doctor/health checks before
    segment 2 started); B'1 segment 2, B'2 and A2 each ended on a no-hit session (record 16, record 15 and record
    15 respectively); `warmup-284` ended on its second (no-hit) session. The only boundary where an invocation's
    LAST session was an unproven hit and the NEXT invocation started without a preflight is pre-arm, on Cronus28:
    `smoke-traced` segment 2 ended on a hit (its #4, `smoke-traced.ndjson` record 5), and `smoke-untraced` started
    next (a separate invocation, no recovery in between, `log.txt` 18:56:00 to 18:56:24) with `afterUnprovenHit`
    reset to `false` and so no preflight before its first session. `smoke-untraced`'s first session was itself a
    hit. No arm session in the OUTCOME (O1 to O11) was reached through a skipped preflight; the gap only ever
    affected a pre-arm smoke boundary. No OUTCOME result changes.
