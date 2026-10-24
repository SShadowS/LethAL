codeunit 93710 "R707 Dep API"
{
    procedure Call(): Integer
    var
        Target: Codeunit "R707 Target";
    begin
        exit(Target.Answer());
    end;
}
