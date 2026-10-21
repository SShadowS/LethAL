# R-572 plan r4 (lethal-code): r3 plus the adversary-r3 fixes

`plan.r3.md` holds except as changed here. F-numbers refer to `adversary-r3.md`.

## Prototype holes fixed (F1, F2; class 1, reproduced on r3)
- **Writers as a fixpoint (F1).** The value path starts from the chain's result: its `exit(...)` and named
  return, R480 feeds, `var` parameters written, and record state read. It also starts from the GUARDS of the exits
  that lead to the result and the branch conditions on that path (F5).
  - Every procedure in a chain object that WRITES a path global is a writer, whoever calls it: the chain, the loop
    body, or a `Codeunit.Run` step.
  - Each writer adds the globals it reads to the path, and this repeats until nothing changes.
  - Every writer reached is refused.
  - Test 18 uses the measured `GetNext`/`Advance`/`Refill` shape, with Advance called from the loop body.
- **Field-argument writes (F2).** A call argument that is a member expression on a path global (`Buf.Val`) counts as
  a write. The exception is a callee that resolves with that parameter by value. The same goes for built-ins that
  write their argument (`Evaluate`, `Clear`).
- **(b) is RECORD-level (F6).** A non-read-only method on a path-global record, including `Validate`, `Modify` and
  field assignment, writes the path.

## Narrowing (a), tightened (F3, F4, F7)
- **What X may be.** X must be a bare LOCAL variable, or a BY-VALUE parameter, of integer type. A global, a record
  field or a `var` parameter is never accepted.
- **Invariant by proof.** In the loop body:
  - X is not assigned;
  - X is not passed to any built-in;
  - X is not passed to a call whose parameter is `var`, unresolved or uncertain.
  
  An assignment inside an `#if` arm counts, and a test pins that.
- **Next(0) (F7).** Before (a) is built, a BC probe on Cronus28 (the al-probe skill, under a lease) measures what
  `R.Next(0)` returns and whether it moves the cursor.
  - If `Next(0)` returns 0, or raises an error, a mutant that zeroes X ends the loop, which is safe. (a) is built
    as written.
  - Otherwise, (a) also requires X to be assigned only non-zero literals before the loop. A mutant that removes
    that assignment then leaves X unproven, and the loop refuses.
- **The helper form (F4).**
  - EVERY exit path of the helper must return the forced step under the polarity rule.
  - The stepped record must be the helper object's global, or a `var` parameter bound to the loop's cursor.
  - No procedure in reach may move it back (`r570Touches` on Find, FindFirst, SetRange and similar).
  - The flag form needs the helper to set the flag on every stepping path, and no other writer of the flag: no
    assignment, var-out pass, `Clear`, or same-object subscriber. Anything uncertain refuses.

## The hang gate, restated (F5)
The put-away class is 192 keys, all refused per mutant. They are:
- CreateWarehouseActivityLine, InsertWhseActivLine and InsertSNWhseActivLine (147);
- UpdateWhseActivHeader (20);
- MakeWarehouseActivityHeader (19);
- GetLocation (6).

The guard-path rule keeps them, and the re-price checks all 192 by name. The other classes are as in r3.

## Price (expected)
PowerBI's tracker writers stay refused at record level, so BC.History will likely land over 0.05% (F6). The
residual groups, each classified real, plausible or over-refusal, go to the orchestrator for a ruling, as agreed.
DC stays accepted over the bar.

## Tests added (each red-checked alone)
- **18, replaced:** the loop-body-called writer (`Advance`): refused. Red: start the writers from the chain only.
- **21:** `Evaluate(Buf.Val, …)` and `H.Inc(Buf.Val)` (var): refused. Red: count bare identifiers only.
- **22:** `R.Next(Rec.Step) = 0`: refused. Red: accept fields as X.
- **23:** a global X: refused. Red: accept globals as X.
- **24:** X assigned inside an `#if` arm in the body: refused. Red: skip directive arms.
- **25:** a helper with a second exit (`if Cond then exit(1); exit(R.Next())`): refused. Red: check only the last
  exit.
- **26:** a helper that re-finds (`R.FindFirst(); exit(R.Next())`): refused. Red: drop the touch check in the
  helper form.
- **27:** a guard-global writer (a branch condition global on the result path, written by another procedure):
  refused. Red: data feeds only.


---

# R-572 plan r3 (lethal-code): the flag-fed iterator rule, with the r2-review fixes and two narrowings

This plan replaces `plan.r2.md`, as amended by its review `adversary-r2.md`. Base: lethal/r572 at 879f7dd2, which
is prototype r3 (e592074e, 4f999cca, 294743bf) with master 0254e6d2 merged. Measurement: `/coord/handoff/R-572/measure.md`,
sections "Rework after plan review r1" and "Rework after plan review r2 (r3 re-price)". The orchestrator's rulings
are in force: option (b) is procedure-level; DC is accepted over the bar when its cost sits on real or plausible
hangs; and, from 2026-10-20, narrowings (a) and (b) are built, under the conditions listed below.

## The rule (prototype r3, kept)
- **Flags.** These feed the exit: R480 `indirectFeeds` of the exit parts and the exit-part calls, same-object
  wrappers (I3b), and var-out flags of simple type.
- **Chains.** `r572Chain` follows `exit(<call>)` up to 4 hops. Rule P decides it by statefulness alone:
  - it names an own-object global, unless shadowed;
  - it runs Find, Next or Delete on the implicit Rec or a `var` record;
  - it assigns a `var` parameter;
  - it writes a record that is not a local temporary;
  - it calls a stateful procedure, within 4 hops;
  - it reaches UNKNOWN, which covers publishers, `Codeunit.Run`, codeunit or interface calls with no body, table
    procedures with no body, a missing body, the hop cap, and a call with no targets and no resolved built-in.
- **Cache.** The stateful cache is cycle-safe: no caching while another procedure is in progress.
- **Writers.** The reach walk starts from the chain AND from every loop-body call, and from `Codeunit.Run` steps,
  that lands in a chain object.
- **Option D (precise).** A loop is skipped only when the step alone forces the exit. For `while`, that means a
  top-level AND conjunct `R.Next() <> 0` or `> 0`. For `until`, a top-level OR disjunct `R.Next() = 0`.
  Negations are pushed through first. The receiver must be a record or stream, and the step argument must be
  absent or literal.
- **The cursor-touch exemption** (`r570Touches`) applies only under that D condition.

## Narrowing (a): a forced step with an invariant argument
D also accepts `R.Next(X) = 0` (or `<> 0`, in the same polarity positions) when `X` is INVARIANT BY PROOF inside
the loop. That means:
- no assignment to X in the loop body;
- no `var`-argument passing of X to any call in the loop body;
- X is not a global written by any procedure the loop body reaches. An unresolved call counts as writing.

An unknown write anywhere counts as not invariant, so the loop is refused. D also accepts the same forced test
reached through a same-object helper (`until Helper() = 0`, where Helper's `exit(...)` is `R.Next(X)` under the same
proof). D also accepts a flag that ONLY that helper writes, proven by the same name-based write scan.

## Narrowing (b): writers restricted to the value path
A writer procedure is refused only when the global it writes is on the chain's VALUE PATH. The value path is the
set of names the chain's result is computed from. It is collected over:
- every chain procedure's `exit(...)` expression and its named return;
- the feeds of those expressions, through R480 `indirectFeeds` within the procedure;
- the `var` parameters the chain writes;
- the record state the result reads, meaning a record whose Find, Next, IsEmpty, Count or field values reach the
  result, when that record is a global or a `var` parameter;
- transitively, any global read by a same-object procedure the chain calls whose result reaches the value.

A global set by a SECOND procedure and read by the chain's result is on the path: the writer of that global is
refused. When the path cannot be decided (a call with no body, an unresolved receiver), every written global counts
as on the path.

## Hangs that must stay refused PER MUTANT
These are checked on the built branch from production keys, and the gate is 0 lost:
- **BaseApp:**
  - put-away: CreateWarehouseActivityLine plus InsertWhseActivLine plus InsertSNWhseActivLine (192);
  - GetDeprPeriod (51);
  - CalcTimeDelta and IsNonworkingDay (20);
  - NextDimEntryNo (7);
  - AppendFileNameWithIndex (6);
  - Serv-Amounts Mgt. InvoiceRounding (55).
- **DC:** GetNextBottom (26) and CaptureFromPos2 (84).
- **DO and CDO:** CutAtSeperator (12 each).
- **System Application and the rest of BC.History:**
  - IsEndOfListing (External File Storage);
  - Shopify RetrieveOrderLinesJson and GetValueAsBoolean;
  - the Graph pagination trio SetNextLink, HasMorePages and GetNextPage;
  - ForNAV GetDocsFromJson.

## Expected price (production re-price against fresh master legs)
- **BC.History:** about 0.049% (estimate). If it lands over 0.05% with a mostly over-refusal remainder, the
  residual groups go to the orchestrator for a ruling.
- **DC:** about 0.110%, accepted over the bar. R572 shows its split into real 26, plausible 84 and over-refusal 101.
- **DO and CDO:** 12 each, all real.
- **Identity:** 0 tuples and 0 ordinals moved, measured. If any moves, I ask for the next scheme.

## Tests (each red-checked alone, full output read)
1. A global-buffer stepper (the NextDimEntryNo class): refused. Red: the seam off.
2. A writer called from the loop body only (the PowerBI shape): refused. Red: reach from the chain only.
3. A `var` text consumer (CutAtSeperator): refused. Red: drop the `var`-assign condition.
4. A var-out flag (GetNextBottom): refused. Red: drop var-out.
5. A local real-table queue (`Q.FindFirst`, `Q.Delete`): refused. Red: drop the local-record write.
6. UNKNOWN through an interface dispatch: refused. Red: treat unknown as stateless.
7. A one-call-deep global getter: refused. Red: walk 0 hops.
8. D, `while More or (R.Next() <> 0)`: NOT skipped, so refused. Red: use `namesCursorMethod`.
9. D, `until (not More) and (R.Next() = 0)`: refused. Red: same.
10. D, `while More and (R.Next() <> 0)` with a stateful callee: SKIPPED, so emitted. Red: D off.
11. Cursor touch: a stateful shared-cursor procedure that does not move the cursor, under the D condition: not
    refused. Red: the touch check off.
12. Cycle `A(var T)`, `B(T)`: refused both ways round. Red: cache while in progress.
13. (a) `R.Next(Step) = 0` with Step assigned in the body: refused. Red: drop the body-assignment scan.
14. (a) `R.Next(Step) = 0` with Step invariant and the callee stateful: skipped, so emitted. Red: (a) off.
15. (a) Step passed `var` to a body call: refused. Red: drop the var-pass scan.
16. (a) through a same-object helper `until Helper() = 0`: skipped. Red: helper form off.
17. (b) a writer of a global NOT on the value path: not refused. Red: (b) off.
18. (b) a writer whose global reaches the result only through a SECOND procedure's read: refused. Red: a value path
    without the transitive read.
19. (b) a writer through a `var` parameter the result reads: refused. Red: drop var-parameter state.
20. A stateless self-feed control: emitted, which is the stated limit. Red: everything counts as stateful.

The R570, R571 and R574 seam-off legs turn `r572Seam` off inside those tests. 12 tests needed this in the
measurement.

## Stated limits (in R572)
- The stateless self-feed (NextSendingDate and the additive shape) is not refused. Re-open on a `RE-OPEN SHAPE` row
  from `scripts/r572-flag-census.ts` whose loop has no stop.
- Statefulness is read by name, with a 4-hop cap; anything past the cap is UNKNOWN, which counts as stateful.
- (a)'s proof is name-based. An alias write through a `var` parameter of another name is caught by the var-pass
  scan, but a write through RecordRef or FieldRef counts as UNKNOWN, so it refuses.
- The site-level variant is filed as its own item, with the lower bound DC about 87.

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; doc tests.
- The production re-price, with every hang above checked by name, per mutant.
- Opus build review; one CI push; R572 `done (<commit>)`; submit.


---

# R-572 plan r2 (lethal-code): procedure-level flag-fed iterator rule (D + reachable writers + cursor-touch)

This plan replaces `plan.r1.md`, whose rule P alone was priced over the bar after the r1 review's fixes. Base:
master 4ca6b4d1 (R-570 and R-571 merged; scheme 40). Branch `lethal/r572`. The prototype r2 is in local commits
32fda28d and d6911219 (on the lethal/r570 tip); it is rebased or merged onto master at the start of the build.
Measurement: `/coord/handoff/R-572/measure.md`, sections 1 to 4 and "Rework after plan review r1". Review of
r1: `adversary-r1.md`.

## Orchestrator rulings
- **2026-10-10.** Rule P; UNKNOWN counts as stateful; the stateless-self-feed limit is stated with a re-open
  condition.
- **2026-10-11:**
  - Option (b): the procedure-level D + reachable writers + cursor-touch rule.
  - DC at about 0.083% is ACCEPTED over the bar, because about 110 of DC's refusals sit on real or plausible
    hangs.
  - R572 shows DC's cost split into real, plausible and over-refusal, and names the hangs per corpus.
  - The site-level variant is filed as its own item, with its lower bound (DC about 87).

## The rule (`packages/builtin-tier1/src/loop-hazard.ts`, extending R570's `r570LoopCallees`/`r570Reach`)
Refusal only. It applies to an ordinary loop whose EXIT reads a flag fed by a call into another object.

**1. Flag following.** These calls count as feeding the exit:
- calls in R480's `indirectFeeds` of the exit parts;
- same-object wrappers (R570's I3b `exit(<call>)`);
- **var-out flags**: a body call that passes a name the exit reads (directly or through a feed) to a `var`
  parameter of a simple type (Boolean, number, date, text or code).

**2. Chain.** From each such call, `r572Chain` follows `exit(<call>)` up to 4 hops into other objects. There is
no shape test.

**3. Rule P: stateful.** A chain is refused only when one of its procedures is stateful (`r572Stateful`). A
procedure is stateful when it does any of these:
- names a global of its object, unless a local or parameter of the same name shadows it;
- runs Find, Next or Delete on its implicit Rec or a `var` record parameter;
- assigns a `var` parameter;
- runs Insert, Modify, ModifyAll, Delete, DeleteAll or Rename on any record that is not a LOCAL TEMPORARY one;
- calls a stateful procedure, followed up to 4 hops;
- reaches UNKNOWN code. That means an event publisher, `Codeunit.Run`, a codeunit or interface call with no
  project body, a table procedure call with no project body, a procedure with no body, or a call past the hop
  cap. UNKNOWN counts as stateful.

**4. Option D.** A loop whose condition steps its own cursor is skipped, unless the call receives that cursor.

**5. Writers, `reach`.** The procedures of a chain object that write a global the chain names are refused too,
but only those reachable from the chain through same-object calls. This keeps the put-away write in
`InsertWhseActivLine` refused per mutant.

**6. Cursor-touch check.** A shared-cursor table procedure that never moves the cursor is not refused. This uses
R570's `r570Touches` (option b) instead of the prototype's by-name estimate. Examples: BuildTempLinesTransLookup,
IsUserMember, GetRecipients.

A refused chain gets R570's existing treatment. A test seam, `r572Seam = { on: true }`, switches the whole rule.

## Expected price (re-measured on the built branch, against fresh master 4ca6b4d1 legs, per mutant)
| corpus | estimate |
|---|---|
| DC | about 160 (0.083%), ACCEPTED over the bar |
| DO | about 12 (0.015%) |
| CDO | about 12 (0.022%) |
| BC.History | at most 931 (0.042%) |
| fixtures | 0 |

Identity: 0 tuples and 0 ordinals moved in every prototype dump. If any ordinal moves, I ask for the scheme.

**Hangs kept, per mutant.** Every key in these procedures must be refused, checked by name on the built
branch:
- the 13 first-sample loops: NextDimEntryNo; CreateWarehouseActivityLine plus InsertWhseActivLine (53/53);
  InsertSNWhseActivLine;
- the new real hangs: CutAtSeperator (CDO, DO), GetDeprPeriod, GetNextBottom, CalcTimeDelta,
  AppendFileNameWithIndex;
- the plausible ones: CaptureFromPos2, GetDocsFromJson, GetStatus.

R572 tables DC's cost split into real, plausible and over-refusal, with the hangs named per corpus.

## Stated limits (in R572)
- **A stateless self-feed.** A pure callee fed its own last result, or whose result is added into a name the
  exit reads (the CalcTimeDelta shape without its event), is not refused.
  - The 3 sampled NextSendingDate-shape loops are safe, each for its own reason: a duplicate key, a strict
    increase, a short finite walk.
  - Re-open when `scripts/r572-flag-census.ts` prints a `RE-OPEN SHAPE` row whose loop has none of those stops.
  - The census also prints the additive shape.
- **Statefulness is read by name**, with a 4-hop cap. Anything past the cap is UNKNOWN, which counts as stateful.
- **R570's limits apply:** feeds come only through R480 body assignments and var-out arguments, and event
  subscribers are not followed.

## Filed with this item
The site-level variant gets a new item, with the next free id taken right before writing. It refuses only the
state-writing sites plus the callee's local feeds. Its lower-bound estimate is DC about 87 (0.045%) and DO/CDO 11
each. The risk it carries is that local-feed tracking is a new place for misses.

## Tests (`packages/builtin-tier1/tests/r572-flag-fed.test.ts`; each red-checked alone, full output read)
1. **A global buffer stepper** (NextDimEntryNo shape; the callee is shaped): refused. Red: the seam off.
2. **A global remaining-quantity callee with an off-chain writer** (put-away shape): the writer's mutant is
   refused. Red: set writers to `none`.
3. **A `var` text consumer** (CutAtSeperator shape): refused. Red: drop the "assigns a var parameter" condition.
4. **Var-out flag** (GetNextBottom shape): refused. Red: drop var-out feeds.
5. **A local real-table queue consumer** (`Q.FindFirst ... Q.Delete`): refused. Red: drop the local-record write
   condition.
6. **UNKNOWN:** an interface dispatch inside a chain procedure is refused. Red: count unknown as stateless.
7. **State one call deep:** a same-object getter that reads a global is refused. Red: walk 0 hops.
8. **A same-object wrapper** (I3b): refused. Red: skip wrappers.
9. **Option D:** a loop that steps its own cursor and passes only values is NOT refused. Red: D off.
10. **Cursor touch:** a shared-cursor table procedure that does not move the cursor is NOT refused. Red: the
    touch check off.
11. **Stateless control:** the callee does a local-record FindFirst with no writes and no globals, and is fed its
    own key. It stays emitted, which is the stated limit. It is shaped, so only P separates it. Red: every
    callee counts as stateful.

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations and
  roadmap-index.
- Re-measure DC, DO, CDO, BaseApp and the BC.History projects the census flags, against fresh master legs.
- Opus build review; one CI push; R572 `done (<commit>)`; submit.


---

# R-572 plan r1 (lethal-code): a loop flag fed by a stateful cursor procedure in another object

Base: R-570 merged (R572 extends R570's `r570LoopCallees`). The prototype is local commit f35c0ce4 on
`lethal/r572`, which is the lethal/r570 tip 88737740 plus one commit. Measurement: `/coord/handoff/R-572/measure.md`.
Item: R572 (filed by R-570 on lethal/r570).

## Orchestrator ruling, 2026-10-10
- Rule P. Refusal only.
- "Stateful" with an UNKNOWN answer counts as stateful, so the site is refused.
- R572 states the stateless-self-feed limit, with the 3 safe NextSendingDate-shape loops and their reasons, plus a
  re-open condition.
- The tighter A+D+P combination is not built.

## Change (`packages/builtin-tier1/src/loop-hazard.ts`)
R570 refuses a cursor-shaped procedure in another project object when the loop's exit calls it. R572 also follows
a FLAG.

**Calls followed.** In `r570LoopCallees`, the calls inside `indirectFeeds` (R480) of the loop's exit parts are
followed to other-object chains with `r570Chain`. These are the calls whose result reaches the condition through
body assignments, as in `More := X.GetNext(); while More do`.

**Rule P.** A chain reached ONLY through a flag is refused only when some procedure on it is STATEFUL
(`r572Stateful`). A procedure is stateful when it does any of these:
- reads or writes a global of its own object;
- runs Find, Next or Delete on its implicit Rec or on a `var` record parameter;
- has a body or receiver the analysis cannot read (UNKNOWN), which counts as stateful (the ruling).

A refused chain gets R570's existing treatment. Chains R570 already refuses through the exit itself are unchanged.

A test seam (`r572Seam = { on: true }`) gives the R570-only leg.

## Expected price (re-measured on the built branch, against fresh master legs taken after R-570 merges)
| corpus | price | share |
|---|---|---|
| DC Cloud | -26, all in `CDC Document`.BuildTempLinesTransLookup | 0.014% |
| BaseApp | -145 | 0.020% of BaseApp; 0.007% of BC.History |
| CDO, DO, the fixtures, and the other BC.History projects | 0 | |

Identity: 0 tuples and 0 ordinals moved in the prototype's DC and CDO dumps. BaseApp is re-checked on the built
branch.

**Kept hangs.** The sample covered the whole population, 76 loops. All 13 hang loops stay refused:
- 9 Date Compress reports, through `Dimension Buffer Management`.NextDimEntryNo;
- 4 loops in Mfg. Create Inventory Put-away, through `Create Inventory Put-away`.CreateWarehouseActivityLine.

## Stated limits (in R572)
**A stateless stepper fed its own result is not refused.** This is a callee with no global and no Rec/var cursor
state, whose loop feeds back the callee's last result. A mutant that returns its argument unchanged could hang
such a loop. The 3 loops of this shape in the sample are safe for reasons specific to each:
- CDO NextSendingDate: each pass inserts a calendar line keyed by that date, so a repeated date fails the Insert;
- a strict-increase test in the condition;
- a short, finite walk.

**Re-open when** a corpus loop of that shape has none of those stops.

**Statefulness is read by name.** A global read anywhere in the chain counts. A cursor method on a LOCAL record
does not. R570's limits also apply: feeds are followed only through R480 body assignments, and event subscribers
are not followed.

## Tests (`packages/builtin-tier1/tests/r572-flag-fed.test.ts`; each red-checked alone, full output read)
1. **Global buffer stepper.** The callee steps a global temporary buffer, in the NextDimEntryNo shape. The loop is
   `More := X.Next(); while More do ...`. A callee mutant (the negated end test) is emitted with the seam off and
   refused with it on. Red: the seam off.
2. **Global remaining quantity.** The callee returns a global quantity, in the put-away shape. Refused. Red: drop
   the global half of P.
3. **`var` record cursor.** The callee runs Next on a `var` record parameter. Refused. Red: drop the Rec/var half.
4. **Stateless stepper control.** The callee is pure (date + 1). It stays emitted, which is the stated limit. Red:
   treat every callee as stateful.
5. **Unknown means stateful.** A callee whose body cannot be read is refused. Red: unknown as stateless.
6. **No regression.** Exit-called chains are still refused when the seam is off, which is R570 unchanged. A control.

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations and
  roadmap-index.
- Re-measure DC Cloud, CDO and BaseApp against fresh master legs taken after R-570 merges. Expect -26, 0 and -145,
  with 0 tuples and 0 ordinals.
- Opus build review; one CI push; R572 `done (<commit>)`; submit.


---

