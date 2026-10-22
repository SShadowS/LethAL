// The exact shape of the v3 gate's codeunit 50605 "Probe Sleeper" (scripts/r586-probe/extras),
// under a new id, so codeunit 92932 measures X (d)'s SleeperDoubles as BC runs it.
codeunit 92921 "R649 Probe Sleeper"
{
    procedure WaitThenDouble(X: Integer): Integer
    var
        Waited: Integer;
    begin
        Sleep(600000);
        Waited := 1;
        exit(X * 2);
    end;
}
