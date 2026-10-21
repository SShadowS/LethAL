#if WRAPDEF
namespace LethAL.SandboxWrapped;

// R545: a one-arm wrapped PAGE EXTENSION alone in its file. `Scaled` is reached by calling it on a
// variable of the extended page (no TestPage, which the fenced session refuses); `OnOpenPage` is
// never run. Its unwrapped twin (WrappedXtraTwin) has the same text on the same lines. Do not move
// a line without a new pre-commitment.
pageextension 78911 "Wrapped Xtra" extends "Wrapped View"
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
#endif
