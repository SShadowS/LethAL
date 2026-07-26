// ROADMAP R1 investigation probe (Stream A follow-up, scratch — NOT part of the Tier-2 Phase 0
// fixture). Exists ONLY so R1PermissionProbe.Codeunit.al can capture an Insert failure's exact text
// via `Codeunit.Run` instead of a local `[TryFunction]`: measured that BC rejects a write-performing
// TryFunction called from inside a `[Test]` method's own call scope ("Call to the function 'INSERT'
// is not allowed inside the call to '<TestMethodName>' when it is used as a TryFunction"), regardless
// of how many plain (non-try) procedures separate the two. `Codeunit.Run` opens a genuinely separate
// method scope (its own OnRun trigger) and sidesteps the restriction — the standard AL idiom.
//
// Idempotent by construction (delete-then-insert a fixed key), matching the pattern
// fixtures/sandbox-data-tests/src/DataTests.Codeunit.al's InsertDoublesAmountWeak uses, because
// LethAL's fenced path commits around each run rather than rolling back.
codeunit 79313 "R1 Same Ext Insert"
{
    trigger OnRun()
    var
        SameExt: Record "R1 Same Ext";
    begin
        if SameExt.Get('R1S') then
            SameExt.Delete(false);
        SameExt.Init();
        SameExt."No." := 'R1S';
        SameExt.Insert(true);
    end;
}
