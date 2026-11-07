// R857: leg ISO's writer and reader, in ONE codeunit, unlike the Writer and Reader of OrderProbe.al.
// A whole-codeunit entry shows the date reach the reader; run alone, the reader must not see it.
codeunit 77056 "Order Isolate Probe"
{
    Subtype = Test;

    [Test]
    procedure W1SetDate()
    begin
        WorkDate(20200315D);
    end;

    [Test]
    procedure R2ReadDate()
    begin
        Error('ISODATE=%1', Format(WorkDate(), 0, 9));
    end;
}
