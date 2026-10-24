codeunit 93775 "R728 Dep Two API"
{
    procedure Call(): Integer
    var
        Target: Codeunit "R728 Target";
    begin
        exit(Target.Answer());
    end;
}
