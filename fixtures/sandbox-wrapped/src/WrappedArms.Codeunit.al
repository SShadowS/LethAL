#if WRAPDEF
// R-300b refusal control: a TWO-ARM wrapper, a shape al-runner is not
// admitted on. Its mutants read no-coverage, refused by name.
codeunit 78906 "Wrapped Arms"
{
    procedure Pick(X: Integer): Integer
    begin
        if X > 0 then
            exit(1);
        exit(0);
    end;
}
#else
codeunit 78906 "Wrapped Arms"
{
    procedure Pick(X: Integer): Integer
    begin
        exit(1);
    end;
}
#endif
