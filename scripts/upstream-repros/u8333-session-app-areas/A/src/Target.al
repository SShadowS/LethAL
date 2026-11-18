// PR-175 (#8333, R1126): a control whose ApplicationArea is enabled only for the Premium experience. Invented; no corpus text.
tableextension 51840 "U8333 AA Setup" extends "Application Area Setup"
{
    fields { field(51840; U8333Area; Boolean) { DataClassification = SystemMetadata; } }
}

codeunit 51841 "U8333 AA Mgt"
{
    // The custom area is enabled only for the Premium experience.
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Application Area Mgmt. Facade", 'OnGetPremiumExperienceAppAreas', '', false, false)]
    local procedure OnGetPremium(var TempApplicationAreaSetup: Record "Application Area Setup" temporary)
    begin
        TempApplicationAreaSetup.U8333Area := true;
    end;
}

table 51842 "U8333 AA Row"
{
    fields
    {
        field(1; Code; Code[20]) { }
        field(2; InArea; Decimal) { }
        field(3; InAll; Decimal) { }
    }
    keys { key(PK; Code) { Clustered = true; } }
}

page 51843 "U8333 AA Card"
{
    PageType = Card;
    SourceTable = "U8333 AA Row";
    layout
    {
        area(Content)
        {
            group(Main)
            {
                field(Code; Rec.Code) { ApplicationArea = All; }
                field(InArea; Rec.InArea) { ApplicationArea = U8333Area; }
                field(InAll; Rec.InAll) { ApplicationArea = All; }
            }
        }
    }
}
