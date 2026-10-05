// Carries the report's results out to the test without a table (no schema ghost).
codeunit 91602 "R254 Probe Sink"
{
    SingleInstance = true;

    var
        BaseTotal: Integer;
        ExtTotal: Integer;

    procedure SetBase(Value: Integer)
    begin
        BaseTotal := Value;
    end;

    procedure SetExt(Value: Integer)
    begin
        ExtTotal := Value;
    end;

    procedure GetBase(): Integer
    begin
        exit(BaseTotal);
    end;

    procedure GetExt(): Integer
    begin
        exit(ExtTotal);
    end;

    procedure Reset()
    begin
        BaseTotal := -1;
        ExtTotal := -1;
    end;
}
