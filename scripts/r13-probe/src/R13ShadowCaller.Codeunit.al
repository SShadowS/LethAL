// R13 arm A9: does a CALLER's grant cover a write its callee performs?
//
// This decides which cost bar `PermissionReduce` is judged against. If a caller's grant does NOT
// reach into a callee, then a reduction could be emitted through the EXISTING guarded emit path —
// `if Active(id) then Shadow.Write(Rec) else Rec.Modify()`, where `Shadow` carries the reduced
// grant — and the operator would be a new predicate rather than a new pipeline (bar (a), not bar
// (b)). If the caller's grant DOES cover the callee, that routing cannot reduce anything and the
// only way to express the mutation is to edit the property in place, which needs one artifact per
// mutant.
codeunit 71503 "R13 Shadow Caller"
{
    Permissions = tabledata Item = rm;

    // Grants rm, writes nothing itself: the write happens inside a callee granting only `r`.
    procedure TouchViaReducedCallee(No: Code[20])
    var
        Reduced: Codeunit "R13 Reduced Callee";
    begin
        Reduced.Touch(No);
    end;
}
