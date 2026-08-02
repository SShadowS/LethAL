// R70 fixture, half 1 of 2 — the cross-kind NAME COLLISION every frozen gate was blind to.
//
// This table and `page 79324 "Data Scope Probe"` share a NAME and differ only in KIND: the
// ordinary "card page named after its table" convention, measured on Continia Document Output
// Cloud as 13 names shared across kinds, 12 of them page+table. `buildSymbolTable` used to key
// variable scope on the bare name, so whichever parsed LAST supplied the globals for BOTH.
//
// WHAT THIS IS NOW, AND WHAT IT USED TO BE.
//
// It was the R70 REGRESSION DETECTOR: `Helper` was declared in the trigger's own var section,
// which the symbol table did not index (R68, then open), so the receiver was unresolvable, Tier 2
// refused, Tier 1 claimed `void-method-call` — and under a regressed R70 the same-named page's
// global answered instead, Tier 2 claimed, and §3.2 precedence DELETED the Tier-1 mutant. The
// observable was an operator-name flip.
//
// THAT PREMISE WAS R68 STAYING OPEN, and R68 has now landed: trigger-local vars resolve, this site
// claims `remove-setrange` either way, and the flip is gone. The loss was NOT discovered by a gate
// — a detector losing its discriminating power changes no verdict — it was caught by an executable
// premise test written for exactly this moment (`packages/builtin-tier2/tests/receiver.test.ts`).
// An adversarial review then found that the obvious repair (give the table an object global, let
// the page supply a rule-3-refusing table) ALSO fails, for an unrelated reason: files are parsed in
// sorted order, `...Page.al` sorts before `...Table.al`, and the globals map is last-write-wins, so
// the table would win its own key regardless of R70.
//
// So the alarm moved OFFLINE, where it belongs — claiming is deterministic and needs no live gate.
// `packages/engine/tests/semantic/symbol-table.test.ts` asserts ORDER INVARIANCE (same files
// permuted, identical answers), the property R70 actually violated.
//
// This pair's job is now to be the MEASURED STATEMENT that the shape exists and executes: a
// same-named page and table live in a real instrumented app, and the table's site is scored rather
// than theoretical. It also carries the fixture's only proof that R68's fix CLAIMS — the site
// resolves through a trigger-local declaration, which nothing else here exercises.
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
        // R71: the first `lethal.swap-rec-xrec` site any fixture carries. `xRec` was MEASURED to
        // differ from `Rec` in a field `OnValidate` (rec=250, xrec=100, differ=YES on Cronus281,
        // fenced path) and NOT to differ in `OnModify` — so the operator is scoped to this trigger
        // kind, and this is the shape that proves the claim rather than the refusal.
        //
        // Change detection, the idiom `OnValidate` exists for. Under the mutant `xRec.Tracked`
        // becomes `Rec.Tracked`, the comparison is a value against itself, the branch never fires
        // and `Bumped` stays false — which `ScopeProbeTracksFieldChange` asserts.
        field(4; Tracked; Integer)
        {
            trigger OnValidate()
            begin
                if Tracked <> xRec.Tracked then
                    Bumped := true;
            end;
        }
        field(5; Bumped; Boolean) { }
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
