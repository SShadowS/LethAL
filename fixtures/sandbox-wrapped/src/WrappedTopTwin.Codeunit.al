// twin of WrappedTop: the wrapper's #if line, as a comment
namespace LethAL.SandboxWrapped;

codeunit 78902 "Wrapped Top Twin"
{
    procedure Grow(X: Integer): Integer
    begin
        if X > 10 then
            exit(X + 1);
        exit(X);
    end;

    procedure Twice(X: Integer): Integer
    // R-300b. This header comment is load-bearing: it makes Twice's span
    // in the ORIGINAL text long enough to cover the lines Grow occupies
    // once Grow is instrumented. If al-runner reported this wrapped
    // object's lines in the original frame while LethAL reads them in the
    // instrumented frame, Twice's hits would land inside Grow: Twice's
    // mutants would lose TwiceTop and read no-coverage, and Grow's would
    // gain TwiceTop. The unwrapped twin (WrappedTopTwin) has the same
    // text on the same lines, so the gate compares the two per mutant.
    //
    // The statement-level #if below is part of the measured shape (I2).
    //
    // Do not shorten this comment, move Twice, or add a procedure to this
    // file without a new pre-commitment: the line numbers are what
    // docs/superpowers/specs/2026-10-06-r300b-wrapped-leg-precommitment.md
    // predicts from.
    //
    // (padding)
    // (padding ends)
    begin
#if WRAPDEF
        X := X * 2;
#endif
        exit(X);
    end;
}
// twin of WrappedTop: the wrapper's #endif line, as a comment
