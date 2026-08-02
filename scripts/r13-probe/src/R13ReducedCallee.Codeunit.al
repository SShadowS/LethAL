// R13 arm A8's mutated form: `rm` reduced to `r`, which is exactly what a `PermissionReduce`
// mutant would emit at this site. If this one is refused while `R13 Grant Callee` succeeds, the
// operator has a real kill mechanism in a mode real suites use.
codeunit 71501 "R13 Reduced Callee"
{
    Permissions = tabledata Item = r;

    procedure Touch(No: Code[20])
    var
        Itm: Record Item;
    begin
        Itm.Get(No);
        Itm.Description := 'r13-reduced';
        Itm.Modify(false);
    end;
}
