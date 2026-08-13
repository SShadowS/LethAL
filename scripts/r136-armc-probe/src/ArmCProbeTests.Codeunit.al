// R136 arm C probe -- MEASURES, rather than reasons about, whether
// `Rec."No." := X; Rec.Delete(true);` (no preceding Get/Find/Insert on THAT variable) deletes the
// row and runs OnDelete. This is the exact shape of
// fixtures/sandbox-data/src/DataFlagOps.Codeunit.al's DeleteWithTrigger (arm C), committed in
// fd4d21c without this measurement having been made first.
codeunit 71571 "R136 ArmC Probe Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure DeleteWithoutGetRunsOnDelete()
    var
        Seed: Record "R136 ArmC Probe";
        Tomb: Record "R136 ArmC Probe";
        Probe: Record "R136 ArmC Probe";
    begin
        // Clean slate, same discipline as the committed fixture: Delete(false) only, clear the
        // tombstone first.
        if Tomb.Get('TOMB-ARMC1') then
            Tomb.Delete(false);
        if Seed.Get('ARMC1') then
            Seed.Delete(false);
        Seed.Init();
        Seed."No." := 'ARMC1';
        Seed.Insert(false);

        // THE MEASURED SHAPE: a FRESH record variable, never Get/Find/Insert'd by this code --
        // only its primary key assigned -- then Delete(true). This is arm C's own body, verbatim.
        Probe."No." := 'ARMC1';
        Probe.Delete(true);

        if not Tomb.Get('TOMB-ARMC1') then
            Error('MEASURED: FAIL -- Delete(true) on a key-only record ran with no runtime error, but OnDelete did not leave a tombstone (row deleted without running the trigger, or the trigger did not fire as expected)');

        Error('MEASURED: PASS -- Delete(true) on a key-only record (no prior Get/Find) ran OnDelete and left the tombstone. No runtime error was raised locating the row by primary key alone.');
    end;
}
