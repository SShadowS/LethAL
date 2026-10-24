// Counts visits and applies the leg's action. Every walk calls Visit first; Visit returns true at the
// cap (3N+10 visits), and the caller then leaves its loop. So no leg can run forever.
codeunit 93722 "R702 State"
{
    SingleInstance = true;

    var
        Visits: Dictionary of [Integer, Integer];
        Total: Integer;
        Cap: Integer;
        Mode: Text;
        MaxId: Integer;
        MaxSort: Integer;
        Capped: Boolean;
        First: Text;
        FirstCount: Integer;

    procedure Reset(N: Integer; NewMode: Text)
    begin
        Clear(Visits);
        Total := 0;
        Cap := 3 * N + 10;
        Mode := NewMode;
        MaxId := N;
        MaxSort := N * 10;
        Capped := false;
        First := '';
        FirstCount := 0;
    end;

    procedure Visit(Id: Integer): Boolean
    var
        C: Integer;
    begin
        Total += 1;
        if Visits.Get(Id, C) then
            Visits.Set(Id, C + 1)
        else
            Visits.Add(Id, 1);
        if FirstCount < 20 then begin
            FirstCount += 1;
            if First <> '' then
                First += ',';
            First += Format(Id, 0, 9);
        end;
        if Total >= Cap then begin
            Capped := true;
            exit(true);
        end;
        exit(false);
    end;

    // The action on the visited row. R is the walker's own variable, temporary or not (IsTemp says which).
    // Modes: T1c second variable made by Copy(R, true); T1v second variable made by a by-value parameter;
    // T3o R's own Insert; T3c Insert through a Copy(R, true) variable; L2 / L2b own-variable Modify.
    procedure Act(var R: Record "R702 Probe"; IsTemp: Boolean)
    var
        TmpCopy: Record "R702 Probe" temporary;
        PermCopy: Record "R702 Probe";
    begin
        case Mode of
            'T1c':
                if IsTemp then begin
                    TmpCopy.Copy(R, true);
                    Move(TmpCopy, R.Id);
                end else
                    // BC refuses Copy(R, true) unless both records are temporary (measured: HTTP 400); a plain
                    // second variable of the table is R696's own L1 control.
                    Move(PermCopy, R.Id);
            'T1v':
                MoveByValue(R, R.Id);
            'T3o':
                InsertAhead(R);
            'T3c':
                if IsTemp then begin
                    TmpCopy.Copy(R, true);
                    InsertAhead(TmpCopy);
                end else
                    // As T1c: a plain second variable (R696's L3 control).
                    InsertAhead(PermCopy);
            'L2':
                begin
                    R.SortKey += 1000000;
                    R.Modify();
                end;
            'L2b':
                begin
                    R.SortKey += 15;
                    R.Modify();
                end;
            else
                Error('R702: unknown mode %1', Mode);
        end;
    end;

    local procedure Move(var X: Record "R702 Probe"; Id: Integer)
    begin
        X.Reset();
        X.Get(Id);
        X.SortKey += 1000000;
        X.Modify();
    end;

    // X is a by-value copy of the walker's variable. Whether it shares the walker's temporary rows is
    // part of what is measured.
    local procedure MoveByValue(X: Record "R702 Probe"; Id: Integer)
    begin
        X.Reset();
        X.Get(Id);
        X.SortKey += 1000000;
        X.Modify();
    end;

    local procedure InsertAhead(var X: Record "R702 Probe")
    begin
        MaxId += 1;
        MaxSort += 10;
        X.Init();
        X.Id := MaxId;
        X.Grp := 1;
        X.SortKey := MaxSort;
        X.Insert();
    end;

    procedure Summary(): Text
    var
        V: Integer;
        MaxPer: Integer;
    begin
        foreach V in Visits.Values do
            if V > MaxPer then
                MaxPer := V;
        exit(StrSubstNo('visits=%1;distinct=%2;maxPerId=%3;capped=%4;first20=%5', Total, Visits.Count, MaxPer, Capped, First));
    end;
}
