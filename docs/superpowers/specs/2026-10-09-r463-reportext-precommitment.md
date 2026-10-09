# R-463 itest:tables pre-commitment: the `CountBand` arm in `Data Band Ext`

**r2 (2026-10-09): r1 MISSED ONE FIGURE. Read "r1 miss and r2" at the end first.** r1's text below is kept
unchanged; where r2 overrides it, r2 wins.

Written by lethal-code on 2026-10-09, BEFORE any live run of R-463's build. It is committed to master on its own
(specs only, [skip ci]) before the run.

- Branch: `lethal/r463`, on master 2e40f73f.
- Fixture: `sandbox-data` 1.0.0.12, `sandbox-data-tests` 1.0.0.20.
- Gate: `LETHAL_ITEST_TABLES=1 bun run itest:tables` on Cronus28, under a lease.

## What changes

R-463 lets Tier 2 resolve record receivers inside a `reportextension`. The arm adds a procedure that a test reaches
through the base report's variable (`BandClassifiesDirectly`'s route):

```al
procedure CountBand(Low: Integer): Integer
var
    Rel: Record "Data Related";
begin
    Rel.SetRange("Main No.", 'BAND');
    Rel.SetRange("Entry No.", Low, 99);
    exit(Rel.Count());
end;
```

It is reached by the new test `Data Tests.BandCountsFromLow`, which:
1. clears the `'BAND'` rows;
2. seeds `Entry No.` 1..4 under `'BAND'`;
3. seeds a decoy, `Entry No.` 5 under `'OTHER'`;
4. asserts `CountBand(3) = 2`, else `Error('CountBand(3) should be 2, got %1', Actual)`.

The decoy lies in [3, 99] and is not one of 1..4 (`Entry No.` is the primary key), so removing the `'BAND'` filter
counts at least 3.

## The four new mutants

Codes are those of the branch's offline generation. **Matching is by identity key**, never by code. The key's hash
prefix is shown here; the full keys are the dump's.

| Code | Line | Operator | Change | Identity key | Verdict | Killing test | Position | Failure (substring) |
|---|---|---|---|---|---|---|---|---|
| M0020 | 46 | empty-block | `CountBand` body -> `begin end` | `00ed47bf...e963a\|Data Band Ext\|CountBand\|lethal.empty-block\|1` | killed | BandCountsFromLow | 1 | `CountBand(3) should be 2, got 0` |
| M0021 | 47 | remove-setrange | delete `Rel.SetRange("Main No.", 'BAND')` | `c1cb148a...97214\|...\|lethal.remove-setrange\|1` | killed | BandCountsFromLow | 1 | `CountBand(3) should be 2, got` |
| M0022 | 48 | remove-setrange | delete `Rel.SetRange("Entry No.", Low, 99)` | `26535d33...b8cd2\|...\|lethal.remove-setrange\|1` | killed | BandCountsFromLow | 1 | `CountBand(3) should be 2, got 4` |
| M0023 | 49 | return-value | `exit(Rel.Count())` -> `exit(0)` | `3fbca8ea...47b3c\|...\|lethal.return-value\|1` | killed | BandCountsFromLow | 1 | `CountBand(3) should be 2, got 0` |

Notes on the table:
- **M0021's count is not pinned.** Other `Data Related` rows with an `Entry No.` in [3, 99] may exist in the
  container; any count other than 2 kills it. The decoy guarantees at least 3.
- **No tags.** None of the four carries `platformKillMechanism` or `hangCapable`. The project has no hang-refused
  site, on master or on the branch.

**Why every position is 1.** `CountBand` is a procedure, so it has its own member entry. Only `BandCountsFromLow`
calls it, so it is the only covering test. This differs from R254's trigger mutants M0005 and M0009. Those had no
member entry and fell back to object-level coverage, which is why `BandClassifiesDirectly` ran first there and they
sit at position 2.

**The discriminator.**
- M0021 and M0022 are `lethal.void-method-call` under master's code on this same fixture: master never claims a
  record call inside a reportextension. So R-463 shows on this gate as an OPERATOR-NAME change at lines 47 and 48.
  A per-mutant baseline catches that; a matching total would not.
- A reverted R-463 would generate `void-method-call` at those two lines. `r254-arm-oracle.ts` would then report
  both as "not in the oracle".

**Not generated, contrary to plan r2.** The planned `shift-integer` survivor on `99` does not exist.
- `shift-integer` targets an integer literal only as a comparison operand or an assignment's right-hand side,
  never a call argument (`shiftedBeforeHang`). So `99` is not a site, under master's code either.
- `toggle-blank-string` on `'BAND'` and a swap of `Low`/`99` are not generated either.
- `flip-filter-literal` does not apply, because `SetRange` takes values, not a filter string.
- The built generator's list is the authority (`/coord/handoff/R-463/fixture-mutants.md`), and it holds 4 mutants,
  all predicted killed.

## Every existing mutant keeps its verdict

Matching is by identity key.
- The offline key diff of master 2e40f73f against the branch on `fixtures/sandbox-data` is **4 added, 0 removed,
  0 moved** (`tuple|ordinal` compared per site). `tables.baseline.json`'s 402 existing keys are unchanged.
- Each existing key keeps its verdict and killing test. The new test covers only `CountBand`, so no existing
  mutant's covering set, member rank or kill order changes.
- **Codes move.** Mutant codes are numbered project-wide in file order, so every code after `DataBandExt.ReportExt.al`
  moves +4. That this is the only difference in the emitted project is proven in
  `/coord/handoff/R-463/id-shift-proof.txt`. Codes inside the arm, M0005 to M0019, keep their values; the new
  procedure sorts last in the file.

## Gate figures

| Figure | Before | After |
|---|---|---|
| killed / survived / no-coverage | 310 / 70 / 22 | **314 / 70 / 22** (406 deployed) |
| `totalMutantSites` (raw specs) | 422 | **428** (+4 deployed, plus the 2 Tier-1 `void-method-call` that dedup removes at M0021's and M0022's sites) |
| mutation score | 310 / 380 | **314 / 384 = 0.8177083333333334** |
| `groupedCalls` | 380 + 15 | **384 + 15** (each new kill is one call; no warm-kill replay) |
| `warmKills` | 15 | **15** |
| `killPositions` | M0175 5 / M0179 4 / M0171 2 / M0005 2 / M0009 2 | **M0179 5 / M0183 4 / M0175 2** (the same `DataMain.Table.al` mutants, +4), **M0005 2 / M0009 2** (unchanged) |
| `untargetedTriggerCount` | 0 | 0 |
| `platformArtifactKills`, `assertionScreen.discrimination`, `declarativeSites`, `notInstrumented` | as frozen | unchanged |
| baseline failures | exactly `Data Tests.PageActionComputesNonZero` | unchanged |

- `r254-arm-oracle.ts` gains the four rows above, keyed by line and operator.
- The forced-screen assertion message's code becomes M0242 (was M0238). The mutant is the same; only the message
  text changes.
- `itest:verify-scale`: `COMMITTED_TESTS` goes from 70 to **71** (offline discovery: 71 `[Test]`), so the scratch
  suite goes from 75 to **76**. `SURVIVORS` stays 70.
- `itest:chunked` is unchanged. It runs `--only src/DataMain.Table.al`, whose codes restart, and the new test
  covers no `Data Main` code.
- `itest:bcdev`, `itest:alrunner` and `itest:envtool` are untouched: no reportextension in their fixtures.

## Baseline

The gate compares by identity key, and the 4 new keys are absent from `tables.baseline.json`. So the baseline is
re-recorded by the R332 procedure after this pre-commitment is on master:
1. delete it;
2. record once with `LETHAL_ITEST_RECORD_BASELINE=tables.baseline.json` (it exits 3 by design);
3. re-run without that variable and confirm a pass;
4. diff old against new, expecting exactly 4 added keys and 0 removed or changed;
5. commit.

## Block rule

Each of these is a BLOCK, not "close enough":
- a verdict, killing test, position or failure substring that differs from this table;
- any existing key whose verdict or killing test moves;
- any figure above that differs.

## r1 miss and r2 (written 2026-10-09, after the r1 record run and BEFORE the r2 runs)

**What failed.** The r1 record run (Cronus28, lease attempt 053, branch head b01d8e93, merged with master 79f39b01)
stopped at:

> `AssertionError: R206: M0005 (BandReportSumsBands) killPosition 3, expected 2`

No baseline was written. The run's store, compared with the old `tables.baseline.json` as a per-key multiset with
identity ordinals (`mutant-equality.ts`'s rule):
- all 402 existing keys keep their verdict and killing test;
- exactly the 4 predicted keys are added, all killed by `BandCountsFromLow` at position 1;
- killed / survived / no-coverage 314 / 70 / 22, score 0.8177083333333334, as r1 predicted.

So the miss is kill POSITIONS only. Evidence: `/coord/handoff/R-463/tables-record.log` and
`tables-record-diff.txt`.

**The false r1 claim.** Section "Every existing mutant keeps its verdict" said: "The new test covers only
`CountBand`, so no existing mutant's covering set, member rank or kill order changes." That is FALSE for the
mutants that take R254's object-level coverage FALLBACK.

**Cause.** The reportextension's trigger mutants have no member entry, so selection falls back to object-level
coverage (`selection.ts`, fallback 1, measured by R254's M1): every test that covers object 79341 covers them.
`BandCountsFromLow` calls `CountBand`, so it covers object 79341 and joins every fallback mutant's covering set.

In R197's order (kills in the same procedure first, then fewest members covered, then name):
1. `BandClassifiesDirectly` (1 member);
2. `BandCountsFromLow` (1 member; `Cl` < `Co`);
3. `BandReportSumsBands` (2 members).

Both passing tests now run before the killer.

**Every fallback mutant in object 79341**, all five measured in the r1 run (`coverage_attribution` `object`), each
now covered by `BandClassifiesDirectly`, `BandCountsFromLow` and `BandReportSumsBands`:

| Code | Line | Operator | Trigger | Verdict | Killer | Position (r1 predicted -> r2) |
|---|---|---|---|---|---|---|
| M0005 | 12 | empty-block | modify(BandItem) OnAfterAfterGetRecord | killed | BandReportSumsBands | 2 -> **3** |
| M0006 | 13 | remove-assignment | same | killed | BandReportSumsBands | 1 -> **1** (its trigger already has a kill this session, so the killer runs first) |
| M0007 | 19 | empty-block | OnPreReport | survived | - | - (covering set grows by one; still survived) |
| M0008 | 20 | remove-assignment | OnPreReport | survived | - | - (same) |
| M0009 | 20 | shift-integer | OnPreReport | killed | BandReportSumsBands | 2 -> **3** |

No other mutant in the object takes the fallback:
- `Band` M0010-M0013 are `exact`, covered by `BandClassifiesDirectly` and `BandReportSumsBands`, position 1;
- `GetTotal` M0014-M0015 are `exact`, covered by `BandReportSumsBands`, position 1;
- `Unreached` M0016-M0019 are no-coverage;
- `CountBand` M0020-M0023 are `exact`, covered by `BandCountsFromLow`, position 1.

No mutant outside object 79341 gains `BandCountsFromLow` as a covering test (in the r1 run's store, it appears in
no other mutant's covering set).

**r2 figures** (everything else in r1 holds):
- `killPositions`: M0179 5 / M0183 4 / M0175 2 / **M0005 3 / M0009 3**, killer `BandReportSumsBands` for both.
- `r254-arm-oracle.ts`: line 12 `empty-block` and line 20 `shift-integer` move to position **3**.
- Predictions, not reached by the r1 run, which stopped at the R206 assertion:
  - `warmKills` **15** (M0005 and M0009 are still warm kills);
  - `groupedCalls` **384 + 15** (a deeper position adds no call: one grouped call per scored mutant plus one
    replay per warm kill).

**What R-463 learns.** A new test that reaches an object through the R254 fallback joins the covering set of every
fallback mutant in that object. That is the cost side of R254, and R463 records it.

**Procedure.** Commit r2 to master (specs only, [skip ci]), then the two branch edits, then the record run and the
confirm run under lease 053. Any further difference is another BLOCK.
