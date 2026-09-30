codeunit 50012 "P11 Ops"
{
    procedure Run(C: Code[20])
    var
        Rec: Record "P11 Tab";
    begin
        Rec.Init();
        Rec.Code := C;
        Rec.Insert();
        Commit();
#if T2SYM
        Rec.SetRange(Code, C);
        Codeunit.Run(50013);
#else
        Rec.Amt := 5;
        Rec.Modify(true);
#endif
    end;
}
