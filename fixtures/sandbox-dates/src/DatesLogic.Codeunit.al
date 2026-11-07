codeunit 77100 "Dates Logic"
{
    // R856: the sites of lethal.swap-workdate-today (opt-in; no default operator finds a site here
    // except what a default run would find in any code).
    // StampDate: WorkDate() -> Today(). A test that sets its own date and asserts that date kills it.
    // TodayDate: Today() -> WorkDate(). A separate test kills it by asserting the value is NOT that date.
    // IsDateSet: WorkDate() -> Today(). Both are never 0D, so a test asserting only <> 0D lets it live.

    procedure StampDate(): Date
    begin
        exit(WorkDate());
    end;

    procedure TodayDate(): Date
    begin
        exit(Today());
    end;

    procedure IsDateSet(): Boolean
    begin
        exit(WorkDate() <> 0D);
    end;
}
