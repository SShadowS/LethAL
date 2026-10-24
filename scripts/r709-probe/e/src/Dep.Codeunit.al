codeunit 93755 "R709 Dep Solo API"
{
    procedure Call(): Integer
    var
        Target: Codeunit "R709 Solo Target";
    begin
        exit(Target.Answer());
    end;
}
