codeunit 79212 "Slow Run Probe"
{
    // Witnesses Layer 5C-B1's Round-1 finding sol#1 ("lock across run starves renew/steal") the ONLY
    // way that finding can actually be witnessed live: a [Test] method that is genuinely still
    // executing, server-side, while a concurrent RenewLease call lands
    // (packages/runner/itest/lease.itest.ts's P9B, cross-referenced from P9's own header). sol#1's
    // fix was "lock only in short critical sections" — RunMutant's phase 1 (claim) and phase 3
    // (verify-and-clear) each take a short LockTable() on the single "LC Lease" row, commit, and
    // release BEFORE this method's body ever runs (ControlState.Codeunit.al TryBeginRun/TryFinishRun),
    // so for the WHOLE duration of the sleep below, the lease row is unlocked and a concurrent
    // RenewLease must land freely. A regression that re-widens the lock across phase 2 would make a
    // concurrent renew issued during this sleep hang or fail — exactly what P9B asserts.
    //
    // MUST NEVER call anything in fixtures/sandbox-app. This codeunit lives in sandbox-probes
    // specifically so it is driven directly by RunMutantTransport (never discovered by runSession),
    // and calling sandbox-app code from here would let it move a mutant's verdict against the frozen
    // 3/10/3 (bcdev) / 3/13/0 (al-runner) baselines fixtures/sandbox-tests owns. This method touches
    // no table and no sandbox-app object — it only sleeps, then returns (an AL test with no Error
    // raised is a pass, same convention as fixtures/sandbox-tests's own ClampPercentRuns).
    Subtype = Test;

    [Test]
    procedure SleepsAcrossRenewWindow()
    begin
        Sleep(SlowSleepMs());
    end;

    // GraceMs() + RenewPeriodMs() + slack, mirroring lease.itest.ts's own P9_HOLD_MS derivation
    // (ControlState.Codeunit.al: RenewPeriodMs()=5000ms (local, unreadable over the wire),
    // GraceMs()=3*RenewPeriodMs()=15000ms) — long enough to span several renew periods AND cross the
    // grace window, so a holder that stopped renewing partway through this sleep would have visibly
    // aged from operation-busy to operation-orphaned before it returns.
    local procedure SlowSleepMs(): Integer
    begin
        exit(23000);
    end;
}
