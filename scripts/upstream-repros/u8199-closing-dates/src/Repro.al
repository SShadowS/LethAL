// Invented repro: closing dates on BC 28.4 W1 (PR-86): subtracting from one raises; WorkDate accepts one.
codeunit 58340 "Closing Test"
{
    Subtype = Test;

    [Test]
    procedure SubtractFromClosingDateRaises()
    var
        D: Date;
        N: Integer;
    begin
        D := ClosingDate(DMY2Date(31, 12, 2023));
        asserterror N := D - DMY2Date(31, 12, 2023);
        if GetLastErrorText() <> 'The operation cannot be performed on a closing date value.' then
            Error('BC raises on a closing date; got %1 (%2)', N, GetLastErrorText());
    end;

    [Test]
    procedure WorkDateTakesClosingDate()
    begin
        WorkDate(ClosingDate(DMY2Date(31, 12, 2023)));
        if NormalDate(WorkDate()) <> DMY2Date(31, 12, 2023) then
            Error('BC gives 2023-12-31; got %1', Format(NormalDate(WorkDate()), 0, 9));
    end;
}
