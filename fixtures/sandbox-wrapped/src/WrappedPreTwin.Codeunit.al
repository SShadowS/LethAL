namespace LethAL.SandboxWrapped.Pre;
using LethAL.SandboxWrapped;

// R-300b W-pre: namespace, using and this comment sit BEFORE the wrapper.
// twin of WrappedPre: the wrapper's #if line, as a comment
codeunit 78904 "Wrapped Pre Twin"
{
    procedure Grow(X: Integer): Integer
    begin
        if X > 10 then
            exit(X + 1);
        exit(X);
    end;

    procedure Twice(X: Integer): Integer
    // R-300b. Load-bearing, as in WrappedTop: Twice's span in the
    // ORIGINAL text covers the lines Grow occupies once instrumented, so a
    // frame misread moves Twice's hits into Grow. The twin
    // (WrappedPreTwin) has the same text on the same lines.
    //
    // Do not shorten this comment, move Twice, or add a procedure to this
    // file without a new pre-commitment:
    // docs/superpowers/specs/2026-10-06-r300b-wrapped-leg-precommitment.md
    //
    // (padding)
    // (padding)
    // (padding)
    // (padding)
    // (padding)
    // (padding)
    // (padding)
    // (padding)
    // (padding)
    // (padding ends)
    begin
        exit(X * 2);
    end;
}
// twin of WrappedPre: the wrapper's #endif line, as a comment
