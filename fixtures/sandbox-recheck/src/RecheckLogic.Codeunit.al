codeunit 76000 "Recheck Logic"
{
    var
        State: Codeunit "Recheck State";

    procedure Double(X: Integer): Integer
    begin
        exit(X * 2);
    end;

    procedure Triple(X: Integer): Integer
    begin
        exit(X * 3);
    end;

    procedure Bump()
    begin
        State.Increment();
    end;

    procedure Count(): Integer
    begin
        exit(State.Value());
    end;
}

codeunit 76001 "Recheck State"
{
    SingleInstance = true;

    var
        Counter: Integer;

    procedure Increment()
    begin
        Counter := Counter + 1;
    end;

    procedure Value(): Integer
    begin
        exit(Counter);
    end;
}
