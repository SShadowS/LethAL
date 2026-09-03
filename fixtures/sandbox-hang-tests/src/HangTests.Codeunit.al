codeunit 79450 "Hang Tests"
{
    Subtype = Test;
    // R1, measured: a test codeunit that omits this runs Restrictive (AL's default) and BC refuses
    // its writes on every path through `Test Runner - Mgt` 130454. This one writes nothing, but the
    // property is declared anyway so the fixture cannot start failing for that reason later.
    TestPermissions = Disabled;

    /// <summary>
    /// Passes against the unmutated target, and would never RETURN against the empty-block mutant
    /// of `CountUpTo` — which is the point of the whole fixture. Every verdict here is therefore
    /// about whether LethAL can end a run that will not end on its own.
    ///
    /// Asserts via `Error()` rather than Library Assert, matching the other fixtures: no dependency
    /// on the test framework's own app beyond `Subtype = Test`.
    /// </summary>
    [Test]
    procedure CountUpToReachesTheLimit()
    var
        Logic: Codeunit "Hang Logic";
        Got: Integer;
    begin
        Got := Logic.CountUpTo(3);
        if Got <> 3 then
            Error('CountUpTo(3) returned %1, expected 3', Got);
    end;

    /// <summary>
    /// R164. Drives `WalkOneRow` over exactly one row, which is the shape whose
    /// `negate-conditional` mutant never returns. MEASURED as `timeout-killed` before
    /// `loop-truncate`'s cession landed, and absent afterwards.
    /// </summary>
    [Test]
    procedure WalkOneRowVisitsExactlyOneRow()
    var
        Logic: Codeunit "Hang Logic";
        Got: Integer;
    begin
        Got := Logic.WalkOneRow();
        if Got <> 1 then
            Error('WalkOneRow() returned %1, expected 1', Got);
    end;

    /// <summary>
    /// R179. Drives `DrainQueue` over three laps, so `while false` returns 0 and dies. Before the
    /// cession, `empty-block` on that loop's body freezes `Pending` and never returns.
    /// </summary>
    [Test]
    procedure DrainQueueEmptiesTheQueue()
    var
        Logic: Codeunit "Hang Logic";
        Got: Integer;
    begin
        Got := Logic.DrainQueue(3);
        if Got <> 3 then
            Error('DrainQueue(3) returned %1, expected 3', Got);
    end;

    /// <summary>
    /// R206's arm, test 1 of 2: takes `SpinUntil`'s early exit and asserts its DISTINCTIVE value,
    /// so this test kills every guard-line mutant at position 1 and seeds the kill ledger before
    /// the loop's mutants are scored. Its name sorts before `SpinUntilReachesTheTarget` (`A` &lt; `R`)
    /// on purpose; see `Hang Logic.SpinUntil`.
    /// </summary>
    [Test]
    procedure SpinUntilAtZeroExitsEarly()
    var
        Logic: Codeunit "Hang Logic";
        Got: Integer;
    begin
        Got := Logic.SpinUntil(0);
        if Got <> -1 then
            Error('SpinUntil(0) returned %1, expected -1', Got);
    end;

    /// <summary>
    /// R206's arm, test 2 of 2: drives the unbounded loop, and is the method that HANGS under
    /// `void-method-call` on `Advance()`, at group position 2. Its name sorts after
    /// `CountUpToReachesTheLimit` (`C` &lt; `S`) on purpose: it now also covers `Advance`, and a name
    /// sorting first would move that procedure's two existing hangs to position 2.
    /// </summary>
    [Test]
    procedure SpinUntilReachesTheTarget()
    var
        Logic: Codeunit "Hang Logic";
        Got: Integer;
    begin
        Got := Logic.SpinUntil(3);
        if Got <> 3 then
            Error('SpinUntil(3) returned %1, expected 3', Got);
    end;
}
