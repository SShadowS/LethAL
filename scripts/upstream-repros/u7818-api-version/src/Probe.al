table 50283 "Probe Api Row"
{
    fields
    {
        field(1; Id; Integer) { }
    }
    keys { key(PK; Id) { } }
}

page 50284 "Probe Multi Version Api"
{
    PageType = API;
    APIPublisher = 'probe';
    APIGroup = 'probe';
    APIVersion = 'v1.0', 'v2.0', 'beta';
    EntityName = 'probeRow';
    EntitySetName = 'probeRows';
    SourceTable = "Probe Api Row";
    DelayedInsert = true;
    ODataKeyFields = Id;

    layout
    {
        area(Content)
        {
            field(id; Rec.Id) { }
        }
    }
}

codeunit 50285 "Probe Api Version Tests"
{
    Subtype = Test;

    [Test]
    procedure ApiVersionHoldsEveryVersion()
    var
        PageMetadata: Record "Page Metadata";
    begin
        PageMetadata.Get(Page::"Probe Multi Version Api");
        if PageMetadata.APIVersion <> 'v1.0,v2.0,beta' then
            Error('APIVersion is "%1" (length %2), expected "v1.0,v2.0,beta"', PageMetadata.APIVersion, StrLen(PageMetadata.APIVersion));
    end;
}
