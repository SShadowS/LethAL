codeunit 50105 "Vars Test"
{
    var
        GlobalCount: Integer;

    procedure Compute(Input: Integer): Integer
    var
        Local: Integer;
    begin
        Local := Input * 2;
        GlobalCount := GlobalCount + 1;
        exit(Local + GlobalCount);
    end;
}
