# Pre-commitment: GH-24's reach control arm on `itest:tables`

Written and committed BEFORE any live run, from the offline dry run, the offline instrumented
source and reasoning about the two tests. Nothing above the OUTCOME line is edited afterwards.

Plan: `docs/superpowers/plans/2026-09-25-GH-24-active-guard-reach.md`, Task 6 (Decisions 4 to 7).
Arm: `fixtures/sandbox-data/src/DataReachOps.Codeunit.al`, `codeunit 79334 "Data Reach Ops"`
(79334 is the lowest free id above 79326; 79320 to 79329 is `sandbox-coverage-probe`'s block).
Covering tests: `ReachTakesBranch` and `ReachWithoutBranch`, appended to `codeunit 79310 "Data Tests"`.
Fixture versions: `sandbox-data` 1.0.0.9 to 1.0.0.10, `sandbox-data-tests` 1.0.0.17 to 1.0.0.18.

## 1. What the arm is for

Every mutant on the bcdev path now reports, per covering test, whether its own statement began
executing (`reachGrain`, `guardReached`, `reachedBy`). The unit tests prove the plumbing against
fakes. Only a real server can show two things:

1. the flag is per TEST, not per call: two tests in ONE `RunMutantMany` call can disagree;
2. the flag is RESET between tests: a `true` from the first test does not leak into the second.

`Classify(Amount)` has a branch (`Amount > 100`) that writes a variable no test reads. Two tests
cover it. `ReachTakesBranch` passes 500 and enters the branch; `ReachWithoutBranch` passes 10 and
does not. Both assert only the return value, so every mutant that leaves `exit(Amount)` alone
survives and runs BOTH tests in one grouped call.

Order: R197 (`test-order.ts`) sorts covering tests by kills in the same procedure, then members
covered (both cover exactly `Classify`), then qualified name. `Data Tests.ReachTakesBranch` sorts
before `Data Tests.ReachWithoutBranch` (T before W). The two kills below both land on
`ReachTakesBranch` at position 1, so the kill ledger only reinforces that order. So for a mutant
inside the branch the grouped entries read `[true, false]`, IN THAT ORDER. A reset that does
nothing would read `[true, true]`: the second test would inherit the first test's flag.

## 2. The offline evidence

Dry run (no server, no config): `bun packages/runner/src/cli.ts run --project fixtures/sandbox-data
--tests fixtures/sandbox-data-tests --dry-run --only src/DataReachOps.Codeunit.al`:

```
dry run: 1 file(s), 10 mutant site(s), 10 deployed mutant(s), 1 batch(es)
  src\DataReachOps.Codeunit.al:36  lethal.empty-block
  src\DataReachOps.Codeunit.al:37  lethal.conditional-boundary
  src\DataReachOps.Codeunit.al:37  lethal.empty-block
  src\DataReachOps.Codeunit.al:38  lethal.remove-assignment
  src\DataReachOps.Codeunit.al:40  lethal.conditional-boundary
  src\DataReachOps.Codeunit.al:41  lethal.void-method-call
  src\DataReachOps.Codeunit.al:42  lethal.return-value
  src\DataReachOps.Codeunit.al:46  lethal.empty-block
  src\DataReachOps.Codeunit.al:47  lethal.remove-assignment
  src\DataReachOps.Codeunit.al:47  lethal.shift-integer
```

Ten sites, ten deployed, nothing displaced. The grains come from the whole-project manifest
(`writeInstrumentedProject` into a scratch directory, the same call `compile-only.ts` makes), and
that instrumented project compiles with `alc` at zero warnings and zero errors against the 1.0.0.19
control symbols. The manifest ids below are that offline run's (`M0240` to `M0249`); a live run of
the same source generates the same ids, but the gate keys on `codeunitName`, `procedureName` and
`operatorName`, never on a code.

Three things the brief anticipated are NOT emitted, measured rather than assumed:

- no `negate-conditional` on `Amount > 100` or `Amount > 1000`: that operator flips only `=` and
  `<>` (`COMPARISON_FLIP`); an ordering comparison is `conditional-boundary`'s;
- no `shift-integer` on `100` or `1000`: it CEDES the operands of `<`, `<=`, `>`, `>=` to
  `conditional-boundary` (`CEDED_TO_CONDITIONAL_BOUNDARY`), which shifts the same boundary;
- no literal mutant on `Seen := Amount`: its right-hand side is a variable, not a literal.

`shift-integer` DOES claim `Seen := 0` in `Touch` (`0` to `1`).

The two branches that decide the control, quoted from the instrumented `DataReachOps.Codeunit.al`:

```
end else if MutationSelector.Active('M0243') then begin
  begin
        if Amount > 100 then begin
            MutationSelector.Reached('M0243'); ;
        end;
```

`Seen := Amount`'s marker sits INSIDE the then-block (P2 at a statement-list position), so it runs
only when the branch is taken. The then-block's own `empty-block` (M0242) is the P1 form:
`if Amount > 100 then begin MutationSelector.Reached('M0242'); end;`.

```
end else if MutationSelector.Active('M0245') then begin
  begin
        if Amount > 100 then begin
            Seen := Amount;
        end;
        if Amount > 1000 then
            ;
        exit(Amount);
    end
```

`Touch()`'s deletion has NO marker: an unbraced then-call resolves to the whole `if` statement
(`reachGrain: "enclosing"`), and a marker there would fire when the branch is not taken. The file
carries nine `Reached(` calls for ten mutants; `Reached('M0245')` occurs zero times.

## 3. Every mutant, pre-committed

`reachedBy` is qualified (`Data Tests.<method>`), in run order. `killingTest` is the bare method,
as the report and `tables.baseline.json` carry it. "absent" means the field is not in the report.

| id | line | operator | procedure | verdict | killingTest | reachGrain | guardReached | reachedBy |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| M0240 | 36 | `empty-block` (body) | Classify | killed | `ReachTakesBranch` | statement | true | `[ReachTakesBranch]` |
| M0241 | 37 | `conditional-boundary` `> 100` to `>= 100` | Classify | survived | | statement | true | `[ReachTakesBranch, ReachWithoutBranch]` |
| M0242 | 37 | `empty-block` (then-block, P1) | Classify | survived | | statement | true | `[ReachTakesBranch]` |
| **M0243** | 38 | **`remove-assignment` `Seen := Amount`** (P2) | Classify | **survived** | | statement | **true** | **`[ReachTakesBranch]`** |
| M0244 | 40 | `conditional-boundary` `> 1000` to `>= 1000` | Classify | survived | | statement | true | `[ReachTakesBranch, ReachWithoutBranch]` |
| **M0245** | 41 | **`void-method-call` `Touch()`** | Classify | **survived** | | **enclosing** | **absent** | **absent** |
| M0246 | 42 | `return-value` `exit(Amount)` to `exit(0)` | Classify | killed | `ReachTakesBranch` | statement | true | `[ReachTakesBranch]` |
| M0247 | 46 | `empty-block` (body) | Touch | no-coverage | | statement | absent | absent |
| M0248 | 47 | `remove-assignment` `Seen := 0` | Touch | no-coverage | | statement | absent | absent |
| M0249 | 47 | `shift-integer` `0` to `1` | Touch | no-coverage | | statement | absent | absent |

Per row, the reasoning:

- **M0240, M0246 (killed).** Both change the return value: an emptied body returns the Integer
  default 0, and `exit(0)` returns 0. `ReachTakesBranch` runs first and fails with
  `expected 500 from Classify(500), got 0`, so the call ends there (`endedBy: "failure"`) at kill
  position 1. The marker is P0 for M0240 (the body is the component root) and P2 before `exit` for
  M0246, and both run whenever `Classify` is entered, so `guardReached: true`. `reachedBy` is PARTIAL
  on a kill: only `[ReachTakesBranch]`, because `ReachWithoutBranch` never ran against these.
  `ReachWithoutBranch` would also kill both (10 is not 0), which is why the ORDER is what decides
  `killingTest`. Neither operator declares a `PlatformKillMechanism`, and both kills raise through
  bare `Error(...)`, so R121's screen flags both.
- **M0241, M0244 (survived, reached by both).** Moving either boundary by one changes nothing for 500
  or 10, and nothing reads `Seen`. The marker is P2 at the `if` statement itself, which begins
  whenever `Classify` runs, so both tests reach it. A `"statement"` claim for an expression means
  its statement BEGAN, not that the comparison was evaluated (Decision 6).
- **M0242, M0243 (THE CONTROL: survived, reached by the first test only).** Nothing reads `Seen`, so
  deleting the write or emptying the block is invisible to both tests. Their markers sit inside the
  then-block, which only `Classify(500)` enters. One grouped call runs `ReachTakesBranch` then
  `ReachWithoutBranch`; the per-entry values are `[true, false]` in that order; the fold gives
  `guardReached: true`, `reachedBy: ["Data Tests.ReachTakesBranch"]`.
- **M0245 (THE ENCLOSING CASE).** No test passes an Amount above 1000, so `Touch()` is never called
  in either test and deleting it changes nothing: survived. Coverage is exact at `Classify` (the
  member is covered), so it is NOT no-coverage. `reachGrain: "enclosing"`, no marker, so no
  `guardReached` and no `reachedBy` whatever the server says. This is the live form of Review
  Focus 3: a `"reached"` here would be false, since the branch never runs.
- **M0247 to M0249 (no-coverage).** Coverage is procedure-grained (`byMember`) and BC reports only
  lines with `No. of Hits > 0` (`ControlApi.Codeunit.al`). No test calls `Touch`, so no covering
  test exists and nothing runs: no-coverage, and with no run `guardReached` and `reachedBy` stay
  absent (Decision 7: `false` needs at least one answered run). `reachGrain` is still written:
  it is a compile fact.

Where I am least sure, and why:

1. **M0247 to M0249 could come back `survived` with `guardReached: false`** if coverage for `Touch`
   fell back to object level (`coverageAttribution: "object"`), which would run them against the
   object's covering tests. I predict no-coverage because `Touch` has a name the local-procedure scan
   resolves and the gate already pins `unplaceableCount` 0. If they do survive, that is a SPEC
   MISMATCH to be explained before anything moves, not a re-reading.
2. **The order of the two tests** rests on R197's tie-break and on member counts being equal. Both
   tests cover exactly `Classify`. If the order came back reversed, the per-entry values for the
   control would read `[false, true]`: the per-test claim would still hold, but the reset claim
   would NOT be demonstrated (a `false` measured after a `true` is what proves the reset). That is
   also a mismatch, and `assertReachControl` fails on it rather than accepting the set.

## 4. The baseline control

With no mutant active (`mutantId: ""`), a direct `RunMutantTransport` run of `ReachTakesBranch` and
of `ReachWithoutBranch` each returns a `ran` verdict (`pass`) with `reachedActive: false`: no marker
can fire when nothing is active. `assertReachControl` asserts both, mirroring `bcdev.itest.ts`'s
direct-transport section, on a probe lease taken after the second session.

## 5. What the arm moves on `itest:tables`

Read from `tables.itest.ts`'s `EXPECTED`, not from a summary.

| | before | predicted after | delta |
| --- | ---: | ---: | ---: |
| `totalMutantSites` (raw specs) | 397 | **407** | +10 |
| deployed (`killed + survived + noCoverage`) | 377 | **387** | +10 |
| `killed` | 299 | **301** | +2 |
| `survived` | 63 | **68** | +5 |
| `noCoverage` | 15 | **18** | +3 |
| `mutationScore` | 299 / 362 | **301 / 369** | |
| `groupedCalls` | 375 (362 + 13) | **382** (369 + 13) | +7 |
| `warmKills` | 13 | **13** | 0 |
| `platformArtifactKills` | 2 | 2 | 0 |
| `untargetedTriggerCount` | 0 | 0 | 0 |
| `declarativeSites` | 1 site / 1 file | unchanged | |
| `notInstrumented` | 1 file / 5 sites | unchanged | |
| `assertionScreen.discrimination` | `partial` | `partial` | |
| reach grain over the fixture | 371 / 6 / 0 | **380 / 7 / 0** | +9 / +1 / 0 |

Measured offline: `generateMutationSet` gives 407 raw specs with the arm, and the arm's file
contributes exactly 10, so 397 without it, equal to the pinned figure. `groupedCalls` rises by one
call per new SCORED mutant (2 killed + 5 survived) plus new warm-kill replays, of which there are
none: both kills land at position 1, and the arm has no session state. The one expected baseline
failure is still `Data Tests.PageActionComputesNonZero` and nothing else: both new tests pass at
baseline.

No existing mutant's verdict or `killingTest` moves. The kill ledger is keyed by procedure, and
the new procedures are the arm's own. Mutant codes after the new file shift by 10, but the only
codes the gate pins by name (`M0156`, `M0160`, `M0164`, all in `Data Main`) sit before it, and the
per-mutant baseline keys on semantic identity.

Other gates: `itest:chunked` (`--only src/DataMain.Table.al`), `itest:bcdev`, `itest:alrunner`
and `itest:envtool` do not see this file and are unchanged by it.

## 6. What the gate asserts (`assertReachControl`)

- The control (`remove-assignment` in `Data Reach Ops.Classify`) and the then-block `empty-block`:
  `survived`, `reachGrain: "statement"`, `guardReached: true`, `reachedBy` exactly
  `["Data Tests.ReachTakesBranch"]`. From the store: that mutant's `pass`/`fail` rows are
  `ReachTakesBranch` then `ReachWithoutBranch`, in that order, both `op_kind` `many` with one shared
  session id (one grouped call), and the per-entry values in run order read `[true, false]`.
- The enclosing mutant (`void-method-call` in `Classify`): `survived`, `reachGrain: "enclosing"`,
  no `guardReached`, no `reachedBy`.
- Both baseline direct runs: `reachedActive: false`.

The frozen totals in `tables.itest.ts` and `tables.baseline.json` are NOT edited by the lane. The
owner updates them to section 5's figures and re-records the baseline only after the live run
matches this file per mutant. Until then the gate fails at `totalMutantSites` (397 vs 407) before a
session starts, which is the intended state: an uncommitted prediction cannot pass by accident.

Any verdict difference, any mismatch with sections 3 to 5, or any killed statement-grain mutant with
`guardReached` other than `true` (ruling 2) is a BLOCK, filed before anything else moves.

---

## OUTCOME

(Filled in after the owner's live run. Nothing above this line changes.)

**Run order (added 2026-09-26 after the adversarial review; no prediction above changed).** With the
committed baseline kept, `assertMatchesBaseline` throws on the ten added mutants before the second
session and before `assertReachControl`, and with the baseline deleted it writes the new file from
run A before the control is checked. So the verification takes two runs:

1. Baseline KEPT, `EXPECTED` at section 5's figures: the run must stop in `assertMatchesBaseline` with
   exactly ten "present in after but missing from before" differences, all in `Data Reach Ops`, and
   zero field differences on existing mutants.
2. Baseline absent (`tables.baseline.json` moved aside, or `BASELINE_PATH` pointed at a scratch path):
   the run must pass END TO END, including `assertReachControl` and the determinism check, before any
   recorded file is kept. If it fails, discard the recorded file.

