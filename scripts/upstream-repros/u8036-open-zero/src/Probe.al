codeunit 50960 "PR10 RecordRef Open"
{
    Subtype = Test;

    [Test]
    procedure OpenTableZeroThenReadPermission()
    var
        R: RecordRef;
    begin
        // An empty record's "Table Id" is 0. BC (expected): Open(0) raises an error.
        asserterror begin
            R.Open(0);
            if R.ReadPermission() then;
        end;
    end;

    [Test]
    procedure OpenMissingTableThenReadPermission()
    var
        R: RecordRef;
    begin
        // A table id no app declares. BC (expected): Open raises an error.
        asserterror begin
            R.Open(1999999990);
            if R.ReadPermission() then;
        end;
    end;

    [Test]
    procedure OpenMissingTableAlone()
    var
        R: RecordRef;
    begin
        asserterror R.Open(1999999990);
    end;
}
