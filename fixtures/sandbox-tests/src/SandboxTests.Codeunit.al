codeunit 79100 "Sandbox Tests"
{
    Subtype = Test;

    var
        SandboxLogic: Codeunit "Sandbox Logic";

    [Test]
    procedure OverBudgetDetected()
    begin
        if not SandboxLogic.IsOverBudget(101, 100) then
            Error('101 vs 100 must be over budget');
        if SandboxLogic.IsOverBudget(99, 100) then
            Error('99 vs 100 must not be over budget');
        if SandboxLogic.IsOverBudget(100, 100) then
            Error('equal amounts must not be over budget');
    end;

    [Test]
    procedure ClampPercentRuns()
    begin
        SandboxLogic.ClampPercent(50);   // weak on purpose: no assertion on the result
        SandboxLogic.ApplyAudit(10);
    end;
}
