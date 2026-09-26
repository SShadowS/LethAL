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

## OUTCOME
