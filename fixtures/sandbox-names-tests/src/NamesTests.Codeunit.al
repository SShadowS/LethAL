codeunit 78850 "Names Tests"
{
    Subtype = Test;

    var
        C: Codeunit "Names Calc";

    [Test]
    procedure "Space Step"()
    begin
        if C.SpaceStep(5) <> 6 then
            Error('SpaceStep(5) must be 6');
    end;

    [Test]
    procedure "Dash-Step"()
    begin
        if C.DashStep(5) <> 6 then
            Error('DashStep(5) must be 6');
    end;

    [Test]
    procedure "Paren(Step)"()
    begin
        if C.ParenStep(5) <> 6 then
            Error('ParenStep(5) must be 6');
    end;

    [Test]
    procedure "Dot.Step"()
    begin
        if C.DotStep(5) <> 6 then
            Error('DotStep(5) must be 6');
    end;

    [Test]
    procedure "Slash/Step"()
    begin
        if C.SlashStep(5) <> 6 then
            Error('SlashStep(5) must be 6');
    end;

    [Test]
    procedure "Amp&Step"()
    begin
        if C.AmpStep(5) <> 6 then
            Error('AmpStep(5) must be 6');
    end;

    [Test]
    procedure "7Digit Step"()
    begin
        if C.DigitStep(5) <> 6 then
            Error('DigitStep(5) must be 6');
    end;

    [Test]
    procedure Default()
    begin
        if C.KeywordStep(5) <> 6 then
            Error('KeywordStep(5) must be 6');
    end;

    [Test]
    procedure "Blåbær Step"()
    begin
        if C.DanishStep(5) <> 6 then
            Error('DanishStep(5) must be 6');
    end;

    [Test]
    procedure "Twin Pair"()
    begin
        if C.TwinStep(5) <> 6 then
            Error('TwinStep(5) must be 6');
    end;

    [Test]
    procedure Twin_PairLong()
    begin
        if C.TwinLongStep(5) <> 6 then
            Error('TwinLongStep(5) must be 6');
    end;

    [Test]
    procedure PlainControl()
    begin
        if C.PlainStep(5) <> 6 then
            Error('PlainStep(5) must be 6');
    end;
}
