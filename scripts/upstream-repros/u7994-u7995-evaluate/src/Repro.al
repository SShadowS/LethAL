// Invented repros for aldevtools/BusinessCentral.AL.Runner#7994 (Evaluate into a `var` Option parameter declared without
// members) and #7995 item 3 (Evaluate of a Boolean with format 2). BC's answer: measured by PR-03 on BC 28.4 W1, where
// Microsoft's Json Test (the same two calls) passes all 18 tests. One test per codeunit, so nothing cascades.
codeunit 51301 "Eval Option Var Param"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        V: Option Alpha,Beta,Gamma;
    begin
        EvalInto('Beta', V);
        if V <> V::Beta then
            Error('expected Beta, got %1', V);
    end;

    local procedure EvalInto(T: Text; var Value: Option)
    begin
        Evaluate(Value, T, 0);
    end;
}

codeunit 51302 "Eval Boolean Format 2"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        B: Boolean;
    begin
        Evaluate(B, 'true', 2);
        if not B then
            Error('expected true');
    end;
}
