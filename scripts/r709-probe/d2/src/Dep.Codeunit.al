codeunit 93745 "R709 Dep Two API"
{
    procedure Call(): Integer
    var
        Target: Codeunit "R709 Target";
    begin
        exit(Target.Answer());
    end;
}
