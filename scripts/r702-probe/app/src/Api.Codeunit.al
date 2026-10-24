codeunit 93721 "R702 API"
{
    // RunLeg(leg, find, n, isTemp): leg is T1c, T1v, T3o, T3c, L2 or L2b. find is FindSet, FindSetTrue or
    // FindMinus. temp true walks a TEMPORARY record; false walks the permanent table (the control).
    // Returns one result line. perm= is the permanent row count after the walk: it must be 0 for a temp cell.
    procedure RunLeg(leg: Text; find: Text; n: Integer; isTemp: Boolean): Text
    var
        TmpR: Record "R702 Probe" temporary;
        PermR: Record "R702 Probe";
        State: Codeunit "R702 State";
        Result: Text;
    begin
        PermR.DeleteAll();
        State.Reset(n, leg);
        if IsTemp then
            Result := Walk(TmpR, find, n, true)
        else
            Result := Walk(PermR, find, n, false);
        Result := StrSubstNo('%1|%2|%3|%4|%5|perm=%6', leg, find, n, IsTemp, Result, PermR.Count);
        PermR.DeleteAll();
        exit(Result);
    end;

    local procedure Walk(var R: Record "R702 Probe"; find: Text; n: Integer; IsTemp: Boolean): Text
    var
        State: Codeunit "R702 State";
        Ok: Boolean;
        i: Integer;
    begin
        for i := 1 to n do begin
            R.Init();
            R.Id := i;
            R.Grp := 1;
            R.SortKey := i * 10;
            R.Insert();
        end;
        R.Reset();
        R.SetCurrentKey(Grp, SortKey);
        R.SetRange(Grp, 1);
        case find of
            'FindSet':
                Ok := R.FindSet();
            'FindSetTrue':
                Ok := R.FindSet(true);
            'FindMinus':
                Ok := R.Find('-');
            else
                Error('R702: unknown find %1', find);
        end;
        if Ok then
            repeat
                if State.Visit(R.Id) then
                    break;
                State.Act(R, IsTemp);
            until R.Next() = 0;
        R.Reset();
        exit(StrSubstNo('%1|rows=%2', State.Summary(), R.Count));
    end;
}
