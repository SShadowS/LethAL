# R-532 plan r2 (lethal-code): r1 plus the adversary-r1 fixes

`plan.r1.md` holds except as changed here. F-numbers refer to `adversary-r1.md`. The orchestrator ruled one opus
round, then build. These fixes are folded in, and the BaseApp cost is RE-MEASURED on the built branch before
submitting.

1. **F1, call feeds.** `isFeed(n)` also accepts a `directWrite(n, fedNames, ctx)` in the writing scope: a `var`
   argument (`Compute(Tmp)`), `Evaluate`/`Clear`, and an unknown callee (refused, as master's "unknown counts as a
   write" does), through the existing `argWritten`. Targets are matched with `rootName`, so `Arr[1] := X` feeds
   `Arr`. Feeds through record methods (SetRange/Insert before `not Buf.IsEmpty()`) are stated as a residual in
   R532. I read the census's `L-unwritten` and `F` rows and name in R532 what the widening now covers.
2. **F6, the mechanism.** The build uses `r531Feeds` (R-531's FEEDS) and states that it drops the `#if` expression
   tails R480's `indirectFeeds` follows. Collecting the tails is cheap, so the build collects them: the safe
   direction.
3. **F2, every census class is in the ruling,** with counts and reasons (A is closed):
   - **A (34, cross-object call):** closed by ruling. Reason: the sample, plus the price.
   - **A' (14, same-object var call):** closed. Mostly empty OnAfter event publishers, which write nothing. A real
     same-object writer is a preset WRITER under R-555 already.
   - **B-obj (24, a global written in another procedure of the same object):** already a preset write under shape
     1. That procedure's write IS refused when it lies outside open-item code; only its OWN feeds are B's job, and
     the widened B covers them.
   - **P (78, a parameter fed at call sites):** closed with A's reason. The value comes from the caller, which is
     the cross-object or same-object call case. The sample's names include P-fed ones (the setter pattern).
   - **B (3) and the F1 widening:** built.
4. **F3, the re-open condition:** "a corpus loop with an EXIT OR BOUND that is a preset exit name fed indirectly
   (another object's function, a parameter or another variable)". The census script is committed as
   `scripts/r532-preset-feed-census.ts`. It is parse-only and its output is counts and names only. R532 says to
   re-run it on each BC.History or customer-corpus bump, and to read any new A/P class site whose item is not bounded
   on its own.
5. **F5, wording and evidence.**
   - The ruling says the 15-site sample was drawn from ALL classes (about 11 cross-object or parameter names, 3 B),
     not from the 34 A writes alone.
   - It uses the reviewer's wording: "each gates only an OnPreDataItem `Break`, which can only skip an item that is
     bounded on its own (`Number = const(1)`, a finite Count, a table item)".
   - It names the checked FormatAddress-fed and LineIsEmpty sites.
   - `measure.md` gets the BaseApp leg results, citing `out/ba-B.json` and `out/ba-AA2.json`.
6. **F4, tests.**
   - Every test first asserts the mutant IS emitted with B off (on a clean master build of the same AL), then
     asserts it is absent with B on, per mutant.
   - The "no new refusal kind" test is dropped.
   - Added: a `Compute(Tmp)` var-argument feed, an `Evaluate(Tmp, S)` feed, and an `Arr[1]` feed.
   - The transitive red-check edits the shared `r531Feeds`, so R-531's own FEEDS tests going red too is expected,
     and the build record says so.

Expected cost: at least the measured -18, plus the F1 widening (call feeds), plus any `#if` tails. Re-measured on
the built branch. If any key or ordinal moves, I ask for scheme 40.


---

# R-532 plan r1 (lethal-code): same-scope variable feeds of a preset exit name (B); the cross-object part (A) closed by ruling

Base: master 131d74f4 (scheme 39). Branch `lethal/r532`. Measurement: `/coord/handoff/R-532/measure.md`. The
prototype diff, which includes A for the record, is in the session scratchpad at `r532/proto.diff`.

Orchestrator rulings 2026-10-10:
- BUILD (B), refusal only, no scheme change;
- CLOSE (A) by ruling inside R532 (one item);
- R532's status ends as `done (<commit>)` for B plus "the cross-object part closed <date> by ruling".

## Change, B (`packages/builtin-tier1/src/loop-hazard.ts`)
R500 shape 1 (`writesPresetExitName`) refuses, outside open-item code, a write of a preset exit name and its
shape-1 neighbourhood: the write, the blocks containing it, its guards, and an early exit before it. B adds one
kind of write: a FEED.

- **What a feed is.** An assignment in the SAME procedure or trigger to a local or global variable whose value
  flows into a preset write's right-hand side. Feeds are found by name, to a fixpoint (`Tmp := ...; Continue :=
  Tmp`, and `T2 := ...; Tmp := T2; Continue := Tmp`). This is R480's `indirectFeeds`, already reused by R-531's
  FEEDS; nothing new is written.
- **Shape 1 treats a feed as a write.** The feed itself, the blocks containing it, its guards, and an early exit
  before it in the same scope are all refused. Implementation: the `writes` predicate becomes `directWrite ||
  callsPresetWriter || isFeed`, so shape 1's existing walk handles the rest. No second walk.
- **Scope bound.** Feeds are searched only in the scope of a preset write that is outside open-item code. A feed
  in open-item code was already refused by R-501, so nothing changes there.
- Over-refusal, which is the safe direction and stated: by-name matching can also refuse a same-named variable
  written AFTER the preset write. This is the same as R-531's FEEDS.

## Measured (prototype B against master leg r562/all/ba-b.json, equal to 131d74f4)
- **BaseApp:** -18 deployed, 0 added, 0 tuples, 0 ordinals, `skipped` equal, hang-refused +18:
  - `GetDemandToReserve` `GetBatchFilters`: 15 (remove-assignment 8, empty-block 2, negate-conditional 2,
    toggle-blank-string 2, toggle-blank-temporal 1);
  - `ItemPriceList` `InitializeRequest`: 1;
  - `FinanceChargeMemoTest` `OnAfterGetRecord`: 1;
  - `ReminderTest` `OnAfterGetRecord`: 1.
- **Withholding Tax, Tests-TestLibraries, all 19 fixtures:** 0. CDO, DC and DO have no preset writes at all.
- No scheme bump.

## Ruling, A (written into R532)
**"The cross-object part closed 2026-10-10 by ruling."**
- **Census:** indirect feeds of preset exit names exist only in BaseApp. Of 280 writes, 34 call into another
  project object, 14 are same-object `var` calls (mostly empty OnAfter event publishers), and 49 are not
  resolvable. Withholding Tax and Tests-TestLibraries reach only code outside their project. CDO, DC and DO have
  no preset writes.
- **Sample:** 15 sites read by hand, 0 certain or plausible hangs. Every preset name gates or filters an item that
  is ALSO bounded elsewhere: `Number = const(1)`, `SetRange(Number, 1, Buffer.Count)`, a finite Count, a filter on
  an ordinary table item, end of file, or a `Next`-driven loop.
- **Price:** refusing the whole followed callee would remove 321 BaseApp mutants. Most of them are in shared
  library code: `FormatAddress` 90 and `ServiceFormatAddress` 57 (reached through 22 document reports'
  FormatAddressFields), `PostedPhysInvtOrderDiff` 76 and `PhysInvtOrderDiffList` 49 (EmptyLine), `AccountSchedule`
  23, and the PhysInvt order line tables 13 each.

  Refusing only the sites that affect the return value is NOT sound: it misses record state and globals.
- **Re-open when:** a corpus loop is found whose ONLY exit is a preset exit name fed indirectly, through another
  object's function or another variable.

## Tests (each red-checked one direction at a time; read the full output)
- **Feed refused:** a report whose open `Integer` item's exit reads `Continue`, a global. OnPreReport does
  `Tmp := Compute(); Continue := Tmp;`. The `remove-assignment` of `Tmp := Compute()` is refused. Red: drop
  `isFeed`.
- **Transitive:** `T2 := X; Tmp := T2; Continue := Tmp`; the `T2` write is refused. Red: a single step only, no
  fixpoint.
- **Guard of a feed:** `if Cond then Tmp := true; Continue := Tmp;`; the `negate-conditional` of `Cond` is
  refused.
- **Control:** a variable never flowing into a preset write is NOT refused. Red: treat every same-scope
  assignment as a feed.
- **Open-item control:** a feed inside open-item code is not double-counted. Assert the site is still refused, by
  R-501, and that this rule adds no new refusal kind.

## Gates
- typecheck; `rm -rf packages/*/dist`; `bun scripts/verify.ts`; biome on touched files; line-citations and
  roadmap-index.
- BaseApp re-dump on the built branch against the master leg (one job; expect exactly -18, 0 tuples, 0 ordinals).
  Withholding Tax and the fixtures are re-checked.
- Opus build review, one CI push, R532 status as ruled, submit.


---

