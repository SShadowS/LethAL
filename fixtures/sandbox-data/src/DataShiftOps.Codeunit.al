// R159's assertion-screen arm for `shift-integer` -- a TWIN PAIR, the device R132 built for exactly
// this question and `Data Blank Ops` reused.
//
// The operator declares no `PlatformKillMechanism`, on the same ruling `remove-assignment` and
// `toggle-blank-string` carry: changing a written or compared VALUE is ordinary changed behaviour,
// and R121's assertion screen is what tells a reader whether such a kill carried an assertion.
//
// The spike could not test that ruling. Its two live kills came from `credit-limit` and
// `sandbox-hang`, both of which raise through bare `Error(...)`, so the screen flagged both and
// reported `vacuous` -- it separated nothing. Reading that as a pass would have been wrong, and the
// three sites this operator already has on THIS fixture (`Data Commit Ops`, lines 37/51/88) all
// SURVIVE, so they cannot answer it either.
//
// So these two procedures are identical in shape and differ in nothing but how their covering test
// raises:
//
//   BandedViaAssert  -- killed through Microsoft's Library Assert  -> screen must NOT flag
//   BandedViaError   -- killed through bare Error(...)             -> screen MUST flag
//
// Same operator, same shape, same verdict, opposite screen outcome. That pairing is the evidence,
// and `tables.itest.ts` pins it BY MUTANT: a count of flagged kills reads identically on a suite
// that separated nothing.
//
// WHY THE LOOP REFUSAL IS NOT HERE. The operator's other cession -- an integer literal in a loop's
// exit condition, R164's non-termination hazard -- has no arm on this or any other fixture, and
// that is deliberate. R164 rules that a hang-capable site must not enter a scored gate, and there
// is no safe version of one: a loop whose exit depends on a counter is turned non-terminating by
// `remove-assignment`, by `swap-additive`, and by `shift-integer` itself. An arm here would plant a
// landmine to prove an ABSENCE that no server can observe anyway, since a refused site produces no
// mutant for one to run. It is proven instead against real AL, positionally and offline, in
// `packages/builtin-tier1/tests/shift-integer.test.ts`.
codeunit 79325 "Data Shift Ops"
{
    // `10` is an equality-comparison operand, so the operator claims it: `Amount = 11` never matches
    // the 10 the test passes, and the mutant returns 0 where 1 is expected.
    procedure BandedViaAssert(Amount: Integer): Integer
    begin
        if Amount = 10 then
            exit(1);
        exit(0);
    end;

    // Identical in shape. The ONLY difference is in the test that covers it.
    procedure BandedViaError(Amount: Integer): Integer
    begin
        if Amount = 10 then
            exit(1);
        exit(0);
    end;
}
