// twin of WrappedXtra: the wrapper's #if line, as a comment
namespace LethAL.SandboxWrapped;

// R545: a one-arm wrapped PAGE EXTENSION alone in its file. `Scaled` is reached by calling it on a
// variable of the extended page (no TestPage, which the fenced session refuses); `OnOpenPage` is
// never run. Its unwrapped twin (WrappedXtraTwin) has the same text on the same lines. Do not move
// a line without a new pre-commitment.
pageextension 78912 "Wrapped Xtra Twin" extends "Wrapped View Twin"
{
    var
        Seen: Boolean;

    trigger OnOpenPage()
    begin
        Seen := true;
    end;

    procedure Scaled(X: Integer): Integer
    begin
        if X > 2 then
            exit(X * 10);
        exit(0);
    end;
}
// twin of WrappedXtra: the wrapper's #endif line, as a comment
