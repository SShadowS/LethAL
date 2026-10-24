codeunit 79950 "CF Tests"
{
    Subtype = Test;

    // Each test calls exactly ONE procedure of ONE target codeunit, so per-test coverage
    // maps a test to one procedure.
    // SURVIVE ON PURPOSE: no test asserts a boundary value (IsBig(100), IsSmall(10),
    // IsNegative(0), IsAdult(18), Clamp(50)), so the five conditional-boundary mutants
    // in CF Active, CF Inactive, CF Second and CF Plain (two) survive.

    var
        CFActive: Codeunit "CF Active";
        CFInactive: Codeunit "CF Inactive";
        CFFirst: Codeunit "CF First";
        CFSecond: Codeunit "CF Second";
        CFPlain: Codeunit "CF Plain";

    [Test]
    procedure ActiveAddKills()
    begin
        if CFActive.Add(2, 3) <> 5 then
            Error('Add(2,3) must be 5');
    end;

    [Test]
    procedure ActiveIsBigKills()
    begin
        if not CFActive.IsBig(101) then
            Error('IsBig(101) must be true');
        if CFActive.IsBig(5) then
            Error('IsBig(5) must be false');
    end;

    [Test]
    procedure ActiveBothKills()
    begin
        if CFActive.Both(true, false) then
            Error('Both(true,false) must be false');
        if not CFActive.Both(true, true) then
            Error('Both(true,true) must be true');
    end;

    [Test]
    procedure InactiveSubKills()
    begin
        if CFInactive.Sub(7, 3) <> 4 then
            Error('Sub(7,3) must be 4');
    end;

    [Test]
    procedure InactiveIsSmallKills()
    begin
        if not CFInactive.IsSmall(3) then
            Error('IsSmall(3) must be true');
        if CFInactive.IsSmall(30) then
            Error('IsSmall(30) must be false');
    end;

    [Test]
    procedure InactiveEitherKills()
    begin
        if CFInactive.Either(false, false) then
            Error('Either(false,false) must be false');
        if not CFInactive.Either(false, true) then
            Error('Either(false,true) must be true');
    end;

    [Test]
    procedure FirstTwiceKills()
    begin
        if CFFirst.Twice(4) <> 8 then
            Error('Twice(4) must be 8');
    end;

    [Test]
    procedure FirstIsZeroKills()
    begin
        if not CFFirst.IsZero(0) then
            Error('IsZero(0) must be true');
        if CFFirst.IsZero(1) then
            Error('IsZero(1) must be false');
    end;

    [Test]
    procedure SecondThriceKills()
    begin
        if CFSecond.Thrice(4) <> 12 then
            Error('Thrice(4) must be 12');
    end;

    [Test]
    procedure SecondIsNegativeKills()
    begin
        if not CFSecond.IsNegative(-1) then
            Error('IsNegative(-1) must be true');
        if CFSecond.IsNegative(1) then
            Error('IsNegative(1) must be false');
    end;

    [Test]
    procedure SecondPickKills()
    begin
        if CFSecond.Pick(true) <> 1 then
            Error('Pick(true) must be 1');
        if CFSecond.Pick(false) <> 2 then
            Error('Pick(false) must be 2');
    end;

    [Test]
    procedure PlainIncKills()
    begin
        if CFPlain.Inc(5) <> 6 then
            Error('Inc(5) must be 6');
    end;

    [Test]
    procedure PlainIsAdultKills()
    begin
        if CFPlain.IsAdult(10) then
            Error('IsAdult(10) must be false');
        if not CFPlain.IsAdult(30) then
            Error('IsAdult(30) must be true');
    end;

    [Test]
    procedure PlainClampKills()
    begin
        if CFPlain.Clamp(80) <> 50 then
            Error('Clamp(80) must be 50');
        if CFPlain.Clamp(7) <> 7 then
            Error('Clamp(7) must be 7');
    end;
}
