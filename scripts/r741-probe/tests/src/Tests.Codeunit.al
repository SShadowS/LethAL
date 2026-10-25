codeunit 93870 "R741 Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure TestTableAnswer()
    var
        Base: Record "R741 Base";
    begin
        if Base.Answer() <> 42 then
            Error('answer');
    end;

    [Test]
    procedure TestTableOther()
    var
        Base: Record "R741 Base";
    begin
        if Base.Other(1) <> 2 then
            Error('other');
    end;

    [Test]
    procedure TestPageAnswer()
    var
        Card: Page "R741 Base Card";
    begin
        if Card.PageAnswer() <> 7 then
            Error('page answer');
    end;

    [Test]
    procedure TestPageOther()
    var
        Card: Page "R741 Base Card";
    begin
        if Card.PageOther(2) <> 4 then
            Error('page other');
    end;

    [Test]
    procedure TestFails()
    begin
        Error('genuine failure');
    end;
}
