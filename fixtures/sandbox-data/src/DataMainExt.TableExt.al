// R30: the fixture's first EXTENSION object, and the first one any LethAL gate has ever executed.
//
// Extension support (`OBJECT_KINDS`, implicit `Rec` -> the extended table, and the extension's own
// variable scope) shipped 2026-07-28 with unit tests and a measurement on Continia Document Output
// — but NO fixture declared an extension, so none of it had ever been instrumented by `alc`,
// published to a BC server, or run. R62 states the same fact from the other side: "no fixture's
// SymbolReference declares an extension array". This file closes that.
//
// Both sites below are POSITIVES, one per mechanism, and each is killed by a named test:
//
//   1. `TestField(Category)` — the IMPLICIT-receiver form. It claims only if `Rec` inside a
//      `tableextension` resolves to the EXTENDED table (`base_object`), which is also what makes
//      rule 3's shadowing guard key on "Data Main" rather than on this extension's own name.
//   2. `Related.SetRange(...)` — a receiver DECLARED INSIDE the extension. It claims only if
//      `buildSymbolTable` indexes an extension's members for variable scope.
//
// Reaching them from a test needs no page and no UI: in AL a `tableextension`'s public procedures
// are callable on a variable of the extended table's type — the same language rule the shadowing
// guard exists for.
//
// No `fields` section on purpose. A tableextension field would add a schema change to every publish
// this gate performs, and buys nothing: the mutation sites are in the procedure bodies.
tableextension 79322 "Data Main Ext" extends "Data Main"
{
    // POSITIVE (RemoveTestField, IMPLICIT receiver, inside a tableextension). Killed by
    // `ExtRequireCategoryFails`, which calls it on a row whose Category is blank inside
    // `asserterror`: delete the call and the procedure body is empty, no error is raised, and the
    // asserterror fails.
    //
    // `Data Main` must NOT declare a procedure named `TestField` for this to be claimed — it does
    // not; `Data Shadow` is the table that deliberately declares builtin names.
    procedure ExtRequireCategory()
    begin
        TestField(Category);
    end;

    // POSITIVE (RemoveSetRange, receiver declared as a LOCAL INSIDE the extension). Killed by
    // `ExtCountRelatedIgnoresDecoys`, which seeds out-of-filter decoy rows so the deletion widens
    // the count instead of leaving it unchanged — without decoys the mutant is equivalent and the
    // site proves nothing (spec §6).
    //
    // `"No."` here is the implicit `Rec`'s field, which is what makes this an extension-scope test
    // rather than a plain codeunit one: the receiver `Related` is visible only inside this object.
    procedure ExtCountRelated(): Integer
    var
        Related: Record "Data Related";
    begin
        Related.SetRange("Main No.", "No.");
        exit(Related.Count());
    end;
}
