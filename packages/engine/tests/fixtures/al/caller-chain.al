codeunit 50108 "Callers"
{
    procedure Helper(): Integer
    begin
        exit(1);
    end;

    procedure Direct(): Integer
    begin
        exit(Helper());
    end;

    procedure Indirect(): Integer
    begin
        exit(Direct() + Helper());
    end;
}
