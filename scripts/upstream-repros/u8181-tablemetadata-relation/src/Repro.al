// Invented repro for aldevtools/BusinessCentral.AL.Runner#8181: a field whose TableRelation targets the system table
// "Table Metadata" is refused ("relation target `Table Metadata.ID` is not declared in the workspace"), as Base Application's
// company initialization (System Initialization Impl.InitCompany) is on edge-4ebfe7913 (PR-57). A direct read of Table Metadata runs.
table 51680 "TM Holder"
{
    TableType = Temporary;
    fields
    {
        field(1; "No."; Integer) { }
        field(2; "Table ID"; Integer)
        {
            TableRelation = "Table Metadata".ID;
        }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}

codeunit 51681 "TM Relation Tests"
{
    Subtype = Test;

    [Test]
    procedure ValidateExistingTableId() // BC: passes (the repro's own table 51680 exists)
    var
        Holder: Record "TM Holder";
    begin
        Holder."No." := 1;
        Holder.Validate("Table ID", Database::"TM Holder");
        Holder.Insert(true);
    end;

    [Test]
    procedure ValidateMissingTableId() // BC: the relation check fails, so asserterror passes
    var
        Holder: Record "TM Holder";
    begin
        Holder."No." := 2;
        asserterror Holder.Validate("Table ID", 1999999999);
    end;

    [Test]
    procedure ReadTableMetadata() // control: reading the system table directly (BC: passes)
    var
        TM: Record "Table Metadata";
    begin
        TM.Get(Database::"TM Holder");
    end;
}
