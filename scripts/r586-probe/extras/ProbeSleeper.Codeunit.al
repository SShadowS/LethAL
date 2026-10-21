// R586 plan r4 (I-1 (4)): a TARGET procedure that sleeps, for the Sleep rule's live positive control. A mutant
// in WaitThenDouble (any operator on its `exit`) runs under a covering test that passes because Sleep does nothing
// on v3 alpha.2; the backend must score that pass `error` / `runner-refused`. Invented; copied into a scratch copy
// of probe-app by sleep-noop-probe.sh, never into the committed probe-app.
codeunit 50605 "Probe Sleeper"
{
    procedure WaitThenDouble(X: Integer): Integer
    begin
        Sleep(600000);
        exit(X * 2);
    end;
}
