/// R572 probe: what does `Rec.Next(0)` return, and does it move the cursor? Read-only on real tables;
/// writes only to a TEMPORARY record. Every loop is bounded at 5 passes. Exposed as the web service
/// `R572Next0Probe` (registered by the install codeunit); `Measure` returns one line per case.
codeunit 91500 "R572 Next0 Probe"
{
    var
        Line: Text;

    procedure Measure(): Text
    var
        Out: Text;
    begin
        Out := Run(1) + ' | ' + Run(2) + ' | ' + Run(3) + ' | ' + Run(4) + ' | ' + Run(5) + ' | ' + Run(6)
            + ' | ' + Run(7) + ' | ' + Run(8) + ' | ' + Run(9) + ' | ' + Run(10);
        exit(Out);
    end;

    /// Removes this probe's web-service row; called last, before the app is uninstalled.
    procedure RemoveService(): Text
    var
        Tws: Record "Tenant Web Service";
    begin
        if Tws.Get(Tws."Object Type"::Codeunit, 'R572Next0Probe') then
            Tws.Delete(true);
        exit('removed');
    end;

    local procedure Run(CaseNo: Integer): Text
    begin
        Line := '';
        ClearLastError();
        if not TryCase(CaseNo) then
            exit(StrSubstNo('C%1 ERROR: %2 [so far: %3]', CaseNo, GetLastErrorText(), Line));
        exit(StrSubstNo('C%1 %2', CaseNo, Line));
    end;

    [TryFunction]
    local procedure TryCase(CaseNo: Integer)
    var
        Tws: Record "Tenant Web Service";
        TempTws: Record "Tenant Web Service" temporary;
        AllObj: Record AllObj;
        RecRef: RecordRef;
        K0: Text;
        K1: Text;
        N0: Integer;
        N1: Integer;
        I: Integer;
    begin
        case CaseNo of
            1:
                begin
                    // real SQL table, first row: Next(0), then Next(1) as the control
                    Line := StrSubstNo('real rows=%1;', Tws.Count());
                    Tws.FindFirst();
                    K0 := KeyOf(Tws);
                    N0 := Tws.Next(0);
                    K1 := KeyOf(Tws);
                    N1 := Tws.Next(1);
                    Line += StrSubstNo(' FindFirst; Next(0)=%1 moved=%2; then Next(1)=%3 moved=%4', N0, K0 <> K1, N1, K1 <> KeyOf(Tws));
                end;
            2:
                begin
                    // real table, mid-set (after one Next)
                    Tws.FindFirst();
                    Tws.Next(1);
                    K0 := KeyOf(Tws);
                    N0 := Tws.Next(0);
                    Line := StrSubstNo('real mid-set Next(0)=%1 moved=%2', N0, K0 <> KeyOf(Tws));
                end;
            3:
                begin
                    // real table, last row
                    Tws.FindLast();
                    K0 := KeyOf(Tws);
                    N0 := Tws.Next(0);
                    Line := StrSubstNo('real FindLast Next(0)=%1 moved=%2', N0, K0 <> KeyOf(Tws));
                end;
            4:
                begin
                    // real table through FindSet
                    Tws.FindSet();
                    K0 := KeyOf(Tws);
                    N0 := Tws.Next(0);
                    Line := StrSubstNo('real FindSet Next(0)=%1 moved=%2', N0, K0 <> KeyOf(Tws));
                end;
            5:
                begin
                    // temporary table, 3 rows
                    AddTemp(TempTws, 'R572A');
                    AddTemp(TempTws, 'R572B');
                    AddTemp(TempTws, 'R572C');
                    TempTws.FindFirst();
                    K0 := KeyOf(TempTws);
                    N0 := TempTws.Next(0);
                    K1 := KeyOf(TempTws);
                    N1 := TempTws.Next(1);
                    Line := StrSubstNo('temp FindFirst Next(0)=%1 moved=%2; Next(1)=%3 moved=%4', N0, K0 <> K1, N1, K1 <> KeyOf(TempTws));
                end;
            6:
                begin
                    // a virtual system table
                    AllObj.FindFirst();
                    K0 := Format(AllObj."Object Type") + Format(AllObj."Object ID");
                    N0 := AllObj.Next(0);
                    Line := StrSubstNo('AllObj Next(0)=%1 moved=%2', N0, K0 <> Format(AllObj."Object Type") + Format(AllObj."Object ID"));
                end;
            7:
                begin
                    // RecordRef
                    RecRef.Open(Database::"Tenant Web Service");
                    RecRef.FindFirst();
                    K0 := Format(RecRef.RecordId());
                    N0 := RecRef.Next(0);
                    Line := StrSubstNo('RecordRef Next(0)=%1 moved=%2', N0, K0 <> Format(RecRef.RecordId()));
                    RecRef.Close();
                end;
            8:
                begin
                    // the loop shape R572 narrowing (a) reads: until Next(Step) = 0, Step = 0, bounded
                    Tws.FindFirst();
                    I := 0;
                    repeat
                        I += 1;
                    until (Tws.Next(0) = 0) or (I >= 5);
                    Line := StrSubstNo('until Next(0) = 0: passes=%1 (5 = capped, Next(0) never 0)', I);
                end;
            9:
                begin
                    // the while shape: while Next(0) <> 0, bounded
                    Tws.FindFirst();
                    I := 0;
                    while (Tws.Next(0) <> 0) and (I < 5) do
                        I += 1;
                    Line := StrSubstNo('while Next(0) <> 0: passes=%1 (5 = capped)', I);
                end;
            10:
                begin
                    // no Find first: Next(0) on a fresh record variable
                    N0 := Tws.Next(0);
                    Line := StrSubstNo('no Find, Next(0)=%1', N0);
                end;
        end;
    end;

    local procedure KeyOf(var T: Record "Tenant Web Service"): Text
    begin
        exit(Format(T."Object Type") + '/' + T."Service Name");
    end;

    local procedure AddTemp(var T: Record "Tenant Web Service" temporary; Name: Text[240])
    begin
        T.Init();
        T."Object Type" := T."Object Type"::Codeunit;
        T."Service Name" := Name;
        T.Insert();
    end;
}
