// R33 / spec §5: the `SwapRecXRec` go/no-go experiment.
//
// Spec: "built only if an experiment justifies it. When `Modify(true)` is driven from AL code
// rather than a page, `xRec` may carry the same values as `Rec`; LethAL drives every test
// headlessly. If `xRec` does not differ in that path, the operator is near-worthless in this
// execution model." **Go criterion: the two recorded values differ.**
//
// Deliberately in `sandbox-probes`, which is published and driven separately and belongs to NO
// frozen mutation baseline — adding a test here cannot move `itest:bcdev` or `itest:tables`.
//
// The test is RED by construction (the trigger raises), which is the transport, not a broken
// probe: LethAL's console and report carry a baseline failure's message verbatim, so the
// measurement arrives whichever runner executes it.
codeunit 79214 "Rec XRec Probe Tests"
{
    Subtype = Test;
    // R1: without this, AL's Restrictive default strips a test body of write permission on its own
    // app's tables and the Insert below is refused on EVERY runner — the probe would then measure
    // the permission system rather than `xRec`.
    TestPermissions = Disabled;

    [Test]
    procedure ReportsRecVsXRecOnModify()
    var
        Probe: Record "Rec XRec Probe";
    begin
        if Probe.Get('RX1') then
            Probe.Delete(false);
        Probe.Init();
        Probe."No." := 'RX1';
        Probe.Amount := 100;
        Probe.Insert(false);

        // Re-read so the variable holds exactly what the database holds, which is the shape a real
        // `Modify(true)` site has: read a row, change a field, write it back.
        Probe.Get('RX1');
        Probe.Amount := 250;
        // Raises from OnModify with both values. 250 vs 100 = the operator has signal here;
        // 250 vs 250 = it does not, and the spec says to record that instead of building it.
        Probe.Modify(true);
    end;
}
