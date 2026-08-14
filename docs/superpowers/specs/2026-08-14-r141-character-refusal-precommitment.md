# R141 pre-commitment — the character-refusal arm (arm I), per-mutant verdicts stated before the run

Written 2026-08-14, **before** any live run of the grown fixture. Committed before the gate is
started. Same discipline as `2026-08-12-r134-filter-precommitment.md` and
`2026-08-12-r136-trio-precommitment.md`: a prediction that is edited after the run is not a
prediction. If the live gate contradicts anything below, the contradiction is the finding and this
document does not move.

Roadmap row: `docs/roadmap/R141.md`.

## What this wave adds, and why exactly one arm

`lethal.flip-filter-literal` refuses a filter string two structurally different ways:

1. **Character refusal**, early and cheap. `REFUSED_CHARACTERS` in
   `packages/builtin-tier2/src/filter-expression.ts` is `/[*?@()'&]/`. If the unescaped content
   carries any of those, `classifyContent` returns `null` immediately and nothing is classified.
2. **Ladder exhaustion**, late. The content classifies fine and then no rule in the four-rule ladder
   matches it. A closed range (`'%1..%2'`) is the worked example.

R134's fixture measures (2) at arm H and measures it well. It never measures (1): the character
refusal is proven by one offline unit test and by nothing else. The two fail differently. A broken
ladder-exhaustion refusal splices a filter the ladder never validated and the fixture would notice as
an aggregate mismatch; a broken CHARACTER refusal hands BC a string the parser was never meant to
reach, and the likely outcome is a runtime filter error, which scores `killed` with no assertion
earning it and nothing tagging the mechanism (R86, R138). That is the false-kill shape this project
exists to catch.

**Which character.** The inner quote, via the `<>''` not-blank idiom, exactly as R141 asks. It is the
commonest `<>` shape in real AL, so it is where rule 1's real-world reach mostly goes, and it is the
one whose accidental mutation (`<>''` becoming `=''`) is most likely to raise inside BC. The wildcard
(`*`) arm the row names as an acceptable fallback was **not** needed: the idiom compiled under `alc`
first time and BC accepted it (see below), so the higher-value choice was taken.

## Measured before writing the arm

`scripts/r141-filter-probe/` (probe app 71520/71521), published to **Cronus283** on 2026-08-14 and
unpublished afterwards. The probe seeds the arm's exact data and measures the arm's three counts:

```
MEASURED: NO THROW -- baseline=2 (expect 2) noSetFilter=3 (expect 3) noSetRange=3 (expect 3)
          filterAsBCReportsIt=<>''
```

So: BC accepts the filter, reads it as "not blank", and each collateral mutant changes the count.
Every verdict below therefore rests on a measured number, not on arithmetic nobody checked. This is
the same precaution `scripts/r134-filter-probe/` took for arm D, where the spec's literal text would
have broken the arm's own baseline.

## The arm

`fixtures/sandbox-data/src/DataFilterOps.Codeunit.al`, one new procedure:

```al
procedure CountTaggedInBand(LowBound: Integer): Integer
var
    Related: Record "Data Related";
begin
    Related.SetRange("Entry No.", LowBound, LowBound + 3);
    Related.SetFilter("Main No.", '<>''''');
    exit(Related.Count());
end;
```

`fixtures/sandbox-data-tests/src/DataTests.Codeunit.al`, one new `[Test]`,
`NotBlankFilterCountsOnlyTaggedRows`, seeding Entry No. band 79200..79203 with 79200 `FLT-I`, 79201
`FLT-I`, 79202 **blank**, plus the out-of-band residue decoy 79210 `FLT-I-DECOY`, and asserting the
count is 2 through a bare `Error(...)`.

Two design points that are forced rather than stylistic:

- **Scoped by Entry No. band, not by "Main No."** The filter's own target field IS "Main No.", so a
  "Main No." scope would make the not-blank filter redundant, the baseline would equal the
  filter-deleted count, and the arm's assertion would stop proving the filter ran.
- **The band's upper bound is a computed expression** (`LowBound + 3`), for arm H's reason: two bare
  same-typed identifiers would let Tier-1 `lethal.swap-call-arguments` claim the site. Confirmed by
  census: `swap-call-arguments` stays at 7.

Test app `app.json` bumped 1.0.0.11 -> 1.0.0.12. The target's symbols in
`fixtures/sandbox-data-tests/.alpackages` were REBUILT (same version string, new build) before the
test app would compile — R139's second trap, hit again and fixed the same way.

## Census reconciliation (offline, `bun scripts/census-fixture-mutants.ts fixtures/sandbox-data/src`)

| | at HEAD (`6c12ae2`) | with arm I | delta |
| --- | --- | --- | --- |
| raw specs | 243 | 248 | +5 |
| deployed (post-dedup, post-displacement) | 224 | 228 | +4 |
| **`lethal.flip-filter-literal`** | **6** | **6** | **0** |
| `lethal.empty-block` | 81 | 82 | +1 |
| `lethal.void-method-call` | 73 | 75 | +2 |
| `lethal.remove-setrange` | 11 | 12 | +1 |
| `lethal.return-value` | 36 | 37 | +1 |
| `lethal.swap-call-arguments` | 7 | 7 | 0 |
| every other operator | unchanged | unchanged | 0 |

The +5 raw is 1 empty-block + 2 void-method-call + 1 remove-setrange + 1 return-value. One of the two
void-method-call specs is DISPLACED (the `SetRange` span, where Tier 2's `remove-setrange` wins under
§3.2 precedence — same empty `after.text`), so 5 raw becomes 4 deployed.

**`flip-filter-literal` must appear EXACTLY SIX times, never seven.** That is the row's load-bearing
number, and it is the whole point of the arm: the operator sees this `SetFilter` and emits nothing.

## Per-mutant verdicts — four new mutants, all pre-committed

All four sit in `DataFilterOps.Codeunit.al`, procedure `CountTaggedInBand`, and are covered by
`Data Tests.NotBlankFilterCountsOnlyTaggedRows`.

| # | operator | site | mutation | PREDICTED | why |
| --- | --- | --- | --- | --- | --- |
| I-1 | `lethal.empty-block` | procedure body | `begin end` | **killed** | the procedure returns 0, the test asserts 2 |
| I-2 | `lethal.remove-setrange` | `SetRange("Entry No.", LowBound, LowBound + 3)` | deleted | **killed** | the not-blank filter goes unscoped and picks up the out-of-band decoy: 3, not 2 (MEASURED) |
| I-3 | `lethal.void-method-call` | `SetFilter("Main No.", '<>''''')` | deleted | **killed** | the band count includes the blank row: 3, not 2 (MEASURED) |
| I-4 | `lethal.return-value` | `exit(Related.Count())` | `exit(0)` | **killed** | 0, not 2 |
| I-5 | `lethal.flip-filter-literal` | `SetFilter("Main No.", '<>''''')` | — | **NO MUTANT EXISTS** | the character refusal declines the site before classification |

I-5 is not a verdict, it is an absence, and it is the one the row is about. It is asserted three
ways: the offline census (6, not 7), the deployed count (228, not 229), and an extension of
`assertFilterLiteralEvidence` in `packages/runner/itest/tables.itest.ts` that fails if any
`flip-filter-literal` mutant names `CountTaggedInBand`.

All four kills must carry the arm's own bare `Error('expected 2 non-blank rows in the band, got %1',
...)` text in `killingTestFailure`. A kill on this arm whose failure text is a BC filter-evaluation
error would mean the character refusal is broken and BC was handed `=''` — the exact false kill this
arm exists to detect. That check is part of judging the run, not an afterthought.

## Invariants that must NOT move

| invariant | value |
| --- | --- |
| killed | 183 -> **187** |
| survived | 31 -> **31** |
| no-coverage | 10 -> **10** |
| deployed mutants | 224 -> **228** |
| raw specs | 243 -> **248** |
| score | 183/214 -> **187/218** |
| `platformArtifactKills.killedCount` | **1** (unchanged; only `lethal.remove-commit` declares a mechanism — R138) |
| `assertionScreen.discrimination` | **`vacuous`** (the new test also raises via bare `Error(...)`) |
| `untargetedTriggerCount` | **0** |
| baseline failures | **exactly 1**, `Data Tests.PageActionComputesNonZero`, named in the report |
| every pre-existing mutant's verdict | **unchanged, per mutant** |

## How the run is judged

1. Judge per mutant against `report.mutants`, not against baseline rows.
2. Any differing verdict is a BLOCK: stop, report it verbatim, do not reconcile by editing this file
   or the expectation.
3. Run the gate a SECOND, SEPARATE time after the baseline is re-recorded, to prove the new baseline
   compares against itself. An in-process double run does not satisfy this.
