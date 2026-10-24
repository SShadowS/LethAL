codeunit 93740 "R709 Dep One API"
{
    procedure Call(): Integer
    var
        Target: Codeunit "R709 Target";
    begin
        exit(Target.Answer());
    end;
}
