// R33 / spec §5: the `SwapRecXRec` go/no-go experiment's target table.
//
// The question the operator's existence depends on: when `Modify(true)` is driven from AL code
// rather than from a page, does `xRec` carry the row as it was BEFORE the change, or the same
// values as `Rec`? LethAL drives every test headlessly, so if the two are equal on that path a
// `Rec` <-> `xRec` swap changes nothing observable and the operator would emit survivors that mean
// nothing.
//
// The channel is `Error` from inside `OnModify`, the same trick `Session Capability Probe` uses:
// a passing test reports nothing a runner surfaces, while a failure message is carried back
// verbatim by BOTH the hub and the fenced path. The test failing IS the measurement.
table 79201 "Rec XRec Probe"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Amount; Decimal) { }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    trigger OnModify()
    begin
        Error(
          'MEASURED rec.Amount=%1 | xrec.Amount=%2 | differ=%3 | rec.No=%4 | xrec.No=%5',
          Rec.Amount,
          xRec.Amount,
          Rec.Amount <> xRec.Amount,
          Rec."No.",
          xRec."No.");
    end;
}
