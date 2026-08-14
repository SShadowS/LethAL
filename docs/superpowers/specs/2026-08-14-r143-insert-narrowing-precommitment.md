# R143 pre-commitment: the Insert platform tag gets a detector, and one kill leaves the screen

Written 2026-08-14, BEFORE the `itest:tables` run that judges it. Never edited afterwards: a
contradicted prediction is the finding.

## 1. What changed

R138 gave `lethal.swap-modify-flag`'s `Insert` mutants the `run-trigger-skipped-insert` mechanism and
applied it to EVERY `Insert` mutant, with no detector. The tables gate then measured the cost: the
screen fired on two kills and exactly one was a platform artifact.

R143 adds the detector. `insertSkipCanRaise` (`packages/builtin-tier2/src/insert-key-assignment.ts`)
resolves the receiver's table through the shared resolver, finds that table's `OnInsert`, reads the
first key entry of its `keys` section, and asks whether the trigger assigns a field of that key
(directly, or through `Validate("<field>", …)`).

`resolveReceiverTable` is NEW and lives in `receiver.ts` beside `claimsRecordMethod`, sharing its
`describeCallee` / `enclosingObject` / `resolveReceiver` path. It is not a second resolver: R80
records what happens when one node shape gets two parsers. It also handles the implicit-`Rec` form,
which raw `resolveReceiver` never sees.

## 2. The ruling on the unresolvable case, stated rather than assumed

R143 asks for this explicitly. Four cases:

| target table | `OnInsert` | tag |
| --- | --- | --- |
| resolved | assigns a primary-key field | TAG |
| resolved | exists, does not assign the key | no tag |
| resolved | absent | no tag |
| NOT resolvable (base-app record, unresolvable receiver) | unknown | **TAG** |

Every other Tier-2 guard resolves an unknown by REFUSING, because claiming a wrong site mislabels a
mutant and suppresses the correct Tier-1 one. **A screen is the opposite case.** An untagged platform
kill is a platform refusal credited to the suite, which is the failure the screen exists to prevent;
an over-tagged kill costs a reader one look. So the unknown case keeps the tag, and every mutant that
LOSES the tag lost it to a proof.

## 3. The two limits R143 named, measured rather than reasoned

Both censused 2026-08-14 on the 554-file Continia Document Output snapshot
(`U:/Git/do-lethal/Cloud`), with `scripts/r143-insert-census/census.ts` plus a hand read of every
residual case.

**Limit 1 — indirect key assignment (a No. Series call, a helper procedure).** 62 tables, 15 with an
`OnInsert`:

| | count |
| --- | --- |
| assigns a primary-key field DIRECTLY in the trigger body | 6 |
| does not assign the key at all | 9 |
| reaches the key indirectly | **0** |

All 9 residual triggers were read by hand, including the four that call a helper
(`SetContactCompanyNo`, `InitFields`, `SetDefaultOnInsert`, `InsertHeaderCaption`): each sets
non-key fields or writes to another table. ZERO `OnInsert` bodies in that corpus call a No. Series.
So on the one real corpus this repo has, the direct-assignment predicate misses nothing. Fifteen
tables is a small population and no RATE should be read off it; what it rules out is the assumption
that indirect assignment is the common case.

**Limit 2 — base-app records cannot be resolved.** Resolved by the ruling in §2 rather than by the
predicate: those mutants keep the tag they had before R143, so this change cannot under-report.

**A third limit, found while measuring.** `OnBeforeInsertEvent` subscribers also run only when
`RunTrigger` is true and could assign a key the table's own `OnInsert` does not. Censused in the same
snapshot: ONE subscriber in 554 files, targeting a base-app table, which the detector cannot resolve
and therefore tags anyway. Real blind spot, measured population of zero project tables.

## 4. The prediction

Judged against `LETHAL_ITEST_TABLES=1 bun run itest:tables`.

**The one thing that moves:**

- `platformArtifactKills.killedCount` **3 -> 2**
- the `run-trigger-skipped-insert` group holds **`InsertTwiceWithKeyTrigger` ALONE** (arm K, whose
  table `Data Key Probe` assigns `"No."` in `OnInsert`)
- `InsertWithTrigger` (arm A) is NO LONGER in the group. Its table, `Data Trigger Probe`, sets a
  Boolean in `OnInsert` and never touches the key
- `write-txn-codeunit-run` unchanged: one mutant, `CommitThenRunValueForm`, still `killed`

**Everything else unchanged, and a differing figure is a BLOCK:**

- killed **191** / survived **31** / no-coverage **10**; 232 deployed, **252** raw specs
- `mutationScore` **191 / 222**, `untargetedTriggerCount` **0**
- `assertionScreen.discrimination` **`partial`**
- `declarativeSites.siteCount` **1** (R144, landed earlier today)
- exactly ONE baseline failure, `Data Tests.PageActionComputesNonZero`
- **`tables.baseline.json` needs no re-recording.** The baseline key is
  `astHash|codeunitName|operatorName|operatorMajor` and holds no mechanism field, so a tag change
  cannot re-key a row. If the baseline mismatches, a VERDICT moved and that is the finding.
- arm B (`InsertCounted`) still **survives**. It was never screened (survivors are not) and its site
  is now untagged as well, so nothing about it may move.

## 5. Measured offline, before the run

- `generateMutationSet` over `fixtures/sandbox-data`: exactly two specs carry a mechanism —
  `lethal.remove-commit` at `Commit()` (`write-txn-codeunit-run`) and
  `lethal.swap-modify-flag` at `KeyProbe.Insert(true)` (`run-trigger-skipped-insert`). The two
  `Probe.Insert(true)` sites carry none. 252 raw specs, unchanged.
- `bun test`: 2346 pass, 0 fail, including 11 new R143 cases and two implicit-receiver cases (one
  tagged, one not).
- Red-check: forcing the detector to `true` turns FIVE tests red, four of them the "does NOT tag"
  cases and one the implicit-receiver control. Restored: 234 pass in `builtin-tier2`.

## 6. What would falsify this

A moved verdict, anywhere. The tag is a diagnosis and R72's discipline is that a diagnosis never
re-scores a mutant; the fixture's own `Insert` sites are the ones most likely to expose a violation,
because they are exactly what this change touched.

An empty `run-trigger-skipped-insert` group would mean the detector refuses a table it CAN resolve,
which is the direction that credits a platform refusal to the suite.
