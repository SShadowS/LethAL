codeunit 79680 "R534 Count Logic"
{
    // sandbox-hang's CountUpTo shape: dropping Advance() (void-method-call) or emptying it
    // (empty-block) never returns. Called from a test codeunit's OnRun, so the OnRun hangs.
    var
        Counter: Integer;

    procedure CountTo(Limit: Integer): Integer
    begin
        Counter := 0;
        repeat
            Advance();
        until Counter >= Limit;
        exit(Counter);
    end;

    local procedure Advance()
    begin
        Counter += 1;
    end;
}
