codeunit 79900 "LethAL R372 Probe"
{
    Subtype = Test;

    [Test]
    procedure ProbeAlpha()
    var
        X: Integer;
    begin
        X := 1;
    end;

    [Test]
    procedure ProbeBeta()
    var
        Y: Integer;
    begin
        Y := 10;
    end;
}
