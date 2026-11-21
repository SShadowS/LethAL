codeunit 75000 "Reach Logic"
{
    // PR-298 sites. U = never reached, R = reached and asserted, S = reached after an earlier test armed the flag.

    procedure Score(Mode: Integer; X: Integer): Integer
    var
        Result: Integer;
    begin
        if Mode = 1 then begin
            Result := Result + 3;
            if Mode = 2 then begin
                Result := Result + 5;
            end;
            Result := Result * X;
        end else begin
            Result := Result - 4;
            Result := Result * 2;
        end;
        exit(Result);
    end;

    procedure Big(Mode: Integer; X: Integer): Boolean
    var
        IsBig: Boolean;
    begin
        if Mode = 1 then begin
            IsBig := X > 10;
            if Mode = 3 then begin
                IsBig := X > 20;
            end;
        end else begin
            IsBig := X < 0;
        end;
        exit(IsBig);
    end;

    procedure Tally(Kind: Integer; N: Integer): Integer
    var
        Total: Integer;
    begin
        case Kind of
            1:
                begin
                    Total := Total + N;
                    if N < 0 then begin
                        Total := Total - 50;
                    end;
                    Total := Total * 3;
                end;
            2:
                begin
                    Total := Total - N;
                    Total := Total + 100;
                end;
        end;
        exit(Total);
    end;

    procedure Clamp(X: Integer): Integer
    var
        Result: Integer;
    begin
        if X > 0 then begin
            Result := X;
            Result := Result + 1;
            Result := Result * 2;
        end;
        exit(Result);
    end;

    procedure Late(N: Integer): Integer
    var
        State: Codeunit "Reach State";
        Result: Integer;
    begin
        if State.IsArmed() then begin
            Result := N + 10;
            Result := Result * 2;
        end;
        exit(Result);
    end;

    procedure LateMix(N: Integer): Integer
    var
        State: Codeunit "Reach State";
        Result: Integer;
    begin
        if State.IsArmed() then begin
            Result := N - 2;
            Result := Result + N;
        end;
        exit(Result);
    end;
}
