codeunit 79451 "Hang Z Baseline Tests"
{
    Subtype = Test;
    // Same reason as codeunit 79450: declared so the fixture cannot start failing on permissions.
    TestPermissions = Disabled;

    // R-658's BASELINE leg (docs/superpowers/specs/2026-10-22-r658-hang-baseline-leg-precommitment.md).
    // Only that leg runs this codeunit with a short baseline budget (10 s). At the 120 s default
    // every test here passes, and the names sort after codeunit 79450's ("Hang T" < "Hang Z"), so
    // the existing killers stay first under every mutant. Do not rename these tests or the
    // codeunit without a new pre-commitment.

    /// <summary>
    /// Sleeps past the BASELINE leg's 10 s budget, so LethAL stops it on the server. It calls
    /// `DrainQueue` first, as the leak check for the coverage recording: if the stopped session's
    /// recording survived the stop, the next test would show `DrainQueue` in its coverage.
    /// </summary>
    [Test]
    procedure SleepsPastTheBaselineBudget()
    var
        Logic: Codeunit "Hang Logic";
    begin
        Logic.DrainQueue(3);
        Sleep(25000);
    end;

    /// <summary>
    /// Runs right after the stopped test and covers nothing, so any target member in its
    /// coverage is a leak from the stopped session.
    /// </summary>
    [Test]
    procedure ZPassesAfterTheStoppedTest()
    begin
    end;

    /// <summary>
    /// The control (D2): it MUST cover `DrainQueue`, so "no coverage anywhere" cannot pass by
    /// coverage silently returning nothing. It kills `while Pending > 0` -> `>= 0` (returns 4).
    /// </summary>
    [Test]
    procedure ZZDrainsAfterTheStop()
    var
        Logic: Codeunit "Hang Logic";
        Got: Integer;
    begin
        Got := Logic.DrainQueue(3);
        if Got <> 3 then
            Error('DrainQueue(3) returned %1, expected 3', Got);
    end;
}
