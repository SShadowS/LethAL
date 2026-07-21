table 79200 "Sandbox Probe Marker"
{
    // The order-matters probe's shared witness. Under Codeunit isolation the two probe test
    // methods run in one transaction, so a marker inserted by the first method is visible to the
    // second. RunMutant selecting exactly ONE method means the second runs alone and sees an empty
    // table — the observable proof of single-method selection. The isolation runner rolls this row
    // back after every RunMutant call, so nothing leaks across probe calls.
    DataClassification = SystemMetadata;
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Entry No."; Integer) { }
    }

    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
    }
}
