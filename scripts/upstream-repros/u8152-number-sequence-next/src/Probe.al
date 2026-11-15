// PR-28 (#8152, from family 7 / #8002): a rollback between a changer codeunit and a reader codeunit (codeunit isolation). BC
// (measured on bc2, PR-27's BC check) keeps the numbers Next handed out, and undoes Restart, Delete and Insert. Each reader asserts
// BC's answer. Invented; no corpus text.
codeunit 51550 "U8152 Install"
{
    Subtype = Install;

    trigger OnInstallAppPerCompany()
    begin
        Reset('U8152Next');
        Reset('U8152Restart');
        Reset('U8152Delete');
        Drop('U8152New');
    end;

    local procedure Reset(Name: Text)
    begin
        Drop(Name);
        NumberSequence.Insert(Name, 100, 1);
    end;

    local procedure Drop(Name: Text)
    begin
        if NumberSequence.Exists(Name) then
            NumberSequence.Delete(Name);
    end;
}

codeunit 51551 "U8152 Next Change"
{
    Subtype = Test;

    [Test]
    procedure Change()
    begin
        if NumberSequence.Next('U8152Next') = 0 then;
        if NumberSequence.Next('U8152Next') = 0 then;
    end;
}

codeunit 51552 "U8152 Next Read"
{
    Subtype = Test;

    [Test]
    procedure NextIsKept()
    begin
        // BC: 101 (Next is not undone by the rollback); edge-5a58a0f16: 100
        if NumberSequence.Current('U8152Next') <> 101 then
            Error('Current is %1, not 101', NumberSequence.Current('U8152Next'));
    end;
}

codeunit 51553 "U8152 Restart Change"
{
    Subtype = Test;

    [Test]
    procedure Change()
    begin
        NumberSequence.Restart('U8152Restart', 500);
    end;
}

codeunit 51554 "U8152 Restart Read"
{
    Subtype = Test;

    [Test]
    procedure RestartIsUndone()
    begin
        if NumberSequence.Current('U8152Restart') <> 100 then
            Error('Current is %1, not 100', NumberSequence.Current('U8152Restart'));
    end;
}

codeunit 51555 "U8152 Delete Change"
{
    Subtype = Test;

    [Test]
    procedure Change()
    begin
        NumberSequence.Delete('U8152Delete');
    end;
}

codeunit 51556 "U8152 Delete Read"
{
    Subtype = Test;

    [Test]
    procedure DeleteIsUndone()
    begin
        if not NumberSequence.Exists('U8152Delete') then
            Error('the sequence is gone');
    end;
}

codeunit 51557 "U8152 Insert Change"
{
    Subtype = Test;

    [Test]
    procedure Change()
    begin
        NumberSequence.Insert('U8152New', 100, 1);
    end;
}

codeunit 51558 "U8152 Insert Read"
{
    Subtype = Test;

    [Test]
    procedure InsertIsUndone()
    begin
        if NumberSequence.Exists('U8152New') then
            Error('the new sequence is still there');
    end;
}
