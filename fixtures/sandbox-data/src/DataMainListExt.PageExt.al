// R30's `pageextension` half: a Tier-2 site whose receiver is DECLARED INSIDE a pageextension.
//
// Until 2026-07-31 `buildSymbolTable` indexed a `pageextension`'s members NOWHERE — the node
// matched neither the tableextension branch nor the object-kind map and fell through the loop — so
// `lookupVar` found nothing here and every such call was refused as an unresolvable receiver.
// Measured on Continia Document Output Cloud (`scripts/probe-r30-pageext.ts`): 18 sites of exactly
// this shape, against ZERO calls on a pageextension's implicit `Rec`.
//
// The implicit `Rec` is still refused here, and that refusal is deliberate: a page's record is its
// `SourceTable`, declared on the EXTENDED page, which in a real project is routinely a dependency
// the source cannot see. Zero of Document Output's 93 pageextensions extend a page it declares.
//
// WHY THE WORK HAPPENS IN `OnOpenPage`: a pageextension's procedures are not callable from a test
// codeunit — nothing outside the page can name them. A trigger is reachable, through a `TestPage`.
// That is the only way this object's code can execute at all, and whether it executes in LethAL's
// `GuiAllowed=No` / `ClientType=ODataV4` session (R57/R60) is what `PageExtCountsMatchingRelated`
// answers on the live gate.
pageextension 79321 "Data Main List Ext" extends "Data Main List"
{
    // GLOBALS, not trigger locals, and the difference is load-bearing. `lookupVar` resolves
    // procedure locals, procedure parameters and object globals — a variable declared in a
    // TRIGGER's own `var` section is not indexed in any object kind, so the site would be refused
    // as unresolvable (rule 4) and this fixture would prove nothing about pageextension scope.
    // Measured, not assumed: with these two declared inside `OnOpenPage`, the file generated four
    // specs and NOT ONE of them was `remove-setrange`. (That trigger-local gap is R68.)
    var
        Related: Record "Data Related";
        Main: Record "Data Main";

    trigger OnOpenPage()
    begin
        // POSITIVE (RemoveSetRange, receiver declared as a trigger LOCAL inside a pageextension).
        // Killed by `PageExtCountsMatchingRelated`, which seeds out-of-filter decoys so deleting
        // the filter widens the count.
        Related.SetRange("Main No.", 'P-EXT');
        // The count has to leave the page to be assertable, so it is written onto a Data Main row
        // the test reads back. `Modify()` (i.e. RunTrigger = false) on purpose: running OnModify
        // would add 1 to the very field being asserted.
        if Main.Get('P-EXT') then begin
            Main."Modify Count" := Related.Count();
            Main.Modify();
        end;
    end;
}
