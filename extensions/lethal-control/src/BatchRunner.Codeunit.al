namespace LethAL.Control;

// R69 Task 0a: same rationale as ControlApi.Codeunit.al — this file DECLARES a namespace, so the
// Code Coverage API does not resolve unqualified the way it did in the unnamespaced R58 probes.
using System.Tooling;
using System.TestTools.CodeCoverage;

/// <summary>R69: the in-session batch loop, invoked as ONE page action over the client-services
/// WebSocket. Reuses "LC Run Method" (the single-method fence primitive) per queue item so the AL
/// runs in the capable client-services session — the one that CAN CreateNavTestService — rather than
/// the fenced ODataV4 session that refuses it. Commits after every result row: each RunMethod drives
/// the platform test runner whose per-method isolation ROLLS BACK, and an uncommitted result row would
/// be rolled back with it (the project's empty-vs-empty signature bug).</summary>
codeunit 71013 "LC Batch Runner"
{
    procedure RunBatch()
    var
        Queue: Record "LC Batch Queue";
        Res: Record "LC Batch Result";
        Runner: Codeunit "LC Run Method";
        State: Codeunit "LC Control State";
        ControlApi: Codeunit "LC Control API";
        CodeCoverageMgt: Codeunit "Code Coverage Mgt.";
        Coverage: JsonArray;
        CoverageObj: JsonObject;
        CoverageJson: Text;
        ScannedRows: Integer;
        EmittedRows: Integer;
        Ok: Boolean;
        Json: Text;
        ErrText: Text;
    begin
        Res.DeleteAll(true);
        Commit();
        if not Queue.FindSet() then
            exit;
        repeat
            // Activate EVERY row, baseline included (blank Mutant Id). See ActivateForBatch: the
            // "LC Mutation Active" row outlives the session, so a baseline that skips this inherits
            // the PREVIOUS row's mutant via EnsureLoaded and runs mutated.
            State.ActivateForBatch(Queue."Target App Id", Queue."Artifact Id", Queue."Mutant Id");
            // R69 Task 0a: same StartApplicationCoverage/.../StopApplicationCoverage pairing as
            // RunMutantWithCoverage — proven in production on the fenced path. The filter is
            // mandatory, not an optimisation (see "LC Batch Queue"."Coverage Filter"'s doc comment).
            CodeCoverageMgt.StartApplicationCoverage();
            Runner.SetRequest(State.NextSuiteName(), Queue."Codeunit ID", Queue.Method);
            Ok := Runner.Run();
            CodeCoverageMgt.StopApplicationCoverage();
            if Ok then begin
                Json := Runner.Results();
                ErrText := '';
            end else begin
                Json := '';
                ErrText := CopyStr(GetLastErrorText(), 1, 2048);
            end;
            Clear(Coverage);
            ScannedRows := 0;
            EmittedRows := 0;
            Coverage := ControlApi.CoverageArray(Queue."Coverage Filter", ScannedRows, EmittedRows);
            // R69 Task 0a: "Coverage Json" holds an OBJECT — {coverage, coverageScannedRows,
            // coverageEmittedRows} — the same three keys RunMutantWithCoverage attaches to its own
            // result, not the bare array. There is only this one blob to carry the row's coverage
            // state across the commit boundary to GetBatchResults, and ScannedRows/EmittedRows must
            // survive alongside the array itself: an empty array from "no rows matched the filter"
            // must stay distinguishable from one meaning "the filter matched nothing to scan at
            // all" — the exact ambiguity CoverageArray's own doc comment calls out.
            Clear(CoverageObj);
            CoverageObj.Add('coverage', Coverage);
            CoverageObj.Add('coverageScannedRows', ScannedRows);
            CoverageObj.Add('coverageEmittedRows', EmittedRows);
            CoverageObj.WriteTo(CoverageJson);
            Res.Init();
            Res."Line No." := Queue."Line No.";
            Res."Codeunit ID" := Queue."Codeunit ID";
            Res.Method := Queue.Method;
            Res.Ok := Ok;
            Res.Attested := State.AttestationObservedAny();
            Res."Identity Mismatch" := State.AttestationMismatch();
            Res.Nonce := Queue.Nonce;
            Res."Error Text" := ErrText;
            Res.SetResultJson(Json);
            Res.SetCoverageJson(CoverageJson);
            Res.Insert(true);
            Commit();
            // Clear on EVERY terminal path — including the error path above. The active row outlives
            // the session, so a miss here runs the NEXT invocation's baseline mutated.
            State.ClearForBatch(Queue."Target App Id", Queue."Artifact Id", Queue."Mutant Id");
            Commit();
        until Queue.Next() = 0;
    end;
}
