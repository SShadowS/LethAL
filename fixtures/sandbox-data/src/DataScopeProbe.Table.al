// R70 fixture, half 1 of 2 — the cross-kind NAME COLLISION every frozen gate was blind to.
//
// This table and `page 79324 "Data Scope Probe"` share a NAME and differ only in KIND: the
// ordinary "card page named after its table" convention, measured on Continia Document Output
// Cloud as 13 names shared across kinds, 12 of them page+table. `buildSymbolTable` used to key
// variable scope on the bare name, so whichever parsed LAST supplied the globals for BOTH.
//
// WHAT MAKES THIS A DETECTOR, and why the receiver is declared where it is:
//
// `Helper` is declared in the TRIGGER'S OWN var section. The symbol table indexes `procedure`
// members only, so a trigger-local is invisible to `lookupVar` (that is R68, filed and open) and
// the receiver is correctly UNRESOLVABLE here. Tier 2 must therefore refuse this site, and Tier 1
// claims the statement as `lethal.void-method-call`.
//
// Under the R70 bug the same-named PAGE's global `Helper: Record "Data Main"` answered for this
// table, the receiver resolved — to the WRONG table, which is the second half of the hazard — and
// Tier 2 CLAIMED the site as `lethal.remove-setrange`. Under §3.2 dedup precedence the Tier-2
// claim wins and DELETES the Tier-1 mutant. So the regression is visible as an OPERATOR NAME
// CHANGE at a fixed file:line, which is exactly what `tables.baseline.json` compares per mutant.
//
// The site is deliberately SCORED rather than no-coverage: `OnInsert` writes a count the test
// asserts, and `Data Scope Probe Tests` seeds out-of-filter decoy rows so that deleting either the
// `SetRange` or the whole statement widens the count and the mutant dies. A detector whose mutants
// are `no-coverage` would still catch the operator flip, but it would not also prove the site is
// live.
table 79309 "Data Scope Probe"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Main No. Filter"; Code[20]) { }
        field(3; "Related Count"; Integer) { }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    trigger OnInsert()
    var
        Helper: Record "Data Related";
    begin
        Helper.SetRange("Main No.", "Main No. Filter");
        "Related Count" := Helper.Count();
    end;
}
