table 51134 "Refusal Probe"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Tag; Integer) { }
    }
    keys
    {
        key(PK; Id) { Clustered = true; }
    }
}

page 51135 "Refusal Probe"
{
    PageType = List;
    SourceTable = "Refusal Probe";
    layout
    {
        area(Content)
        {
            repeater(R)
            {
                field(Id; Rec.Id) { }
            }
        }
    }
}

codeunit 51136 "Refusal Inner"
{
    trigger OnRun()
    begin
    end;
}

codeunit 51137 "Refusal Probe Tests"
{
    Subtype = Test;

    [Test]
    procedure AuditCategoryAuthentication()
    begin
        Session.LogAuditMessage('m', SecurityOperationResult::Success, AuditCategory::Authentication, 1, 0);
    end;

    [Test]
    procedure RecordRefGetTableUnassignedVariant()
    var
        V: Variant;
        RR: RecordRef;
    begin
        asserterror RR.GetTable(V);
    end;

    [Test]
    procedure DeleteAllUnderOtherRecordsGlobalFilterGroup()
    var
        A: Record "Refusal Probe";
        B: Record "Refusal Probe";
    begin
        A.DeleteAll();
        A.Init();
        A.Id := 1;
        A.Tag := 1;
        A.Insert();
        A.Id := 2;
        A.Tag := 2;
        A.Insert();
        A.FilterGroup(1);
        A.SetRange(Tag, 1);
        A.FilterGroup(0);
        B.DeleteAll();
        A.FilterGroup(1);
        A.SetRange(Tag);
        A.FilterGroup(0);
        if A.Count() <> 1 then
            Error('rows left: %1', A.Count());
    end;

    [Test]
    procedure ConsistentFalseThenGuardedCodeunitRun()
    var
        A: Record "Refusal Probe";
    begin
        A.Consistent(false);
        if Codeunit.Run(Codeunit::"Refusal Inner") then;
        A.Consistent(true);
    end;

    [Test]
    procedure UriSchemeThroughSystemApplication()
    var
        U: Codeunit Uri;
    begin
        U.Init('https://example.com/x');
        if U.GetScheme() <> 'https' then
            Error('scheme %1', U.GetScheme());
    end;

    [Test]
    procedure GetUrlODataFiveArgumentsWithRecord()
    var
        A: Record "Refusal Probe";
    begin
        if GetUrl(ClientType::ODataV4, CompanyName(), ObjectType::Page, Page::"Refusal Probe", A) = '' then
            Error('empty');
    end;
}
