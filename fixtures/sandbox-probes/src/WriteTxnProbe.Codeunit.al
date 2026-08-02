// R72: what EXACTLY does BC say when `Codeunit.Run` is called inside a write transaction, and is
// it even catchable?
//
// `RemoveCommit` deletes a `Commit()` before a `Codeunit.Run(...)`. If the platform then refuses
// the call, the mutant dies for a reason that says NOTHING about assertion quality — a platform
// artifact counted as test quality, inflating the score. R72 asks for a best-effort DIAGNOSIS of
// that case, and the row is explicit about the order: produce the artifact live, pin its text per
// runner, THEN write the detector. A detector written against an assumed string is the R31 shape,
// where a reworded literal silently stops a diagnosis firing.
//
// Reported as an `Error` for the same reason `Session Capability Probe` does: a passing test
// surfaces nothing, a failing one carries its message back verbatim on both runners. The test
// showing FAILED is the transport, not a broken probe.
//
// Three things are measured at once, because guessing any of them is how this goes wrong:
//   1. Is the refusal RAISED AT ALL, or does BC allow the call? (`Codeunit.Run` inside a write
//      transaction is folklore until measured on THIS platform version.)
//   2. Is it CATCHABLE by `Codeunit.Run`'s Boolean form — i.e. does `GetLastErrorText` hold it —
//      or does it escape as an uncatchable error?
//   3. The exact text, verbatim and unformatted, so a detector can be written against a real
//      string rather than a remembered one.
codeunit 79219 "Write Txn Probe"
{
    Subtype = Test;
    // R1: without this, Microsoft's Permissions Mock refuses the write below on every runner, and
    // the probe would measure its own permissions rather than the transaction rule.
    TestPermissions = Disabled;

    // THREE tests, not one, because the first run of this probe produced BC's generic
    // "An error occurred and the transaction is stopped" at an AL-callstack line that maps
    // ambiguously onto the source — so the failing statement could not be named from the message.
    // Decoding AL's line numbering would have been a guess; isolating the variable by A/B is the
    // house rule and costs one extra test each way.
    //
    // Read them together: WriteOnly and RunOnly are the controls, WriteThenRun is the shape a
    // `RemoveCommit` mutant actually creates.

    [Test]
    procedure WriteThenRun()
    var
        Captured: Text;
        Ran: Boolean;
    begin
        SeedMarker(79219);
        Ran := Codeunit.Run(Codeunit::"Write Txn Target");
        if Ran then
            Captured := '<<NO REFUSAL - Codeunit.Run SUCCEEDED inside an open write transaction>>'
        else
            Captured := GetLastErrorText();
        Error('MEASURED WriteThenRun ran=%1 | text=[%2]', Ran, Captured);
    end;

    [Test]
    procedure WriteOnly()
    begin
        // Control 1: does the WRITE alone survive? If this also fails, the refusal above is about
        // permissions or the marker table, not about the transaction rule.
        SeedMarker(79219);
        Error('MEASURED WriteOnly reached end - the write itself is fine');
    end;

    [Test]
    procedure RunOnly()
    var
        Ran: Boolean;
    begin
        // Control 2: does `Codeunit.Run` alone survive, with NO write opened first? If this fails
        // too, the callee is at fault and the transaction is not the variable.
        Ran := Codeunit.Run(Codeunit::"Write Txn Target");
        Error('MEASURED RunOnly ran=%1', Ran);
    end;

    local procedure SeedMarker(EntryNo: Integer)
    var
        Marker: Record "Sandbox Probe Marker";
    begin
        Marker.Init();
        Marker."Entry No." := EntryNo;
        if not Marker.Insert(false) then
            Marker.Modify(false);
    end;
}
