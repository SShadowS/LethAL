codeunit 50010 "P10 Case"
{
    procedure Run(X: Integer)
    begin
#if Foo
        Helper(X);
#else
        Helper(X + 1);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
