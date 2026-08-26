// Task 4 (excluded-sites-spine): the ONLY fixture file that gives `notInstrumented` a live proof
// that can actually fail.
//
// Every other object in this project is a CARRIER kind (`CARRIER_KINDS` in
// packages/schemata/src/compile.ts: codeunit, table, page, report, pageextension,
// tableextension), so `notInstrumented` reports zero on every gate run today, and a derived view
// that returns `{ ...view, files: [] }` would pass unnoticed. That is the exact gap this file
// closes.
//
// `query` is one of the two kinds that still hold executable code (a trigger) and still cannot
// carry the injected `MutationSelector` var (compile.ts's `CARRIER_KINDS` doc comment). The
// comparison below gives `lethal.negate-conditional` a real site to claim, so this file produces
// a deployable-looking mutant that the carrier check then refuses: one row in
// `SessionReport.notInstrumented`, not zero.
query 79332 "Data Scope Query"
{
    QueryType = Normal;

    elements
    {
        dataitem(Main; "Data Main")
        {
            column(No_; "No.") { }
            column(Amount; Amount) { }
        }
    }

    var
        Threshold: Integer;

    trigger OnBeforeOpen()
    begin
        if Threshold = 0 then
            Threshold := 10;
    end;
}
