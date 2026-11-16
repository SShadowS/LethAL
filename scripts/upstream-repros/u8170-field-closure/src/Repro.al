// Invented repro, no corpus source text. An app with no dependency still sees the closure's tables in the virtual Field table
// (2000000041) on BC: it holds rows for tables below this app's own table 51640.
table 51640 "Probe Tags"
{
    fields
    {
        field(1; "Company"; Code[30]) { }
        field(2; "Tag"; Code[250]) { }
    }
    keys
    {
        key(PK; "Company") { Clustered = true; }
    }
}

codeunit 51641 "Field Closure Tables"
{
    Subtype = Test;

    [Test]
    procedure RowsBelowOwnTable()
    var
        F: Record Field;
    begin
        F.SetRange(TableNo, 1, 51639);
        if F.IsEmpty() then
            Error('no Field rows below table 51640');
    end;
}
