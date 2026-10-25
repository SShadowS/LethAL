codeunit 50763 "R766 Tests C"
{
    // Positive control: always fails, and the message carries the counter after TWO bumps.
    // 2 = a fresh counter; more = state carried in from earlier work in the same process.
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure BumpTwiceAndReport()
    var
        Counter: Codeunit "R766 Counter";
        n: Integer;
    begin
        Counter.Bump();
        n := Counter.Bump();
        Error('R766 count %1', n);
    end;
}
