namespace LethAL.Control;

using System.TestTools.TestRunner;

/// <summary>
/// R198: phase 2 of a `RunMutantMany` op. A LOOP over the requested methods, one CODEUNIT.Run of
/// the test codeunit per method under the STOCK runner, in REQUEST order, behind this ONE
/// catchable boundary: a raise anywhere inside (a platform concurrency raise on a write, a missing
/// progress row) is caught by the caller's `if not Runner.Run()` so phase 3 still runs and the op
/// is never stranded.
///
/// Every method is its own CODEUNIT.Run of the test codeunit, so isolation, the test codeunit's
/// OnRun, its globals and its RequiredTestIsolation are exactly today's. MEASURED
/// (`scripts/r198-group-runner-probe/`, E1 vs E7): grouping methods under one suite run leaks one
/// method's writes into the next; this loop does not.
///
/// R206 §4 (docs/superpowers/specs/2026-09-03-r206-warm-confirmation.md): the loop no longer
/// delegates to "LC Run Method". It builds ONE suite per call (delete, create, one
/// SelectTestMethodsByRange per distinct codeunit), resolves every requested (codeunitId, method)
/// PAIR to its function line before anything runs, and per method flips two Run flags, positions a
/// record on the codeunit header line filtered to `header|function`, and runs it through
/// `Test Suite Mgt.RunTests` rather than `RunAllTests` (which Resets to the whole suite). The
/// result is read back OFF THE FUNCTION LINE RECORD (`method` from `Name`, never from the request:
/// the client's inner-method check compares that value with its request, and a request echo would
/// turn the check into a comparison of the request with itself). Run 3 on hosted SQL spent ~330 ms
/// per method rebuilding a suite and serialising every line; this is the cut.
///
/// Two named invariants the loop implements itself now that it no longer delegates, both pinned by
/// `packages/runner/tests/control-app-source.test.ts`:
///   PROGRESS_BETWEEN_FIRST: `ProgressBetween` is the FIRST statement after `RunTests` returns,
///     before the function line is re-read, before any CalcFields on the error BLOBs, before the
///     JSON is built. R204's after-408 narrowing reads `lastCompletedIndex`; anything placed
///     between the run's return and that write widens its false-kill branch.
///   LOOP_READS_LEASE_ONLY: after each `between` Commit, a plain Get of the marker (IsOwnRunActive)
///     in a fresh transaction; start nothing once the op is no longer ours.
///
/// Three terminations, always named in the answer (`endedBy`: complete | failure | cap), and
/// `ranCount` is the number of entries, at least 1: method 1 ALWAYS starts (the client never asks
/// for a method whose budget cannot fit the ceiling); from method 2 on, a method is started only
/// if `elapsed + budget + grace` fits inside the ceiling, so a stop for it can still land inside
/// the call (the cap bounds STARTS; only TryStopHungRunAt ends a running method).
///
/// A request that does not RESOLVE (a pair matching zero or several function lines, or two pairs
/// resolving to one line) is refused as a whole BEFORE any method runs: `Unresolved()` is true,
/// `UnresolvedReason()` names the pair and the count, and the caller answers the call-level status
/// `suite-unresolved`, which the client routes to a session abort with these words (a test app that
/// does not resolve is not a per-mutant fact).
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
        SuiteUnresolved: Boolean;
        SuiteUnresolvedReason: Text;

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
        SuiteUnresolved := false;
        SuiteUnresolvedReason := '';
    end;

    /// <summary>{endedBy, ranCount, methods: [{index, codeunitId, method, lineNo, sessionId,
    /// codeunitResults, durationMs}]}, meaningful only when Run() returned true and Unresolved()
    /// is false.</summary>
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

    /// <summary>R206 §4 item 1: true when a requested pair did not resolve to exactly one function
    /// line, or two pairs resolved to one. Nothing ran. The caller answers `suite-unresolved`.</summary>
    procedure Unresolved(): Boolean
    begin
        exit(SuiteUnresolved);
    end;

    procedure UnresolvedReason(): Text
    begin
        exit(SuiteUnresolvedReason);
    end;

    local procedure RunAll(): Text
    var
        State: Codeunit "LC Control State";
        Mgt: Codeunit "Test Suite Mgt.";
        ALTestSuite: Record "AL Test Suite";
        Line: Record "Test Method Line";
        RunLine: Record "Test Method Line";
        FnLine: Record "Test Method Line";
        Methods: JsonArray;
        Entry: JsonToken;
        EntryObj: JsonObject;
        Out: JsonObject;
        Ran: JsonArray;
        One: JsonObject;
        SuiteName: Code[10];
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
        FnLineNos: List of [Integer];
        HeaderLineNos: List of [Integer];
        HeaderNames: List of [Text];
        FnLineNo: Integer;
        PrevFnLineNo: Integer;
        HeaderLineNo: Integer;
        I: Integer;
    begin
        if FenceAttemptId = '' then
            Error('LC Run Many: SetRequest was not called with a fence; the loop runs only inside a claimed op.');
        if not Methods.ReadFrom(MethodsJson) then
            Error('LC Run Many: testMethods is not a JSON array: %1', CopyStr(MethodsJson, 1, 200));
        Count := Methods.Count();
        if Count = 0 then
            Error('LC Run Many: testMethods is empty; a call that runs nothing is a caller-contract violation, not an empty answer.');

        // Build the suite ONCE per call (R206 §4 item 1), then resolve every pair before any method
        // runs. `NextSuiteName` restarts per session, so the name recurs across calls and each call
        // cleans the previous one's rows.
        SuiteName := State.NextSuiteName();
        if ALTestSuite.Get(SuiteName) then
            ALTestSuite.Delete(true);
        Mgt.CreateTestSuite(SuiteName);
        ALTestSuite.Get(SuiteName);
        SelectDistinctCodeunits(Mgt, ALTestSuite, Methods);

        Line.SetRange("Test Suite", SuiteName);
        Line.SetRange("Line Type", Line."Line Type"::"Function");
        if Line.FindSet() then
            repeat
                Line.Validate(Run, false);
                Line.Modify(true);
            until Line.Next() = 0;

        if not ResolvePairs(SuiteName, Methods, FnLineNos, HeaderLineNos, HeaderNames) then
            exit('');

        T0 := CurrentDateTime;
        EndedBy := 'complete';
        PrevFnLineNo := 0;
        I := 0;
        foreach Entry in Methods do begin
            I += 1;
            EntryObj := Entry.AsObject();
            Index := ReadInt(EntryObj, 'index');
            CodeunitId := ReadInt(EntryObj, 'codeunitId');
            MethodName := ReadText(EntryObj, 'method');
            BudgetMs := ReadInt(EntryObj, 'budgetMs');
            if Index <> I then
                Error('LC Run Many: testMethods must be numbered 1..N in order; entry %1 carries index %2.', I, Index);
            FnLineNo := FnLineNos.Get(I);
            HeaderLineNo := HeaderLineNos.Get(I);

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

            // Two Run-flag updates per method: the previous function line off, this one on. Every
            // other line has been false since the suite was built (a second guard behind the
            // runner's own line filter below).
            if PrevFnLineNo <> 0 then begin
                Line.Get(SuiteName, PrevFnLineNo);
                Line.Validate(Run, false);
                Line.Modify(true);
            end;
            Line.Get(SuiteName, FnLineNo);
            Line.Validate(Run, true);
            Line.Modify(true);
            PrevFnLineNo := FnLineNo;

            // The progress row's `running` write, inside this boundary (a raise here is caught by
            // the caller, so phase 3 still runs), own Commit.
            State.ProgressBegin(FenceAttemptId, FenceOpSeq, Index, CodeunitId, MethodName);

            // Position the record on the codeunit header line, filtered to exactly the header and
            // this function line. Runner 130450 copies this record in OnRun BEFORE TestRunnerMgt
            // widens its own copy, so PlatformBeforeTestRun admits exactly this function; and
            // `TestRunnerMgt.RunTests` ranges on the record's CURRENT "Test Suite" value, so an
            // unpositioned record would silently run nothing (R206 §4 item 2).
            RunLine.Reset();
            RunLine.SetRange("Test Suite", SuiteName);
            RunLine.SetFilter("Line No.", '%1|%2', HeaderLineNo, FnLineNo);
            RunLine.FindFirst();
            TStart := CurrentDateTime;
            State.NoteTestMethodRun();
            Mgt.RunTests(RunLine, ALTestSuite);
            // PROGRESS_BETWEEN_FIRST (R198): the very next statement after the run returns.
            State.ProgressBetween(FenceAttemptId, FenceOpSeq, Index);

            // Read the result back off the FUNCTION line record (R206 §4 item 3). The codeunit
            // header line's Result is never read: under suite reuse UpdateCodeunitLine scans every
            // function line of the codeunit, earlier methods' results included.
            FnLine.Get(SuiteName, FnLineNo);
            Result := FnLine.Result;

            Clear(One);
            One.Add('index', Index);
            One.Add('codeunitId', CodeunitId);
            One.Add('method', MethodName);
            One.Add('lineNo', FnLineNo);
            One.Add('sessionId', SessionId());
            One.Add('codeunitResults', FunctionLineResults(Mgt, FnLine, CodeunitId, HeaderNames.Get(I)));
            One.Add('durationMs', DurationMs(CurrentDateTime - TStart));
            Ran.Add(One);

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

    /// <summary>One SelectTestMethodsByRange per DISTINCT codeunit in the request, in first-seen
    /// order. Selecting a codeunit twice would insert its lines twice.</summary>
    local procedure SelectDistinctCodeunits(var Mgt: Codeunit "Test Suite Mgt."; var ALTestSuite: Record "AL Test Suite"; Methods: JsonArray)
    var
        Entry: JsonToken;
        Seen: List of [Integer];
        CodeunitId: Integer;
    begin
        foreach Entry in Methods do begin
            CodeunitId := ReadInt(Entry.AsObject(), 'codeunitId');
            if not Seen.Contains(CodeunitId) then begin
                Seen.Add(CodeunitId);
                Mgt.SelectTestMethodsByRange(ALTestSuite, Format(CodeunitId));
            end;
        end;
    end;

    /// <summary>R206 §4 item 1: resolve every requested (codeunitId, method) PAIR to its function
    /// line and its codeunit header line, keyed on BOTH fields (two test codeunits sharing a method
    /// name is ordinary in a BC test app). A pair matching zero or several lines, or two pairs
    /// matching one line, sets Unresolved with a reason naming the pair and the count, and the
    /// caller refuses the whole call before any method runs. Returns false on refusal.</summary>
    local procedure ResolvePairs(SuiteName: Code[10]; Methods: JsonArray; var FnLineNos: List of [Integer]; var HeaderLineNos: List of [Integer]; var HeaderNames: List of [Text]): Boolean
    var
        Line: Record "Test Method Line";
        Header: Record "Test Method Line";
        Entry: JsonToken;
        EntryObj: JsonObject;
        CodeunitId: Integer;
        MethodName: Text;
        MatchCount: Integer;
        Position: Integer;
        Earlier: Integer;
    begin
        foreach Entry in Methods do begin
            Position += 1;
            EntryObj := Entry.AsObject();
            CodeunitId := ReadInt(EntryObj, 'codeunitId');
            MethodName := ReadText(EntryObj, 'method');

            Line.Reset();
            Line.SetRange("Test Suite", SuiteName);
            Line.SetRange("Line Type", Line."Line Type"::"Function");
            Line.SetRange("Test Codeunit", CodeunitId);
            Line.SetRange(Name, MethodName);
            MatchCount := Line.Count();
            if MatchCount <> 1 then begin
                SuiteUnresolved := true;
                SuiteUnresolvedReason := StrSubstNo('expected exactly one method %1 in codeunit %2, found %3', MethodName, CodeunitId, MatchCount);
                exit(false);
            end;
            Line.FindFirst();
            if FnLineNos.Contains(Line."Line No.") then begin
                Earlier := FnLineNos.IndexOf(Line."Line No.");
                SuiteUnresolved := true;
                SuiteUnresolvedReason := StrSubstNo('entries %1 and %2 (%3.%4) resolve to the same function line %5', Earlier, Position, CodeunitId, MethodName, Line."Line No.");
                exit(false);
            end;
            FnLineNos.Add(Line."Line No.");

            Header.Reset();
            Header.SetRange("Test Suite", SuiteName);
            Header.SetRange("Line Type", Header."Line Type"::Codeunit);
            Header.SetRange("Test Codeunit", CodeunitId);
            if not Header.FindFirst() then begin
                SuiteUnresolved := true;
                SuiteUnresolvedReason := StrSubstNo('no codeunit header line for codeunit %1 (entry %2, %3)', CodeunitId, Position, MethodName);
                exit(false);
            end;
            HeaderLineNos.Add(Header."Line No.");
            HeaderNames.Add(Header.Name);
        end;
        exit(true);
    end;

    /// <summary>The per-method `codeunitResults` in the shape the client reads off
    /// `TestResultsToJSON`'s answer: {name, codeUnit, testResults: [{method, startTime, finishTime,
    /// result, message?, stackTrace?}]}, one line, every value READ OFF THE FUNCTION LINE RECORD,
    /// with the stack trace's `\`→`;` and `"` stripping copied from TestResultsToJSON so R121's
    /// screen sees byte-identical text. The AllObj/installed-app keys and the codeunit-level result
    /// are not produced: the client reads none of them, and the queries behind them were part of
    /// the per-method cost this rewrite removes.</summary>
    local procedure FunctionLineResults(var Mgt: Codeunit "Test Suite Mgt."; var FnLine: Record "Test Method Line"; CodeunitId: Integer; HeaderName: Text): JsonObject
    var
        CodeunitResult: JsonObject;
        TestResults: JsonArray;
        TestResult: JsonObject;
        ResultInteger: Integer;
        ConvertedText: Text;
    begin
        CodeunitResult.Add('name', HeaderName);
        CodeunitResult.Add('codeUnit', CodeunitId);
        TestResult.Add('method', FnLine.Name);
        TestResult.Add('startTime', FnLine."Start Time");
        TestResult.Add('finishTime', FnLine."Finish Time");
        ResultInteger := FnLine.Result;
        TestResult.Add('result', ResultInteger);
        if FnLine.Result = FnLine.Result::Failure then begin
            TestResult.Add('message', Mgt.GetFullErrorMessage(FnLine));
            ConvertedText := Mgt.GetErrorCallStack(FnLine);
            ConvertedText := ConvertedText.Replace('\', ';');
            ConvertedText := ConvertedText.Replace('"', '');
            TestResult.Add('stackTrace', ConvertedText);
        end;
        TestResults.Add(TestResult);
        CodeunitResult.Add('testResults', TestResults);
        exit(CodeunitResult);
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
