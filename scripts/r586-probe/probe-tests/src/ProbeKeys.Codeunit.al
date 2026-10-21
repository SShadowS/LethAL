codeunit 50655 "Probe Keys"
{
    Subtype = Test;

    // BC raises "The record ... already exists" on the second Insert in each of these.
    [Test]
    procedure DuplicateBlankKeyInLoop()
    var
        Row: Record "Probe Row";
        I: Integer;
    begin
        Row.DeleteAll();
        for I := 1 to 2 do begin
            Row.Init();
            Row."Key" := '';
            Row.Insert(true);
        end;
    end;

    [Test]
    procedure DuplicateBlankKeyStraight()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row.Init();
        Row.Insert();
        Row.Init();
        Row.Insert();
    end;

    [Test]
    procedure DuplicateNamedKey()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row.Init();
        Row."Key" := 'K1';
        Row.Insert();
        Row.Init();
        Row."Key" := 'K1';
        Row.Insert();
    end;

    [Test]
    procedure DuplicateNamedKeyReturnValue()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row."Key" := 'K3';
        Row.Value := 1;
        if not Row.Insert() then
            Error('first insert returned false');
        Row."Key" := 'K3';
        Row.Value := 2;
        if Row.Insert() then
            Error('second insert of K3 returned true; rows=%1', Row.Count());
        Error('second insert returned false (BC shape); rows=%1', Row.Count());
    end;

    // BC raises "... does not exist" in each of these three.
    [Test]
    procedure GetMissingStatement()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row.Get('NOPE');
    end;

    [Test]
    procedure ModifyMissingStatement()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row."Key" := 'NOPE';
        Row.Modify();
    end;

    [Test]
    procedure DeleteMissingStatement()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row."Key" := 'NOPE';
        Row.Delete();
    end;

    // BC raises "There is no Probe Row within the filter" here.
    [Test]
    procedure FindFirstEmptyStatement()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row.FindFirst();
    end;

    [Test]
    procedure DuplicateKeyTwoVariables()
    var
        Row: Record "Probe Row";
        Row2: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row."Key" := 'K2';
        Row.Insert();
        Row2."Key" := 'K2';
        Row2.Insert();
    end;
}
