codeunit 79701 "Layout Beta"
{
    procedure Grow(X: Integer): Integer
    begin
        if X > 10 then
            exit(X + 1);
        exit(X);
    end;

    procedure Twice(X: Integer): Integer
    // R353. This header comment is load-bearing: it is what makes Twice's
    // span in the UNINSTRUMENTED text long enough to hold every line that
    // Grow occupies once Grow is instrumented.
    //
    // At maxGuardsPerBatch 7 this file is batch 1 and Layout Alpha is
    // batch 0. Batch 0 copies this file verbatim, so the coverage index
    // built during batch 0 knows this layout: Grow on lines 3 to 8 and
    // Twice on lines 10 to 39. Batch 1 instruments this file, and Grow
    // then runs from line 6 to line 41 of the emitted text.
    //
    // With R349's reset, batch 1 rebuilds the index from its own text, so
    // every line Grow executes is Grow's and every line Twice executes is
    // Twice's. Without it, a line of the instrumented Grow before line 9
    // is still Grow, but every executed line from 10 to 39 is read as
    // Twice, and every line of the instrumented Twice (from line 43 on)
    // is past the end of this 40-line file and names no procedure.
    // So Twice's two mutants LOSE their own test, TwiceOfThree, and GAIN
    // GrowAboveTen, which never calls Twice: both go from killed to
    // survived. Grow's five mutants keep GrowAboveTen and do not move.
    //
    // Do not shorten this comment, move Twice, or add a procedure to this
    // file without a new pre-commitment: the line numbers above are what
    // docs/superpowers/specs/2026-09-30-r353-stale-layout-precommitment.md
    // predicts from.
    //
    // (padding ends)
    begin
        exit(X * 2);
    end;
}
