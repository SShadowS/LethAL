# R132 design — make one live gate exercise the assertion screen's `partial` branch

Written 2026-08-14, before any AL is changed. Roadmap row: `docs/roadmap/R132.md`.

## The problem, restated

R121's screen asks one question of every kill: does its failure text begin with `Assert.`? It
reports which of four things happened in `SessionReport.assertionScreen.discrimination` — `partial`
(the rule separated something), `vacuous` (everything was flagged, so it separated nothing), `none`,
`no-text`.

Every LethAL fixture raises through bare `Error(...)`, so every live gate produces `vacuous` (or
`no-text`). The `partial` branch — the only one where a reader is told something actionable — is
proven by unit tests and by re-scoring one committed third-party corpus, and by no live run. A
branch nothing exercises is a branch nobody knows still works.

## Feasibility, MEASURED first (`scripts/r132-assert-probe/`)

The row said this decision turns entirely on whether the containers have Microsoft's test libraries
and what a dependency costs. Both were measured on 2026-08-14 rather than assumed:

- `Library Assert` 28.0.46665.49944 is installed **Global** on **both** Cronus283 (the table
  fixture's container) and Cronus281 (sandbox-app's), alongside `Test Runner`, `Any`,
  `Library Variable Storage` and `System Application Test Library`.
- Its symbol package downloads straight from the container's own dev endpoint
  (`dev/packages?publisher=Microsoft&appName=Library%20Assert`), so the dependency costs one file in
  `.alpackages` and one `app.json` entry — no toolkit install, no marketplace copy.
- A probe app declaring that dependency compiled (`alc 18.0.38.8509`) and published to Cronus283
  with no schema or dependency complaint.
- The failure text is what the screen needs:

  ```
  Assert.AreEqual failed. Expected:<1> (Integer). Actual:<2> (Integer). probe message.
  Assert.IsTrue failed. probe message
  ```

  Both begin with `Assert.`, and the AL labels carry `Locked = true`, so they do not localise.

So option (1) from the row — "give a fixture a Library Assert dependency and a few `Assert.*` tests"
— is available at low cost. Option (2), a second real project with a hand-classified kill corpus, is
not something this session can produce.

## Decision 1: the TABLE fixture hosts `partial`, and the bcdev gate keeps the `vacuous` case

Three candidates were considered.

| candidate | verdict |
| --- | --- |
| `fixtures/sandbox-data` + `-tests` (the tables gate) | **chosen** |
| `fixtures/sandbox-app` + `sandbox-tests` (the bcdev gate) | rejected |
| a new dedicated fixture pair and a fifth gate | rejected |

**Why not sandbox-app**, which looks cheaper at 16 mutants: that fixture pair is shared with the
`itest:envtool` gate, whose environment currently reports `Stopped` (LethAL refuses to start an
environment it does not own), and with `itest:alrunner`. Changing it would move the frozen figures of
a gate that cannot be re-measured right now, leaving a durable expectation nobody has verified. The
table fixture is used by exactly one gate, which this session can run end to end.

**Why not a new fixture pair**: a fifth gate is a standing cost — another container, another
baseline, another set of frozen figures — for one branch of one screen. R132 asks for the branch to
run live, not for a new gate to run it in.

**The cost of choosing the table fixture, and how it is paid.** The tables gate currently ASSERTS
`vacuous` by name, and that assertion is itself evidence — R134 and R141 both lean on it, because a
count reads identically on a suite that separates nothing and one that separates well. Growing that
fixture an `Assert.*` arm makes `vacuous` false there. So the `vacuous` case moves to the bcdev gate,
which keeps a bare-`Error(...)`-only suite (`fixtures/sandbox-tests`), and `bcdev.itest.ts` gains the
assertion the tables gate is giving up. After this wave BOTH states are pinned live, by two different
gates, which is strictly more than is pinned today.

**PRE-COMMITTED PREDICTION for the bcdev gate**: `vacuous`. Its three kills all come from tests that
raise through bare `Error(...)`, and a kill that carries text at all is therefore flagged. The
competing possibility is `no-text` (no kill carried failure text), which R132's own table lists as an
alternative because nobody has measured which. If the measurement says `no-text`, that is a finding
to record on the row and the assertion is set to the measured value with the measurement cited —
never silently.

## Decision 2: the arm is a TWIN PAIR, so the discrimination is visible inside one codeunit

`codeunit 79318 "Data Assert Ops"` (ids 79300-79399 are sandbox-data's own range), two procedures of
the identical shape, differing only in how their covering test raises:

```al
procedure DoubledLevel(Level: Integer): Integer   // covered by an Assert.AreEqual test
begin
    exit(Level * 2);
end;

procedure TripledLevel(Level: Integer): Integer   // covered by a bare Error(...) test
begin
    exit(Level * 3);
end;
```

Both are `Integer` in and out deliberately: `Library Assert.AreEqual` compares Variants and reports
the type it saw, so a `Decimal` actual against an Integer literal expectation would fail on the type
rather than the value — a test that passes or fails for the wrong reason on its first day.

Two tests in `fixtures/sandbox-data-tests/src/DataTests.Codeunit.al`, one per procedure. Neither
seeds a row, neither touches any other arm's tags or Entry No. band, so no existing verdict can move
for a data reason.

Each procedure yields two Tier-1 mutants (`empty-block` on the body, `return-value` on the `exit`),
all four predicted **killed**: an emptied body returns 0 and a zeroed `exit` returns 0, and both
tests assert an exact non-zero value. The pair's point is what the SCREEN does with those kills:

| mutant | killed by | begins with `Assert.` | screen |
| --- | --- | --- | --- |
| `DoubledLevel` empty-block | `Assert.AreEqual` | yes | NOT flagged |
| `DoubledLevel` return-value | `Assert.AreEqual` | yes | NOT flagged |
| `TripledLevel` empty-block | bare `Error(...)` | no | flagged |
| `TripledLevel` return-value | bare `Error(...)` | no | flagged |

Same operators, same code shape, same verdict, opposite screen outcome. That is a pairing no
aggregate count can fake, and it is the same evidence discipline `assertFilterLiteralEvidence` uses
for R134's arm C / arm D pair.

## What the gate asserts

`packages/runner/itest/tables.itest.ts`:

1. `assertionScreen.discrimination === "partial"` (replacing `"vacuous"`), with the comment
   explaining that the fixture's assertion style is now mixed BY CONSTRUCTION.
2. Both populations are non-empty: `flagged > 0` and `killsWithText - flagged > 0`. A count alone
   would pass on a suite where the rule separated nothing, which is the mistake R121 exists to avoid.
3. Membership, per mutant: the two `DoubledLevel` mutants are NOT in `flaggedMutants`, and the two
   `TripledLevel` mutants ARE. This is what makes the assertion about the RULE rather than about a
   number that happens to land in range.

`packages/runner/itest/bcdev.itest.ts` gains the `vacuous` pin the tables gate gives up, with its own
note that its suite raises through bare `Error(...)` only.

## What this is NOT

**It is not evidence about the rule's precision.** The 26.1% figure comes from 73 hand-classified
kills on Continia Document Output. A fixture built to produce `partial` proves the PIPELINE runs and
reports what the unit tests say it reports; it says nothing about how often a flagged kill is really
false. R132 names confusing these two as the specific mistake it exists to prevent, and the arm's own
AL comments say so at the site.

**It does not tune the rule.** No rule changes in this wave. The screen's code is untouched.

## Sequence

1. Add the arm, the two tests, the `Library Assert` dependency and its symbol file; bump the test
   app to 1.0.0.13.
2. `bun run compile:fixtures`, then the offline census, and reconcile the delta exactly.
3. Write and COMMIT the per-mutant pre-commitment before anything live runs.
4. Publish the test app to Cronus283; verify the container reports 1.0.0.13.
5. Delete `tables.baseline.json`, run `itest:tables`, judge per mutant against the pre-commitment,
   then run the gate a second, separate time.
6. Run `itest:bcdev` with its new `vacuous` assertion.
7. Update the frozen figures in `CLAUDE.md` and `fixtures/README.md`, and close R132.
