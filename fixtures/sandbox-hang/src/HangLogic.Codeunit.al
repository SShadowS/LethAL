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
}
