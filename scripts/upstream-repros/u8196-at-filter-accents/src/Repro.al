// Invented repro: BC's @ filter ignores accents as well as case; measured on BC 28.4 W1 (PR-83).
table 58310 "At Row"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Name; Text[50]) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

codeunit 58311 "At Test"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure AtIgnoresAccents()
    var
        R: Record "At Row";
    begin
        R.DeleteAll();
        R."Code" := 'B002';
        R.Name := 'Émile';
        R.Insert();
        R.SetFilter(Name, '@emile');
        if R.IsEmpty() then
            Error('BC finds Émile with @emile');
    end;
}
