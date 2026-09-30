codeunit 79750 "Layout Tests"
{
    Subtype = Test;

    var
        LayoutAlpha: Codeunit "Layout Alpha";
        LayoutBeta: Codeunit "Layout Beta";

    [Test]
    procedure AlphaIsBig()
    begin
        if not LayoutAlpha.IsBig(20) then
            Error('IsBig(20) must be true');
    end;

    [Test]
    procedure GrowAboveTen()
    begin
        if LayoutBeta.Grow(20) <> 21 then
            Error('Grow(20) must be 21');
    end;

    [Test]
    procedure TwiceOfThree()
    begin
        if LayoutBeta.Twice(3) <> 6 then
            Error('Twice(3) must be 6');
    end;
}
