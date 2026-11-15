// PR-28 (#8013, Company Triggers): a subscriber to OnCompanyOpenCompleted writes a row when the company opens, before the first
// test. A test that reads the table, and one that never does. Invented; no corpus text. On BC the subscriber runs when the test
// session opens the company, and its row is there for the tests (inferred, not measured).
table 51490 "U8013 Open Row"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}

codeunit 51491 "U8013 Open Subscriber"
{
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Company Triggers", 'OnCompanyOpenCompleted', '', false, false)]
    local procedure OnOpen()
    var
        R: Record "U8013 Open Row";
    begin
        if not R.Get('OPENED') then begin
            R.Code := 'OPENED';
            R.Insert();
        end;
    end;
}

codeunit 51492 "U8013 Open Tests"
{
    Subtype = Test;

    [Test]
    procedure ReadsTheTableTheSubscriberWrote()
    var
        R: Record "U8013 Open Row";
    begin
        if R.IsEmpty() then
            Error('the company-open row is not there');
    end;

    [Test]
    procedure NeverReadsIt()
    begin
        // the control: touches nothing the subscriber wrote
        if 1 + 1 <> 2 then
            Error('arithmetic');
    end;
}
