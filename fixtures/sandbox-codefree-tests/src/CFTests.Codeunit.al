codeunit 79950 "CF Tests"
{
    Subtype = Test;

    var
        CFActive: Codeunit "CF Active";
        CFInactive: Codeunit "CF Inactive";
        CFFirst: Codeunit "CF First";
        CFSecond: Codeunit "CF Second";
        CFPlain: Codeunit "CF Plain";

    [Test]
    procedure ActiveKills()
    begin
        if CFActive.Add(2, 3) <> 5 then
            Error('Add(2,3) must be 5');
        if not CFActive.IsBig(101) then
            Error('IsBig(101) must be true');
        if CFActive.IsBig(5) then
            Error('IsBig(5) must be false');
        if CFActive.Both(true, false) then
            Error('Both(true,false) must be false');
        if not CFActive.Both(true, true) then
            Error('Both(true,true) must be true');
    end;

    [Test]
    procedure InactiveKills()
    begin
        if CFInactive.Sub(7, 3) <> 4 then
            Error('Sub(7,3) must be 4');
        if not CFInactive.IsSmall(3) then
            Error('IsSmall(3) must be true');
        if CFInactive.IsSmall(30) then
            Error('IsSmall(30) must be false');
        if CFInactive.Either(false, false) then
            Error('Either(false,false) must be false');
        if not CFInactive.Either(false, true) then
            Error('Either(false,true) must be true');
    end;

    [Test]
    procedure SplitKills()
    begin
        if CFFirst.Twice(4) <> 8 then
            Error('Twice(4) must be 8');
        if not CFFirst.IsZero(0) then
            Error('IsZero(0) must be true');
        if CFFirst.IsZero(1) then
            Error('IsZero(1) must be false');
        if CFSecond.Thrice(4) <> 12 then
            Error('Thrice(4) must be 12');
        if not CFSecond.IsNegative(-1) then
            Error('IsNegative(-1) must be true');
        if CFSecond.IsNegative(1) then
            Error('IsNegative(1) must be false');
        if CFSecond.Pick(true) <> 1 then
            Error('Pick(true) must be 1');
        if CFSecond.Pick(false) <> 2 then
            Error('Pick(false) must be 2');
    end;

    [Test]
    procedure PlainKills()
    begin
        if CFPlain.Inc(5) <> 6 then
            Error('Inc(5) must be 6');
        if CFPlain.IsAdult(10) then
            Error('IsAdult(10) must be false');
        if not CFPlain.IsAdult(30) then
            Error('IsAdult(30) must be true');
        if CFPlain.Clamp(80) <> 50 then
            Error('Clamp(80) must be 50');
        if CFPlain.Clamp(7) <> 7 then
            Error('Clamp(7) must be 7');
        // SURVIVE ON PURPOSE: no test asserts a boundary value (IsBig(100), IsSmall(10),
        // IsNegative(0), IsAdult(18), Clamp(50)), so the five conditional-boundary mutants
        // in CF Active, CF Inactive, CF Second and CF Plain (two) survive.
    end;
}
