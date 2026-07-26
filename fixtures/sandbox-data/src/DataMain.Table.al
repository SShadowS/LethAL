// The table fixture's primary mutation target.
//
// Carries the IMPLICIT-RECEIVER Tier-2 positives (spec §6): inside a table, `TestField(...)`,
// `Modify(true)` and `CalcFields(...)` are legal with no receiver and `Rec` is implicit. Those are
// precisely the sites Tier 2 exists to mutate, so a predicate that only handles the `<rec>.` form
// would pass the rest of this fixture while missing its own reason for existing.
//
// This table must NOT declare a procedure named after any builtin it is meant to expose as a
// claimable site — `claimsRecordMethod` refuses the implicit form when the enclosing table
// declares a procedure of that name. `Data Shadow` is the table that deliberately does declare
// them.
table 79300 "Data Main"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                if "No." = '' then
                    Error('No. must not be blank');
                Touched := Touched + 1;
            end;
        }
        field(2; Amount; Decimal) { }
        field(3; Category; Code[10])
        {
            trigger OnValidate()
            begin
                // POSITIVE (RemoveCalcFields, IMPLICIT receiver, inside a trigger body). Killed by
                // `CategoryGuardNeedsCalcFields`, which seeds two Data Related rows summing to
                // 1300: delete the call and the FlowField reads back as 0, the guard never fires
                // and the asserterror fails. The seeded rows are load-bearing — with none, 0 = 0
                // and the mutant is equivalent (spec §6).
                //
                // Deliberately in a TRIGGER rather than a table procedure. BC reports no coverage
                // for table trigger code, so `coverageFilter` falls all the way back to "every
                // green test" (selection.ts FALLBACK 2) and this site is guaranteed to execute. A
                // table PROCEDURE has no such fallback: it needs a member-level coverage entry, and
                // whether BC emits one for table procedures is unmeasured here. Hosting this
                // operator's only kill there would have made its verdict depend on that unknown.
                CalcFields("Related Total");
                if "Related Total" > 1000 then
                    Error('related total too large');
            end;
        }
        field(4; Processed; Boolean)
        {
            trigger OnValidate()
            begin
                // POSITIVE (RemoveTestField, one-argument, IMPLICIT receiver, inside a trigger
                // body). Killed by `ProcessedRequiresCategory`, which validates a row whose
                // Category is blank inside `asserterror`: delete this call and no error is raised,
                // so the asserterror fails. The second statement keeps this trigger from being a
                // single-statement body, so the `empty-block` mutant here is not merely a second
                // spelling of this one.
                TestField(Category);
                Touched := Touched + 1;
            end;
        }
        field(5; Flagged; Boolean)
        {
            trigger OnValidate()
            begin
                // POSITIVE (SwapModifyFlag, IMPLICIT receiver, inside a trigger body). Killed by
                // `FlaggedFiresModifyTrigger`: `Modify(false)` still writes the row but skips
                // OnModify, so "Modify Count" stays 0 and the assertion fails. Observability comes
                // entirely from OnModify below — spec §4 warns this operator has no signal unless
                // the table's OnModify does something the test asserts.
                Modify(true);
            end;
        }
        field(6; "Modify Count"; Integer) { }
        field(7; "Related Total"; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = sum("Data Related".Amount where("Main No." = field("No.")));
            Editable = false;
        }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
        key(Cat; Category) { }
    }

    var
        Touched: Integer;

    trigger OnInsert()
    begin
        Amount := Amount * 2;
    end;

    // The only thing that makes `SwapModifyFlag` observable here. Every test that needs a
    // "did the trigger run?" answer reads "Modify Count" back after a fresh `Get`.
    trigger OnModify()
    begin
        "Modify Count" := "Modify Count" + 1;
    end;

    // Deliberately uncovered — no test calls it, so its two mutants stay `no-coverage`. A fixture
    // with no no-coverage bucket cannot catch a coverage-attribution regression.
    procedure TouchCount(): Integer
    begin
        exit(Touched);
    end;

    // POSITIVE (RemoveSetRange) in the CASE-VARIANT spelling `Rec.SETRANGE(...)`, which spec §4.1
    // requires to be the same site as `Rec.SetRange(...)` — AL is case-insensitive and a
    // lowercase-only predicate silently misses real code. `CountInCategoryUppercaseSetRange` seeds
    // out-of-filter decoy rows in another category so the deletion is observable.
    //
    // This one is a table PROCEDURE, and its verdict therefore depends on whether BC emits a
    // member-level coverage entry for table procedures (see the Category trigger above): killed if
    // it does, no-coverage if it does not. Either way the site's OPERATOR NAME is pinned by the
    // committed baseline, which is what catches a predicate that stops matching the uppercase
    // spelling — and RemoveSetRange's guaranteed kill lives in `Data Ops.CountForMain`, a codeunit.
    procedure CountInCategory(CategoryCode: Code[10]): Integer
    begin
        Rec.SETRANGE(Category, CategoryCode);
        exit(Rec.Count());
    end;
}
