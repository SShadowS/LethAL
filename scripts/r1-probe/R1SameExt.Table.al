// ROADMAP R1 investigation probe (Stream A follow-up, scratch — NOT part of the Tier-2 Phase 0
// fixture). Deliberately carries NO `InherentPermissions`: that declaration is exactly what
// DataMain.Table.al / DataNoTrigger.Table.al need to work around Microsoft's Permissions Mock, and
// its absence here is the point of this table.
//
// This table lives in the SAME app ("LethAL Sandbox Data Tests") as the `[Test]` codeunit that reads
// its permissions (R1PermissionProbe.Codeunit.al), unlike "Data Main"/"Data No Trigger" which live in
// a DIFFERENT extension ("LethAL Sandbox Data"). It measures whether the mock's write-strip is scoped
// by "different extension than the running test codeunit" or is a blanket strip on any table without
// `InherentPermissions`, regardless of which extension owns it — the load-bearing question for a
// same-extension canary table proposed for `extensions/lethal-control`.
//
// Compile it by copying into fixtures/sandbox-data-tests/src, alongside R1PermissionProbe.Codeunit.al
// and R1SameExtInsert.Codeunit.al — see that file's header for the full compile/publish recipe.
table 79312 "R1 Same Ext"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20]) { }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}
