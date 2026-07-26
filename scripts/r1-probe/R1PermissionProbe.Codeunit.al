// ROADMAP R1 investigation probe (Stream A, scratch — NOT part of the Tier-2 Phase 0 fixture).
//
// Measures the PERMISSION EXECUTION CONTEXT a test body actually runs under, so the difference
// between LethAL's two test-invocation paths can be observed rather than inferred:
//
//   * baseline / coverage runs go through bc-dev's dev-service test endpoint (`bcdev_test_run`)
//   * mutant runs go through the fenced OData `RunMutant` -> `Test Suite Mgt.RunAllTests`
//     -> codeunit 130450 "Test Runner - Isol. Codeunit" -> codeunit 130454 "Test Runner - Mgt"
//
// `Test Runner - Mgt.PlatformBeforeTestRun` calls its local `StartStopPermissionMock()`, which does
// `Codeunit.Run(131006)` whenever codeunit 131006 "Permissions Mock" exists in AllObj. That
// codeunit's OnRun is a strict toggle (`if Started then Stop() else Start()`), so the SECOND path
// runs every test body with permissions MOCKED, and the first does not.
//
// Results are surfaced via Error() because a passing AL test returns no payload — the test
// framework only ever reports a failure message, so Error() is the only channel a diagnostic value
// can travel out on. Each probe is therefore EXPECTED to "fail"; the message is the measurement.
codeunit 79311 "R1 Permission Probe"
{
    Subtype = Test;

    /// <summary>Reports the effective permissions of the running test body. Run through both paths
    /// and diff: an identical published app reporting different values proves the context differs.</summary>
    [Test]
    procedure R1ReportPermissions()
    var
        DataMain: Record "Data Main";
        Customer: Record Customer;
    begin
        Error(
            'R1DIAG user=%1 | DataMain(79300, third-party) read=%2 write=%3 | Customer(18, Microsoft) read=%4 write=%5',
            UserId(),
            DataMain.ReadPermission(),
            DataMain.WritePermission(),
            Customer.ReadPermission(),
            Customer.WritePermission());
    end;

    /// <summary>The unmodified reproduction: a plain INSERT into the target's own table, exactly
    /// what `InsertDoublesAmountWeak` does. Expected to pass on the dev endpoint and to fail on the
    /// fenced path with "Sorry, the current permissions prevented the action."</summary>
    [Test]
    procedure R1InsertPlain()
    var
        DataMain: Record "Data Main";
    begin
        if DataMain.Get('R1A') then
            DataMain.Delete(false);
        DataMain.Init();
        DataMain."No." := 'R1A';
        DataMain.Amount := 5;
        DataMain.Insert(true);
    end;

    /// <summary>CANDIDATE FIX, probed from the test app so no change to `LethAL Control` is needed
    /// to evaluate it: cancel the mock the test runner just switched on, by toggling codeunit 131006
    /// once more, then do the same INSERT. If this passes on the fenced path while R1InsertPlain
    /// fails, the mock is conclusively the cause AND toggle-cancelling is a working lever.
    ///
    /// The AllObj existence check mirrors Microsoft's own `StartStopPermissionMock`, so this stays a
    /// no-op on a server where the Permissions Mock app is not installed.</summary>
    [Test]
    procedure R1InsertAfterMockToggle()
    var
        DataMain: Record "Data Main";
        AllObj: Record AllObj;
    begin
        AllObj.SetRange("Object Type", AllObj."Object Type"::Codeunit);
        AllObj.SetRange("Object ID", 131006);
        if not AllObj.IsEmpty() then
            Codeunit.Run(131006);

        if DataMain.Get('R1B') then
            DataMain.Delete(false);
        DataMain.Init();
        DataMain."No." := 'R1B';
        DataMain.Amount := 5;
        DataMain.Insert(true);
    end;

    /// <summary>Same toggle, but reporting permissions instead of inserting — shows exactly which
    /// permissions the toggle restores.</summary>
    [Test]
    procedure R1ReportPermissionsAfterMockToggle()
    var
        DataMain: Record "Data Main";
        Customer: Record Customer;
        AllObj: Record AllObj;
    begin
        AllObj.SetRange("Object Type", AllObj."Object Type"::Codeunit);
        AllObj.SetRange("Object ID", 131006);
        if not AllObj.IsEmpty() then
            Codeunit.Run(131006);

        Error(
            'R1DIAG-TOGGLED user=%1 | DataMain(79300, third-party) read=%2 write=%3 | Customer(18, Microsoft) read=%4 write=%5',
            UserId(),
            DataMain.ReadPermission(),
            DataMain.WritePermission(),
            Customer.ReadPermission(),
            Customer.WritePermission());
    end;
}
