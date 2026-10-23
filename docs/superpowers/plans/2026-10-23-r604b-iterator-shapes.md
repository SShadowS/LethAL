# R-604b PLAN: R604's M1, narrowed (M2 not included)

Measured basis: `measure.md` (all sections) in this directory.

## Change (only `packages/builtin-tier1/src/loop-hazard.ts`)
**Where.** In `r572LoopRows`, the option-D branch:
1. The touch exemption calls `r570Touches(q, s.key, s.byValue, 0, filtered, ctx)` and `continue`s when every shared entry is clean.
2. The M1 DROP follows it. For a same-object callee whose `r570ExitTargets` reach no other object, it does `if (chain.length === 0) { m1TouchViaWrapper++; continue; }`.

**The new predicate.** Evaluate it at the drop, before the `continue`. Refuse when **varShared ∧ (movesOrFilters ∨ insertsIterated)**:
- **varShared:** some entry of `shared(c, q)` has `byValue === false` and `key !== R570_UNKNOWN`.
- **movesOrFilters:** a procedure in the `r570Touches` graph that holds the record under a `var` key calls one of these methods on it: `R604_MOVE` = R570_TOUCH minus {delete deleteall rename insert truncate validate}.
  - This needs the graph's `(node, key, byValue)` entries. Add `r570TouchEntries`, which returns them, and make `r570Touches` map it to nodes, so its callers are unchanged.
- **insertsIterated:** `q`, or a touch-graph procedure, calls `Insert` on ANY non-temporary record whose table is the loop cursor's table (`r570TableOf`).
- **Unknown errs toward refusing:** a touch-graph procedure with no body counts as true.

**What is refused when the predicate holds.** Push a row with `wrapper: q`, `chain: <touch-graph nodes>`, `stateful: true` and `writers: []`. `r572LoopRefusals` then refuses those procedures, and the guard-writer rule follows them as usual. When the predicate is false, keep today's drop.

**The census.** Split `m1TouchViaWrapper` into `m1Refused` and `m1Dropped`, updating the census script and its pinned JSON.

## Tests (test-first, in `tests/r604-m1.test.ts`, invented AL, offline only)
Two shapes that must be REFUSED, each red on master:
- **A (insert into the iterated set):** modelled on `CombineInvoiceGroupsByAmounts`. A forced-step loop over table T filtered on field F. A same-object callee gets the cursor by `var`, writes F, and inserts a new T row.
- **B (cursor moves):** modelled on `ModifyItemTrackingOnTempRec`. The callee gets the cursor by `var` and calls `SetRange`, then `FindFirst`, on it.

Twins that must stay MUTATED, so the other direction goes red if the predicate over-refuses:
- A′: A with the record passed by value.
- B′: the callee only modifies a non-key field (rows only).
- B″: B by value.

Red-check: revert the predicate, and A and B go red. Turn varShared to always true, and A′ and B″ go red. Drop the moves/inserts term, and B′ goes red. No hang-capable site enters any live gate (R164).

## M2: not built, state the limit
BaseApp generation (`prod-identity-keys.ts`) at R572_STATE_HOPS = 4: 3,018 s and 12.6 GB peak. At 12 it was still running at 5,291 s (at least 75% slower), and it was stopped on the orchestrator's ruling (`measure.md`, "## M2: cap 4 vs 12"). No deep writer found in any corpus is a risk.

## One check during the build (from S3's side note)
In `Fixed Asset - Projected Value.CalculateFirstDeprAmount`, the until-date is advanced by the report's own `GetNextDate`. Check by parse, on the build head, whether master refuses `GetNextDate`'s mutants as a loop-exit writer. If it does not, file a roadmap item. It is not part of this change.

## Roadmap edits (R604.md, then regenerate the index)
- Close H2, M3a, M3b, S4 and S3 by ruling, each citing its section of `measure.md`.
- Close M2 by ruling (state the limit) with the timing.
- M1 is done by this branch: `status: "done (<commit>)"`.
- Run `bun test scripts/line-citations.test.ts`.

## Expected re-price (upper bounds from the c03d5356 dump)
| corpus | fewer deployed mutants |
|---|---|
| DC | ≤136 (`CDC PCD Analyze Invoices`: CombineInvoiceGroupsByAmounts 45 + AssignInvoiceGroupToCombinedGroup 23, in both Cloud and the PC Integration project) |
| BaseApp | ≤211 (ModifyItemTrackingOnTempRec 150, MakeConnection 61) |
| DO, CDO, fixtures, other BC.History | 0 |

A STOP rule: any other procedure removed.

## Gate legs (pre-commit)
`selectLegs` on this diff returns `bcdev`, `tables`, `chunked` and `alrunner-v3`. Expect every per-mutant verdict unchanged: no gate fixture has an M1 site, since the fixtures census shows 0.

## r1 (overrides everything above where they differ; answers review B1, B2, I3–I6 and the minors)

**Predicate (B1 and B2, the simpler fix).** It sits in `r572LoopRows`, in the option-D branch. It runs right after the cursor-touch exemption (the `sh.every(... r570Touches(...).length === 0)` → `continue`) for EVERY callee in the loop's own object (I3). That includes callees whose `exit(<call>)` chain reaches another object, so it no longer waits for the `chain.length === 0` drop.

The callee is refused when any entry of `shared(c, q)`:
- has the key `R570_UNKNOWN`. Then `[q]` is refused (unknown counts as shared and touching); or
- is passed by `var` and `r570Touches(q, key, false, 0, filtered, ctx)` is non-empty. Then that list is refused, exactly as `r570Touches` returns it, duplicates included.

So every `r570Scan` reason counts: `B := X`, `Clear`, `Copy(B, true)`, unresolved or external calls, the hop cap, `Modify(true)`, key-field and filtered-field writes, and the temporary-cursor `Insert` and moves. The one exception is the one `r570Scan` already makes: a write to a field that is neither a key nor filtered. There is no new `R604_MOVE` list, and nothing reads the table or the temporary flag.

The refusal is a pushed row with wrapper `q`, the refused list as its chain, stateful, and no writers. `r572LoopRefusals` and the guard-writer rule then apply as they do today.
- A cursor passed by value keeps today's behaviour: it is dropped (`m1Dropped`).
- Event publishers have empty bodies and are not followed (I5). Their subscribers stay limit L1; a publisher only enters the list when `r570Touches` returns it.

Measured on invented probes (`probe-r1/`, made by `make-r1-probes.ts`, run with `r1-reprice.ts`):

| probe | result |
|---|---|
| A: insert into the iterated set (the `CombineInvoiceGroupsByAmounts` shape) | refused |
| B: `SetRange` + `FindFirst` on a temporary `var` cursor | refused |
| A′: A by value | mutated |
| B″: B by value | mutated |
| C: only a non-key field written, `Modify(false)` | **refused** |

C is refused because `r570LoopFilters` returns `"*"` (every field counts as filtered) whenever the cursor is handed to a call. So a by-`var` "rows only" twin cannot exist.

**Tests (I4).** In `tests/r604-m1.test.ts`, test-first:
- A and B must be refused.
- A′ and B″ must stay mutated, and `m1Dropped` must go up. This is the red check for the other direction: force varShared true, and they go red.
- C asserts that it is refused (a pin).
- A same-object callee with `exit(<other object>)` (I3) must be refused.

Update `ZERO` and the M1 case in `tests/r572-flag-fed.test.ts`, whose probe is now refused. The census script has no pinned JSON. Proven offline only (R164).

**Identity.** The guard-writer can refuse a single site, which may renumber same-tuple twins, as it did for R572. So bump `IDENTITY_SCHEME` (41 → 42) with its pins, unless the build shows no ordinal move.

**Re-price (I6)**, measured at master f31ae5ad. `r1-reprice.ts` compares master's full refused set (`r570Reach`, guard-writer included) with r1's, per project; nothing was removed anywhere. The full list is `r1-expected-refused.tsv`, and it is the pre-commitment; STOP if any other procedure appears.

| corpus | procedures added | mutants ≤ |
|---|---|---|
| DC (Cloud and PC Integration, 3 each: `CDC PCD Analyze Invoices` AssignInvoiceGroupToCombinedGroup, CombineInvoiceGroupsByAmounts, LineSetsDiffersOnlyByAmount, the last through the guard-writer) | 6 | 168 |
| BaseApp | 7 | 266 |
| DO, CDO, fixtures | 0 | 0 |

The 7 BaseApp procedures:
- `Late Binding Management.MakeConnection`
- `Reservation Engine Mgt..ModifyItemTrackingOnTempRec`
- `Whse.-Activity-Register.DeleteNonSpecificReservationEntries`
- `Item Tracking Summary.MinValueAbs`
- `Mfg. Sales Order Planning.CreateOrder`
- `Mfg. Sales Order Planning.OnCreateOrdersOnBeforeCreateProdOrder`
- `Entry Summary.QtyAvailableToSelectFromBin`

The rest of BC.History was not re-run: it has no M1 counter hit, and the near census found M1 only in BaseApp.

No operator package changed after c03d5356; only `loop-hazard.ts` (refusals), the orchestrator and `IDENTITY_SCHEME` changed. So that dump is still an upper bound.

## r2 (overrides r0 and r1 where they differ; answers the r1 delta review B1, I2, I3, I4, I5)

Built and measured in a scratch copy, `/coord/handoff/R-604b/wt-r2`, only in `packages/builtin-tier1/src/loop-hazard.ts`. The build repeats it in `/work/lethal-wt/r604b`. Models: build sonnet, reviews opus, census haiku.

### The exact predicate
It sits in `r572LoopRows`, option-D branch, for a callee `q` in the loop's own object (also when its `exit(<call>)` chain reaches another object). `sh` is `shared(c, q)`. Three rules add a row (wrapper `q`, chain = the refused list, stateful, no writers). The guard-writer rule then follows as today.

1. **I2, forced globals (before the other rules).** For each forced cursor `k` that is a global of the object, named in `q` (`r572Globals`), and not shadowed in `q`, and not already in `sh`: add `{ key: k, byValue: false }` to `sh`. Counted by name, as `r572HelperKeeps` does. So a bare `H()` that uses a forced global gets a shared entry.
2. **B1, A0 (table-level insert check).** If `sh` is not empty: take the tables of the loop's forced cursors (`r604CursorTables`). Walk `q` and everything within `R570_HOPS` calls, any object. Collect each procedure that calls `Insert` or `Rename` on any record whose declared table is in that set. Locals, globals and parameters are resolved by `declaredType`. Temporary, real and unknown all count. An unknown table on either side matches (refuse). An implicit `Rec` counts through its own object's table. Refuse `[q, ...those procedures]`. It does not look at `byValue`.
3. **Var-touch (r1 rule, now complete).** For each entry of `sh`:
   - `R570_UNKNOWN` (I3): refuse `[q, ...r570Touches over each of q's record parameters]` (each by its own var or by-value mode). r1 refused only `[q]`.
   - passed by `var` (including a rule-1 global): refuse `r570Touches(q, key, false, 0, filtered, ctx)`, exactly as returned.
   - by value: nothing here.

A cursor passed by value, with no table-level insert, keeps today's drop (`m1Dropped`). The touch exemption stays first, so a clean callee is untouched.

**Stated limits (no hidden case):**
- **I5 / R570_CONSUME.** A by-value `Insert` or `Rename` on the cursor itself is refused, not dropped: rule 2 sees it by table (probe `byvalue_insert`: refused). A by-value record parameter that is only written or modified stays mutated.
- **A0-nocursor.** A callee that gets no cursor but inserts into the iterated table is counted only, not refused. Measured: DO 2, BaseApp 6, others 0. Limit L2.
- **Event subscribers** of an empty publisher (limit L1 from r1) are not followed.
- **M2** is a stated limit: cap 12 was at least 75% slower than cap 4 (3,018 s, 12.6 GB), stopped on the orchestrator's ruling (`measure.md`, "## M2: cap 4 vs 12").

### Probes (invented AL; `make-r2-probes.ts`, run with `r2-reprice.ts`; measured on the scratch build)
| probe | what it is | expected | measured |
|---|---|---|---|
| A | by-`var` write, `Modify`, insert through a local | refused (A0 and var-touch) | refused |
| A0 | by-`var`, only READS the cursor, inserts matching rows through a local record (B1) | refused (A0) | refused |
| A0_temp_local | A0 with a temporary local | refused (A0) | refused |
| A0_byvalue | A0 with the cursor by value | refused (table-level, by design) | refused |
| A0_other_table_control | inserts into a different table | mutated | mutated |
| B | `SetRange` + `FindFirst` on a temporary `var` cursor | refused (var-touch) | refused |
| C_rows_only | by-`var`, non-key field, `Modify(false)` | refused (pin: `"*"` filtered) | refused |
| A′ (`A_byvalue_write`) | A with the cursor by value, no insert | mutated, `m1Dropped` +1 | mutated, reached by value only |
| B″ replacement = A′ | B″ never reached the check (touch exemption). A′ is the by-value twin that does reach it | mutated | mutated |
| byvalue_insert | by-value `Insert` on the cursor | refused (stated above) | refused |
| I2_global | forced global used by a bare `H()` | refused (global) | refused |
| I2_global_shadowed_control | `H()` declares its own `R` | mutated | mutated |
| I3 unknown | `R570_UNKNOWN` entry, callee passes the record on to a record parameter that is touched | refused `[q, touched procedure]` | no corpus site; BaseApp has 5 `unknown` procedures. Build writes the invented probe test. |

B″ is dropped from the plan. A′ replaces it.

**Red check, each direction (test-first in `tests/r604-m1.test.ts`):**
- Refuse direction: revert rule 2, then A0, A0_temp_local, A0_byvalue and byvalue_insert go red. Revert rule 3, then B and C go red (A stays red through rule 2). Revert rule 1, then I2_global goes red. Revert the I3 record-parameter walk, then the I3 probe goes red.
- Mutate direction: force "refuse always", then A′, A0_other_table_control and I2_global_shadowed_control go red. A′ must also assert `m1Dropped` rose.
- Update `ZERO` and the M1 case in `tests/r572-flag-fed.test.ts` (that probe is now refused).

### Identity and baselines (orchestrator rulings)
- `IDENTITY_SCHEME` goes 41 → 42, fail-closed. r2's guard-writer refusals renumber same-tuple twins. A key/ordinal compare was stopped as unneeded and was confounded by a tree difference.
- Settled with bugs (coordinator, final). R-604b does NOT re-record. On R-604b's branch:
  - List EVERY `packages/runner/itest/*.baseline.json` whose `identityScheme` is below 42 in `LAGGING_SCHEME` (`gate-pages.test.ts`), pointing at R690. That is all of them, not only today's eight: the 41 ones lag too (for example the al-runner-v3 layout and symbols baselines). Keep envtool pointing at R683.
  - Edit `docs/roadmap/R690.md`: title and table say "42".
  - Regenerate the roadmap index; `gate-pages.test.ts` must stay green at 42.
  - After R-604b merges, R690 re-records them once on master at 42, each under R332 with a pre-commitment. R-604b stays off the bc servers for a re-record round.
  - These are added build steps.

### Re-price (pre-commitment: `r2-expected-refused.tsv`; master f31ae5ad; nothing removed anywhere)
| corpus | procedures added | single guard sites added | mutants ≤ |
|---|---|---|---|
| DC (Cloud and PC Integration, 3 procedures each, plus 1 guard site each) | 6 | 2 | 170 |
| BaseApp | 16 | 18 | 584 |
| DO | 0 | 0 | 0 |
| CDO | 0 | 0 | 0 |
| fixtures | 0 | 0 | 0 |
| other BC.History | not run | not run | 0 (`near-bch.jsonl`: 0 M1 hook hits) |

Measured: BaseApp one project, 3,356 s. By reason (procedure names): DC A0 2, var-touch 4; BaseApp A0 11, var-touch 3, unknown 5. `global` is 0 in every corpus. r1 listed 7 BaseApp procedures at ≤266; r2 adds the I3 and A0 ones and the guard sites.

**STOP rule:** any refused procedure or guard site that is not a row of `r2-expected-refused.tsv`, or any entry removed from master's set, stops the build. Compare with `r2-reprice.ts` on the final head.

### Gate legs (pre-commit; run nothing now)
`selectLegs` on the diff. Expected: `bcdev`, `tables`, `chunked`, `alrunner-v3`. No gate fixture has an M1 hit (fixtures re-price: 0), so every per-mutant verdict must stay equal. The bump to 42 moves keys, so the baselines that read keys are re-recorded as above. No hang-capable site enters a gate (R164).

### Census counters and tests
- Split `m1TouchViaWrapper` into `m1Refused` and `m1Dropped`; add `m1RefusedA0`, `m1RefusedVar`, `m1RefusedUnknown`, `m1RefusedGlobal` and `m1A0NoCursor` (counted only). Update the census script. It has no pinned JSON.
- Update `ZERO` and `tests/r572-flag-fed.test.ts` (M1 case). Add the new `tests/r604-m1.test.ts`. Pin `IDENTITY_SCHEME` 42 in its tests.
- Roadmap: close S3, H2, M3a, M3b and S4 by ruling, each citing `measure.md`. M2 closed by ruling (the limit, with the timing). M1 `done (<commit>)`. Run `bun test scripts/line-citations.test.ts`.

## r2 narrow review fixes (opus; no Blocking, no false-kill path; these override r2 where they differ)
- **N1 (code).** In `r604Inserters`, drop `n.rawKind !== "member_expression"`. Without that, a paren-less `NewRec.Insert;`
  (AL compiles it, with only a CodeCop AA0008 warning) slips through. Add probe A0p: A0 with a paren-less Insert,
  which must be refused, with its own red check.
- **N2 (limits, stated in R604).** These are not followed: `Codeunit.Run`, and page, report or XMLport inserts; an
  insert more than `R570_HOPS` (4) calls deep; and a callee that gets NO cursor but inserts (counted only: DO 2,
  BaseApp 6). Such a mutant either hangs, which design §6.7 and R164 score as `timeout-killed` (a real kill), or is
  measured normally. `List.Insert` and `JsonArray.Insert` may over-refuse; that is a cost, not a risk.
- **N3 (branch base).** Merge origin/master into lethal/r604b BEFORE building. The plan's base, f31ae5ad, predates
  `LAGGING_SCHEME` and R690. "Every baseline below 42" is TEN files: the seven already listed, plus
  `al-runner-v3.layout`, `al-runner-v3.symbols-lethala` and `al-runner-v3.symbols-lethalb` (at 41). R690.md says
  "ten", and names the `LETHAL_ITEST_RECORD_SYMBOL_BASELINES` procedure for the two symbol baselines. envtool stays
  on R683.
- **N4 (harden marks).** `fixtures/sandbox-harden/lethal.equivalent.json` records scheme 41, and
  `harden-fixture.test.ts` requires it to equal `IDENTITY_SCHEME`. Restamp it to 42 in the build, and justify it in
  the commit: the fixtures re-price showed no M1 change, and the test that applies the mark must still pass.
- **N5 (tests pinned to 41).** Update the roughly nine tests that pin `IDENTITY_SCHEME` to 41 (r196, r254, r295, r405a,
  r455, r459, r477, r500, resume) to read the constant, or 42. `credit-limit/demo.baseline.json` stays at 41:
  `baseline-guard.test` pins it, and the comparison falls back to text checks.
- **Models.** The build is sonnet, red checks from this recipe are sonnet, the build review is opus, and gate runs
  are haiku.
