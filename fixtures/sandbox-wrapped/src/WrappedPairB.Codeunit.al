#if not WRAPDEF or not WRAPAPP
// R-300b C1, file B: the same object as file A, compiled only when A is
// not. LethAL reads it as compiled out, so it is never indexed and carries
// no mutant. Same behaviour as A, so the test passes whichever is compiled.
codeunit 78905 "Wrapped Pair"
{
    procedure Pick(X: Integer): Integer
    begin
        if X > 0 then
            exit(1);
        exit(0);
    end;
}
#endif
