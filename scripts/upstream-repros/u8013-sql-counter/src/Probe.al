// PR-28 (#8013, a SQL counter stored in a record field): SessionInformation.SqlStatementsExecuted assigned to a BigInteger field,
// then the row inserted. Invented; no corpus text. On BC the value is some non-negative count and the insert succeeds (inferred,
// not measured): the test never reads the value, so no count needs pinning.
table 51520 "U8013 Counter Row"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; "Statements"; BigInteger) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

codeunit 51521 "U8013 Counter Tests"
{
    Subtype = Test;

    [Test]
    procedure SqlCounterStoredInAField()
    var
        R: Record "U8013 Counter Row";
    begin
        R.Code := 'A';
        R.Statements := SessionInformation.SqlStatementsExecuted();
        R.Insert();
    end;
}
