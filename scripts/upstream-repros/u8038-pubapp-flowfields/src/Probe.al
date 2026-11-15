// PR-33 (#8038, refusal family pubapp-flowfield): reads of Published Application that touch its own FlowFields over system tables
// (Tenant Visible over NAV App Extra; Installed over Installed Application), under a set that grants Published Application R and
// nothing else. On BC (measured by the family's BC-check cells of the same shapes, BC 28.4): a Tenant Visible filter without an ID
// and CalcFields of Tenant Visible pass, a filter on Installed passes, and CalcFields of Installed fails, needing IndirectRead on
// Installed Application. One codeunit per test. Invented; no corpus text.
permissionset 51610 "U8038 Grant PubApp"
{
    Assignable = true;
    Permissions = tabledata "Published Application" = R;
}

codeunit 51611 "U8038 Tenant Visible Filter"
{
    Subtype = Test;

    [Test]
    procedure FindFirstOnTenantVisibleAlone()
    var
        App: Record "Published Application";
        PermissionsMock: Codeunit "Permissions Mock";
    begin
        App.SetRange("Tenant Visible", true);
        PermissionsMock.Set('U8038 Grant PubApp');
        if App.FindFirst() then;
    end;
}

codeunit 51612 "U8038 Tenant Visible Calc"
{
    Subtype = Test;

    [Test]
    procedure CalcFieldsTenantVisible()
    var
        App: Record "Published Application";
        PermissionsMock: Codeunit "Permissions Mock";
        Me: ModuleInfo;
    begin
        NavApp.GetCurrentModuleInfo(Me);
        App.SetRange(ID, Me.Id());
        PermissionsMock.Set('U8038 Grant PubApp');
        if App.FindFirst() then App.CalcFields("Tenant Visible");
    end;
}

codeunit 51613 "U8038 Installed Filter"
{
    Subtype = Test;

    [Test]
    procedure FindFirstOnInstalled()
    var
        App: Record "Published Application";
        PermissionsMock: Codeunit "Permissions Mock";
        Me: ModuleInfo;
    begin
        NavApp.GetCurrentModuleInfo(Me);
        App.SetRange(ID, Me.Id());
        App.SetRange(Installed, true);
        PermissionsMock.Set('U8038 Grant PubApp');
        if App.FindFirst() then;
    end;
}

codeunit 51614 "U8038 Installed Calc"
{
    Subtype = Test;

    [Test]
    procedure CalcFieldsInstalled()
    var
        App: Record "Published Application";
        PermissionsMock: Codeunit "Permissions Mock";
        Me: ModuleInfo;
    begin
        // fails on BC: IndirectRead on Installed Application is not granted
        NavApp.GetCurrentModuleInfo(Me);
        App.SetRange(ID, Me.Id());
        PermissionsMock.Set('U8038 Grant PubApp');
        if App.FindFirst() then App.CalcFields(Installed);
    end;
}
