// Invented repro for aldevtools/BusinessCentral.AL.Runner#7832: a [WithEvents] DotNet variable must not refuse the test when no event is raised.
// The constructor is the no-argument one (the issue's Timer(1000) is ambiguous, AL0196, per the maintainer).
dotnet
{
    assembly(System)
    {
        type("System.Timers.Timer"; "R783 Timer") { }
        type("System.Timers.ElapsedEventArgs"; "R783 ElapsedArgs") { }
    }
}

codeunit 78321 "R783 Helper With Trigger"
{
    var
        [WithEvents]
        Timer: DotNet "R783 Timer";

    procedure Touch(): Decimal
    begin
        Timer := Timer.Timer();
        Timer.Interval := 1000;
        exit(Timer.Interval);
    end;

    trigger Timer::Elapsed(sender: Variant; e: DotNet "R783 ElapsedArgs")
    begin
    end;
}

codeunit 78322 "R783 Helper No Trigger"
{
    var
        [WithEvents]
        Timer: DotNet "R783 Timer";

    procedure Touch(): Decimal
    begin
        Timer := Timer.Timer();
        Timer.Interval := 1000;
        exit(Timer.Interval);
    end;
}

codeunit 78323 "R783 Tests"
{
    Subtype = Test;

    [Test]
    procedure WithEventsTimerWithElapsedTrigger()
    var
        H: Codeunit "R783 Helper With Trigger";
    begin
        if H.Touch() <> 1000 then
            Error('wrong');
    end;

    [Test]
    procedure WithEventsTimerWithoutTrigger()
    var
        H: Codeunit "R783 Helper No Trigger";
    begin
        if H.Touch() <> 1000 then
            Error('wrong');
    end;
}
