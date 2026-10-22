#if WRAPDEF and WRAPAPP
// R-300b C1, file A: compiled when BOTH symbols are defined. WRAPDEF is the
// config symbol (al-runner --define), WRAPAPP comes from app.json. LethAL
// reads A as the compiled arm. If al-runner's --define REPLACED app.json's
// symbols, al-runner would compile B instead, and A's mutants must read
// no-coverage, never another file's coverage.
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
