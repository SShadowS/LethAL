// Invented repro for aldevtools/BusinessCentral.AL.Runner#8191: a TableRelation naming a table of another namespace through
// `using` is refused at Validate on edge-4ebfe7913 ("relation target `Repro Posting Group` is not declared in the workspace"); the
// namespace-qualified name and a target in the field's own namespace run. Base Application is written this way (PR-75).
namespace Repro.Assets;

using Repro.Setup;

table 51691 "Repro Holder"
{
    fields
    {
        field(1; "No."; Integer) { }
        field(2; "Group"; Code[20])
        {
            TableRelation = "Repro Posting Group";
        }
        field(3; "Group Full"; Code[20])
        {
            TableRelation = Repro.Setup."Repro Posting Group";
        }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}

table 51693 "Repro Local Group"
{
    fields
    {
        field(1; "Code"; Code[20]) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
}

table 51694 "Repro Local Holder"
{
    fields
    {
        field(1; "No."; Integer) { }
        field(2; "Group"; Code[20])
        {
            TableRelation = "Repro Local Group";
        }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}
