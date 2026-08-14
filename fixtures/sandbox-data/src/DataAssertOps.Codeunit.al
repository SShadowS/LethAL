// R132's assertion-screen arm -- a TWIN PAIR whose two halves differ in nothing except how their
// covering test raises.
//
// Design: docs/superpowers/specs/2026-08-14-r132-assertion-screen-partial-design.md.
//
// R121's screen asks one question of every kill: does its failure text begin with `Assert.`? Until
// this arm, every test in every LethAL fixture raised through bare `Error(...)`, so on every live
// gate the screen flagged EVERY kill and reported `discrimination: "vacuous"` -- it separated
// nothing, and the `partial` branch, the only one where a reader is told something actionable, had
// never run against a real server.
//
// The two procedures below are deliberately identical in shape (one arithmetic expression returned
// from a one-line body), so the ONLY difference between their four mutants is the assertion style
// of the test that kills them:
//
//   DoubledLevel -- covered by `AssertScreenSeesAnAssertionFailure`, which raises through
//                   Microsoft's Library Assert. Measured text (scripts/r132-assert-probe/):
//                   `Assert.AreEqual failed. Expected:<50> (Integer). Actual:<0> (Integer). ...`
//                   The screen does NOT flag those kills.
//   TripledLevel -- covered by `AssertScreenSeesABareErrorFailure`, which raises through bare
//                   `Error(...)`, the style every other test in this fixture uses. The screen DOES
//                   flag those kills.
//
// Same operators, same shape, same verdict, opposite screen outcome. That pairing is the evidence;
// a count of flagged kills reads identically on a suite that separates nothing.
//
// WHAT THIS IS NOT. It is not evidence about the rule's PRECISION. The 26.1% figure comes from 73
// hand-classified kills on a third-party app, and a fixture built to produce `partial` proves the
// pipeline reports what the unit tests say it reports -- nothing about how often a flagged kill is
// really false. R132 names confusing those two as the specific mistake it exists to prevent.
//
// Both procedures are Integer in and Integer out on purpose: `Library Assert.AreEqual` compares
// Variants and reports the TYPE it saw, so a Decimal actual against an Integer literal expectation
// would fail on the type rather than the value -- a test that fails for the wrong reason on day one.
codeunit 79318 "Data Assert Ops"
{
    procedure DoubledLevel(Level: Integer): Integer
    begin
        exit(Level * 2);
    end;

    procedure TripledLevel(Level: Integer): Integer
    begin
        exit(Level * 3);
    end;
}
