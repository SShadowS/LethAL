codeunit 79682 "R534 Ask Logic"
{
    // A mutant that flips the guard raises no Confirm, so the test's declared handler goes unused.
    procedure AskUser(Ask: Boolean): Boolean
    begin
        if Ask then
            exit(Confirm('Go on?'));
        exit(false);
    end;
}
