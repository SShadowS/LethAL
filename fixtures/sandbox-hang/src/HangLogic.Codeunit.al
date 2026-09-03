codeunit 79400 "Hang Logic"
{
    var
        Counter: Integer;
        Rows: Integer;
        Walked: Integer;

    /// <summary>
    /// R53's shape, made deterministic.
    ///
    /// Measured on Continia Document Output, M0013 is `negate-conditional` on
    /// `until DOCustSetup.Next() = 0;` — which becomes `&lt;&gt; 0` and never terminates once the
    /// recordset is exhausted, because `Next()` returns 0 forever from then on. That hang depends
    /// on table data, which makes it useless as a fixture: it would hang or not depending on what
    /// happened to be in the table when the run started.
    ///
    /// This carries the same PROPERTY with none of the data dependency. The loop advances only
    /// through `Advance()`, so the mutant that DELETES that call (`lethal.void-method-call`) leaves
    /// `Counter` at 0 and `Counter >= Limit` false forever. Unmutated it terminates in `Limit`
    /// iterations.
    ///
    /// The increment is a CALL rather than an inline `Counter += 1` deliberately: measured with
    /// `--dry-run`, `lethal.empty-block` claims the PROCEDURE body here, not the loop body, so an
    /// inline increment produced no hanging mutant at all — the empty-bodied procedure just
    /// returns 0 and the test fails, which is an ordinary kill. The fixture only earns its name if
    /// some mutant genuinely never returns.
    ///
    /// NOTHING BOUNDS THIS LOOP, on purpose. A self-limiting hang would prove nothing: the whole
    /// question is whether LethAL can end a run that will not end by itself. It is safe to publish
    /// because the mutant is inert until the selector activates it, and the run that activates it
    /// is the run that stops it.
    /// </summary>
    procedure CountUpTo(Limit: Integer): Integer
    begin
        Counter := 0;
        repeat
            Advance();
        until Counter >= Limit;
        exit(Counter);
    end;

    local procedure Advance()
    begin
        Counter += 1;
    end;

    /// <summary>
    /// R164's arm, and the same design principle as `CountUpTo` above: the canonical BC hang made
    /// DETERMINISTIC.
    ///
    /// The shape R164 is about is `repeat BODY until Rec.Next() = 0`, whose `negate-conditional`
    /// mutant (`&lt;&gt; 0`) never terminates once the recordset is exhausted. A real recordset would make
    /// the fixture depend on table data, so `NextRow` reproduces BC's `Next()` CONTRACT instead:
    /// 1 while rows remain, 0 once exhausted, and 0 forever after. No table, same property.
    ///
    /// `WalkOneRow` drives it over exactly ONE row, which is the case that hangs. It is also the
    /// case where `loop-truncate` is an EQUIVALENT mutant: truncating a one-iteration loop to one
    /// iteration changes nothing, and the operator's doc comment says so before the verdict arrives.
    /// Killability is proven by the OTHER loop in this file, `CountUpTo`, whose test drives three.
    /// </summary>
    local procedure NextRow(): Integer
    begin
        if Walked >= Rows then
            exit(0);
        exit(1);
    end;

    procedure WalkOneRow(): Integer
    begin
        Rows := 1;
        Walked := 0;
        repeat
            Walked += 1;
        until NextRow() = 0;
        exit(Walked);
    end;

    /// <summary>
    /// R179's arm: a `while` loop whose BODY advances its own condition, which is every terminating
    /// `while` loop by construction (if the body did not move the condition, the original would
    /// never end).
    ///
    /// That is what makes `empty-block` on a `while` body structurally non-terminating: emptying the
    /// body freezes the condition forever. MEASURED on `do-rel2/Cloud` at 19 `while` bodies, the
    /// largest of the three non-termination sources found so far, and larger than R173's 7.
    ///
    /// `loop-skip` asks the same question -- does anything notice if this body never runs -- as
    /// `while false`, which cannot hang on any input. This arm exists so the cession is MEASURED
    /// rather than argued: `empty-block`'s mutant here is scored `timeout-killed` BEFORE the cession
    /// lands, and afterwards that row is gone.
    ///
    /// `conditional-boundary` on `Pending > 0` is the CONTROL. It is R173's shape, `>` to `>=`, and
    /// here it TERMINATES: `Pending` reaches 0, runs one extra lap, reaches -1 and the test fails.
    /// R173's 7 hazardous sites are all `StrPos(...) > 0`, where the value cannot go below 0. Same
    /// syntax, opposite outcome, which is exactly why R173 refuses to cede on syntax alone.
    /// </summary>
    procedure DrainQueue(Depth: Integer): Integer
    var
        Pending: Integer;
        Drained: Integer;
    begin
        Pending := Depth;
        while Pending > 0 do begin
            Pending -= 1;
            Drained += 1;
        end;
        exit(Drained);
    end;

    /// <summary>
    /// R206's arm: the only live exercise of a WARM timeout, and of the warm confirmation's
    /// replay. Two tests cover this procedure. `SpinUntilAtZeroExitsEarly` takes the early exit
    /// and asserts -1; `SpinUntilReachesTheTarget` drives the same unbounded counter loop as
    /// `CountUpTo` and asserts 3. Under `void-method-call` on `Advance()` the first PASSES and the
    /// second HANGS, so the hang lands at group position 2 of one `RunMutantMany` call and is
    /// scored `timeout-killed` only after methods 1..2 are replayed unmutated and method 2
    /// completes inside its budget (`killPosition` 2). The loop's other kills (`conditional-
    /// boundary` on the `until`, `loop-truncate`, `return-value`) are warm `fail`s at position 2
    /// by the same order.
    ///
    /// DESIGNED AROUND THE KILL LEDGER, which is `orderCoveringTests`'s FIRST sort key. The guard
    /// returns a DISTINCTIVE value (-1) that the early-exit test asserts, so every mutant of the
    /// guard line (negate-conditional, conditional-boundary, return-value, the branch and
    /// whole-body empty-blocks) is killed by the early-exit test at position 1 FIRST, in manifest
    /// order, and from then on the ledger keeps that test first for everything after. A guard that
    /// returned 0 would leave `empty-block` (returns 0) to the loop test, the ledger would then put
    /// that test first, and the hang would land at position 1 with no replay.
    ///
    /// SHARES `Advance()` rather than copying it, so the arm adds exactly ONE hang (this
    /// procedure's `void-method-call`), and `Advance`'s two existing hangs gain this arm's loop
    /// test as a second covering test. The test NAMES are load-bearing: that second test sorts
    /// AFTER `CountUpToReachesTheLimit` (`C` &lt; `S`) on the members tie, so the existing rows keep
    /// `killPosition` 1, and the early-exit test sorts before it (`A` &lt; `R`) on the name key alone,
    /// so the arm survives a run under `coverageMode: "none"`.
    ///
    /// NOTHING BOUNDS THE LOOP, for the same reason `CountUpTo`'s is unbounded: the fixture only
    /// earns its name if some mutant genuinely never returns.
    /// </summary>
    procedure SpinUntil(Target: Integer): Integer
    begin
        if Target <= 0 then
            exit(-1);
        Counter := 0;
        repeat
            Advance();
        until Counter >= Target;
        exit(Counter);
    end;
}
