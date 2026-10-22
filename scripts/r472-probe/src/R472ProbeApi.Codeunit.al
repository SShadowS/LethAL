namespace R472.Probe;

// Each call starts from an empty table, inserts row A (No. 1), commits, then inserts row B (No. 2).
// Mode 1: B.SystemId := A.SystemId, B.Insert(false, true)   -- the flipped-to-true direction
// Mode 2: B.SystemId := A.SystemId, B.Insert(false, false)  -- the flipped-to-false direction
// Mode 3: B.SystemId := CreateGuid(), B.Insert(false, true) -- control: a fresh, unused id
// Measure runs B's insert through Codeunit.Run, so it reports the error code and text and the
// table state after. Raw runs it directly, so any error reaches the OData client unchanged.
codeunit 91722 "R472 Probe API"
{
    [ServiceEnabled]
    procedure Measure(Mode: Integer) Result: Text
    var
        A: Record "R472 Probe Row";
        B: Record "R472 Probe Row";
        After: Record "R472 Probe Row";
        Ok: Boolean;
        Wanted: Guid;
    begin
        Wanted := Setup(Mode, A, B);
        Ok := Codeunit.Run(Codeunit::"R472 Probe Insert B", B);
        Result := StrSubstNo('mode=%1 ok=%2 code=[%3] text=[%4] A.SystemId=%5 asked=%6 rows=%7',
            Mode, Ok, GetLastErrorCode(), GetLastErrorText(), A.SystemId, Wanted, After.Count());
        if After.Get(2) then
            Result += StrSubstNo(' B.SystemId=%1 sameAsA=%2', After.SystemId, After.SystemId = A.SystemId);
    end;

    [ServiceEnabled]
    procedure Raw(Mode: Integer) Result: Text
    var
        A: Record "R472 Probe Row";
        B: Record "R472 Probe Row";
        After: Record "R472 Probe Row";
    begin
        Setup(Mode, A, B);
        if B.Tag = 'with-systemid' then
            B.Insert(false, true)
        else
            B.Insert(false, false);
        After.Get(2);
        Result := StrSubstNo('mode=%1 raw ok B.SystemId=%2 sameAsA=%3', Mode, After.SystemId, After.SystemId = A.SystemId);
    end;

    local procedure Setup(Mode: Integer; var A: Record "R472 Probe Row"; var B: Record "R472 Probe Row") Wanted: Guid
    begin
        A.DeleteAll();
        A.Init();
        A."No." := 1;
        A.Tag := 'A';
        A.Insert(false);
        Commit();
        A.Get(1);

        B.Init();
        B."No." := 2;
        case Mode of
            1:
                begin
                    B.SystemId := A.SystemId;
                    B.Tag := 'with-systemid';
                end;
            2:
                begin
                    B.SystemId := A.SystemId;
                    B.Tag := 'without-systemid';
                end;
            3:
                begin
                    B.SystemId := CreateGuid();
                    B.Tag := 'with-systemid';
                end;
            else
                Error('unknown mode %1', Mode);
        end;
        Wanted := B.SystemId;
    end;
}
