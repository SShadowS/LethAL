// Invented repro for aldevtools/BusinessCentral.AL.Runner#7996: Base64Convert.ToBase64(InStream, true) must break lines after 76 characters.
table 79960 "R961 Holder"
{
    TableType = Temporary;
    fields
    {
        field(1; "No."; Integer) { }
        field(2; Data; Blob) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}

codeunit 79961 "R961 Base64 Line Breaks"
{
    Subtype = Test;

    [Test]
    procedure InStreamToBase64KeepsLineBreaks() // BC: passes
    var
        Holder: Record "R961 Holder";
        Converter: Codeunit Base64Convert;
        OutS: OutStream;
        InS: InStream;
        Result: Text;
    begin
        Holder.Data.CreateOutStream(OutS);
        OutS.WriteText(PadStr('', 100, 'A'));
        Holder.Data.CreateInStream(InS);
        Result := Converter.ToBase64(InS, true);
        if StrPos(Result, CRLF()) <> 77 then
            Error('No line break after 76 characters; length %1', StrLen(Result));
    end;

    [Test]
    procedure TextToBase64KeepsLineBreaks() // control: passes
    var
        Converter: Codeunit Base64Convert;
        Result: Text;
    begin
        Result := Converter.ToBase64(PadStr('', 100, 'A'), true, TextEncoding::UTF8, 0);
        if StrPos(Result, CRLF()) <> 77 then
            Error('No line break after 76 characters; length %1', StrLen(Result));
    end;

    local procedure CRLF(): Text[2]
    var
        T: Text[2];
    begin
        T[1] := 13;
        T[2] := 10;
        exit(T);
    end;
}
