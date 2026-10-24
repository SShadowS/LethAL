codeunit 93800 "R738 Tests"
{
    Subtype = Test;

    var
        Logic: Codeunit "R738 Logic";

    [Test]
    procedure TestAnswer()
    begin
        if Logic.Answer() <> 1 then
            Error('answer');
    end;

    [Test]
    procedure TestOther()
    begin
        if Logic.Other(1) <> 2 then
            Error('other');
    end;

    [Test]
    procedure TestScale()
    begin
        if Logic.Scale(2) <> 4 then
            Error('scale');
    end;

    [Test]
    procedure TestFails()
    begin
        Error('genuine failure');
    end;
}
