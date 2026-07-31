// R33 follow-up probes, raised by an adversarial review of the first measurement.
//
// The first probe measured `xRec` in ONE trigger kind (`OnModify`, driven by a record-variable
// `Modify(true)`) and the design then concluded "the operator is not built" for ALL `xRec` sites.
// That step is not supported by that data point: `OnValidate` is where the base app's ubiquitous
// `if F <> xRec.F then` change detection lives, and `OnRename` compares old and new primary keys,
// which cannot be equal. Both are measured here.
//
// Same channel as every other probe in this fixture: raise from inside the trigger, because a
// failure message is carried back verbatim by both the hub and the fenced path.
table 79202 "Rec XRec Probe 2"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Decimal)
        {
            trigger OnValidate()
            begin
                Error(
                  'MEASURED validate rec.Amount=%1 | xrec.Amount=%2 | differ=%3',
                  Rec.Amount,
                  xRec.Amount,
                  Rec.Amount <> xRec.Amount);
            end;
        }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    trigger OnRename()
    begin
        Error(
          'MEASURED rename rec.No=%1 | xrec.No=%2 | differ=%3',
          Rec."No.",
          xRec."No.",
          Rec."No." <> xRec."No.");
    end;
}
