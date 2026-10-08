codeunit 79600 "R517 Probe Logic"
{
    // Busy-waits on the real clock for Ms milliseconds and returns the elapsed time.
    procedure SpinFor(Ms: Integer): Integer
    var
        Start: DateTime;
        Spins: Integer;
    begin
        Start := CurrentDateTime();
        repeat
            Spins += 1;
        until CurrentDateTime() - Start >= Ms;
        exit(CurrentDateTime() - Start);
    end;

    procedure Twice(X: Integer): Integer
    begin
        exit(X * 2);
    end;
}
