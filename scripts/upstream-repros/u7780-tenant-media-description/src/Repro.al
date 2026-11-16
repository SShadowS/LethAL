// Invented repro for aldevtools/BusinessCentral.AL.Runner#7780: description-only Insert(false) on "Tenant Media", read back by key.
// The shape artkashin measured on BC 27.5, 28.5 and 29.0 (a synthetic GUID; not from a corpus).
codeunit 77811 "R778 Description Tests"
{
    Subtype = Test;

    [Test]
    procedure InsertDescriptionOnlyReadsBack()
    var
        TenantMedia: Record "Tenant Media";
        Id: Guid;
    begin
        Id := 'eb5700b7-a069-42c4-a86e-404e2839defc';
        if TenantMedia.Get(Id) then
            TenantMedia.Delete();
        TenantMedia.Init();
        TenantMedia.ID := Id;
        TenantMedia.Description := 'Synthetic description';
        TenantMedia.Insert(false);
        Clear(TenantMedia);
        TenantMedia.Get(Id);
        TenantMedia.TestField(Description, 'Synthetic description');
        TenantMedia.Delete();
    end;
}
