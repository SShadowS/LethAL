namespace LethAL.Control;

/// <summary>
/// Carries the permission canary's observation OUT of the test body (ROADMAP R26).
///
/// WHY A SINGLEINSTANCE CODEUNIT AND NOT THE TEST'S OWN RESULT. The canary needs three facts —
/// `ReadPermission`, `WritePermission`, and the exact text of a real `Insert` failure — but a test
/// method's only channel back through `Test Suite Mgt.RunAllTests` is its pass/fail line plus a
/// length-bounded message field. Squeezing a structured observation through that message (and
/// re-parsing it on the other side) would make the canary's verdict depend on message formatting
/// and truncation, which is exactly the kind of accidental coupling that turns a measurement into
/// a guess. In-memory state on a `SingleInstance` codeunit crosses the same boundary with no
/// encoding at all.
///
/// This is NOT a new mechanism: "LC Control State" (71002) already carries the per-run attestation
/// (`ObservedAny` / `ObservedIdentityMismatch`) across exactly this boundary — set from inside a
/// test body by the instrumented target's guard, read back by `RunMutant` after `Runner.Run()`
/// returns. That path is proven live (every fenced mutant verdict depends on it), and this reuses
/// its one load-bearing property: a `SingleInstance` codeunit's globals live in the session, not
/// the database, so the test runner's per-test transaction rollback does not touch them, and the
/// permission mock does not gate them either (an in-memory write is not a data permission).
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
        InsertErrorValue: Text;

    /// <summary>Drops any observation from an earlier call in this session. The CALLER (the
    /// `PermissionCanary` OData action) must run this BEFORE dispatching the test, never after:
    /// `HasObservation()` returning false is the signal that the test body never reached its
    /// recording call, and a stale observation left over from a previous invocation would answer
    /// a confident verdict for a run that never happened.</summary>
    procedure ClearObservation()
    begin
        HasObservationValue := false;
        CanReadValue := false;
        CanWriteValue := false;
        InsertSucceededValue := false;
        InsertErrorValue := '';
    end;

    /// <summary>Records what the test body actually saw. `NewInsertError` is the verbatim
    /// `GetLastErrorText()` of the failed insert (empty when the insert succeeded).</summary>
    procedure Observe(NewCanRead: Boolean; NewCanWrite: Boolean; NewInsertSucceeded: Boolean; NewInsertError: Text)
    begin
        CanReadValue := NewCanRead;
        CanWriteValue := NewCanWrite;
        InsertSucceededValue := NewInsertSucceeded;
        InsertErrorValue := NewInsertError;
        HasObservationValue := true;
    end;

    /// <summary>True only when `Observe` actually ran in this session since the last
    /// `ClearObservation`. False means the test body did not complete — the canary is then
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

    procedure InsertSucceeded(): Boolean
    begin
        exit(InsertSucceededValue);
    end;

    procedure InsertErrorText(): Text
    begin
        exit(InsertErrorValue);
    end;
}
