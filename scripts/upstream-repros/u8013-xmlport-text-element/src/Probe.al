// PR-28 (#8013, XmlPort export of an unbound text element): a VariableText export whose table element holds only an unbound text
// element, filled in OnBeforePassVariable (the shape of Base Application's generic CSV and fixed-width exports, written fresh;
// no corpus text). On BC the export writes one line per row and ends (inferred, not measured).
table 51530 "U8013 Port Row"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}

xmlport 51531 "U8013 Text Element Export"
{
    Direction = Export;
    Format = VariableText;
    UseRequestPage = false;
    schema
    {
        textelement(Root)
        {
            tableelement(Row; "U8013 Port Row")
            {
                textelement(ColumnX)
                {
                    trigger OnBeforePassVariable()
                    begin
                        ColumnX := Row.Code;
                    end;
                }
            }
        }
    }
}

codeunit 51532 "U8013 Port Tests"
{
    Subtype = Test;

    [Test]
    procedure ExportUnboundTextElement()
    var
        R: Record "U8013 Port Row";
        B: Codeunit "Temp Blob";
        O: OutStream;
    begin
        R.Code := 'A';
        R.Insert();
        B.CreateOutStream(O);
        Xmlport.Export(Xmlport::"U8013 Text Element Export", O);
    end;
}
