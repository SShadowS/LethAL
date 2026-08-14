table 71541 "R135 Probe"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20]) { DataClassification = CustomerContent; }
        // THE ONE PROPERTY THE PROBE MUTATES: the Category literal in the where() condition below.
        // Variant A uses the letter A, variant B the letter B, and `drive.ps1` rewrites just that
        // literal between publishes. Nothing else in this app differs between the two builds.
        // (Deliberately worded without the const form, because the driver's regex would rewrite a
        // comment containing it too, and a comment that contradicts the code is worse than none.)
        field(2; "Category A Total"; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = Sum("R135 Source".Amount where("Main No." = field("No."), "Category" = const('A')));
            Editable = false;
        }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}
