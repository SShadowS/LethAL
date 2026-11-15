// PR-28 (#8013, Find on an empty set): a filter that matches nothing, then Find('=<>') as a statement (its result unused), on an
// app table and on the platform's Time Zone. Invented; no corpus text. On BC the Find raises (no record within the filter), so
// asserterror passes (inferred, not measured). The '=<>' form is the trigger (measured by review: the filter plays no part, and
// Find('-') under asserterror runs, the control below). The refusal's "without a filter" is not about SetFilter.
table 51500 "U8013 Find Row"
{
    fields { field(1; "Code"; Code[20]) { } }
    keys { key(PK; "Code") { Clustered = true; } }
}

codeunit 51501 "U8013 Find Tests"
{
    Subtype = Test;

    [Test]
    procedure FindNoMatchOnAppTable()
    var
        R: Record "U8013 Find Row";
    begin
        R.SetFilter(Code, '''@*NOMATCH*''');
        asserterror R.Find('=<>');
    end;

    [Test]
    procedure FindNoMatchOnTimeZone()
    var
        TZ: Record "Time Zone";
    begin
        TZ.SetFilter(ID, '''@*NOMATCH*''');
        asserterror TZ.Find('=<>');
    end;

    [Test]
    procedure FindFirstNoMatchControl()
    var
        R: Record "U8013 Find Row";
    begin
        // the control: the same filter and an unused Find('-') runs on edge-5a58a0f16
        R.SetFilter(Code, '''@*NOMATCH*''');
        asserterror R.Find('-');
    end;
}
