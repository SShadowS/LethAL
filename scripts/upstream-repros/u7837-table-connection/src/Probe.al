// PR-30 (#7837, refusal family table-connection): the test marker @@test@@ inside a fuller connection string, the shape an app
// builds around it ('Url=%1; UserName=%2; ...'), and an Insert with its trigger on a TableType = CRM table. One test codeunit each,
// so a refusal's cascade cannot reach another. Each test registers its own connection name, after unregistering a leftover of it:
// BC keeps a connection for the whole session and refuses a second registration of a name. Invented; no corpus text. On BC both
// pass (inferred, not measured: Microsoft's Field Service and Sustainability ESG integration tests use these shapes and ship as
// passing).
table 51580 "U7837 CRM Row"
{
    TableType = CRM;
    ExternalName = 'u7837_row';
    fields
    {
        field(1; "Id"; Guid) { ExternalName = 'u7837_rowid'; ExternalType = 'Uniqueidentifier'; ExternalAccess = Insert; }
        field(2; "Name"; Text[100]) { ExternalName = 'u7837_name'; ExternalType = 'String'; }
    }
    keys { key(PK; "Id") { Clustered = true; } }

    trigger OnInsert()
    begin
        Name := 'set by OnInsert';
    end;
}

codeunit 51581 "U7837 Marker In String"
{
    Subtype = Test;

    [Test]
    procedure MarkerInsideAConnectionString()
    begin
        if HasTableConnection(TableConnectionType::CRM, 'U7837String') then
            UnregisterTableConnection(TableConnectionType::CRM, 'U7837String');
        RegisterTableConnection(TableConnectionType::CRM, 'U7837String',
            'Url=@@test@@; UserName=u; Password=p; ProxyVersion=9; AuthType=Office365');
        SetDefaultTableConnection(TableConnectionType::CRM, 'U7837String');
    end;
}

codeunit 51582 "U7837 Crm Trigger Insert"
{
    Subtype = Test;

    [Test]
    procedure InsertWithTriggerOnCrmTable()
    var
        Row: Record "U7837 CRM Row";
    begin
        if HasTableConnection(TableConnectionType::CRM, 'U7837Trigger') then
            UnregisterTableConnection(TableConnectionType::CRM, 'U7837Trigger');
        RegisterTableConnection(TableConnectionType::CRM, 'U7837Trigger', '@@test@@');
        SetDefaultTableConnection(TableConnectionType::CRM, 'U7837Trigger');
        Row.Id := CreateGuid();
        Row.Insert(true);
    end;
}

codeunit 51583 "U7837 Exact Marker"
{
    Subtype = Test;

    [Test]
    procedure ExactMarker()
    begin
        // the control: the one string al-runner pins
        if HasTableConnection(TableConnectionType::CRM, 'U7837Exact') then
            UnregisterTableConnection(TableConnectionType::CRM, 'U7837Exact');
        RegisterTableConnection(TableConnectionType::CRM, 'U7837Exact', '@@test@@');
        SetDefaultTableConnection(TableConnectionType::CRM, 'U7837Exact');
    end;
}
