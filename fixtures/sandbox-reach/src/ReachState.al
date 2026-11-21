codeunit 75001 "Reach State"
{
    SingleInstance = true;

    var
        Armed: Boolean;

    procedure Arm()
    begin
        Armed := true;
    end;

    procedure IsArmed(): Boolean
    begin
        exit(Armed);
    end;
}
