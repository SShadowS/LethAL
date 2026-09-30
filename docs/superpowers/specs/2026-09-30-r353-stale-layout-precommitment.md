# R353 pre-commitment: `sandbox-layout` at two batches, one-shot and `--server`, fixed and with R349's reset removed

Written **before** any al-runner session on this fixture, and committed alone, before the fixture
itself. Every figure below is derived by hand from the AL and from the code at HEAD `0abf71aa`,
checked against an offline dry run (no al-runner, no BC; see "How the numbers were checked"). A
verdict, killing test or covering test that differs from this document is a finding and a stop. It
is never re-recorded.

**Terms.** A *batch* is one instrumented copy of the project (`planArtifacts`). *Instrumented* means
LethAL rewrote a file to carry its mutants behind guards; a file with no mutant in a batch is copied
*verbatim*. The *coverage index* (`AlRunnerCoverageIndex`) maps a covered line of a file to the
procedure that holds it. R349's fix is the call `this.resetLayoutState();` at the top of
`AlRunnerBackend.deploy()`. *Unfixed* below means that one call deleted.

## The fixture

A new pair, its own app and id range, so no other gate or baseline moves.

`fixtures/sandbox-layout` (target, ids 79700 to 79749, no dependencies, runtime 13.0):

```al
codeunit 79700 "Layout Alpha"
{
    procedure IsBig(X: Integer): Boolean
    begin
        exit(X > 10);
    end;
}
```

`src/LayoutBeta.Codeunit.al`, 40 lines. Lines 11 to 36 are one comment in the procedure header,
between `procedure Twice` and its `begin`. The emitter keeps a header comment once and does not copy
it per mutant (measured in the dry run), so it lengthens `Twice` in BOTH layouts by the same 26 lines.
The comment's text is in the plan; only its line count matters here.

```al
codeunit 79701 "Layout Beta"                    // line 1
{
    procedure Grow(X: Integer): Integer         // line 3
    begin
        if X > 10 then
            exit(X + 1);
        exit(X);
    end;                                        // line 8

    procedure Twice(X: Integer): Integer        // line 10
    // ... 26 comment lines, 11 to 36 ...
    begin                                       // line 37
        exit(X * 2);                            // line 38
    end;                                        // line 39
}                                               // line 40
```

(The `// line N` markers are for this document only. They are not in the fixture.)

`fixtures/sandbox-layout-tests` (ids 79750 to 79799, depends on the target), one codeunit, three
tests, each raising through bare `Error(...)`:

| test | calls | raises unless |
| --- | --- | --- |
| `Layout Tests.AlphaIsBig` | `IsBig(20)` | it returns `true` |
| `Layout Tests.GrowAboveTen` | `Grow(20)` | it returns 21 |
| `Layout Tests.TwiceOfThree` | `Twice(3)` | it returns 6 |

Baseline: all three pass in both batches.

## The batch plan, `maxGuardsPerBatch` 7

Files are taken in sorted path order. `src\LayoutAlpha.Codeunit.al` has 3 raw specs,
`src\LayoutBeta.Codeunit.al` has 7. First fit with a budget of 7: Alpha opens batch 0 (3); Beta
would make 10, over 7, so it opens batch 1 (7, exactly the budget, so no `oversized-batch`
warning). **2 batches.** Batch 0 instruments Alpha and copies Beta verbatim. Batch 1 instruments
Beta and copies Alpha verbatim. Mutant codes restart per batch, so a mutant is named
`<batch>/<code>`.

## The 10 mutants

| mutant | file | line | operator | procedure | mutated to |
| --- | --- | ---: | --- | --- | --- |
| 0/M0001 | `src\LayoutAlpha.Codeunit.al` | 4 | `lethal.empty-block` | IsBig | body emptied, returns `false` |
| 0/M0002 | `src\LayoutAlpha.Codeunit.al` | 5 | `lethal.return-value` | IsBig | `exit(not (X > 10))` |
| 0/M0003 | `src\LayoutAlpha.Codeunit.al` | 5 | `lethal.conditional-boundary` | IsBig | `X >= 10` |
| 1/M0001 | `src\LayoutBeta.Codeunit.al` | 4 | `lethal.empty-block` | Grow | body emptied, returns 0 |
| 1/M0002 | `src\LayoutBeta.Codeunit.al` | 5 | `lethal.conditional-boundary` | Grow | `X >= 10` |
| 1/M0003 | `src\LayoutBeta.Codeunit.al` | 6 | `lethal.return-value` | Grow | `exit(X + 1)` to `exit(0)` |
| 1/M0004 | `src\LayoutBeta.Codeunit.al` | 6 | `lethal.swap-additive` | Grow | `X - 1` |
| 1/M0005 | `src\LayoutBeta.Codeunit.al` | 7 | `lethal.return-value` | Grow | `exit(X)` to `exit(0)` |
| 1/M0006 | `src\LayoutBeta.Codeunit.al` | 37 | `lethal.empty-block` | Twice | body emptied, returns 0 |
| 1/M0007 | `src\LayoutBeta.Codeunit.al` | 38 | `lethal.return-value` | Twice | `exit(0)` |

All public. No two share an identity key (different procedures, operators or text), so the frozen
baseline has no twin groups.

## Where the covered lines land

al-runner's Cobertura reports **statement lines** only (R220's measurement: `SandboxLogic` at
`line-rate 0.8571` is 6 of its 7 statement lines, with no `begin`, `end` or declaration line
counted). The emitted text of each batch is from the dry run.

**Batch 1, `LayoutBeta.Codeunit.al` as emitted** (83 lines). The emitter adds
`var MutationSelector` at lines 3 to 5, so `Grow` runs from line 6 to 41 and `Twice` from 43 to
82. With no mutant active, each guard chain evaluates every `Active(...)` test and then runs the
original code in its final `else`:

| test | statement lines hit, batch 1 | owner, batch 1's own index | owner, batch 0's index (unfixed) |
| --- | --- | --- | --- |
| GrowAboveTen | 8, 10, 16, 22, 28 (the `Active` chain), 36, 37 (`if X > 10`, `exit(X + 1)`) | all `Grow` | 8: `Grow`. 10 to 37: `Twice` |
| TwiceOfThree | 71, 73 (the `Active` chain), 79 (`exit(X * 2)`) | all `Twice` | none: past line 40, so object-level only |
| AlphaIsBig | Alpha is verbatim here: 5 | `IsBig` | not `IsBig` (line 5 of instrumented Alpha is a blank line after the `var`); no batch-1 mutant reads it |

Batch 0's index knows Beta VERBATIM: `Grow` 3 to 8, `Twice` 10 to 39, nothing past 40.

**How robust the unfixed column is.** It needs three facts, not the exact hit list. (a) Line 8, the
first statement of `Grow`'s body, is reported: it keeps `Grow`'s mutants on `GrowAboveTen`. (b) At
least one line from 10 to 39 is reported for `GrowAboveTen`: lines 36 and 37 are the original,
unguarded statements that run on every baseline call, so this holds even if al-runner does not
report the `else if` lines. (c) No line of the instrumented `Twice` is at or below 40: its body
starts at 70. Whether lines 10, 16, 22 and 28 are reported changes nothing.

**Batch 0** is read through batch 0's own index in both the fixed and the unfixed code, because
that index is built during batch 0. `AlphaIsBig` hits Alpha's lines 8, 10, 14, 20, all `IsBig`.
`GrowAboveTen` and `TwiceOfThree` hit Beta's verbatim lines 5, 6 and 38, which no batch-0 mutant
reads.

## Predicted scoring, fixed code (HEAD), one-shot and `--server`

`K(t)` = killed, killing test `t`. `S` = survived, no killing test. Killing tests are method names
(the report's form); covering tests are `Layout Tests.<method>`.

| mutant | verdict | killing test | covering tests | why |
| --- | --- | --- | --- | --- |
| 0/M0001 | K | AlphaIsBig | AlphaIsBig | returns `false` for 20 |
| 0/M0002 | K | AlphaIsBig | AlphaIsBig | `not (20 > 10)` is `false` |
| 0/M0003 | S | | AlphaIsBig | `20 >= 10` is still `true` |
| 1/M0001 | K | GrowAboveTen | GrowAboveTen | returns 0, not 21 |
| 1/M0002 | S | | GrowAboveTen | `20 >= 10` takes the same branch |
| 1/M0003 | K | GrowAboveTen | GrowAboveTen | returns 0 |
| 1/M0004 | K | GrowAboveTen | GrowAboveTen | returns 19 |
| 1/M0005 | S | | GrowAboveTen | `exit(X)` is not reached for 20 |
| 1/M0006 | K | TwiceOfThree | TwiceOfThree | returns 0, not 6 |
| 1/M0007 | K | TwiceOfThree | TwiceOfThree | returns 0 |

**7 killed / 3 survived / 0 no-coverage over 10, 2 batches, baseline green in both.** The one-shot
and `--server` legs are identical per mutant (verdict, killing test, covering tests), keyed by
`<batch>/<code>`. Every `coverageAttribution` is `exact`.

## Predicted scoring with `resetLayoutState()` removed (the live red-check)

**One-shot: exactly two mutants move, and both move the same way.**

| mutant | fixed | unfixed |
| --- | --- | --- |
| 1/M0006 | killed, TwiceOfThree, covered by [TwiceOfThree] | **survived**, no killing test, covered by **[GrowAboveTen]** |
| 1/M0007 | killed, TwiceOfThree, covered by [TwiceOfThree] | **survived**, no killing test, covered by **[GrowAboveTen]** |

Why: in batch 1 the stale index reads `GrowAboveTen`'s lines 10 to 37 as `Twice` and reads every
`TwiceOfThree` line as no procedure. So `Twice` loses its own test and gains one that never calls
it; each mutant runs only `GrowAboveTen`, which passes. `Twice` is public, so no object-level
fallback applies (`coverageFilter`). `Grow` keeps `GrowAboveTen` through line 8, so its five do not
move. Batch 0 does not move. **Unfixed one-shot: 5 killed / 5 survived / 0 no-coverage.** This is a
false `survived` with a covering test that never ran the code, the worst of R349's shapes.

**`--server`: nothing moves. 7 / 3 / 0, identical to the fixed table.** The server names each
covered statement's procedure itself (`st.scope`, `alRunnerCoverageFromServer`). The index is
consulted only for the file's object, which is the same in both layouts, and for `#if`-renamed
members (R318), of which this fixture has none. The other half of the reset, `serverSuite`, is not
observable here either: every batch's baseline starts with `activate(null)`, which already clears
it. So the `--server` leg is a CONTROL in the red-check, not a detector: it must still match the
fixed table, and its equality check against the one-shot leg must fail on exactly 1/M0006 and
1/M0007.

**What that means.** Only the one-shot leg can see R349 live. Removing only the `serverSuite` half
of the reset stays invisible to every live leg; R349's unit test "deploy() DROPS the suite cache
too" remains its only guard.

## What the gate asserts, and how the red-check must fail

Both legs: `report.batches` is 2; every batch-0 mutant is in Alpha and every batch-1 mutant is in
Beta; `baselineGreen`; the table above per mutant (verdict, killing test, covering tests). The
`--server` leg also equals the one-shot leg per mutant. The one-shot leg alone is compared with the
new frozen baseline, after both table checks pass, so a record run can never record a leg that
disagrees with this document.

Red-check (reset removed), predicted failures, and no others:
1. `R353 layout one-shot`: rows differ from this table, naming `1/M0006` and `1/M0007` (killed to
   survived, covering `TwiceOfThree` to `GrowAboveTen`).
2. `R353 layout --server`: differs from the one-shot leg on `1/M0006` and `1/M0007`.
3. The `--server` table check PASSES.
The sandbox-app and symbol legs pass, because they run one batch.

## What would count as a finding

- Any fixed-code verdict, killing test or covering test differing from its row, on either leg.
- A batch count other than 2, a mutant in the wrong batch, a red baseline, or a `no-coverage`.
- A dry-run list different from the 10 rows above.
- In the red-check: the one-shot leg NOT failing; failing on any mutant other than 1/M0006 and
  1/M0007 (for example `Grow`'s five going `no-coverage`, which would mean line 8 is not reported);
  or the `--server` leg moving at all.

A finding is a stop. It is reported, not re-recorded.

## How the numbers were checked (offline, 2026-09-30)

- Dry run: a scratch script (never committed) under the session scratchpad `r353/dryrun.ts` called
  `generateMutationSet`, `planArtifacts({ maxGuardsPerBatch: 7 })`, `writeInstrumentedProject` and
  `prepareBatchProject` per batch, then `buildAlRunnerCoverageIndex` on each batch directory, and
  printed every emitted line's owner under its own index and under batch 0's. No al-runner, no BC.
  It produced the 10 mutants, the 2-batch plan, and the line owners above.
- Offline `alc` (18.0.2732683): target, exit 0 (also with an EMPTY package cache, exit 0); tests
  against the staged target `.app`, exit 0; each batch's instrumented directory with the al-runner
  static selector and the two control-registration files removed, as `deploy()` does, exit 0 with
  no mutant active and exit 0 with M0001 active, in both batches.

## What will change this later

Any change to how the schemata emitter lays out a guard chain moves the emitted line numbers. The
fixed column cannot move from that (each batch reads its own layout), but the unfixed column's
reasoning rests on facts (a) to (c) above. A change to Tier-1 targeting that adds or drops a site in
either file changes the table and the batch plan. Either needs a new pre-commitment and a re-freeze
of `al-runner.layout.baseline.json`.
