table 50990 "R571 Probe Row"
{
    DataClassification = SystemMetadata;
    fields
    {
        field(1; "Code"; Code[20]) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
}

codeunit 50991 "R571 Assign Probe"
{
    Subtype = Test;

    // (a) Real has {A,B}; TempR := Real (on A); TempR.Delete()
    [Test]
    procedure CaseA_TempFromReal()
    var
        Real: Record "R571 Probe Row";
        TempR: Record "R571 Probe Row" temporary;
        DelOk: Boolean;
    begin
        Real.DeleteAll();
        Real.Code := 'A';
        Real.Insert();
        Real.Code := 'B';
        Real.Insert();
        Real.Get('A');
        TempR := Real;
        DelOk := TempR.Delete();
        Error('MEASURED a: TempR.IsTemporary=%1 TempR.Code=%2 DeleteReturned=%3 TempR.Count=%4 Real.Count=%5 RealHasA=%6',
            TempR.IsTemporary(), TempR.Code, DelOk, TempR.Count(), Real.Count(), Real.Get('A'));
    end;

    // (b) TempR has {X,Y}; real table has no X; Real := TempR (on X); Real.Delete()
    [Test]
    procedure CaseB_RealFromTemp()
    var
        Real: Record "R571 Probe Row";
        TempR: Record "R571 Probe Row" temporary;
        DelOk: Boolean;
        RealBefore: Integer;
    begin
        Real.DeleteAll();
        Real.Code := 'A';
        Real.Insert();
        RealBefore := Real.Count();
        TempR.Code := 'X';
        TempR.Insert();
        TempR.Code := 'Y';
        TempR.Insert();
        TempR.Get('X');
        Real := TempR;
        DelOk := Real.Delete();
        Error('MEASURED b: Real.IsTemporary=%1 Real.Code=%2 DeleteReturned=%3 TempR.Count=%4 TempHasX=%5 RealBefore=%6 RealAfter=%7 RealHasA=%8',
            Real.IsTemporary(), Real.Code, DelOk, TempR.Count(), TempR.Get('X'), RealBefore, Real.Count(), Real.Get('A'));
    end;

    // (b2) as (b) but the real table also holds X: does Real.Delete() hit the real row?
    [Test]
    procedure CaseB2_RealFromTempRowInBoth()
    var
        Real: Record "R571 Probe Row";
        TempR: Record "R571 Probe Row" temporary;
        DelOk: Boolean;
    begin
        Real.DeleteAll();
        Real.Code := 'X';
        Real.Insert();
        TempR.Code := 'X';
        TempR.Insert();
        TempR.Code := 'Y';
        TempR.Insert();
        TempR.Get('X');
        Real := TempR;
        DelOk := Real.Delete();
        Error('MEASURED b2: DeleteReturned=%1 TempR.Count=%2 TempHasX=%3 Real.Count=%4 RealHasX=%5',
            DelOk, TempR.Count(), TempR.Get('X'), Real.Count(), Real.Get('X'));
    end;

    // (c) control: TempB.Copy(TempA, true) shares the temp table
    [Test]
    procedure CaseC_CopyShareTable()
    var
        TempA: Record "R571 Probe Row" temporary;
        TempB: Record "R571 Probe Row" temporary;
        TempC: Record "R571 Probe Row" temporary;
        DelOk: Boolean;
    begin
        TempA.Code := 'X';
        TempA.Insert();
        TempA.Code := 'Y';
        TempA.Insert();
        TempB.Copy(TempA, true);
        TempB.Get('X');
        DelOk := TempB.Delete();
        // c2: temp-to-temp plain assignment, for comparison
        TempA.Get('Y');
        TempC := TempA;
        Error('MEASURED c: DeleteViaB=%1 TempA.Count=%2 TempAHasX=%3 TempB.Count=%4 | c2: TempC := TempA -> TempC.Count=%5 TempC.DeleteReturned=%6 TempA.CountAfter=%7',
            DelOk, TempA.Count(), TempA.Get('X'), TempB.Count(), TempC.Count(), TempC.Delete(), TempA.Count());
    end;
}
