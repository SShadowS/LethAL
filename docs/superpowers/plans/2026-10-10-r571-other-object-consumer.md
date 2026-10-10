# R-571 plan r2 (lethal-code): r1 plus the adversary-r1 fixes

`plan.r1.md` holds except as changed here. F-numbers refer to `adversary-r1.md`.

## 1. The temp-flag skip, redefined (F1, F2)

**Where the skip happens.** It is decided at the CALLER only, when R531's alias set is passed as an argument
into the cross-object callee. A callee's globals in the recv-proc path are NEVER skipped: they are the receiver's
own set, not name-matched. A non-record R, such as a codeunit variable, has an UNKNOWN flag.

**What is skipped.** An argument is skipped only when all of these hold:
- the argument is an alias of R made by ASSIGNMENT (`:=`);
- its declared flag differs from R's;
- both flags are KNOWN.

**What counts as a known flag:**
- an explicit `temporary` keyword on a declaration;
- or a `Record X` local or global that has NO `temporary` keyword, is NOT a `var` parameter, and whose table X is
  a project table not declared `TableType = Temporary`.

**What is never skipped:**
- an alias made by `Copy(X, true)`: it shares the table;
- a `var` parameter without the keyword: unknown;
- a plain record of a `TableType = Temporary` table, or of a table outside the project: unknown.

**Evidence that assignment does not share a temporary table.** Before the build relies on the skip, I will:
- cite Microsoft's AL documentation on Record assignment and on `Copy(FromRecord, ShareTable)`;
- run a cheap local al-runner probe (`TempA := Real; Real.Delete` and the reverse), recorded in
  `/coord/handoff/R-571/assign-probe.md`.

If the documentation and the probe do not both confirm it, the skip is dropped. In that case MatchSurplus stays
refused, 1 ordinal moves, and the scheme is the next free number at merge (41 or 42). I ask before taking it.

## 2. The callee's same-object helpers (F3)

In globals mode, a bare same-object call inside the callee counts as a consumer when that helper can see an
unshadowed global of the set. This mirrors R531's `global-call` rule in the loop body. The call site and its
guards are refused. A further hop into the helper's own body is NOT followed. That is a stated limit, together
with the second cross-object hop.

## 3. Early exits (F4)

The hop refuses:
- every `exit` or `Error` textually before the callee's last consumer;
- every `exit` or `Error` inside a loop body (in the callee) that contains a consumer;
- the guards of all of these.

`CurrReport.Break` is not in scope.

## 4. File R531 limits (F5)

These under-refusals already exist on master and are not R571 blockers. They are filed as one item, with the next
free id:
- a `this.P(R)` call in the same object;
- two variables of one SingleInstance codeunit (`A.IsEmpty` / `B.Pop`).

## 5. R-570 merge (F6)

At merge, use R570's `r531ParamKey` in place of the inline copy.

## 6. Tests (F7), added to r1's list; each red-checked alone

- **T10.** A temporary global under a codeunit R stays REFUSED: the DC shape with `TempValue` temporary. Red: apply
  the skip to recv-proc globals.
- **T11.** A `Copy(R, true)` alias passed to the callee stays refused. Red: skip Copy aliases.
- **T12.** A no-keyword `var` parameter alias stays refused. Red: treat a `var` parameter as known real.
- **T13.** An assignment alias with known, different flags is skipped (the MatchSurplus shape, my own AL). Red: no
  skip.
- **T14.** A callee helper `RemoveTop()` that deletes from a global: the helper call and its guard are refused. Red:
  do not count the helper call.
- **T15.** An `exit` inside a callee loop after a guarded consumer is refused. Red: textual order only.
- **T4's by-value SetRange case** is red-checked with "count every consumer kind on a by-value parameter".
- **The pass-R tests (T3, T5)** are each red-checked one at a time.

## 7. Price

The re-measure on the built branch is expected to give:
- DC: -4;
- E-Document Core: -24;
- BaseApp: about -34 with the skip, or about -71 with 1 ordinal moved without it;
- plus whatever T14 and T15's rules add. Their sites are named in the re-measure.


---

# R-571 plan r1 (lethal-code): R531's hop into a record consumer in another object

Base: master 259a5eae, scheme 40. Branch `lethal/r571`, worktree /work/lethal-wt/r571. The prototype is in WIP
commits 5b3b6543, 0c656f59 and 645a3a18. Measurement: `/coord/handoff/R-571/measure.md`. Item: R571, filed by
preproc on lethal/r570, which is not merged yet. R573 and R574 are filed by this lane (729bf37a).

## Orchestrator rulings, 2026-10-10
- Refusal only, reusing the shared resolver.
- **Skip a temporary-flag mismatch, but only when both flags are KNOWN and differ.** That means an explicit
  `temporary` on one side and a real-table declaration on the other.
  - An unknown flag is not skipped.
  - A by-value temporary record stays as R531 ruled: refused.
  - There is a red test for each direction, including an unknown-flag case that stays refused.
- R531's same-object temp-flag over-refusal is filed as R573.
- The same-object early-exit gap is filed as R574. It is lethal-code's NEXT task.
- No scheme bump if the skip leaves 0 ordinals moved. Otherwise the scheme is the next free at merge.

## Change (`packages/builtin-tier1/src/loop-hazard.ts`, R531's hop)
This applies only to loops that `r531Analyze` already accepts.

A body consumer call is handled here when R531's same-object resolution finds no target. It is resolved with
`callTargets` and `r531ProcsIn`, the shared resolver with R564's overload choice and R567's `argumentList`. Only
procedures in ANOTHER PROJECT object are kept.

R is mapped into the callee in two ways:
- **R passed as an argument.** The callee's matching parameter counts as R.
  - A `var` parameter counts every R531 consumer kind.
  - A by-value parameter counts only Delete, Rename and Modify, as R531 ruled for by-value records.
  - A `var` parameter named `Rec` is keyed like `Rec.M()`. This is R570's `r531ParamKey`: copied inline now, and
    switched to R570's helper when R-570 merges.
- **A call on a codeunit or interface variable that the loop condition tests by name** (`while not
  Socket.IsEmpty() do Socket.Pop()`). Every global of the callee's object counts as R, unless the callee shadows
  it with a local or parameter of the same name.

**Temp-flag skip.** A callee record that is matched to R only by name is skipped when R's `temporary` flag and the
callee record's flag are both known and differ. This applies to globals and to aliases. A parameter that receives
R is never skipped, because it IS R.

**What is refused** is R531's normal hop refusal in the callee: the consumers, the sites containing them, and their
guards. For this hop only, it also refuses any `exit` or `Error` before the callee's last consumer, together with
its guards. This is how Pop's `if not FindLast() then exit` is refused. Extending that to the same-object hop is
R574.

**Not followed:** a second cross-object hop, `Codeunit.Run`, event subscribers, and objects outside the project.

A test seam (`r571Seam = { on: true }`) gives the master leg.

## Expected price (re-measured on the built branch)
- **DC Cloud: -4.** `CDC Document Card` OnAfterGetCurrRecord and OnAfterGetRecord, calling `CDC Message Bus
  Socket`.Pop. The refused mutants are void-method-call on the Delete, remove-not on the FindLast guard,
  swap-find-direction and empty-block.
- **E-Document Core: -24.** `E-Doc. Payment Occurrence Mgt.`.ProcessPaymentOccurrence.
- **BaseApp: about -34.** That is -71 minus MatchSurplus's 37, which the temp-flag skip removes. It includes
  `Calendar Absence Management`.UpdateAbsence.
- **Other projects: 0.** DO, CDO, the fixtures and the other BC.History projects have no hop at all.
- **Identity:** 0 tuples and 0 ordinals moved are expected once MatchSurplus is skipped, so there is no scheme
  bump. If an ordinal still moves, I ask.

## Tests (`packages/builtin-tier1/tests/r571-cross-object-consumer.test.ts`; each red-checked alone, full output read)
1. **Socket shape.** The page loop `while not Socket.IsEmpty() do X := Socket.Pop();` uses a codeunit whose Pop
   does a guarded FindLast, then Delete. Pop's Delete void-method-call and the guard's remove-not are refused when
   the seam is on and emitted when it is off. Red: the seam off.
2. **Early exit before the last consumer** (the remove-not on the guard). Red: drop the early-exit code.
3. **R passed `var`** to another codeunit that Modifies it. Refused. Red: drop the argument mapping.
4. **R passed by value**, callee Modifies: refused. Callee only reads (`CalcFields`): emitted. Red: count every
   consumer kind on a by-value parameter.
5. **A `var` parameter named `Rec`** (`Rec.M()` keying). Red: drop that rule.
6. **Temp-flag skip, both directions.** A temporary R against a real-table callee global gives emitted. A real R
   against an explicit `temporary` callee global gives emitted. Red: skip disabled, so both are refused.
7. **Unknown flag stays refused.** The callee's record type cannot be read, for example a declaration the
   lookup cannot type. The site stays refused. Red: treat unknown as different.
8. **Shadowing.** A callee local with the same name as the global is not R. Red: ignore shadowing.
9. **Outside the project:** a codeunit not in the project gives no hop and no change. A control.

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations and
  roadmap-index.
- Re-measure DC Cloud, E-Document Core and BaseApp against fresh master legs. Check 0 tuples and 0 ordinals.
- Merge R-570 if it lands first, switching to its `r531ParamKey`, then re-measure.
- Opus build review; one CI push; R571 `done (<commit>)` (once R571.md is on master through R-570, or filed here
  if not); submit.


---

