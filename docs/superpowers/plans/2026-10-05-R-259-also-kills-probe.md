# R-259 plan r3: `sameProcedure` on each verify row killed by a new test, with T-only probes
(r3 = r2 plus the opus spec-adversary's findings, /coord/reviews/R-259-plan/adversary-r2.md; sol was out of quota)

## Decision: probe (recommended), inside the existing lease
For each row killed by a new test T, report what T alone does to every other source survivor in
the same DECLARATION. A pair the target runs already answered is reused; each missing (sibling, T)
pair gets one T-only probe in the same lease, after the target loop, before the decision-11
reruns. Cost per pair: one RunMutantMany call with one method (one activation, one test run),
plus one unmutated confirmation run when the probe fails (as for every kill). No
compile, publish or extra baseline (T's green baseline is reused). Diff: ~50 lines in
`runNamedMutants`, ~130 in verify.ts, ~40 schema, plus tests. Reuse-only answers nothing in the
ordinary one-survivor workflow, so it is rejected.

## Sibling identity (findings 1, 6)
- Key: `objectType|codeunitId|file|procedureStartLine|procedureEndLine` from the trusted manifest
  (C02-01: the span of the enclosing `procedure`, else `trigger`). Overloads and two fields'
  `OnValidate` triggers have different spans. Two declarations can share both lines only if both
  sit on ONE line, so a member with start = end, or no lines, is unidentified: all candidates go
  `unknown`, never "same procedure" by name. No identity, manifest or digest change.
- Siblings: same run and batch, `survived`/`no-coverage`, same key, minus the row; full
  `<batch>/<code>` ids. Carried and reader-marked-equivalent ones are never probed: `unknown`.

## Field (findings 2, 4, 5); schema v8
`sameProcedure: { test: {codeunitId, codeunitName, method}, alsoKills, notKilled, unknown: string[], overCap: number }`
- `alsoKills` ("T kills S"): verdict exactly `killed` (never `timeout-killed`: a 408 gets no
  unmutated confirmation and no session keys), T ran FIRST in a fresh session against S's mutant
  (a probe, or a target run with `killPosition` 1), and its confirmation passed. A target kill at
  position > 1 is probed, not reused, so every entry is the T-alone claim. "Fresh session" rests on
  R206: the store-level session-id liveness check, `sessionWasReused` reading `testRunsBefore` on
  every failure, the transport refusing an answer without it, and the gates' zero-`session-reused`
  pin. Every chunk is its own call (`coveringRuns`). "T alone" therefore means per session, not per
  database state. The row's OWN
  kill keeps today's meaning: T was the confirmed failing method in verify's executed sequence.
- `notKilled`: verdict `survived` AND the exact `testKeyOf(T)` is in the final sent set (target or
  probe). ObservedActive need not be true: it says "did not kill on this run", nothing more.
- `unknown`: no accepted pair-level conclusion (error, timeout, latch, skip, carried, equivalent,
  unidentified, over cap). Nothing else; it never reads as "kills nothing".
- `testKeyOf` (`codeunitId::method`) for matching and membership. The three lists must be disjoint
  and cover the sibling set; code throws otherwise. v8: required on every killed-by-new-test row
  (zero siblings = empty arrays); absent elsewhere = not applicable; verify-v7 stays frozen.
- Probes never enter `results`, counts or exit code; a latch in a probe still quarantines the
  call. `applyBatchInvalidations` today touches only `outcomes`: it must invalidate the probe
  outcomes too (lease lost or latch during decision-11 reruns -> every probe pair `unknown`).

## Steps
1. `runNamedMutants`: optional `probe(outcomes) => NamedMutantRequest[]`. Capture baseline rows in
   `select`; after `scoreBatch`, if not unsafe, `selectNamed` + `runMutantsOnBackend` once per
   distinct T (fresh ledger, own outcomes, same attestation check). Return `probes`.
2. `resolveVerifySource` also returns the batch's sibling rows (code, verdict, carried). Pure
   `pairsToProbe`, `sameProcedureOf`. Budget = R-384's B minus runs already counted (E filter on,
   S*N+2N off); pairs past it go `unknown`, counted in `overCap`.
3. verify-v8.schema.json, "v7 kept as published" test, agent docs; full build loop; close R259.

## Tests (each names the revert that turns it red)
1. Probe fails -> alsoKills (red: read a probe fail as unknown); passes -> notKilled (red: drop
   the exact-T sent-set check); target killed by U -> probed (red: match any killer).
2. Target killed by T at position 2 (and at 3) -> NOT reused as "T alone": probed. Red: drop the
   `killPosition` 1 check. Position 1 -> reused, no probe sent (red: always probe -> a call count goes up).
2b. Probe answer `timeout-killed` at position 1 -> unknown, not alsoKills; same for a target
   timeout-kill. Red: accept `timeout-killed`.
2c. Invalidation after probes ran (lease lost in decision-11) -> all probe pairs unknown. Red: drop
   the probe array from `applyBatchInvalidations`.
2d. Warm-confirmation failure (a probe fail whose unmutated confirmation also fails) -> unknown.
   Red: skip the confirmation check for probes.
3. Overloads; two fields' `OnValidate` -> not siblings (red: key by member name). One-line member,
   lines absent -> all unknown (red: drop the start = end guard).
4. Same code in two batches; table and page sharing a name; qualified-name collision. Red: key by
   code, by object name, by qualified name (one revert each).
5. Carried, equivalent -> unknown, no probe (red: let them into `pairsToProbe`). Over cap ->
   unknown, `overCap` set, nothing sent past B (red: ignore the remainder).
6. Fake backend through the covering loop: suite-unresolved, skip enum, incomplete chunk, cap
   continuation, latch mid-probe -> all unknown, ObservedActive=false pass ->
   notKilled. Red: map any non-fail probe to notKilled.
7. Field absent on survived/error/skipped/old-test-kill rows; empty arrays at zero siblings; a real
   v8 output validates (red: omit the field at zero siblings). Probes never in results/counts/exit
   (red: append probes to target outcomes).

## Changes since r1
- #1 key = declaration line span, not `memberGroupNameOf`; no or one-line span -> unknown.
  #2 `notRun` renamed `unknown` = "no accepted pair-level conclusion".
- #3 T-only probes in the lease, under R-384's budget, out of results; one call per pair.
  #4 "T kills" defined; `alsoKills` is the T-alone claim; the row's own kill is unchanged.
- #5 notKilled kept (survived AND exact `testKeyOf(T)` sent). #6 full ids; carried, equivalent ->
  unknown; `testKeyOf` everywhere; structured `test`. #7 tests reworked, one revert each. Schema v8.

## Changes since r2 (adversary, opus)
- A1 `timeout-killed` -> unknown, never alsoKills (test 2b; the old "timeout -> error" line is dropped).
- A2 `applyBatchInvalidations` also invalidates probe outcomes (test 2c).
- A3 killPosition-1 reuse is safe per session; R206 evidence cited (orchestrator ruling); test 2
  pins that position 2+ is NOT "T alone".
- A4 cost includes the unmutated confirmation per probe kill; warm-confirmation-failure test 2d.
