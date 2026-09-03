namespace LethAL.Control;

using System.Reflection;
// R58: the Code Coverage API. "Code Coverage" (the table) lives in System.Tooling; the management
// codeunit in System.TestTools.CodeCoverage. Needed because this file DECLARES a namespace — the
// R58 probes resolved the same names unqualified only because they declare none and therefore sit
// in the global namespace.
using System.Tooling;
using System.TestTools.CodeCoverage;

/// <summary>The OData-exposed control surface (registered as a web service by the install codeunit;
/// procedures are OData V4 unbound actions /ODataV4/LethALControl_&lt;Proc&gt;). Layer 5C-A.</summary>
codeunit 91003 "LC Control API"
{
    /// <summary>Identity + capabilities the client verifies before any execution. PROTOCOL V2 (design
    /// §7, R4 sol#8): ClientProtocol is a REQUIRED argument, not an optional one with a default — a v1
    /// client that calls with no argument at all (an OData body of `{}`) must fail to reach a valid v2
    /// payload, so a v1 client can never silently talk to a v2 server. `alc` cannot prove that an
    /// omitted argument is genuinely refused rather than silently defaulted (that is wire/runtime
    /// behavior, not something a compile checks); confirming it is the live probe's job (design §7), not
    /// this comment's. Independently of how the OData layer handles a truly missing argument, a SUPPLIED
    /// ClientProtocol &lt; 2 is rejected explicitly below, so a caller that deliberately downgrades (or a
    /// hypothetical mismatched server on the other side of a v2 client) fails the same way, before any
    /// publish.
    ///
    /// Tenant-scope signal (design §7): the client's pre-deploy single-tenant-container check needs to
    /// know whether more than one tenant shares this service instance. AL CANNOT determine that from
    /// here — this procedure runs inside exactly one tenant's session, and the only tenant-scoped API
    /// this runtime exposes at all, System Application's codeunit 417 "Tenant Information", reports
    /// solely the CURRENT tenant's own id/name (GetTenantId/GetTenantDisplayName); checked directly
    /// against the System Application 28.0 symbols in this repo's package cache, there is no
    /// tenant-enumeration or multitenancy-boolean surface anywhere in it reachable from an extension.
    /// Reporting a fabricated tenantCount, or a `singleTenant: true` this procedure cannot substantiate,
    /// would be worse than reporting nothing — the client would gate a publish decision on it. So this
    /// reports `tenantCountReachable: false` and nothing else on the topic: the client's single-tenant
    /// check (design §7) MUST be performed out-of-band against the container (e.g. the BC admin/
    /// PowerShell surface — `Get-NAVTenant` / bccontainerhelper's `Get-BcContainerTenants`) BEFORE
    /// publish, never by asking this endpoint.
    ///
    /// `serverGeneration` is also reported (Task 4 dependency): it is the ONLY value ForceResetLease
    /// authenticates against (design §8, R4 sol#4), and no OTHER endpoint returns it unless an acquire
    /// is GRANTED — which a still-active op or a live holder's own token refuses. Without it here, a
    /// session killed mid-run (the exact case ForceResetLease exists for) would have no way to obtain
    /// the echo it needs. Read via "LC Control State".CurrentServerGeneration(), never straight off the
    /// table from this codeunit.
    ///
    /// `semver` reports this extension's ACTUAL version (see CurrentAppVersion, ROADMAP R28), which
    /// the client compares against its own minimum — that is what lets a stale control app be named
    /// as such once, up front, rather than surfacing later as whichever action first needs
    /// something this build does not have.</summary>
    procedure HarnessInfo(ClientProtocol: Integer) InfoJson: Text
    var
        State: Codeunit "LC Control State";
        Obj: JsonObject;
        Isolation: JsonArray;
        TestTypes: JsonArray;
        LeaseOwner: Text;
        LeaseOpKind: Text;
        LeaseExpiresAt: Text;
        LeaseTokenPresent: Boolean;
    begin
        if ClientProtocol < 2 then
            Error(ProtocolIncompatibleErr(ClientProtocol));

        Isolation.Add('Codeunit');
        TestTypes.Add('codeunit');
        Obj.Add('appId', '5e7a1c00-1111-4c00-8c00-1e7a1c000701');
        Obj.Add('semver', CurrentAppVersion());
        Obj.Add('protocolVersion', 2);
        Obj.Add('serverGeneration', State.CurrentServerGeneration());
        Obj.Add('tenantCountReachable', false);
        Obj.Add('isolationModes', Isolation);
        Obj.Add('testTypes', TestTypes);
        // R110: the read-only lease peek. Carried on THIS read rather than on a new endpoint,
        // because every client already calls HarnessInfo before it can acquire anything — a
        // separate action would be a second round trip and a second thing to keep in step. Taken
        // as ONE snapshot (see CurrentLeaseSnapshot), never three reads that could disagree.
        State.CurrentLeaseSnapshot(LeaseOwner, LeaseOpKind, LeaseExpiresAt, LeaseTokenPresent);
        Obj.Add('leaseOwner', LeaseOwner);
        Obj.Add('leaseOpKind', LeaseOpKind);
        Obj.Add('leaseExpiresAt', LeaseExpiresAt);
        // Whether a live credential exists, never the credential. See CurrentLeaseSnapshot.
        Obj.Add('leaseTokenPresent', LeaseTokenPresent);
        Obj.WriteTo(InfoJson);
    end;

    /// <summary>This extension's REAL version, as the platform records it for the installed module —
    /// never a literal (ROADMAP R28). `semver` used to be hardcoded '1.0.0.0', so a control app
    /// several builds behind was byte-identical to a current one in the handshake and nothing could
    /// date it; every new client action was left to fail its own way instead (a 404 on an endpoint
    /// that build never had, BC's own 'clientProtocol is not a valid parameter' 400 for one older
    /// still). `lethal-control.app` is gitignored — a LOCAL build on every machine, which no pull
    /// refreshes — so what this reports is the only evidence of how old the deployed build is.
    ///
    /// A failed GetCurrentModuleInfo returns an EMPTY string, not an invented version: the client
    /// refuses an absent/unparseable version loudly (see `HarnessVerifier.checkControlVersion`),
    /// which is the honest outcome when the build cannot be dated. Substituting a plausible literal
    /// here is the exact defect R28 closed.</summary>
    local procedure CurrentAppVersion(): Text
    var
        Module: ModuleInfo;
    begin
        if not NavApp.GetCurrentModuleInfo(Module) then
            exit('');
        exit(Format(Module.AppVersion()));
    end;

    /// <summary>R58: `RunMutant`, plus per-object code coverage collected AROUND the test run.
    ///
    /// A SEPARATE action rather than a parameter on `RunMutant`. Adding a parameter changes the OData
    /// action signature, and BC validates the request shape before the action's own body runs — which
    /// is exactly how R25's stale-control-app failure presented (`the parameter 'clientProtocol' ... is
    /// not a valid parameter`, from a server whose endpoint EXISTED and answered). A new action leaves
    /// every existing caller untouched.
    ///
    /// WHY THIS EXISTS: LethAL's coverage has always come from the bc-dev-mcp hub, so the BASELINE ran
    /// on one runner while every MUTANT ran on this fenced path. Measured (R55/R57), those two sessions
    /// differ — `GuiAllowed=Yes/Web` on the hub versus `No/ODataV4` here — and 12 of 56 Continia
    /// Document Output tests fail on the hub and pass here purely because of it. A test dropped from the
    /// green set takes its coverage with it, and its mutants are then reported `no-coverage`. Collecting
    /// coverage HERE lets the green set and the verdicts come from one runner.
    ///
    /// Coverage is collected only when asked for, because it is not free and only the baseline needs it.
    /// Verified (R58) that a fenced ODataV4 session records coverage identically to the hub session.</summary>
    /// <summary>OBJECT-ID FILTER (1.0.0.9, and the reason this action's signature changed): an AL
    /// `SetFilter` expression over `"Object ID"` — the target artifact's own `idRanges`, e.g.
    /// `79000..79199` or `6175200..6175499|79000..79199`. Empty means NO filter, which is the
    /// measurement mode and not a mode any real run should use.
    ///
    /// It is not an optimisation. MEASURED 2026-07-28 on Cronus281: unfiltered, this action does not
    /// return HEADERS within 300 s for a fixture whose whole test body is three lines — the client's
    /// fetch times out and the baseline test is recorded `error`, which quarantines the tier. The
    /// `Code Coverage` table holds every line the platform recorded during the run, and inside
    /// `RunMutant` that is the entire Test Runner + Test Suite Mgt + Base App machinery, not just the
    /// target. Only rows for objects the artifact DECLARES can ever be attributed anyway (the client
    /// skips every other row — `AppMethodIndex.declaredObjects`), so filtering here throws away
    /// nothing the client could have used.
    ///
    /// Correctness does NOT depend on this filter being right: the client re-checks every row against
    /// the compiled package's own `SymbolReference.json`. A too-wide filter only costs bytes; a
    /// too-narrow one loses coverage, which is why it is the artifact's declared ranges verbatim.</summary>
    procedure RunMutantWithCoverage(TargetAppId: Text; ArtifactId: Text; AttemptId: Text; MutantId: Text; TestCodeunitId: Integer; TestMethod: Text; LeaseEpoch: Integer; LeaseToken: Text; ServerGeneration: Text; OpSeq: BigInteger; CoverageObjectIdFilter: Text) ResultJson: Text
    var
        CodeCoverageMgt: Codeunit "Code Coverage Mgt.";
        Raw: Text;
        Obj: JsonObject;
        Coverage: JsonArray;
        Out: Text;
        RunStarted: DateTime;
        RunEnded: DateTime;
        SerializeEnded: DateTime;
        ScannedRows: Integer;
        EmittedRows: Integer;
    begin
        CodeCoverageMgt.StartApplicationCoverage();
        RunStarted := CurrentDateTime();
        Raw := RunMutant(TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, LeaseEpoch, LeaseToken, ServerGeneration, OpSeq);
        CodeCoverageMgt.StopApplicationCoverage();
        RunEnded := CurrentDateTime();

        // Re-open the result and attach coverage rather than duplicating RunMutant's phase logic. If
        // the payload is not an object something is very wrong upstream; return it untouched instead
        // of masking it with a parse error of our own.
        if not Obj.ReadFrom(Raw) then
            exit(Raw);
        Coverage := CoverageArray(CoverageObjectIdFilter, ScannedRows, EmittedRows);
        SerializeEnded := CurrentDateTime();
        Obj.Add('coverage', Coverage);
        // Diagnostics, and they earn their place: the two costs here — the platform RECORDING every
        // executed line, and this codeunit SERIALIZING the result — fail identically at the client (a
        // timed-out fetch), and only one of them is fixable by filtering. Reporting them separately is
        // what turns "the fenced coverage call hangs" into a number that says which.
        Obj.Add('coverageRunMs', DurationMs(RunEnded - RunStarted));
        Obj.Add('coverageSerializeMs', DurationMs(SerializeEnded - RunEnded));
        Obj.Add('coverageScannedRows', ScannedRows);
        Obj.Add('coverageEmittedRows', EmittedRows);
        Obj.WriteTo(Out);
        exit(Out);
    end;

    /// <summary>The `Code Coverage` table as a JSON array of `{objectType, objectId, lineNo, hits}`,
    /// restricted to `ObjectIdFilter` (see `RunMutantWithCoverage`).
    ///
    /// `Object Type` is an Option (measured — it has no `AsInteger()`), and its integer values are BC's
    /// own object-type numbering, the same one `app-package.ts` maps: Table=1, Report=3, Codeunit=5,
    /// XmlPort=6, Page=8, Query=9, PageExtension=14, TableExtension=15.
    ///
    /// Line-level, which is FINER than the `procedure` granularity LethAL keys coverage on — mapping
    /// lines back to procedures is the client's job, and it has the instrumented source to do it with.
    ///
    /// `ScannedRows`/`EmittedRows` are returned by var so the caller can report how much the filter
    /// actually removed. A filter that silently matched nothing and one that correctly matched a small
    /// set both produce an empty array, and this project's signature bug is exactly that pair being
    /// indistinguishable.
    ///
    /// Public rather than local: it was promoted for R69's client-services batch runner, which has
    /// since been deleted (measured unprofitable — ROADMAP R69). Left public because the fenced
    /// path is its only caller either way and narrowing it buys nothing.</summary>
    procedure CoverageArray(ObjectIdFilter: Text; var ScannedRows: Integer; var EmittedRows: Integer): JsonArray
    var
        CodeCoverage: Record "Code Coverage";
        Arr: JsonArray;
        Row: JsonObject;
    begin
        ScannedRows := 0;
        EmittedRows := 0;
        if ObjectIdFilter <> '' then
            CodeCoverage.SetFilter("Object ID", ObjectIdFilter);
        if CodeCoverage.FindSet() then
            repeat
                ScannedRows += 1;
                // Only executed lines carry information; a zero-hit row is noise on the wire, and a
                // real project's coverage table is large.
                if CodeCoverage."No. of Hits" > 0 then begin
                    Clear(Row);
                    Row.Add('objectType', CodeCoverage."Object Type");
                    Row.Add('objectId', CodeCoverage."Object ID");
                    Row.Add('lineNo', CodeCoverage."Line No.");
                    Row.Add('hits', CodeCoverage."No. of Hits");
                    Arr.Add(Row);
                    EmittedRows += 1;
                end;
            until CodeCoverage.Next() = 0;
        exit(Arr);
    end;

    /// <summary>A Duration as whole milliseconds, for a JSON number. `Format` on a Duration yields
    /// prose ("2 minutes 3 seconds"), which is not a value any client can compare.</summary>
    local procedure DurationMs(Elapsed: Duration): Integer
    begin
        exit(Elapsed div 1);
    end;

    /// <summary>Read-only: the artifact id the target registered for TargetAppId (empty if none).
    /// The DeploymentVerifier reads this as a pre-flight (design §B). No OData WRITE exists — the
    /// registry is written only in-process by the target's install/upgrade codeunits (design §B2).</summary>
    procedure RegisteredArtifact(TargetAppId: Text): Text
    var
        State: Codeunit "LC Control State";
    begin
        exit(State.RegisteredArtifact(TargetAppId));
    end;

    /// <summary>OData action: attempt to acquire the machine-global lease (design §4, R4-hardened).
    /// Thin wrapper — all decision logic (generation-changed / operation-busy / operation-orphaned /
    /// idempotent-nonce replay / fresh grant / held) lives in "LC Control State".TryAcquire. camelCase
    /// JSON result keys: {granted, epoch?, token?, serverGeneration?, lastCompletedOpSeq?, expiresAt?,
    /// reason?, holder?, opAttemptId?, opStartedAt?}.</summary>
    procedure AcquireLease(Owner: Text; TtlSeconds: Integer; ClientNonce: Text; ExpectedGeneration: Text) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Granted: Boolean;
        Epoch: Integer;
        Token: Text;
        ServerGeneration: Text;
        LastCompletedOpSeq: BigInteger;
        ExpiresAt: DateTime;
        Reason: Text;
        Holder: Text;
        OpAttemptId: Text;
        OpStartedAt: DateTime;
    begin
        State.TryAcquire(Owner, TtlSeconds, ClientNonce, ExpectedGeneration, Granted, Epoch, Token, ServerGeneration, LastCompletedOpSeq, ExpiresAt, Reason, Holder, OpAttemptId, OpStartedAt);
        ResultJson := BuildAcquireResult(Granted, Epoch, Token, ServerGeneration, LastCompletedOpSeq, ExpiresAt, Reason, Holder, OpAttemptId, OpStartedAt);
    end;

    /// <summary>OData action: extend the lease's Expires At (design §4). A matching (epoch, token,
    /// generation) is honored even if momentarily past Expires At. Thin wrapper over
    /// "LC Control State".TryRenew. JSON: {renewed, expiresAt?}.</summary>
    procedure RenewLease(Epoch: Integer; Token: Text; Generation: Text; TtlSeconds: Integer) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Renewed: Boolean;
        ExpiresAt: DateTime;
        Obj: JsonObject;
    begin
        State.TryRenew(Epoch, Token, Generation, TtlSeconds, Renewed, ExpiresAt);
        Obj.Add('renewed', Renewed);
        if Renewed then
            Obj.Add('expiresAt', ExpiresAt);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action: release the lease, invalidating its renewal credentials so a delayed
    /// renew cannot resurrect it (design §4). Refused (op-in-flight) while an op marker is set. A
    /// non-matching call is an idempotent success (a prior release already invalidated it). Thin
    /// wrapper over "LC Control State".TryRelease. JSON: {released, reason?}.</summary>
    procedure ReleaseLease(Epoch: Integer; Token: Text; Generation: Text) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Released: Boolean;
        Reason: Text;
        Obj: JsonObject;
    begin
        State.TryRelease(Epoch, Token, Generation, Released, Reason);
        Obj.Add('released', Released);
        if Reason <> '' then
            Obj.Add('reason', Reason);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action: begin a publish operation under the op-marker state machine (design §4).
    /// Thin wrapper over "LC Control State".TryBeginPublish — all decision logic (tuple check /
    /// tombstone check / same-active idempotent replay / fresh begin / refuse) lives there. JSON:
    /// {begun, alreadyCompleted?}.</summary>
    procedure BeginPublish(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Begun: Boolean;
        AlreadyCompleted: Boolean;
        Obj: JsonObject;
    begin
        State.TryBeginPublish(Epoch, Token, Generation, AttemptId, OpSeq, Begun, AlreadyCompleted);
        Obj.Add('begun', Begun);
        if AlreadyCompleted then
            Obj.Add('alreadyCompleted', AlreadyCompleted);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action: end (tombstone) a publish operation (design §4). Outcome is part of the
    /// interface contract but does NOT change the state transition — EndPublish clears/tombstones the
    /// marker identically whether the caller reports success or a deterministic failure; only a
    /// genuinely-unknown publish result should leave the marker set, and deciding/acting on that is a
    /// later task's recovery concern (§8), not invented here. Thin wrapper over
    /// "LC Control State".TryEndPublish. JSON: {ended, alreadyCompleted?}.</summary>
    procedure EndPublish(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger; Outcome: Text) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Ended: Boolean;
        AlreadyCompleted: Boolean;
        Obj: JsonObject;
    begin
        State.TryEndPublish(Epoch, Token, Generation, AttemptId, OpSeq, Ended, AlreadyCompleted);
        Obj.Add('ended', Ended);
        if AlreadyCompleted then
            Obj.Add('alreadyCompleted', AlreadyCompleted);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action: lost-ack reconciliation read for any op, publish or run (design §4).
    /// Deliberately does NOT gate on (epoch, token, generation) matching the current row — see
    /// "LC Control State".TryGetOperationStatus's doc comment for why. Thin wrapper. JSON: {opKind,
    /// opAttemptId, opSeq, lastCompletedOpSeq, completed}.</summary>
    procedure GetOperationStatus(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        OpKind: Text;
        OpAttemptId: Text;
        CurrentOpSeq: BigInteger;
        LastCompletedOpSeq: BigInteger;
        Completed: Boolean;
        Obj: JsonObject;
    begin
        State.TryGetOperationStatus(Epoch, Token, Generation, AttemptId, OpSeq, OpKind, OpAttemptId, CurrentOpSeq, LastCompletedOpSeq, Completed);
        Obj.Add('opKind', OpKind);
        Obj.Add('opAttemptId', OpAttemptId);
        Obj.Add('opSeq', CurrentOpSeq);
        Obj.Add('lastCompletedOpSeq', LastCompletedOpSeq);
        Obj.Add('completed', Completed);
        AddProgress(Obj);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>R198: `opProgress` (the marker's own op's progress row, with the row's own attemptId
    /// and opSeq so a client can tell whose it is; absent when there is none) and `serverNow` (the
    /// clock "startedAt" came from, so elapsed time is computed from server values only).</summary>
    local procedure AddProgress(var Obj: JsonObject)
    var
        State: Codeunit "LC Control State";
        Prog: JsonObject;
        HaveProgress: Boolean;
        ProgAttemptId: Text;
        ProgOpSeq: BigInteger;
        MethodIndex: Integer;
        MethodCodeunitId: Integer;
        MethodName: Text;
        MethodToken: Text;
        StartedAt: DateTime;
        LastCompletedIndex: Integer;
        ProgState: Text;
        ServerNow: DateTime;
    begin
        State.TryGetOperationProgress(HaveProgress, ProgAttemptId, ProgOpSeq, MethodIndex, MethodCodeunitId, MethodName, MethodToken, StartedAt, LastCompletedIndex, ProgState, ServerNow);
        Obj.Add('serverNow', ServerNow);
        if not HaveProgress then
            exit;
        Prog.Add('attemptId', ProgAttemptId);
        Prog.Add('opSeq', ProgOpSeq);
        Prog.Add('methodIndex', MethodIndex);
        Prog.Add('codeunitId', MethodCodeunitId);
        Prog.Add('method', MethodName);
        Prog.Add('token', MethodToken);
        Prog.Add('startedAt', StartedAt);
        Prog.Add('lastCompletedIndex', LastCompletedIndex);
        Prog.Add('state', ProgState);
        Obj.Add('opProgress', Prog);
    end;

    /// <summary>OData action: recover the caller's OWN stranded op marker (design §5/§8). Thin wrapper
    /// over "LC Control State".TryRecoverOp — the proof-of-ownership rules, the unconditional
    /// active-tuple clear and the tombstone all live there, as does the client contract this MUST be
    /// gated by (a parsed application-level terminal response only — never a bare HTTP status, a
    /// connection error or a client timeout, which are indistinguishable from a still-running AL op).
    /// JSON: {recovered, alreadyCompleted?}.</summary>
    procedure RecoverOp(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Recovered: Boolean;
        AlreadyCompleted: Boolean;
        Obj: JsonObject;
    begin
        State.TryRecoverOp(Epoch, Token, Generation, AttemptId, OpSeq, Recovered, AlreadyCompleted);
        Obj.Add('recovered', Recovered);
        if AlreadyCompleted then
            Obj.Add('alreadyCompleted', AlreadyCompleted);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action (R53): end the session running the caller's own hung mutant, so a
    /// non-terminating mutant can be scored instead of stranding the tier.
    ///
    /// CALLED FROM A SECOND CONNECTION, while the original RunMutant request is still OPEN. That is
    /// the whole mechanism: BC then answers the original request with an HTTP 408 naming the AL
    /// StopSession call, and THAT is what the client scores on. This action's own answer is not
    /// sufficient evidence and must not be treated as such — MEASURED (`scripts/r53-probe/`),
    /// StopSession returns without throwing for an id that never existed, for 0 and for -1, so it
    /// cannot report failure at all.
    ///
    /// Refuses on the same ownership proof as every mutating action, plus a tombstone check that is
    /// load-bearing rather than formal: without it, a lost ack after a run that already SUCCEEDED
    /// matches on attempt id alone, and the session it recorded is a live pooled OData session.
    /// Thin wrapper over "LC Control State".TryStopHungRun.
    /// JSON: {stopped, sessionId?, reason?}.</summary>
    procedure StopHungRun(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Stopped: Boolean;
        Refusal: Text;
        StoppedSessionId: Integer;
        Obj: JsonObject;
    begin
        State.TryStopHungRun(Epoch, Token, Generation, AttemptId, OpSeq, Stopped, Refusal, StoppedSessionId);
        Obj.Add('stopped', Stopped);
        if Stopped then
            Obj.Add('sessionId', StoppedSessionId);
        if Refusal <> '' then
            Obj.Add('reason', Refusal);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action (R198): the per-METHOD stop for a RunMutantMany op. Everything
    /// StopHungRun demands plus the progress row reading exactly (methodIndex, methodToken) in state
    /// running, read locked under the lease lock; see "LC Control State".TryStopHungRunAt. A NEW
    /// action rather than new parameters on StopHungRun, so an older client's stop keeps working.
    /// JSON: {stopped, sessionId?, reason?, rowIndex?, rowState?}: the row's index and state travel
    /// on a refusal so the client's abort note can say where the loop actually was.</summary>
    procedure StopHungRunAt(Epoch: Integer; Token: Text; Generation: Text; AttemptId: Text; OpSeq: BigInteger; MethodIndex: Integer; MethodToken: Text) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Stopped: Boolean;
        Refusal: Text;
        StoppedSessionId: Integer;
        RowIndex: Integer;
        RowState: Text;
        Obj: JsonObject;
    begin
        State.TryStopHungRunAt(Epoch, Token, Generation, AttemptId, OpSeq, MethodIndex, MethodToken, Stopped, Refusal, StoppedSessionId, RowIndex, RowState);
        Obj.Add('stopped', Stopped);
        if Stopped then
            Obj.Add('sessionId', StoppedSessionId);
        if Refusal <> '' then
            Obj.Add('reason', Refusal);
        if RowState <> '' then begin
            Obj.Add('rowIndex', RowIndex);
            Obj.Add('rowState', RowState);
        end;
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>OData action: the operator recovery reset (design §8). Step 3 of a FOUR-step procedure
    /// that a restart alone does not accomplish — restart the NST, read the current serverGeneration
    /// from a live status/harness call against the restarted instance, call this with that value as
    /// expectedGeneration, then probe clean and clear the quarantine. This authorization scheme is a
    /// KNOWING, DOCUMENTED DEVIATION from design §8's requirement to bind authorization to a
    /// newly-observed NST/process incarnation — not an oversight: binding to an actual incarnation
    /// proved infeasible in AL, so this takes the plan's Task-4-Step-4 fallback clause ("if infeasible
    /// in AL, document the operational binding and gate via permission") and substitutes the echo below;
    /// see "LC Control State".TryForceResetLease's AUTHORIZATION doc comment for the full rationale, and
    /// the Task 10 docs for where this deviation is recorded. The echo is REPLAY PROTECTION
    /// ACROSS RESETS, not incarnation binding: "Server Generation" is a persistent field that an NST
    /// restart does not change, so a value read before the restart is byte-identical to one read after —
    /// the echo only proves the caller holds the generation from AFTER THE LAST reset (every successful
    /// reset mints a new one), refusing a pre-recorded/replayed request or a stale caller. Whether the
    /// operator actually restarted the NST first (step 1) is procedural discipline this action takes on
    /// trust; it has no server-side way to verify it. Thin wrapper over "LC Control State".
    /// TryForceResetLease. JSON: {reset, serverGeneration?, epoch?, reason?}.</summary>
    procedure ForceResetLease(ExpectedGeneration: Text) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        ResetDone: Boolean;
        NewGeneration: Text;
        NewEpoch: Integer;
        Reason: Text;
        Obj: JsonObject;
    begin
        State.TryForceResetLease(ExpectedGeneration, ResetDone, NewGeneration, NewEpoch, Reason);
        Obj.Add('reset', ResetDone);
        if ResetDone then begin
            Obj.Add('serverGeneration', NewGeneration);
            Obj.Add('epoch', NewEpoch);
        end else
            Obj.Add('reason', Reason);
        Obj.WriteTo(ResultJson);
    end;

    /// <summary>
    /// Run-scoped, single-method execution primitive, fenced by the machine-global lease (design §5).
    /// Three phases, and the split is the whole point: a mutant run that cannot PROVE, after the fact,
    /// that it still held the lease it started under must not have its result recorded.
    ///
    /// Phase 1 — claim, under LockTable, one transaction, one Commit (in TryBeginRun). Validates
    /// (leaseEpoch, leaseToken, serverGeneration) + the artifact + the opSeq rules, sets Op Kind = run
    /// and the active tuple together. Refusal -&gt; 'lease-invalid' / 'artifact-mismatch', nothing
    /// claimed, nothing run. A still-active same-attempt duplicate claim is ALSO refused (design §5
    /// requires Op Kind = none for admission — never an idempotent re-claim on the run path, unlike
    /// publish) and is reported at the wire's 'lease-invalid' status too, with the finer 'op-in-flight'
    /// reason surfaced via the `reason` key below.
    ///
    /// Phase 2 — run, with NO lease lock held (phase 1's Commit released it), behind a catchable
    /// Codeunit.Run boundary. A server-known terminal error (test framework / AL exception) is captured
    /// as a terminal error outcome instead of unwinding past phase 3 and stranding the marker; it is
    /// reported in codeunitResults as {"error": ...}, the same fail-closed shape RunOneMethod already
    /// uses, so it can never be mistaken for a test verdict.
    ///
    /// Phase 3 — verify-and-clear, under LockTable, ONE transaction with exactly ONE Commit (in
    /// TryFinishRun). Only an exact (epoch, token, generation) + Op Kind = run + attemptId + opSeq
    /// match records the result; anything else returns 'lease-invalid' having touched no row.
    ///
    /// JSON: the 5C-A status shape, with the new status 'lease-invalid', plus an optional `reason` key
    /// on phase-1 refusals — e.g. 'op-in-flight' for a still-active same-attempt duplicate, distinct
    /// from a genuine 'lease-invalid' — so a client can tell "poll, do not retry" from "you lost the
    /// lease" WITHOUT a new top-level status (the runner tasks are written against the existing
    /// vocabulary). On any non-'ran' status the result and attestation are deliberately reported as
    /// empty/false — there is no verdict to carry.
    /// </summary>
    procedure RunMutant(TargetAppId: Text; ArtifactId: Text; AttemptId: Text; MutantId: Text; TestCodeunitId: Integer; TestMethod: Text; LeaseEpoch: Integer; LeaseToken: Text; ServerGeneration: Text; OpSeq: BigInteger) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Runner: Codeunit "LC Run Method";
        Claimed: Boolean;
        ClaimReason: Text;
        ClaimStatus: Text;
        Verified: Boolean;
        FinishReason: Text;
        CodeunitResults: Text;
        ObservedAny: Boolean;
        IdentityMismatch: Boolean;
        TestRunsBefore: Integer;
    begin
        // R206 §2.1: the session-freshness predicate, read ONCE at the very top, before anything
        // builds a suite or runs a method. The coverage action delegates here and re-opens this
        // JSON, so both answers carry this one read. 0 = a fresh session.
        TestRunsBefore := State.TestMethodRunsSoFar();

        // PHASE 1 — claim under lock. Nothing is written, and nothing runs, unless this succeeds.
        State.TryBeginRun(LeaseEpoch, LeaseToken, ServerGeneration, AttemptId, OpSeq, TargetAppId, ArtifactId, MutantId, Claimed, ClaimReason);
        if not Claimed then begin
            // 'op-in-flight' (a duplicate claim on a still-active same-attempt marker, design §5) is
            // reported at the wire's existing 'lease-invalid' status, never as a new top-level status —
            // the runner tasks are written against that vocabulary. The finer reason travels in the
            // `reason` key so a client can tell "poll, do not retry" (op-in-flight) from "you lost the
            // lease" (a genuine lease-invalid or artifact-mismatch).
            if ClaimReason = 'op-in-flight' then
                ClaimStatus := 'lease-invalid'
            else
                ClaimStatus := ClaimReason;
            exit(BuildStatus(ClaimStatus, TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, '', false, false, ClaimReason, -1));
        end;

        // PHASE 2 — run exactly one method OUTSIDE the lease lock, behind a catchable boundary.
        // GetLastErrorText is read immediately on the failing branch, before any other statement can
        // clear it. Attestation is read here, BEFORE phase 3, because phase 3 resets it unconditionally.
        Runner.SetRequest(State.NextSuiteName(), TestCodeunitId, TestMethod);
        // R198: a single-method op writes the same progress row as a group's method 1, inside the
        // runner's boundary, so GetOperationStatus reports one shape for every op and R204's
        // narrowing has something to read at this grain too.
        Runner.SetFence(AttemptId, OpSeq, 1);
        if Runner.Run() then
            CodeunitResults := Runner.Results()
        else
            CodeunitResults := BuildRunError(GetLastErrorText());
        ObservedAny := State.AttestationObservedAny();
        IdentityMismatch := State.AttestationMismatch();

        // PHASE 3 — verify-and-clear under lock, one transaction, one Commit. `FinishReason` is
        // blank except for the one refusal a client must not read as a lease loss (`op-stopped`,
        // R203): our own stop tombstoned this op while the session was still finishing.
        State.TryFinishRun(LeaseEpoch, LeaseToken, ServerGeneration, AttemptId, OpSeq, TargetAppId, ArtifactId, MutantId, Verified, FinishReason);
        if not Verified then
            exit(BuildStatus('lease-invalid', TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, '', false, false, FinishReason, -1));

        exit(BuildStatus('ran', TargetAppId, ArtifactId, AttemptId, MutantId, TestCodeunitId, TestMethod, CodeunitResults, ObservedAny, IdentityMismatch, '', TestRunsBefore));
    end;

    /// <summary>
    /// OData action (R198): ONE call runs N test methods against ONE mutant, as a server-side loop
    /// of today's single-method suite run. One fence for the call (phase 1 claims once, phase 3
    /// tombstones once); phase 2 is "LC Run Many" behind its own catchable boundary; the answer
    /// carries `endedBy` (complete | failure | cap), `ranCount` and one entry per method that RAN,
    /// each with the same `codeunitResults` shape RunMutant returns plus a server-measured
    /// `durationMs`; or `runError` with the server's own text when phase 2 raised. Design:
    /// docs/superpowers/specs/2026-09-03-r198-run-mutant-loop.md.
    ///
    /// `TestMethods` is a JSON array of {index, codeunitId, method, budgetMs}, numbered 1..N in
    /// the order to run. `RequestCeilingMs`/`StopGraceMs` bound STARTS: from method 2 on, a method
    /// is started only if its budget plus the grace fits inside the ceiling, so a StopHungRunAt for
    /// it can land inside this call; method 1 always starts.
    /// </summary>
    procedure RunMutantMany(TargetAppId: Text; ArtifactId: Text; AttemptId: Text; MutantId: Text; TestMethods: Text; StopAtFirstFailure: Boolean; RequestCeilingMs: Integer; StopGraceMs: Integer; LeaseEpoch: Integer; LeaseToken: Text; ServerGeneration: Text; OpSeq: BigInteger) ResultJson: Text
    var
        State: Codeunit "LC Control State";
        Runner: Codeunit "LC Run Many";
        Claimed: Boolean;
        ClaimReason: Text;
        ClaimStatus: Text;
        Verified: Boolean;
        FinishReason: Text;
        RunError: Text;
        GroupResults: Text;
        ObservedAny: Boolean;
        IdentityMismatch: Boolean;
        Displaced: Boolean;
        Unresolved: Boolean;
        UnresolvedReason: Text;
        TestRunsBefore: Integer;
    begin
        // R206 §2.1: the session-freshness predicate, read ONCE at the very top (see RunMutant).
        TestRunsBefore := State.TestMethodRunsSoFar();

        // PHASE 1 — identical to RunMutant's.
        State.TryBeginRun(LeaseEpoch, LeaseToken, ServerGeneration, AttemptId, OpSeq, TargetAppId, ArtifactId, MutantId, Claimed, ClaimReason);
        if not Claimed then begin
            if ClaimReason = 'op-in-flight' then
                ClaimStatus := 'lease-invalid'
            else
                ClaimStatus := ClaimReason;
            exit(BuildManyStatus(ClaimStatus, TargetAppId, ArtifactId, AttemptId, MutantId, '', '', false, false, ClaimReason, -1));
        end;

        // PHASE 2 — the loop, behind one boundary. A raise anywhere inside is caught here.
        Runner.SetRequest(AttemptId, OpSeq, TestMethods, StopAtFirstFailure, RequestCeilingMs, StopGraceMs);
        if Runner.Run() then
            GroupResults := Runner.Results()
        else
            RunError := GetLastErrorText();
        Displaced := Runner.WasDisplaced();
        Unresolved := Runner.Unresolved();
        UnresolvedReason := Runner.UnresolvedReason();
        ObservedAny := State.AttestationObservedAny();
        IdentityMismatch := State.AttestationMismatch();

        // PHASE 3 — identical to RunMutant's. A refusal DISCARDS results and runError alike. It
        // runs BEFORE the suite-unresolved answer below, so a refused request never strands the op.
        State.TryFinishRun(LeaseEpoch, LeaseToken, ServerGeneration, AttemptId, OpSeq, TargetAppId, ArtifactId, MutantId, Verified, FinishReason);
        if not Verified then
            exit(BuildManyStatus('lease-invalid', TargetAppId, ArtifactId, AttemptId, MutantId, '', '', false, false, FinishReason, -1));
        // R206 §4 item 1: a request that did not resolve to exactly one function line per pair ran
        // nothing. A call-level status, never an entry and never a runError: the client routes it
        // to a session abort carrying `reason`, since a test app that does not resolve is not a
        // per-mutant fact.
        if Unresolved and (RunError = '') then
            exit(BuildManyStatus('suite-unresolved', TargetAppId, ArtifactId, AttemptId, MutantId, '', '', false, false, UnresolvedReason, -1));
        // Displaced means the loop saw the marker leave; a phase 3 that nevertheless verified is a
        // contradiction, reported as a runError so the client scores an error, never verdicts.
        if Displaced and (RunError = '') then
            RunError := 'displaced-but-verified: the loop stopped because the marker no longer named this op, yet phase 3 verified it; the results are not trusted.';

        exit(BuildManyStatus('ran', TargetAppId, ArtifactId, AttemptId, MutantId, GroupResults, RunError, ObservedAny, IdentityMismatch, '', TestRunsBefore));
    end;

    /// <summary>
    /// OData action: the permission canary (ROADMAP R26). Answers ONE question about THIS server,
    /// once per session — CAN A CORRECTLY-DECLARED TEST CODEUNIT (`TestPermissions = Disabled`)
    /// WRITE A TABLE OF ITS OWN APP HERE?
    ///
    /// WHY IT ASKS THAT, AND NOT WHAT IT USED TO. The original question was "does the FENCED path
    /// strip a test body's permissions", on the belief that Microsoft's Permissions Mock (codeunit
    /// 131006, toggled by "Test Runner - Mgt" 130454's `PlatformBeforeTestRun` ->
    /// `StartStopPermissionMock`) singled that path out. MEASURED A/B on one property (2026-07-26),
    /// it does not: two probe codeunits identical except for `TestPermissions`, same app, same
    /// tables, same server, mock running in both arms — omitted (Restrictive, the AL default) is
    /// REFUSED, `Disabled` SUCCEEDS. The path is not the variable; the declaration on the test
    /// codeunit is, and `continia test run` reaches the same 130454 runner and refuses a Restrictive
    /// codeunit there too. So the canary asks the weaker, honest question above.
    ///
    /// WHY IT IS STILL WORTH ASKING. Expected answer 'not-mocked' on every server we have — this is
    /// a PRECONDITION CHECK, not a scoring caveat. It is what would catch Microsoft changing the
    /// rule so that even a `Disabled` codeunit is stripped: the one future in which fenced runs
    /// start losing kills for a reason no target-side declaration can fix. The actionable half of
    /// the old story now lives in the runner, which names `TestPermissions` when a TARGET suite's
    /// test is refused (`describeTestPermissionsRefusal`, `packages/runner/src/permission-canary.ts`).
    ///
    /// IT MUST TRAVEL THE SAME PATH IT CHARACTERISES. The canary runs through "LC Run Method"
    /// (91007) — the identical `Test Suite Mgt.RunAllTests` mechanism `RunMutant` phase 2 uses,
    /// invoked through the same catchable `Codeunit.Run` boundary — not through a second,
    /// convenient-looking route. A canary reached by a different path measures that path, not the
    /// one mutants are scored on, and would be worse than no canary at all.
    ///
    /// NOT LEASE-FENCED, deliberately. Unlike `RunMutant` this takes no `(epoch, token,
    /// serverGeneration, attemptId, opSeq)`: it activates no mutant, writes no control state, and
    /// touches neither "LC Mutation Active" nor "LC Lease", so there is no claim for the op-marker
    /// state machine to protect and nothing a mismatched tuple could corrupt. Taking a marker here
    /// would only add a way to strand one. What the fence exists to serialise — concurrent use of
    /// the platform test runner — is still respected: the CLIENT calls this once per session while
    /// it already holds the lease (design §6 step 1), before any mutant runs.
    ///
    /// THE CANARY TEST IS ALLOWED TO FAIL, and on a server that answers 'mocked' it MUST. Its
    /// `Insert` is plain and unwrapped — the same call shape a real test body uses — so a refused write aborts the method
    /// rather than returning an error string. That is deliberate and was earned live: the first
    /// version wrapped the `Insert` in a [TryFunction] so it could always return normally, and the
    /// platform answered "Call to the function 'INSERT' is not allowed inside the call to
    /// 'RunTests' when it is used as a TryFunction" — a contract violation that is NOT caught by
    /// that [TryFunction], aborting the method before it recorded anything, and measuring the
    /// canary's own call shape instead of the permission state. See "LC Permission Canary"'s
    /// summary. So the framework's pass/fail line is NOT an infrastructure signal here; the
    /// two-stage observation on "LC Permission Canary State" is, and the failing line's message is
    /// only used as human-readable `detail`.
    ///
    /// A REFUSED WRITE IS NOT BY ITSELF EVIDENCE OF THE MOCK, and two extra facts are gathered so
    /// the verdict can actually mean what it says:
    ///
    /// 1. THE OUT-OF-FENCE BASELINE. "LC Permission Probe" has no `InherentPermissions`, so ANY
    ///    reason this session lacks write on it produces `write=false` + a refused insert. That is
    ///    not hypothetical on this codebase: `MutationActive.Table.al` and `Lease.Table.al` both
    ///    record WHY their tables declare `InherentPermissions = RIMD` — the 5C-A live spike found
    ///    the OData session runs under the CALLING USER, who does not hold this extension's
    ///    permission set. On such a container the probe is unwritable everywhere, and a canary that
    ///    only looked inside the fence would become a permanently-RED light: the exact mirror of the
    ///    permanently-green hazard the probe table's own comment guards against, sending operators
    ///    hunting for an app that is not installed. So the same two flags are read HERE, outside the
    ///    fence, in the same session and as the same user, BEFORE the test runs. If the baseline
    ///    already says no write, the in-fence refusal is unattributable and the answer is
    ///    'inconclusive' saying precisely that.
    /// 2. WHETHER THE MOCK IS EVEN INSTALLED. `AllObj` is asked for codeunit 131006, mirroring
    ///    Microsoft's own `StartStopPermissionMock` guard (and the R1 investigation probe in
    ///    `scripts/r1-probe/`). A refusal on a server that does not have the mock app is caused by
    ///    something else, and must not be reported as the mock.
    ///
    /// JSON: {verdict, observed, baselineReadPermission, baselineWritePermission, mockInstalled,
    /// readPermission?, writePermission?, insertSucceeded?, detail?}. `verdict` is one of
    /// 'mocked' | 'not-mocked' | 'inconclusive'. The three IN-FENCE observation keys are present
    /// ONLY when `observed` is true — omitted rather than defaulted to false, because
    /// `readPermission:false, writePermission:false, insertSucceeded:false` is byte-identical to a
    /// genuine 'mocked' observation, and a client reading defaults as measurements is exactly the
    /// empty-result-reads-as-a-clean-one failure this codebase refuses to ship. The two baseline
    /// keys and `mockInstalled` are ALWAYS present: they are measured before the test runs and do
    /// not depend on it having worked, so withholding them would hide the very context that makes an
    /// inconclusive verdict actionable.
    /// </summary>
    procedure PermissionCanary() ResultJson: Text
    var
        Probe: Record "LC Permission Probe";
        State: Codeunit "LC Control State";
        Runner: Codeunit "LC Run Method";
        CanaryState: Codeunit "LC Permission Canary State";
        RunError: Text;
        RunnerResults: Text;
        TestMessage: Text;
        TestResult: Integer;
        HaveTestLine: Boolean;
        BaselineRead: Boolean;
        BaselineWrite: Boolean;
        MockInstalled: Boolean;
        CanRead: Boolean;
        CanWrite: Boolean;
        InsertOk: Boolean;
    begin
        // Read OUTSIDE the fence, before anything runs — this is the attribution baseline (see the
        // doc comment): the same flags, same session, same user, with no test runner involved.
        BaselineRead := Probe.ReadPermission();
        BaselineWrite := Probe.WritePermission();
        MockInstalled := PermissionsMockInstalled();

        // Cleared BEFORE dispatch, never after: `HasObservation()` is the proof that THIS run's
        // test body reached its first recording call, and a stale observation from an earlier call
        // in this session would otherwise answer a confident verdict for a run that never happened.
        CanaryState.ClearObservation();

        Runner.SetRequest(State.NextSuiteName(), Codeunit::"LC Permission Canary", CanaryTestMethodName());
        // `Results()` is meaningful ONLY when Run() returned true — `LC Run Method` says so
        // explicitly, and `RunMutant` phase 2 already branches exactly this way. Reading it
        // unconditionally would quote a stale/blank result as though it were this run's.
        if Runner.Run() then
            RunnerResults := Runner.Results()
        else
            // Read immediately on the failing branch, before any other statement can clear it.
            RunError := GetLastErrorText();
        HaveTestLine := ReadCanaryTestLine(RunnerResults, TestMessage, TestResult);

        if not CanaryState.HasObservation() then
            // The test body never reached even its FIRST statement: the framework refused the run,
            // the method could not be selected, or the body aborted before stage 1. INCONCLUSIVE —
            // never 'not-mocked'. Stage 1 precedes every operation that can fail on permissions, so
            // reaching here means something OTHER than the permission state went wrong, and the
            // caller must be told that rather than handed the reassuring answer.
            exit(BuildCanaryInconclusive(BaselineRead, BaselineWrite, MockInstalled, CanaryInconclusiveDetail(RunError, RunnerResults)));

        CanRead := CanaryState.ReadAllowed();
        CanWrite := CanaryState.WriteAllowed();
        InsertOk := CanaryState.InsertSucceeded();

        // Consistency guard, and the direct lesson of the live failure this action was rewritten
        // for: if stage 2 was never reached, the write must actually have aborted the method, so
        // the framework MUST report this test as failed. A reported SUCCESS with no stage 2 means
        // the framework did not execute the body this canary assumes it did — exactly the class of
        // "the canary is not on the path it thinks it is on" defect that produced a confident,
        // meaningless answer last time. Refuse to rule on it.
        if (not InsertOk) and HaveTestLine and (TestResult = TestResultSuccess()) then
            exit(BuildCanaryInconclusive(BaselineRead, BaselineWrite, MockInstalled,
                StrSubstNo('the canary test reported SUCCESS yet never reached its post-insert recording call — the test framework did not execute the body this canary assumes. Runner result: %1', RunnerResults)));

        exit(BuildCanaryResult(BaselineRead, BaselineWrite, MockInstalled, CanRead, CanWrite, InsertOk,
            CanaryRefusalDetail(InsertOk, RunError, HaveTestLine, TestMessage, RunnerResults)));
    end;

    /// <summary>Is Microsoft's "Permissions Mock" (codeunit 131006) present on this server? Mirrors
    /// the guard `Test Runner - Mgt`'s own `StartStopPermissionMock` uses to decide whether to
    /// toggle it at all, so this answers the same question the platform asks itself — and it is the
    /// difference between reporting "the write was refused" and reporting "the write was refused AND
    /// the thing that refuses it is installed here", which is what a 'mocked' verdict claims.</summary>
    local procedure PermissionsMockInstalled(): Boolean
    var
        AllObj: Record AllObj;
    begin
        AllObj.SetRange("Object Type", AllObj."Object Type"::Codeunit);
        AllObj.SetRange("Object ID", PermissionsMockCodeunitId());
        exit(not AllObj.IsEmpty());
    end;

    /// <summary>Microsoft's "Permissions Mock" codeunit id. Named rather than written as a bare
    /// literal so it is greppable against the doc comments that cite it.</summary>
    local procedure PermissionsMockCodeunitId(): Integer
    begin
        exit(131006);
    end;

    /// <summary>The refused-write diagnostic, in order of how directly it explains the refusal: a
    /// caught terminal error from the run itself (the ONLY diagnostic that exists on that path —
    /// `Results()` is meaningless there, so dropping `RunError` here would discard the sole piece of
    /// evidence for a run that failed AFTER stage 1 recorded), then the framework's own record of
    /// the failing test line, then the whole runner result. Never an empty string: an inconclusive-
    /// looking verdict with no reason attached is the one an operator cannot act on.</summary>
    local procedure CanaryRefusalDetail(InsertOk: Boolean; RunError: Text; HaveTestLine: Boolean; TestMessage: Text; RunnerResults: Text): Text
    begin
        if InsertOk then
            exit('');
        if RunError <> '' then
            exit(StrSubstNo('the fenced test run raised a terminal error: %1', RunError));
        if HaveTestLine and (TestMessage <> '') then
            exit(TestMessage);
        exit(StrSubstNo('the probe insert did not complete and the test framework reported no message; runner result: %1', RunnerResults));
    end;

    /// <summary>`Test Method Line.Result::Success` as `TestResultsToJSON` emits it — confirmed live
    /// on Cronus281 and already relied on by `run-mutant-transport.ts`'s `RESULT_SUCCESS`. Named
    /// here rather than written as a bare `2` at the one call site so the two ends of that same
    /// wire contract are greppable together.</summary>
    local procedure TestResultSuccess(): Integer
    begin
        exit(2);
    end;

    /// <summary>Reads the single test line out of `LC Run Method`'s result JSON — the SAME
    /// `Test Suite Mgt.TestResultsToJSON` shape `run-mutant-transport.ts` parses for every mutant
    /// ({testResults:[{method, result, message, stackTrace}]}), not a new format.
    ///
    /// It holds itself to that contract's FULL strictness, exactly as the TS side does: EXACTLY ONE
    /// element, and that element's `method` must be the canary's own. Taking index 0 and trusting it
    /// is harmless only while codeunit 91010 declares a single [Test]; the moment a second one is
    /// added, the consistency guard above would read a foreign line and quote the wrong message —
    /// a fail-closed check today is cheaper than the confusing verdict that would produce.
    ///
    /// Returns false, leaving the outputs untouched, for anything that is not exactly that shape
    /// (including the fail-closed {"error": ...} payload `RunOneMethod` produces): a caller that
    /// cannot read a test line must not act as though it read one.</summary>
    local procedure ReadCanaryTestLine(ResultsJson: Text; var TestMessage: Text; var TestResult: Integer): Boolean
    var
        Root: JsonObject;
        LineObj: JsonObject;
        ResultsTok: JsonToken;
        LineTok: JsonToken;
        FieldTok: JsonToken;
    begin
        TestMessage := '';
        TestResult := 0;
        if ResultsJson = '' then
            exit(false);
        if not Root.ReadFrom(ResultsJson) then
            exit(false);
        if not Root.Get('testResults', ResultsTok) then
            exit(false);
        if not ResultsTok.IsArray() then
            exit(false);
        // Exactly one — never "at least one". A different count means the suite did not hold only
        // the method this canary asked for, so no line in it can be trusted to be that method's.
        if ResultsTok.AsArray().Count() <> 1 then
            exit(false);
        if not ResultsTok.AsArray().Get(0, LineTok) then
            exit(false);
        if not LineTok.IsObject() then
            exit(false);
        LineObj := LineTok.AsObject();
        if not LineObj.Get('method', FieldTok) then
            exit(false);
        if not FieldTok.IsValue() then
            exit(false);
        if FieldTok.AsValue().AsText() <> CanaryTestMethodName() then
            exit(false);
        if LineObj.Get('result', FieldTok) then
            if FieldTok.IsValue() then
                TestResult := FieldTok.AsValue().AsInteger();
        if LineObj.Get('message', FieldTok) then
            if FieldTok.IsValue() then
                TestMessage := FieldTok.AsValue().AsText();
        exit(true);
    end;

    /// <summary>The one canary test method's name. Defined once so the dispatch above and the
    /// echoed-line check in `ReadCanaryTestLine` can never name different methods.</summary>
    local procedure CanaryTestMethodName(): Text
    begin
        exit('ProbeInherentPermissions');
    end;

    /// <summary>The verdict mapping, from the two MEASURED worlds: where a test body's permissions
    /// are stripped, a plain `Insert` is refused with "Sorry, the current permissions prevented the
    /// action" and the probe reports read=No write=No; where they are not, it reports read=Yes
    /// write=Yes and the `Insert` succeeds. Since "LC Permission Canary" now declares
    /// `TestPermissions = Disabled`, the first world is the one no server we have produces — the
    /// verdict names are kept ('mocked' / 'not-mocked'), and a 'mocked' answer today would mean the
    /// platform strips even a correctly-declared test codeunit.
    ///
    /// 'mocked' requires BOTH a refused write flag AND an insert that did not complete. The insert
    /// is the operationally decisive fact (it is exactly what makes a real test fail inside the
    /// fence); `WritePermission` corroborates it, and demanding both keeps an insert failing for
    /// some unrelated reason — a broken table, a disk error — from being reported as the permission
    /// mock. That conjunction is UNCHANGED from the first version: the live failure was in how the
    /// insert was invoked, not in what the verdict is derived from, and weakening the rule to
    /// `WritePermission` alone would have dodged the platform error rather than fixed it.
    /// 'not-mocked' demands the complete clean picture. Anything in between is a genuinely mixed
    /// signal and is reported INCONCLUSIVE with the observation attached, never rounded to
    /// whichever verdict is closer.
    ///
    /// TWO ATTRIBUTION GATES run BEFORE that mapping, and both can only ever produce 'inconclusive'
    /// (see this action's doc comment for why each exists):
    ///
    /// - No write permission on the probe OUTSIDE the fence either. The refusal then has nothing to
    ///   do with the test path — the whole session lacks the permission, which is exactly the 5C-A
    ///   calling-user gap its sibling tables carry `InherentPermissions = RIMD` to work around. The
    ///   canary cannot measure anything on such a container and says so, instead of reporting a
    ///   permanent 'mocked'.
    /// - The mock is not installed. A write refused inside the fence on a server with no codeunit
    ///   131006 was refused by something else; naming the mock would be a guess.</summary>
    local procedure BuildCanaryResult(BaselineRead: Boolean; BaselineWrite: Boolean; MockInstalled: Boolean; CanRead: Boolean; CanWrite: Boolean; InsertOk: Boolean; RefusalDetail: Text): Text
    var
        Obj: JsonObject;
        Out: Text;
        Verdict: Text;
        Detail: Text;
    begin
        if not BaselineWrite then begin
            Verdict := 'inconclusive';
            Detail := StrSubstNo('unattributable: this session has NO write permission on the probe table OUTSIDE the fence either (baseline read=%1 write=%2), so an in-fence refusal is not evidence of the permission mock — the calling user does not hold this extension''s permission set at all (the 5C-A finding its sibling tables carry InherentPermissions to work around). Grant the OData user that permission set and re-run; until then this server cannot be characterised. In-fence observation was read=%3 write=%4 insert=%5.', BaselineRead, BaselineWrite, CanRead, CanWrite, InsertOk);
        end else
            if (not CanWrite) and (not InsertOk) then begin
                if MockInstalled then begin
                    Verdict := 'mocked';
                    Detail := RefusalDetail;
                end else begin
                    Verdict := 'inconclusive';
                    Detail := StrSubstNo('unattributable: the in-fence write WAS refused, but codeunit %1 ("Permissions Mock") is not installed on this server, so the refusal was caused by something else and must not be reported as the mock. Refusal was: %2', PermissionsMockCodeunitId(), RefusalDetail);
                end;
            end else
                if CanRead and CanWrite and InsertOk then begin
                    Verdict := 'not-mocked';
                    Detail := '';
                end else begin
                    Verdict := 'inconclusive';
                    Detail := StrSubstNo('mixed signal — read=%1 write=%2 insert=%3 detail=%4', CanRead, CanWrite, InsertOk, RefusalDetail);
                end;

        Obj.Add('verdict', Verdict);
        Obj.Add('observed', true);
        AddCanaryContext(Obj, BaselineRead, BaselineWrite, MockInstalled);
        Obj.Add('readPermission', CanRead);
        Obj.Add('writePermission', CanWrite);
        Obj.Add('insertSucceeded', InsertOk);
        if Detail <> '' then
            Obj.Add('detail', Detail);
        Obj.WriteTo(Out);
        exit(Out);
    end;

    /// <summary>The no-observation exit. Carries `observed:false` and NO in-fence permission keys —
    /// see `PermissionCanary`'s doc comment for why those are omitted rather than defaulted. The
    /// attribution context IS carried: it was measured before the test ran and does not depend on
    /// the test having worked, so it is exactly what makes this inconclusive actionable.</summary>
    local procedure BuildCanaryInconclusive(BaselineRead: Boolean; BaselineWrite: Boolean; MockInstalled: Boolean; Detail: Text): Text
    var
        Obj: JsonObject;
        Out: Text;
    begin
        Obj.Add('verdict', 'inconclusive');
        Obj.Add('observed', false);
        AddCanaryContext(Obj, BaselineRead, BaselineWrite, MockInstalled);
        Obj.Add('detail', Detail);
        Obj.WriteTo(Out);
        exit(Out);
    end;

    /// <summary>The three always-present attribution keys, added in one place so the two builders
    /// cannot drift into emitting different context for the same measurement.</summary>
    local procedure AddCanaryContext(var Obj: JsonObject; BaselineRead: Boolean; BaselineWrite: Boolean; MockInstalled: Boolean)
    begin
        Obj.Add('baselineReadPermission', BaselineRead);
        Obj.Add('baselineWritePermission', BaselineWrite);
        Obj.Add('mockInstalled', MockInstalled);
    end;

    /// <summary>Whichever diagnostic actually exists for a no-observation run: the caught terminal
    /// error text when `Runner.Run()` returned false, otherwise the runner's own result JSON (which
    /// carries either the fail-closed {"error": ...} shape or the test line that did not reach
    /// stage 1). Never both, never an empty string — an inconclusive verdict with no reason attached
    /// is the thing an operator cannot act on. This is also the exit that reported the live
    /// [TryFunction] defect (2026-07-26, Cronus282), carrying the platform's own "not allowed inside
    /// the call to 'RunTests'" message all the way to the operator, which is what made it
    /// diagnosable at all rather than a silent wrong answer.</summary>
    local procedure CanaryInconclusiveDetail(RunError: Text; RunnerResults: Text): Text
    begin
        if RunError <> '' then
            exit(StrSubstNo('the canary test recorded no observation; the fenced test run raised a terminal error: %1', RunError));
        if RunnerResults <> '' then
            exit(StrSubstNo('the canary test recorded no observation; the fenced test run returned: %1', RunnerResults));
        exit('the canary test recorded no observation and the fenced test run returned no result at all');
    end;

    /// <summary>Wraps a caught phase-2 terminal error in the SAME {"error": ...} codeunitResults shape
    /// RunOneMethod already uses for its own fail-closed path. Deliberately not a bare string and not a
    /// testResults array: a client parsing codeunitResults finds zero test lines and must classify it
    /// as a typed error, never as a pass/fail verdict.</summary>
    local procedure BuildRunError(ErrorText: Text): Text
    var
        Obj: JsonObject;
        Out: Text;
    begin
        Obj.Add('error', ErrorText);
        Obj.WriteTo(Out);
        exit(Out);
    end;

    /// <summary>Builds the AcquireLease JSON result. On grant: {granted, epoch, token,
    /// serverGeneration, lastCompletedOpSeq, expiresAt}. On refusal: {granted:false, reason} plus
    /// {holder, expiresAt} for "held"/"operation-busy" or {opAttemptId, opStartedAt} for
    /// "operation-orphaned" (generation-changed carries reason only).</summary>
    local procedure BuildAcquireResult(Granted: Boolean; Epoch: Integer; Token: Text; ServerGeneration: Text; LastCompletedOpSeq: BigInteger; ExpiresAt: DateTime; Reason: Text; Holder: Text; OpAttemptId: Text; OpStartedAt: DateTime): Text
    var
        Obj: JsonObject;
        Out: Text;
    begin
        Obj.Add('granted', Granted);
        if Granted then begin
            Obj.Add('epoch', Epoch);
            Obj.Add('token', Token);
            Obj.Add('serverGeneration', ServerGeneration);
            Obj.Add('lastCompletedOpSeq', LastCompletedOpSeq);
            Obj.Add('expiresAt', ExpiresAt);
        end else begin
            Obj.Add('reason', Reason);
            case Reason of
                'held', 'operation-busy':
                    begin
                        Obj.Add('holder', Holder);
                        Obj.Add('expiresAt', ExpiresAt);
                    end;
                'operation-orphaned':
                    begin
                        Obj.Add('opAttemptId', OpAttemptId);
                        Obj.Add('opStartedAt', OpStartedAt);
                    end;
            end;
        end;
        Obj.WriteTo(Out);
        exit(Out);
    end;

    /// <summary>Builds the RunMutant JSON result. `Reason` is optional (blank on 'ran'), populated
    /// on phase-1 refusals, where it may differ from Status (e.g. Status 'lease-invalid' with Reason
    /// 'op-in-flight' for a still-active same-attempt duplicate claim), and since R198/R203 on ONE
    /// phase-3 refusal: 'op-stopped', the op our own stop tombstoned while the session finished.</summary>
    local procedure BuildStatus(Status: Text; TargetAppId: Text; ArtifactId: Text; AttemptId: Text; MutantId: Text; TestCodeunitId: Integer; TestMethod: Text; CodeunitResults: Text; ObservedAny: Boolean; IdentityMismatch: Boolean; Reason: Text; TestRunsBefore: Integer): Text
    var
        Obj: JsonObject;
        Out: Text;
    begin
        Obj.Add('status', Status);
        if Reason <> '' then
            Obj.Add('reason', Reason);
        Obj.Add('targetAppId', TargetAppId);
        Obj.Add('artifactId', ArtifactId);
        Obj.Add('attemptId', AttemptId);
        Obj.Add('mutantId', MutantId);
        Obj.Add('codeunitId', TestCodeunitId);
        Obj.Add('method', TestMethod);
        if CodeunitResults <> '' then
            Obj.Add('codeunitResults', CodeunitResults);
        Obj.Add('observedAny', ObservedAny);
        Obj.Add('identityMismatch', IdentityMismatch);
        AddSessionKeys(Obj, Status, TestRunsBefore);
        Obj.WriteTo(Out);
        exit(Out);
    end;

    /// <summary>R206 §2.1: on a 'ran' answer only, the session-freshness predicate read at the top
    /// of the action (`testRunsBefore`, 0 = fresh) and this session's id (`sessionId`, recorded by
    /// the client as data). A refusal ran nothing and carries neither; the client checks for them
    /// inside its `ran` branch only, so a refusal keeps its own class.</summary>
    local procedure AddSessionKeys(var Obj: JsonObject; Status: Text; TestRunsBefore: Integer)
    begin
        if Status <> 'ran' then
            exit;
        Obj.Add('testRunsBefore', TestRunsBefore);
        Obj.Add('sessionId', SessionId());
    end;

    /// <summary>Builds the RunMutantMany JSON result: the call-level echo RunMutant's has (status,
    /// reason?, targetAppId, artifactId, attemptId, mutantId, observedAny, identityMismatch) and,
    /// on 'ran', EITHER the loop's {endedBy, ranCount, methods} merged in OR `runError`. Never both,
    /// never neither.</summary>
    local procedure BuildManyStatus(Status: Text; TargetAppId: Text; ArtifactId: Text; AttemptId: Text; MutantId: Text; GroupResults: Text; RunError: Text; ObservedAny: Boolean; IdentityMismatch: Boolean; Reason: Text; TestRunsBefore: Integer): Text
    var
        Obj: JsonObject;
        Group: JsonObject;
        Tok: JsonToken;
        Out: Text;
    begin
        Obj.Add('status', Status);
        if Reason <> '' then
            Obj.Add('reason', Reason);
        Obj.Add('targetAppId', TargetAppId);
        Obj.Add('artifactId', ArtifactId);
        Obj.Add('attemptId', AttemptId);
        Obj.Add('mutantId', MutantId);
        Obj.Add('observedAny', ObservedAny);
        Obj.Add('identityMismatch', IdentityMismatch);
        AddSessionKeys(Obj, Status, TestRunsBefore);
        if Status = 'ran' then
            if RunError <> '' then
                Obj.Add('runError', RunError)
            else begin
                if not Group.ReadFrom(GroupResults) then
                    Obj.Add('runError', 'LC Run Many returned no JSON object: ' + CopyStr(GroupResults, 1, 300))
                else begin
                    Group.Get('endedBy', Tok);
                    Obj.Add('endedBy', Tok);
                    Group.Get('ranCount', Tok);
                    Obj.Add('ranCount', Tok);
                    Group.Get('methods', Tok);
                    Obj.Add('methods', Tok);
                end;
            end;
        Obj.WriteTo(Out);
        exit(Out);
    end;

    /// <summary>HarnessInfo's protocol-incompatibility error (design §7, R4 sol#8). Names BOTH sides so
    /// a client parsing this message (or a human debugging a failed handshake) never has to guess which
    /// end is stale: the caller's supplied clientProtocol and this server's protocolVersion.</summary>
    local procedure ProtocolIncompatibleErr(ClientProtocol: Integer): Text
    begin
        exit(StrSubstNo('HarnessInfo requires clientProtocol >= 2; caller sent clientProtocol %1, server speaks protocolVersion 2. Refusing an incompatible handshake before any publish (design §7) — a v1 client that omits clientProtocol entirely is refused earlier, as a missing required OData parameter, and never reaches this check.', ClientProtocol));
    end;
}
