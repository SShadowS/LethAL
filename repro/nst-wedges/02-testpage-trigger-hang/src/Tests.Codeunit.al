namespace NstRepro02;

codeunit 91615 "NST Repro02 Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    // The arm that hung in the incident.
    [Test]
    procedure OpenTriggerPage()
    var
        MainList: TestPage "NST Repro02 Main List";
    begin
        SeedMain();
        MainList.OpenView();
        MainList.Close();
    end;

    // Control: expected to fail fast with NotSupportedException at CreateNavTestService.
    [Test]
    procedure OpenPlainPage()
    var
        PlainList: TestPage "NST Repro02 Plain List";
    begin
        SeedMain();
        PlainList.OpenView();
        PlainList.Close();
    end;

    local procedure SeedMain()
    var
        Main: Record "NST Repro02 Main";
    begin
        if Main.Get('P-EXT') then
            exit;
        Main.Init();
        Main."No." := 'P-EXT';
        Main.Insert(true);
    end;
}
