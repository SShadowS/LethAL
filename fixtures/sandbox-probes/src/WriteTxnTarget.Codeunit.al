// R72's callee. Deliberately trivial: the measurement is about whether the PLATFORM refuses the
// `Codeunit.Run` while a write transaction is open, so this codeunit must do nothing that could
// itself fail and be mistaken for that refusal.
//
// It writes the marker row so that, if BC turns out to ALLOW the call, the probe still records
// something observable rather than a silent success.
codeunit 79220 "Write Txn Target"
{
    trigger OnRun()
    var
        Marker: Record "Sandbox Probe Marker";
    begin
        Marker.Init();
        Marker."Entry No." := 79220;
        if not Marker.Insert(false) then;
    end;
}
