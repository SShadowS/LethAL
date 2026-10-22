// R586 plan r4 (I-1 (4)), pre-commitments r5 and r11 (leg X (d)): a TARGET procedure that sleeps, for the Sleep rule's
// live positive control. `Waited := 1` gives mutants whose arm still runs the Sleep and leaves the result intact, so
// their covering test passes with the Sleep hit; the backend must score that pass `error` / `runner-refused`. 5 s
// (r11): green under the 120 s baseline on BC (R649) and on v3 builds that count Sleep. Removing the Sleep is the
// negative twin (no Sleep hit, the test passes: survived). Invented; copied by sleep-noop-probe.sh and leg X only.
codeunit 50605 "Probe Sleeper"
{
    procedure WaitThenDouble(X: Integer): Integer
    var
        Waited: Integer;
    begin
        Sleep(5000);
        Waited := 1;
        exit(X * 2);
    end;
}
