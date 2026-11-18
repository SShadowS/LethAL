// Declared order matters: al-runner v3 runs a codeunit's tests in this order. A0_Refuses and B0_Refuses are
// refused on the gate's pinned build (an Evaluate of a run of NUL characters), so every test after one fails
// as a withheld kill under a mutant. B2_SeesTheBump passes after B1_TriplesAndBumps in one codeunit session
// and fails alone: that is what the recheck's rule (e) must notice.
codeunit 76050 "Recheck A Tests"
{
    Subtype = Test;

    var
        Logic: Codeunit "Recheck Logic";

    [Test]
    procedure A0_Refuses()
    var
        NulChar: Char;
        Nuls: Text;
        Value: Decimal;
    begin
        NulChar := 0;
        Nuls := PadStr('', 10, NulChar);
        if not Evaluate(Value, Nuls) then
            exit;
    end;

    [Test]
    procedure A1_Doubles()
    begin
        if Logic.Double(2) <> 4 then
            Error('Double(2) must be 4');
    end;
}

codeunit 76051 "Recheck B Tests"
{
    Subtype = Test;

    var
        Logic: Codeunit "Recheck Logic";

    [Test]
    procedure B0_Refuses()
    var
        NulChar: Char;
        Nuls: Text;
        Value: Decimal;
    begin
        NulChar := 0;
        Nuls := PadStr('', 10, NulChar);
        if not Evaluate(Value, Nuls) then
            exit;
    end;

    [Test]
    procedure B1_TriplesAndBumps()
    begin
        Logic.Bump();
        if Logic.Triple(2) <> 6 then
            Error('Triple(2) must be 6');
    end;

    [Test]
    procedure B2_SeesTheBump()
    begin
        if Logic.Count() <> 1 then
            Error('Count() must be 1 after B1_TriplesAndBumps');
    end;
}
