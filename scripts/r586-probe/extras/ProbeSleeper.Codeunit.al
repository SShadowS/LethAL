// R586 plan r4 (I-1 (4)), pre-commitment r5 (leg X (d)): a TARGET procedure that sleeps, for the Sleep rule's live
// positive control. `Waited := 1` gives mutants whose arm still runs the Sleep and leaves the result intact, so
// their covering test passes only because Sleep does nothing on v3 alpha.2; the backend must score that pass `error`
// / `runner-refused`. Removing the Sleep is the negative twin (no Sleep hit, the test passes: survived). Invented;
// copied into a scratch copy of probe-app by sleep-noop-probe.sh and leg X, never into the committed probe-app.
codeunit 50605 "Probe Sleeper"
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
