codeunit 79600 "R402 Shape"
{
    // R729 shape 2: the then body is a single call with a trailing line comment, and `else` follows.
    // The arm that removes the call must leave `begin end`, never `then ;` before the `else`.
    procedure Run(N: Integer)
    begin
        if N = 1 then
            Foo(10) // why one
        else
            Foo(N);

        if N = 2 then
            Foo(20) /* block comment */
        else
            Foo(N);

        Foo(0);
    end;

    local procedure Foo(P: Integer)
    begin
    end;
}
