codeunit 51730 "Bool Format Norwegian"
{
    Subtype = Test;

    [Test]
    procedure FormatTrue()
    begin
        GlobalLanguage(1044);
        Error('V:[%1]', Format(true));
    end;
}

codeunit 51731 "Bool Evaluate Norwegian"
{
    Subtype = Test;

    [Test]
    procedure EvaluateJa()
    var
        B: Boolean;
        Ok: Boolean;
    begin
        GlobalLanguage(1044);
        B := false;
        Ok := Evaluate(B, 'Ja');
        Error('V:[%1|%2]', Format(Ok, 0, 9), Format(B, 0, 9));
    end;
}

codeunit 51732 "Bool Format Swedish"
{
    Subtype = Test;

    [Test]
    procedure FormatTrue()
    begin
        GlobalLanguage(1053);
        Error('V:[%1]', Format(true));
    end;
}

codeunit 51733 "Bool Evaluate Swedish"
{
    Subtype = Test;

    [Test]
    procedure EvaluateJa()
    var
        B: Boolean;
        Ok: Boolean;
    begin
        GlobalLanguage(1053);
        B := false;
        Ok := Evaluate(B, 'Ja');
        Error('V:[%1|%2]', Format(Ok, 0, 9), Format(B, 0, 9));
    end;
}
