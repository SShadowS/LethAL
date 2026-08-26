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
}
