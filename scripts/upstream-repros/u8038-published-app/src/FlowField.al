table 50600 "Repro Item"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
        field(2; "Extension ID"; Guid) { }
        field(3; "Extension Name"; Text[250])
        {
            FieldClass = FlowField;
            CalcFormula = lookup("Published Application".Name where(ID = field("Extension ID"), "Tenant Visible" = const(true)));
        }
    }
    keys { key(PK; "Code") { Clustered = true; } }
}

permissionset 50601 "Repro Item Edit"
{
    Assignable = true;
    Permissions = tabledata "Repro Item" = RIMD,
                  tabledata "Published Application" = R;
}

codeunit 50602 "FlowField System Table Tests"
{
    Subtype = Test;

    [Test]
    procedure CalcFlowFieldOfAPublishedAppUnderOwnSet()
    var
        Item: Record "Repro Item";
        PermissionsMock: Codeunit "Permissions Mock";
        Me: ModuleInfo;
    begin
        // the lookup finds a row: this app's own entry in Published Application
        NavApp.GetCurrentModuleInfo(Me);
        Item."Code" := 'C';
        Item."Extension ID" := Me.Id;
        Item.Insert();
        PermissionsMock.Set('Repro Item Edit');
        Item.CalcFields("Extension Name");
    end;

    [Test]
    procedure CalcFlowFieldOfNoAppUnderOwnSet()
    var
        Item: Record "Repro Item";
        PermissionsMock: Codeunit "Permissions Mock";
    begin
        Item."Code" := 'A';
        Item."Extension ID" := CreateGuid();
        Item.Insert();
        PermissionsMock.Set('Repro Item Edit');
        Item.CalcFields("Extension Name");
        if Item."Extension Name" <> '' then
            Error('unexpected name');
    end;
}
