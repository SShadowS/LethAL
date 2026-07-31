// R66 probe helper. The write that must be REFUSED lives here rather than in a `[TryFunction]`,
// because the platform refuses `INSERT` inside a TryFunction under `RunTests` outright — measured
// 2026-07-31, and it is the same self-measuring trap `Commit()` sprang in the Phase-2 probe. The
// refusal that comes back then describes the wrapper, not permissions.
//
// `Codeunit.Run` is AL's real catch idiom: it returns false on error and leaves the failure
// readable through `GetLastErrorText`/`GetLastErrorCode`, without the TryFunction restriction.
codeunit 79217 "Lang Refusal Runner"
{
    TableNo = "Rec XRec Probe";

    trigger OnRun()
    begin
        Rec.Init();
        Rec."No." := 'LANG1';
        Rec.Amount := 1;
        Rec.Insert(false);
    end;
}
