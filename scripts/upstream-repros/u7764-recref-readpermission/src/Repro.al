// Invented repro for aldevtools/BusinessCentral.AL.Runner#7764, cause 4: RecordRef.ReadPermission on a RecordRef that is not open.
codeunit 77641 "R913 ReadPermission"
{
    Subtype = Test;

    [Test]
    procedure ReadPermissionNotOpen() // BC: the call errors, so asserterror passes
    var
        RR: RecordRef;
        B: Boolean;
    begin
        asserterror B := RR.ReadPermission();
    end;
}
