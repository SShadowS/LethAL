// PR-175 (#8267, R1116): a bare Insert() of a key that already exists. BC raises "The record in table ... already exists"
// (documented AL behaviour; inferred, not measured on BC here). edge-4ebfe7913 raises nothing: the row is not inserted and
// no error is raised, so the two asserterror tests fail. The return-value form answers false on both. Invented; no corpus text.
table 51830 "U8267 Dup Row"
{
    fields
    {
        field(1; Code; Code[20]) { }
        field(2; Name; Text[50]) { }
    }
    keys { key(PK; Code) { Clustered = true; } }
}

codeunit 51831 "U8267 Bare Twice"
{
    Subtype = Test;

    [Test]
    procedure BareInsertTwiceRaises()
    var
        R: Record "U8267 Dup Row";
    begin
        R.Code := 'A';
        R.Insert();
        asserterror R.Insert();
    end;
}

codeunit 51832 "U8267 Second Variable"
{
    Subtype = Test;

    [Test]
    procedure InsertSameKeyFromSecondVariable()
    var
        R: Record "U8267 Dup Row";
        R2: Record "U8267 Dup Row";
    begin
        R.Code := 'A';
        R.Insert();
        R2.Code := 'A';
        asserterror R2.Insert();
    end;
}

codeunit 51833 "U8267 Return Value"
{
    Subtype = Test;

    [Test]
    procedure InsertTwiceReturnsFalse()
    var
        R: Record "U8267 Dup Row";
    begin
        R.Code := 'A';
        R.Insert();
        if R.Insert() then
            Error('the second Insert of key A returned true');
    end;
}
