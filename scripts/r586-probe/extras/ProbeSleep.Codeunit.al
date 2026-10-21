// R586 plan r4 (I-2): the `sleep-is-noop` probe. Its isolation from #5611 is LOAD-BEARING: this codeunit holds NO
// CPU-bound test, because v3 runs a selected test's whole codeunit and a spinning sibling burns the stop N without a
// row of its own (codeunit 50651's CpuHang made SleepHang read "cut at N"). Run as `--codeunit 50660`.
// Shape of the lane's measured 50660 (sleep-noop-recheck.md), plus the positive-control caller of Probe Sleeper.
// Invented; copied into a scratch copy of probe-tests by sleep-noop-probe.sh.
codeunit 50660 "Sleep Probe"
{
    Subtype = Test;

    var
        Sleeper: Codeunit "Probe Sleeper";

    [Test]
    procedure ShortSleep()
    begin
        Sleep(1500);
    end;

    [Test]
    procedure LongSleepA()
    begin
        Sleep(600000);
    end;

    [Test]
    procedure LongSleepB()
    begin
        Sleep(600000);
    end;

    [Test]
    procedure LongSleepThenAssert()
    var
        Started: DateTime;
        Elapsed: Duration;
    begin
        Started := CurrentDateTime();
        Sleep(600000);
        Elapsed := CurrentDateTime() - Started;
        if Elapsed < 600000 then
            Error('after sleep %1', Elapsed);
    end;

    [Test]
    procedure SleeperDoubles()
    begin
        if Sleeper.WaitThenDouble(21) <> 42 then
            Error('WaitThenDouble(21) must be 42');
    end;
}
