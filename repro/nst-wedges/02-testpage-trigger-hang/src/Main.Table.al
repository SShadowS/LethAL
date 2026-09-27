namespace NstRepro02;

// Source table of the page under test: OnInsert/OnModify triggers, a field OnValidate trigger and a
// FlowField, the ingredients of the page that hung in the incident.
table 91610 "NST Repro02 Main"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Decimal)
        {
            trigger OnValidate()
            begin
                "Modify Count" += 1;
            end;
        }
        field(3; "Modify Count"; Integer) { }
        field(4; "Related Total"; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = sum("NST Repro02 Related".Amount where("Main No." = field("No.")));
            Editable = false;
        }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    trigger OnInsert()
    begin
        "Modify Count" := 0;
    end;

    trigger OnModify()
    begin
        "Modify Count" += 1;
    end;
}
