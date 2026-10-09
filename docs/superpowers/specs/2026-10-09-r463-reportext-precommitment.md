# R-463 itest:tables pre-commitment: the `CountBand` arm in `Data Band Ext`

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
