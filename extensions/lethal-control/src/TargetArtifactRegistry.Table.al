namespace LethAL.Control;

/// <summary>Maps a target app id to the artifact id it registered. Written by the target's
/// own install/upgrade (target -> control, dependency-legal), so LethAL Control knows the
/// deployed artifact id WITHOUT depending on the target. DataPerCompany=false.</summary>
table 71001 "LC Target Artifact Registry"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Target App Id"; Text[40]) { }
        field(2; "Artifact Id"; Text[32]) { }
    }

    keys
    {
        key(PK; "Target App Id") { Clustered = true; }
    }
}
