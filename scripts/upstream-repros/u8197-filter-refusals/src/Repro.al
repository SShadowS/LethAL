// Invented repro: three SetFilter shapes refused by the runner, with BC's answers measured on BC 28.4 W1 (PR-83).
enum 58320 "Ref Color" { value(0; Red) { } value(1; Green) { } value(2; Blue) { } }

table 58320 "Ref Row"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; Kind; Option) { OptionMembers = Alpha,Beta,Gamma; }
        field(3; Color; Enum "Ref Color") { }
        field(4; "Doc Date"; Date) { }
        field(5; Active; Boolean) { }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

codeunit 58321 "Ref Test"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure OptionNotAMember()
    var
        R: Record "Ref Row";
    begin
        asserterror R.SetFilter(Kind, 'Delta');
        if StrPos(GetLastErrorText(), 'The existing options are: Alpha,Beta,Gamma') = 0 then
            Error('BC names the options: %1', GetLastErrorText());
    end;

    [Test]
    procedure DanishBooleanWords()
    var
        R: Record "Ref Row";
    begin
        GlobalLanguage(1030);
        R.DeleteAll();
        R."Code" := 'A';
        R.Active := true;
        R.Insert();
        R.SetFilter(Active, 'Ja');
        if R.IsEmpty() then
            Error('BC reads Ja as true under 1030');
        asserterror R.SetFilter(Active, 'Yes');
    end;

    [Test]
    procedure DanishDateTextUnderEnUsRegion()
    var
        R: Record "Ref Row";
    begin
        GlobalLanguage(1030);
        asserterror R.SetFilter("Doc Date", '15.03.2024');
    end;
}
