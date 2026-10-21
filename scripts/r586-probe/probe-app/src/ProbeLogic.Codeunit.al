codeunit 50600 "Probe Logic"
{
    procedure Add(A: Integer; B: Integer): Integer
    begin
        exit(A + B);
    end;

    procedure Spin(): Integer
    var
        I: Integer;
    begin
        while true do
            I += 1;
        exit(I);
    end;

    procedure ArmName(): Text
    begin
#if LETHALA
        exit('A');
#elif LETHALB
        exit('B');
#else
        exit('none');
#endif
    end;

    procedure ActiveResource(): Text
    begin
        exit(NavApp.GetResourceAsText('active.txt'));
    end;

    procedure InsertRow(K: Code[20]; V: Integer)
    var
        Row: Record "Probe Row";
    begin
        Row.Init();
        Row."Key" := K;
        Row.Value := V;
        Row.Insert();
    end;

    procedure RowCount(): Integer
    var
        Row: Record "Probe Row";
    begin
        exit(Row.Count());
    end;
}
