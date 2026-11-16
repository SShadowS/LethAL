// Invented repro for aldevtools/BusinessCentral.AL.Runner#7935: a Blob set through FieldRef.Value after Clear(Rec.<blob>) must be a copy.
table 79350 "RM Row"
{
    TableType = Temporary;
    fields { field(1; Key1; Integer) { } field(2; Data; Blob) { } }
    keys { key(PK; Key1) { Clustered = true; } }
}

codeunit 79355 "RM Hold"
{
    var
        HB: Record "RM Row" temporary;

    procedure Fill(Txt: Text)
    var
        OS: OutStream;
    begin
        HB.Data.CreateOutStream(OS);
        OS.WriteText(Txt);
    end;

    procedure ToRec(var RR: RecordRef; FNo: Integer)
    var
        FR: FieldRef;
    begin
        FR := RR.Field(FNo);
        FR.Value := HB.Data;
    end;
}

codeunit 79356 "RM Lst"
{
    var
        Rec: Record "RM Row" temporary;

    procedure Add(H: Codeunit "RM Hold")
    var
        RR: RecordRef;
    begin
        Rec.Key1 := Rec.Count() + 1;
        Clear(Rec.Data);
        RR.GetTable(Rec);
        H.ToRec(RR, Rec.FieldNo(Data));
        RR.SetTable(Rec);
        Rec.Insert();
    end;

    procedure Text(K: Integer) Txt: Text
    var
        IS: InStream;
    begin
        Rec.Get(K);
        Rec.CalcFields(Data);
        Rec.Data.CreateInStream(IS);
        IS.ReadText(Txt);
    end;
}

codeunit 79357 "RM Tests"
{
    Subtype = Test;

    [Test]
    procedure SameHolderTwoAdds() // BC: passes (FieldRef.Value copies the Blob)
    var
        L: Codeunit "RM Lst";
        H: Codeunit "RM Hold";
    begin
        H.Fill('alpha');
        L.Add(H);
        H.Fill('beta');
        L.Add(H);
        if L.Text(1) <> 'alpha' then
            Error('row 1 read back <%1>, expected <alpha>', L.Text(1));
    end;
}
