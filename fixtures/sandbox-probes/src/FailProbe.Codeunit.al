codeunit 79211 "Fail Probe"
{
    // Witnesses the failure round-trip (spec §11): a test that fails with an EXACT, known error
    // string. The bcdev itest drives this via RunMutant and asserts the exact text survives the
    // identity-validated result mapping (result enum 1 -> fail, message carried through).
    Subtype = Test;

    [Test]
    procedure AlwaysFails()
    begin
        Error('LETHAL-PROBE-FAIL: exact-error-round-trip');
    end;
}
