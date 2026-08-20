# R163 pre-commitment: `remove-not`, and the one mutant it adds to `itest:tables`

Written **before** the live run. A verdict that differs from this document is a finding, not a
number to update.

## The operator

`lethal.remove-not`, Tier 1, 1.0.0. Rewrites `not <expr>` to `<expr>` where the operand is a bare
call, identifier or member access. A parenthesised operand is REFUSED and ceded to
`negate-conditional`, which owns comparisons.

**No `PlatformKillMechanism`, and that is a ruling.** `if not Rec.Get(X) then Rec.Insert();`
inverted inserts a row that already exists and can die on a duplicate key with nothing asserted.
That is real, and it is exactly what `negate-conditional` already does when it turns `if A = B then`
into `if A <> B then` — the same branch flip through a different token — and that operator declares
no mechanism. R138's mechanisms are for a mutation that changes what is WRITTEN while leaving
control flow alone. A branch flip is ordinary changed behaviour, and design §6.7 already treats a
mutated program that errors on its own wrong behaviour as legitimately killed. Tagging here and not
there would assert a difference that does not exist.

## Footprint, measured before the run

| corpus / fixture | `remove-not` sites |
| --- | ---: |
| `do-rel2/Cloud` (554 files) | **1,106** |
| `fixtures/sandbox-data` | **1** |
| `fixtures/sandbox-probes` | 7 (not gated) |
| `fixtures/sandbox-app` | **0** |
| `examples/gift-card` | **0** |
| `fixtures/sandbox-hang` | **0** |

So `itest:bcdev`, `itest:envtool`, `itest:hang` and the demo campaign are structurally unaffected.
Only `itest:tables` moves, by one mutant.

The corpus figure is 1,106 against the 1,051 predicted from R163's operand-kind census. The census
counted `unary_expression` nodes inside procedure and trigger bodies only; `census-operator-sites.ts`
walks whole files, so the extra 55 sit in declarative positions, where `isMutableSite` refuses them
and they are reported as `declarativeSites` rather than becoming mutants. Neither number is wrong;
they count different populations.

## The one new `itest:tables` mutant

**Site:** the `OnRun` trigger of `codeunit 79313 "Data Commit Target"`
(`src/DataCommitTarget.Codeunit.al`).

```al
if not DataMain.Get(CommitRunNoLbl) then
    exit;
DataMain.Flagged := true;
DataMain.Modify(false);
```

**Mutant:** `not DataMain.Get(CommitRunNoLbl)` → `DataMain.Get(CommitRunNoLbl)`.

**Predicted verdict: `killed`.**

Both covering tests (`CommitBeforeCodeunitRunSucceeds` and
`CommitBeforeValueFormCodeunitRunSucceeds`) insert `T-CMTRUN` and commit before calling
`Codeunit.Run`, then assert the callee flagged it:

```al
if not DataMain.Flagged then
    Error('expected the Codeunit.Run callee to have flagged %1', Target.CommitRunNo());
```

With the `not` removed, `Get` SUCCEEDS, the flipped condition is true, `OnRun` exits immediately and
`Flagged` is never set. That assertion fires. The kill is assertion-earned, not a platform artifact:
the mutated program runs to completion and simply does less.

**No displacement.** Nothing else claims a `unary_expression`, so this is +1 raw and +1 deployed.

### Predicted frozen figures

| | before | after |
| --- | ---: | ---: |
| killed | 194 | **195** |
| survived | 32 | **32** |
| no-coverage | 10 | **10** |
| deployed | 236 | **237** |
| raw specs | 256 | **257** |
| mutation score | 194/226 | **195/227** |

Unchanged, and predicted deliberately:

- `untargetedTriggerCount` **0**. The new mutant sits in a codeunit `OnRun` that tests reach, so it
  is coverage-matched like the two `OnRun` mutants already there.
- `platformArtifactKills.killedCount` **2**. This operator declares no mechanism.
- `assertionScreen.discrimination` **`partial`**. The R132 twin pair is untouched; one more kill
  raised through the fixture's own bare `Error(...)` does not move the label.
- `declarativeSites` **1 site in 1 file**. The fixture's one declarative site is a page property, not
  a `not`.

## What would count as a finding

- Any verdict other than `killed` on the new mutant.
- A second new mutant anywhere: the census says there is exactly one.
- Any of the four unchanged aggregates moving.
- An `AlcCompileError`. The replacement is the operand's own verbatim text, which was already a
  Boolean expression, so a compile failure would mean the operand kinds admitted are wrong.
