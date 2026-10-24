codeunit 93770 "R728 Dep One API"
{
    procedure Call(): Integer
    var
        Target: Codeunit "R728 Target";
    begin
        exit(Target.Answer());
    end;
}
