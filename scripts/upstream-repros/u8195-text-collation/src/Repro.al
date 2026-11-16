// Invented repro: BC sorts 'Æ' as 'AE' (default W1 collation); measured on BC 28.4 W1 (PR-83).
table 58300 "Coll Row"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Name; Text[50]) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
        key(ByName; Name) { }
    }
}

codeunit 58301 "Coll Test"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure AeIsInsideAToB()
    var
        R: Record "Coll Row";
    begin
        R.DeleteAll();
        Add('A001', 'Alpha');
        Add('B001', 'Bravo');
        Add('C001', 'Ærø');
        R.SetRange(Name, 'A', 'B');
        if R.Count() <> 2 then
            Error('BC finds Alpha and Ærø (2 rows); got %1', R.Count());
    end;

    [Test]
    procedure AeSortsBeforeAlpha()
    var
        R: Record "Coll Row";
    begin
        R.DeleteAll();
        Add('A001', 'Alpha');
        Add('C001', 'Ærø');
        R.SetCurrentKey(Name);
        R.FindFirst();
        if R."Code" <> 'C001' then
            Error('BC sorts Ærø first (as AErø); got %1', R."Code");
    end;

    local procedure Add(C: Code[20]; N: Text[50])
    var
        R: Record "Coll Row";
    begin
        R."Code" := C;
        R.Name := N;
        R.Insert();
    end;
}
