table 50420 "Repro Header"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Name; Text[50]) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

table 50421 "Repro Line"
{
    fields
    {
        field(1; "Header Code"; Code[20]) { }
        field(2; "Line No."; Integer) { }
        field(3; Amount; Integer) { }
    }
    keys { key(PK; "Header Code", "Line No.") { Clustered = true; } }
}

table 50422 "Repro Blob"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Data; Blob) { }
    }
    keys { key(PK; Id) { Clustered = true; } }
}

xmlport 50423 "Repro Import"
{
    Direction = Import;
    Format = Xml;

    schema
    {
        textelement(Root)
        {
            tableelement(Header; "Repro Header")
            {
                SourceTableView = sorting("Code");
                UseTemporary = true;
                fieldattribute(Code; Header."Code") { }
                fieldattribute(Name; Header.Name) { }

                tableelement(Line; "Repro Line")
                {
                    LinkTable = Header;
                    LinkFields = "Header Code" = field("Code");
                    fieldattribute(LineNo; Line."Line No.") { }
                    fieldattribute(Amount; Line.Amount) { }
                }

                trigger OnBeforeInsertRecord()
                begin
                    // the guard a mutation negated: a header not seen before is skipped
                    if not Header.Get(Header."Code") then
                        currXMLport.Skip();
                end;
            }
        }
    }
}

codeunit 50424 "XmlPort Skip Tests"
{
    Subtype = Test;

    [Test]
    procedure SkipHeaderWithLines()
    var
        B: Record "Repro Blob" temporary;
        Line: Record "Repro Line";
        OutS: OutStream;
        InS: InStream;
    begin
        B.Id := 1;
        B.Data.CreateOutStream(OutS);
        OutS.WriteText('<Root><Header Code="H1" Name="First"><Line LineNo="1" Amount="5"/><Line LineNo="2" Amount="7"/></Header></Root>');
        B.Insert();
        B.Data.CreateInStream(InS);
        Xmlport.Import(Xmlport::"Repro Import", InS);
        // whatever BC does with the lines of a skipped header, the import itself must finish
        if Line.Count() > 2 then
            Error('more lines than the file holds');
    end;
}
