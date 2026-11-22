# PR-327 (c) pre-commitment: R197's kill ledger never moves a test across test codeunits (R1174)

Coord PR-327 (lethal-code, 2026-11-22). **The orchestrator's order:** (a) the v3 label (built), then this (c), then (b).
**Evidence:** `/coord/handoff/PR-327/findings.md`; the sizing is in `/coord/handoff/PR-327/r1174-size.txt`.

## What R1174 found (bcdev, bc2, BC 28.4, the invented probe)
- **The probe:** a SingleInstance flag that test codeunit A sets and resets, and test codeunit B, which reads it.
- **Three mutants of the reset leak the same way.** The first (M0009) was killed by B, since A ran before B.
- **For the next two (M0010, M0011),** `orderCoveringTests` put B FIRST, because B had killed in this scope. B passed
  before A set the flag, so both **survived**.
- **So the ledger changes a verdict on the authoritative backend.**

## The rule
- **`orderCoveringTests` keeps the test CODEUNITS in their order in `covering`,** the coverage index's own order, which is
  the run's codeunit order.
- **It reorders only WITHIN each test codeunit,** by the existing keys:
  1. kills in the scope, most first;
  2. the narrowest test;
  3. the code-unit-name tie-break.
- **The reason:** state a test codeunit leaves (SingleInstance globals, and anything else the runner does not reset between
  codeunits) can only reach a LATER codeunit. Keeping the codeunit order keeps every such reach, as an unordered run would
  have had it.
- **The cost:** the ledger's speed-up, a killer tried first, now applies only within a codeunit. A kill in a later codeunit
  costs the earlier codeunits' tests first. The A/B below measures that.
- **Both backends use `orderCoveringTests`.**
  - On v3 every codeunit is a fresh entry, so the order across codeunits cannot change a verdict there. The rule is
    harmless on v3 and kept the same, for one code path.

## Predictions (written before the build)
- **The probe on bcdev:** all three `EndIt` mutants (M0009-M0011) are KILLED by `ComputeIsPlain`. Today only M0009 is.
- **A unit test** on a stateful fake: with a kill recorded for a test in codeunit B, `orderCoveringTests` returns A's tests
  before B's. Today it returns B's first.
- **Gates:** any gate whose figures rest on cross-codeunit reordering can move `killingTest`, `killPosition` or a verdict.
  - The build runs EVERY BC gate's comparison offline where possible, and the full v3 gate.
  - Each moved figure is listed and pre-committed before a re-record, by the R332 procedure. **No silent re-record.**
  - The expected result is that the v3 gate figures do not move (fresh entries).
  - **BC gate moves are possible, and each is reported by name, not assumed away.**

## Measure (after the build)
- **The probe on bcdev** (a leased bc server): red (the current head) then green (the fix), with per-mutant verdicts and
  the test order from the store.
- **The size on a real bcdev slice:** re-run R-882's S3 slice (101 at-risk survivors by the static bound, the smallest
  real slice with a non-zero bound) with the fix, on the same server. Count the survived → killed moves (the false
  survivors the ledger caused) and the wall-time cost.
  - **BLOCK:** any killed → survived move is a BLOCK.

## Out of scope
- (b) the v3 `strictOrder` lane comes after this.

## Amendment 1 (2026-11-22): the rule above is WITHDRAWN; the orchestrator chose option 1 (a verdict-only re-walk)
**Why it is withdrawn:** the Opus build review (`/coord/handoff/PR-327/c-review.md`) found the rule BLOCKING. "Keep the
codeunits in covering order" uses the DISCOVERY order, test files sorted by path. In the hang fixture `HangBaselineTests`
sorts first, so the 25 s `SleepsPastTheBaselineBudget` would run first under every `DrainQueue` mutant. That moves about 7
frozen hang rows' `killingTest` and breaks R-658 F1. The WIP is parked on `lethal/pr-327c-wip` and never merges.

### The new rule
- **The ordering is UNCHANGED.** `orderCoveringTests` keeps R197's keys exactly as today (kills in the scope, members,
  the code-unit tie). So every kill, `killingTest` and `killPosition` is as before.
- **`ledgerCrossedCodeunits(m)`:** true when the ledger's kills key put some test codeunit ahead of a covering codeunit
  that came BEFORE it in the no-ledger order. The no-ledger order is the same function with an empty ledger: members, then
  the code-unit tie.
- **The re-walk:** when a mutant's walk ends `survived` and `ledgerCrossedCodeunits(m)` is true, its covering tests are
  walked ONCE more, in the no-ledger order, under the same mutant and the same budgets.
  - **The re-walk's verdict is the one scored.**
  - When it kills, the row carries `killingTest` from the re-walk and the note `[ledger-order-survived]` ("survived in
    the kill ledger's order; killed in the no-ledger order (R1174)"). That is a label, never hidden.
  - When it also survives, the row stays `survived` with no note.
- **On which backends:**
  - **bcdev,** where a session carries state across codeunits, always.
  - **al-runner-v3: skipped, by name, with the reason.** Every covering codeunit is a fresh entry there (PR-298's O1
    freshness, measured at every pin), so the order across codeunits cannot change a v3 verdict, and a re-walk would only
    cost time.
  - **This is the orchestrator's condition (i) read through "where the order can change a verdict".** If the
    orchestrator wants it on v3 too, it is a one-line switch, and its cost is then measured on c2.
- **No other change:** the R197 ledger record, the kill pairs and the budgets.

### Predictions (written before the build)
- **The #53 probe on bcdev, red then green:**
  - today: M0009 killed, M0010 and M0011 survived;
  - with the fix: **all three KILLED.** M0010 and M0011 carry `[ledger-order-survived]` and `killingTest`
    `ComputeIsPlain`.
- **Every BC gate figure is unchanged,** because no kill or ordering moves. A survivor whose re-walk kills would be a
  verdict move; the gates' survivors are expected not to flip. Any flip is listed by name, pre-committed and re-recorded
  under R332, never silently.
- **The cost on R-882's S3 slice** (bcdev, 1,044 mutants, 314 survivors): the static bound has 101 survivors with a
  cross-codeunit killer in their scope.
  - **Predicted:** a re-walk on at most those 101. Each re-walk costs one more walk of the survivor's covering tests, so
    the extra wall is at most 101 × the slice's mean survivor walk time, which is measured, not assumed.
  - **Flips predicted:** few (0-10), since a flip needs real state carry-over between codeunits.
  - **BLOCK:** any killed → survived, or any `killingTest` change on a kill, is a BLOCK.
- **The tests:**
  - a stateful fake in which the ledger crosses codeunits and the first walk survives, and the re-walk kills: scored
    killed, with the note;
  - no crossing means no re-walk, by call count;
  - a kill is never re-walked;
  - v3 never re-walks;
  - each red-checked.

## Amendment 2 (2026-11-22, before any measurement run): the cost and flip slice is PR-287's safe arm on bc4
- **Why not R-882's S3:** S3 (Microsoft's ServiceDeclaration) was measured on bc5, which is gone. Re-running it on a gate
  server means publishing and removing a large third-party app there. And bc3 cannot run DO 30, which needs Continia
  Core 30; bc3 has 28.5 (PR-283).
- **The orchestrator's choice:** the DO server bc4 (BC 29, Continia 30, the owner's yes from PR-287).
- **The slice:** PR-287's safe arm, exactly as `/coord/handoff/PR-287/run.sh safe` scopes it:
  - PR-283's mutants, by `--only` and `--lines`;
  - the 23 safe test codeunits, by `--tests-only`;
  - PR-67's bc4 config; bcdev with `--stop-hung-sessions`.
- **Changes from PR-287:**
  - **WITHOUT `--keep-company-tests`:** company-write tests stay left out (the default), so no new owner ask is needed;
  - `--ci-session-kind headless`, since PR-311 gives a config no `ciSessionKind`;
  - a fresh store per arm.
  - The static bound on PR-287's safe report: 31 of 54 survivors at risk.
- **The arms, one after the other, under ONE bc4 lease, with doctor before, between and after:**
  - **A** = master at the time of the run (no re-walk);
  - **B** = `lethal/pr-327`'s final head (the re-walk).
- **The rules:**
  - **BLOCK:** any killed → survived, or any `killingTest` change on a mutant both arms kill.
  - **Reported:** every survived → killed flip (each must carry `[ledger-order-survived]`; one without the note is a BLOCK),
    the extra wall time (B − A, with each arm's per-test time), and the number of re-walks.
  - **Prediction:** 0-10 flips; re-walks ≤ 31.
- **The #53 probe** stays red then green on a leased bc1-3 server (M0010 and M0011 killed with the note), as above.
