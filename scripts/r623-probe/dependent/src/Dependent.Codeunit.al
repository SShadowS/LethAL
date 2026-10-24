codeunit 91810 "R623 Probe Dependent Logic"
{
    procedure CallTarget(): Integer
    var
        Target: Codeunit "R623 Probe Target Logic";
    begin
        exit(Target.Answer());
    end;
}
