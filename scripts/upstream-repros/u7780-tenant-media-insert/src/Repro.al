// Invented repro for aldevtools/BusinessCentral.AL.Runner#7780: Insert() on "Tenant Media" with a blob written into Content.
codeunit 77801 "R778 Tests"
{
    Subtype = Test;

    [Test]
    procedure InsertWithContentBlobReadsBack()
    var
        TenantMedia: Record "Tenant Media";
        OutS: OutStream;
        InS: InStream;
        Text: Text;
    begin
        TenantMedia.ID := CreateGuid();
        TenantMedia.Content.CreateOutStream(OutS);
        OutS.WriteText('1');
        TenantMedia.Insert();

        TenantMedia.Get(TenantMedia.ID);
        TenantMedia.CalcFields(Content);
        TenantMedia.Content.CreateInStream(InS);
        InS.ReadText(Text);
        if Text <> '1' then
            Error('Content came back as %1', Text);
    end;
}
