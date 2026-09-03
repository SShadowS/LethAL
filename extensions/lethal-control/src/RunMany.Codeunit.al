namespace LethAL.Control;

/// <summary>
/// R198: phase 2 of a `RunMutantMany` op. A LOOP of "LC Run Method" (today's single-method suite
/// run, verbatim), one method per iteration, in REQUEST order, behind this ONE catchable boundary:
/// a raise anywhere inside (a platform concurrency raise on a write, a missing progress row) is
/// caught by the caller's `if not Runner.Run()` so phase 3 still runs and the op is never stranded.
///
/// Every method is its own CODEUNIT.Run of the test codeunit under the STOCK runner, so isolation,
/// the test codeunit's OnRun, its globals and its RequiredTestIsolation are exactly today's.
/// MEASURED (`scripts/r198-group-runner-probe/`, E1 vs E7): grouping methods under one suite run
/// leaks one method's writes into the next; this loop does not.
///
/// Three terminations, always named in the answer (`endedBy`: complete | failure | cap), and
/// `ranCount` is the number of entries, at least 1: method 1 ALWAYS starts (the client never asks
/// for a method whose budget cannot fit the ceiling); from method 2 on, a method is started only
/// if `elapsed + budget + grace` fits inside the ceiling, so a stop for it can still land inside
/// the call (the cap bounds STARTS; only TryStopHungRunAt ends a running method).
///
/// After each method the loop re-reads the marker (LOOP_READS_LEASE_ONLY: a plain Get in its own
/// transaction, after the `between` Commit) and starts nothing further once the op is no longer
/// its own; phase 3 remains the single source of that answer.
/// </summary>
codeunit 91012 "LC Run Many"
{
    var
        FenceAttemptId: Text;
        FenceOpSeq: BigInteger;
        MethodsJson: Text;
        StopAtFirstFailure: Boolean;
        RequestCeilingMs: Integer;
        StopGraceMs: Integer;
        ResultsJson: Text;
        Displaced: Boolean;

    trigger OnRun()
    begin
        ResultsJson := RunAll();
    end;

    procedure SetRequest(AttemptId: Text; OpSeq: BigInteger; NewMethodsJson: Text; NewStopAtFirstFailure: Boolean; NewRequestCeilingMs: Integer; NewStopGraceMs: Integer)
    begin
        FenceAttemptId := AttemptId;
        FenceOpSeq := OpSeq;
        MethodsJson := NewMethodsJson;
        StopAtFirstFailure := NewStopAtFirstFailure;
        RequestCeilingMs := NewRequestCeilingMs;
        StopGraceMs := NewStopGraceMs;
        ResultsJson := '';
        Displaced := false;
    end;

    /// <summary>{endedBy, ranCount, methods: [{index, codeunitId, method, codeunitResults, durationMs}]},
    /// meaningful only when Run() returned true.</summary>
    procedure Results(): Text
    begin
        exit(ResultsJson);
    end;

    /// <summary>True when the loop found the marker no longer its own and stopped starting
    /// methods. Phase 3 will refuse; the caller reports that refusal, never these results.</summary>
    procedure WasDisplaced(): Boolean
    begin
        exit(Displaced);
    end;

    local procedure RunAll(): Text
    var
        State: Codeunit "LC Control State";
        Runner: Codeunit "LC Run Method";
        Methods: JsonArray;
        Entry: JsonToken;
        EntryObj: JsonObject;
        Out: JsonObject;
        Ran: JsonArray;
        One: JsonObject;
        OneResults: JsonObject;
        OneText: Text;
        EndedBy: Text;
        Index: Integer;
        CodeunitId: Integer;
        MethodName: Text;
        BudgetMs: Integer;
        T0: DateTime;
        TStart: DateTime;
        Elapsed: Duration;
        OutText: Text;
        Count: Integer;
        Result: Integer;
    begin
        if FenceAttemptId = '' then
            Error('LC Run Many: SetRequest was not called with a fence; the loop runs only inside a claimed op.');
        if not Methods.ReadFrom(MethodsJson) then
            Error('LC Run Many: testMethods is not a JSON array: %1', CopyStr(MethodsJson, 1, 200));
        Count := Methods.Count();
        if Count = 0 then
            Error('LC Run Many: testMethods is empty; a call that runs nothing is a caller-contract violation, not an empty answer.');

        T0 := CurrentDateTime;
        EndedBy := 'complete';
        foreach Entry in Methods do begin
            EntryObj := Entry.AsObject();
            Index := ReadInt(EntryObj, 'index');
            CodeunitId := ReadInt(EntryObj, 'codeunitId');
            MethodName := ReadText(EntryObj, 'method');
            BudgetMs := ReadInt(EntryObj, 'budgetMs');
            if Index <> Ran.Count() + 1 then
                Error('LC Run Many: testMethods must be numbered 1..N in order; entry %1 carries index %2.', Ran.Count() + 1, Index);

            if Index >= 2 then begin
                // Headroom cap: never start a method whose budget plus the stop's grace cannot be
                // spent inside the ceiling. Method 1 is exempt (the client sends an unfittable
                // method alone through RunMutant, which has no ceiling).
                Elapsed := CurrentDateTime - T0;
                if Elapsed + BudgetMs + StopGraceMs > RequestCeilingMs then begin
                    EndedBy := 'cap';
                    break;
                end;
                // LOOP_READS_LEASE_ONLY: after the previous method's `between` Commit, in a fresh
                // transaction, a plain Get. Start nothing once the op is no longer ours.
                if not State.IsOwnRunActive(FenceAttemptId, FenceOpSeq) then begin
                    Displaced := true;
                    EndedBy := 'cap';
                    break;
                end;
            end;

            Runner.SetRequest(State.NextSuiteName(), CodeunitId, MethodName);
            Runner.SetFence(FenceAttemptId, FenceOpSeq, Index);
            TStart := CurrentDateTime;
            if not Runner.Run() then
                // A raise inside one method's suite run is a raise inside phase 2: re-raise so the
                // caller's boundary reports a runError for the whole call (never a per-method verdict
                // for a method whose run did not complete its own bookkeeping).
                Error(GetLastErrorText());
            OneText := Runner.Results();

            Clear(One);
            One.Add('index', Index);
            One.Add('codeunitId', CodeunitId);
            One.Add('method', MethodName);
            Clear(OneResults);
            if OneResults.ReadFrom(OneText) then
                One.Add('codeunitResults', OneResults)
            else
                One.Add('codeunitResults', OneText);
            One.Add('durationMs', DurationMs(CurrentDateTime - TStart));
            Ran.Add(One);

            Result := FirstLineResult(OneResults);
            if StopAtFirstFailure and (Result <> 2) then begin
                EndedBy := 'failure';
                break;
            end;
        end;

        Out.Add('endedBy', EndedBy);
        Out.Add('ranCount', Ran.Count());
        Out.Add('methods', Ran);
        Out.WriteTo(OutText);
        exit(OutText);
    end;

    /// <summary>The `result` of the ONE function line in a single-method suite answer, or -1 when
    /// the answer does not carry exactly one (the client refuses such an entry; the loop only needs
    /// to know whether to stop). 0 blank, 1 failure, 2 success, 3 skipped, per the Test Runner app.</summary>
    local procedure FirstLineResult(Results: JsonObject): Integer
    var
        Tok: JsonToken;
        Lines: JsonArray;
        Line: JsonToken;
        LineObj: JsonObject;
    begin
        if not Results.Get('testResults', Tok) then
            exit(-1);
        if not Tok.IsArray() then
            exit(-1);
        Lines := Tok.AsArray();
        if Lines.Count() <> 1 then
            exit(-1);
        Lines.Get(0, Line);
        LineObj := Line.AsObject();
        if not LineObj.Get('result', Tok) then
            exit(-1);
        exit(Tok.AsValue().AsInteger());
    end;

    local procedure ReadInt(Obj: JsonObject; KeyName: Text): Integer
    var
        Tok: JsonToken;
    begin
        if not Obj.Get(KeyName, Tok) then
            Error('LC Run Many: testMethods entry lacks "%1".', KeyName);
        exit(Tok.AsValue().AsInteger());
    end;

    local procedure ReadText(Obj: JsonObject; KeyName: Text): Text
    var
        Tok: JsonToken;
    begin
        if not Obj.Get(KeyName, Tok) then
            Error('LC Run Many: testMethods entry lacks "%1".', KeyName);
        exit(Tok.AsValue().AsText());
    end;

    local procedure DurationMs(Elapsed: Duration): Integer
    begin
        exit(Elapsed div 1);
    end;
}
