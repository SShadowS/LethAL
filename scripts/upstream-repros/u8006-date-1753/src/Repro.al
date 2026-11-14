// Invented repro for aldevtools/BusinessCentral.AL.Runner#8006 (LethAL R985, R-971). BC 28.4 refuses to write any non-zero
// date of 1753 to a table field (Date and DateTime, Insert and Modify) and stores 1754-01-01 and later; measured on bc2,
// /coord/handoff/R-971/bc-probe-result.md. Each test writes one value, reads it back and fails with what it read (or BC's error),
// so the expected row is the failure text. One test per codeunit, so a refusal cannot taint another case.
table 50100 "Stamp Row"
{
    fields
    {
        field(1; "Code"; Code[10]) { }
        field(2; "On Date"; Date) { }
        field(3; "At"; DateTime) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
}

codeunit 50101 "Stamp Writer"
{
    procedure WriteDate(D: Date)
    var
        Row: Record "Stamp Row";
    begin
        Row."Code" := 'R';
        Row."On Date" := D;
        Row.Insert();
        Row.Get('R');
        Error('stored date %1', Format(Row."On Date", 0, 9));
    end;

    procedure WriteDateTime(DT: DateTime)
    var
        Row: Record "Stamp Row";
    begin
        Row."Code" := 'R';
        Row."At" := DT;
        Row.Insert();
        Row.Get('R');
        Error('stored datetime %1', Format(Row."At", 0, 9));
    end;
}

codeunit 50102 "Repro Blank Date"
{
    Subtype = Test;
    [Test]
    procedure Measure()
    var
        W: Codeunit "Stamp Writer";
    begin
        W.WriteDate(0D);
    end;
}

codeunit 50103 "Repro 2000"
{
    Subtype = Test;
    [Test]
    procedure Measure()
    var
        W: Codeunit "Stamp Writer";
    begin
        W.WriteDate(20000101D);
    end;
}

codeunit 50104 "Repro 17530102"
{
    Subtype = Test;
    [Test]
    procedure Measure()
    var
        W: Codeunit "Stamp Writer";
    begin
        W.WriteDate(17530102D);
    end;
}

codeunit 50105 "Repro 17531231"
{
    Subtype = Test;
    [Test]
    procedure Measure()
    var
        W: Codeunit "Stamp Writer";
    begin
        W.WriteDate(17531231D);
    end;
}

codeunit 50106 "Repro 17540101"
{
    Subtype = Test;
    [Test]
    procedure Measure()
    var
        W: Codeunit "Stamp Writer";
    begin
        W.WriteDate(17540101D);
    end;
}

codeunit 50107 "Repro 17540102"
{
    Subtype = Test;
    [Test]
    procedure Measure()
    var
        W: Codeunit "Stamp Writer";
    begin
        W.WriteDate(17540102D);
    end;
}

codeunit 50108 "Repro DT 17531231 Late"
{
    Subtype = Test;
    [Test]
    procedure Measure()
    var
        W: Codeunit "Stamp Writer";
    begin
        W.WriteDateTime(CreateDateTime(17531231D, 235959T));
    end;
}

codeunit 50109 "Repro DT 17540101 Early"
{
    Subtype = Test;
    [Test]
    procedure Measure()
    var
        W: Codeunit "Stamp Writer";
    begin
        W.WriteDateTime(CreateDateTime(17540101D, 000001T));
    end;
}
