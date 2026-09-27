namespace NstRepro03;

codeunit 91631 "NST Repro03 Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // A pure CPU loop with no database I/O inside it. It is bounded by MaxMs (set by the client) so
    // that a failed stop clears on its own instead of holding the server tier forever.
    [Test]
    procedure LoopUntilBound()
    var
        Run: Record "NST Repro03 Run";
        T0: DateTime;
        Spin: BigInteger;
    begin
        Run.Get(1);
        T0 := CurrentDateTime();
        while CurrentDateTime() - T0 < Run.MaxMs do
            Spin += 1;
    end;
}
