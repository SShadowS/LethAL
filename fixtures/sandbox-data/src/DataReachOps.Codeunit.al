// GH-24's live negative control: per-test reach, measured at the mutant's own statement.
//
// Every mutant on the bcdev path now says, per covering test, whether its own statement began
// executing (`guardReached`, `reachedBy`). The offline tests prove the plumbing. They cannot prove
// that the flag a real server returns is per TEST rather than per call, or that it is cleared
// between two tests in one grouped call. This arm is where a server has to show that.
//
// `Classify` is covered by two tests that both pass on every mutant which leaves the return value
// alone, so both run in ONE `RunMutantMany` call for such a mutant:
//
//   ReachTakesBranch     Classify(500)  -- enters the `Amount > 100` branch
//   ReachWithoutBranch   Classify(10)   -- does not
//
// R197's name tie-break runs ReachTakesBranch FIRST. So for a mutant inside that branch the grouped
// entries must read [true, false] in that order. A reset that does nothing would read [true, true]:
// the flag set by the first test would still be set when the second one finished.
//
// `Seen` is written by the branch and read by no test, so the branch's effect is unasserted and its
// mutants SURVIVE. A survivor is the case reach exists for: it runs every covering test, so the
// report's `reachedBy` is complete, and it names exactly the test that got there.
//
// The second `if` is the other half of the control. `Touch()` sits alone in an unbraced then-slot,
// so a mutant deleting it resolves to the whole `if` statement, and a marker there would fire even
// when the branch is not taken. It must therefore carry `reachGrain: "enclosing"`, no marker and no
// `guardReached` at all. No test passes an Amount above 1000, so a false "reached" on it would be
// visible, not merely wrong.
//
// Pre-committed verdicts and reach: docs/superpowers/specs/2026-09-25-gh24-reach-control-precommitment.md
codeunit 79334 "Data Reach Ops"
{
    var
        // Written by the branch, read by no test: the branch's effect is unasserted.
        Seen: Integer;

    procedure Classify(Amount: Integer): Integer
    begin
        if Amount > 100 then begin
            Seen := Amount;
        end;
        if Amount > 1000 then
            Touch();
        exit(Amount);
    end;

    local procedure Touch()
    begin
        Seen := 0;
    end;
}
