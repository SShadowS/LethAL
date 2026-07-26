// Related rows for `Data Main`.
//
// Two jobs, both of which exist so a BROKEN operator fails rather than a happy path passing:
//
//   1. The FlowField `Data Main."Related Total"` sums THIS table. Without rows seeded here the
//      FlowField computes 0 whether or not `CalcFields` ran, and every `RemoveCalcFields` mutant
//      would be equivalent — the fixture would report "survived" and teach nothing.
//   2. `Data Ops.CountForMain` filters this table. The tests seed OUT-OF-FILTER decoy rows, so a
//      deleted `SetRange(F, V)` widens the count instead of leaving it unchanged. Without decoys
//      `RemoveSetRange` survives on data starvation.
//
// Deliberately declares NO procedures: `claimsRecordMethod`'s rule-3 refusal keys on a project
// table declaring a procedure of the builtin's name, and this table must stay on the CLAIMED side
// of that rule. `Data Shadow` is the table on the refused side.
table 79302 "Data Related"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "Entry No."; Integer) { }
        field(2; "Main No."; Code[20]) { }
        field(3; Amount; Decimal) { }
    }

    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
        key(Main; "Main No.") { SumIndexFields = Amount; }
    }
}
