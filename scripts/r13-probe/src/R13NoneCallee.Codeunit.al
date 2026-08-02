// R13 arm A8's floor: no `Permissions` property at all — what almost every AL object looks like.
// It separates "the grant did it" from "the lowered session did it".
codeunit 71502 "R13 None Callee"
{
    procedure Touch(No: Code[20])
    var
        Itm: Record Item;
    begin
        Itm.Get(No);
        Itm.Description := 'r13-none';
        Itm.Modify(false);
    end;
}
