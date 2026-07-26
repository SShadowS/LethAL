namespace LethAL.Control;

/// <summary>
/// Carries the permission canary's observation OUT of the test body (ROADMAP R26), in TWO STAGES.
///
/// WHY TWO STAGES. The measurement is a plain, unwrapped `Insert` in the test body — it has to be,
/// or the canary stops travelling the path it characterises (see "LC Permission Canary"'s summary
/// for the live failure that proved it). A plain write that permissions refuse ABORTS the test
/// method on the spot: there is no "after" in which to record anything, and no error text to read.
/// So the observation is split at exactly that point. `ObservePermissions` runs BEFORE the write
/// and captures everything already known; `ObserveInsertSucceeded` runs AFTER it and can only be
/// reached by a write the platform allowed. The ABSENCE of stage 2 is itself the measurement — not
/// a captured error string, which the earlier [TryFunction] design chased and could not have.
///
/// WHY A SINGLEINSTANCE CODEUNIT AT ALL. In-memory globals on a `SingleInstance` codeunit live in
/// the session, not the database, so neither the aborting error nor the test runner's per-test
/// rollback touches them. This is NOT a new mechanism: "LC Control State" (71002) already carries
/// the per-run attestation (`ObservedAny` / `ObservedIdentityMismatch`) across exactly this
/// boundary — set from inside a test body by the instrumented target's guard, read back by
/// `RunMutant` after `Runner.Run()` returns — and it does so for KILLED mutants too, i.e. for test
/// methods that ended in a failure. That is the same survival property stage 1 depends on here, and
/// it is proven live on every fenced run.
///
/// It is kept OFF "LC Control State" on purpose: that codeunit owns the lease/op-marker state
/// machine, where every field is part of a reviewed fencing argument. A canary has no business
/// widening that object's surface, and a bug here must not be able to reach anything the fence
/// depends on.
/// </summary>
codeunit 71009 "LC Permission Canary State"
{
    SingleInstance = true;

    var
        HasObservationValue: Boolean;
        CanReadValue: Boolean;
        CanWriteValue: Boolean;
        InsertSucceededValue: Boolean;

    /// <summary>Drops any observation from an earlier call in this session. The CALLER (the
    /// `PermissionCanary` OData action) must run this BEFORE dispatching the test, never after:
    /// `HasObservation()` returning false is the signal that the test body never reached even its
    /// FIRST recording call, and a stale observation left over from a previous invocation would
    /// answer a confident verdict for a run that never happened. Clearing `InsertSucceededValue`
    /// here matters just as much — a stale `true` would report a permitted write for a run whose
    /// write was refused.</summary>
    procedure ClearObservation()
    begin
        HasObservationValue := false;
        CanReadValue := false;
        CanWriteValue := false;
        InsertSucceededValue := false;
    end;

    /// <summary>STAGE 1: what is known before the write is attempted. Called from the test body as
    /// its first statement, so an aborting write cannot erase it.</summary>
    procedure ObservePermissions(NewCanRead: Boolean; NewCanWrite: Boolean)
    begin
        CanReadValue := NewCanRead;
        CanWriteValue := NewCanWrite;
        HasObservationValue := true;
    end;

    /// <summary>STAGE 2: reached only by a write the platform permitted. Takes no arguments by
    /// design — being called at all IS the fact being recorded.</summary>
    procedure ObserveInsertSucceeded()
    begin
        InsertSucceededValue := true;
    end;

    /// <summary>True only when STAGE 1 ran in this session since the last `ClearObservation`. False
    /// means the test body did not even reach its first statement — the canary is then
    /// INCONCLUSIVE, never "not mocked".</summary>
    procedure HasObservation(): Boolean
    begin
        exit(HasObservationValue);
    end;

    procedure ReadAllowed(): Boolean
    begin
        exit(CanReadValue);
    end;

    procedure WriteAllowed(): Boolean
    begin
        exit(CanWriteValue);
    end;

    /// <summary>True only when STAGE 2 was reached, i.e. the plain `Insert` was permitted. False
    /// covers BOTH "the write was refused" and "the method aborted before reaching stage 2" — which
    /// on this path are the same event, and neither is a permitted write.</summary>
    procedure InsertSucceeded(): Boolean
    begin
        exit(InsertSucceededValue);
    end;
}
