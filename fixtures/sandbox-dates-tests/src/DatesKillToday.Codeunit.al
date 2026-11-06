codeunit 77151 "Dates Kill Today Test"
{
    Subtype = Test;

    [Test]
    procedure TodayIsNotTheWorkDate()
    var
        Logic: Codeunit "Dates Logic";
        D: Date;
    begin
        D := 20200315D;
        WorkDate(D);
        if Logic.TodayDate() = D then
            Error('Expected today to differ from the work date %1.', D);
    end;
}
