table 50320 "Probe Guid Row"
{
    fields
    {
        field(1; Id; Integer) { }
        field(2; Ref; Guid) { }
        field(3; Data; Blob) { }
    }
    keys { key(PK; Id) { } }
}

xmlport 50321 "Probe Guid Import"
{
    Direction = Import;
    Format = Xml;

    schema
    {
        textelement(Root)
        {
            tableelement(Row; "Probe Guid Row")
            {
                fieldelement(Id; Row.Id) { }
                fieldelement(Ref; Row.Ref) { }
            }
        }
    }
}

codeunit 50322 "Probe Refusal Tests"
{
    Subtype = Test;

    [Test]
    procedure XmlPortImportIntoGuidField()
    var
        Row: Record "Probe Guid Row";
        Holder: Record "Probe Guid Row" temporary;
        OutS: OutStream;
        InS: InStream;
    begin
        Holder.Data.CreateOutStream(OutS);
        OutS.WriteText('<Root><Row><Id>1</Id><Ref>{6F9619FF-8B86-D011-B42D-00C04FC964FF}</Ref></Row></Root>');
        Holder.Data.CreateInStream(InS);
        Xmlport.Import(Xmlport::"Probe Guid Import", InS);
        Row.Get(1);
        if Format(Row.Ref) <> '{6F9619FF-8B86-D011-B42D-00C04FC964FF}' then
            Error('imported %1', Row.Ref);
    end;
}
