namespace R198.Probe;

/// <summary>F4's question in miniature: a record read WITHOUT a lock, held across another
/// session's committed write, then Modify()ed. Does the platform raise, or silently overwrite?
/// Run through Codeunit.Run so a raise is caught and reported instead of unwinding the action.</summary>
codeunit 71546 "R198 Stale Writer"
{
    var
        Stale: Record "R198 Progress";

    procedure SetRecord(Rec: Record "R198 Progress")
    begin
        Stale := Rec;
    end;

    trigger OnRun()
    begin
        Stale."Method Name" := 'STALE-WRITER';
        Stale.Modify();
    end;
}
