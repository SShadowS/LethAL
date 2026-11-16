// Invented repro for aldevtools/BusinessCentral.AL.Runner#8191: the relation target lives in its own namespace.
namespace Repro.Setup;

table 51690 "Repro Posting Group"
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
