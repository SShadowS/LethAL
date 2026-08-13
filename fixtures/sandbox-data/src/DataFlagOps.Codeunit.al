// R136 arms A, B, C and K for the extended `lethal.swap-modify-flag` (now covering Insert/Delete,
// version 1.1.0). Target: "Data Trigger Probe" (arms A-C) and "Data Key Probe" (arm K).
// Spec: docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md section 3.2.
//
// Every delete of a "Data Trigger Probe" row anywhere in this suite other than arm C's own uses
// Delete(false) -- the table's OnDelete inserts a tombstone, a unique-key write, so running it twice
// for the same key raises a duplicate key error (spec section 3.3 rule 7). Arm C is the only code in
// this fixture allowed to run OnDelete.
codeunit 79314 "Data Flag Ops"
{
    // ARM A -- the KILL for the Insert half. Insert(false) skips OnInsert, "Inserted By Trigger"
    // stays false, and InsertRunTriggerSetsTheTriggerField's assertion fails.
    //
    // PREDICTED: killed, by InsertRunTriggerSetsTheTriggerField.
    procedure InsertWithTrigger(No: Code[20]): Boolean
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe."No." := No;
        Probe.Insert(true);
        exit(Probe."Inserted By Trigger");
    end;

    // ARM B -- the SURVIVOR for the Insert half, and the first same-span discriminating pair (spec
    // section 2.4): Insert(false) still inserts the row, so the read-back still finds it and
    // WeakInsertAssertionMissesTheFlag still passes; void-method-call at the same span deletes the
    // Insert entirely, so no row lands. The read-back's return value is CONSUMED
    // (`exit(Probe.Get(No))`), not a statement-position Get followed by exit(true) -- a
    // statement-position Get raises when the row is absent, which would make void-method-call kill
    // by platform error instead of by this assertion (spec section 3.2 amendment 11).
    //
    // PREDICTED: survived, by WeakInsertAssertionMissesTheFlag.
    procedure InsertCounted(No: Code[20]): Boolean
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe."No." := No;
        Probe.Insert(true);
        exit(Probe.Get(No));
    end;

    // ARM C -- the KILL for the Delete half. The row is seeded by the TEST, not here (spec
    // section 3.3 rule 3: statements in the target app are not free), so this procedure only sets
    // the key and deletes it. Delete(false) skips OnDelete, no tombstone appears, and
    // DeleteRunTriggerLeavesTombstone's read-back -- CONSUMED for the same reason as arm B -- comes
    // back false.
    //
    // PREDICTED: killed, by DeleteRunTriggerLeavesTombstone.
    procedure DeleteWithTrigger(No: Code[20]): Boolean
    var
        Probe: Record "Data Trigger Probe";
        Tomb: Record "Data Trigger Probe";
    begin
        Probe."No." := No;
        Probe.Delete(true);
        exit(Tomb.Get('TOMB-' + No));
    end;

    // ARM K -- this operator's own R82-arm-E, and the reason the R136 review blocked the first
    // draft (finding 1, blocker): a PLATFORM-ARTIFACT kill that no screen tags (R138). Target:
    // "Data Key Probe", whose OnInsert assigns "No." from a row count when it is blank.
    //
    // Exactly one mutant is active per run, so a single Insert(false) executed TWICE is what
    // produces the duplicate: OnInsert never fires, "No." stays blank both iterations, the first
    // blank-key insert succeeds and the second raises a duplicate key. The kill therefore cannot
    // have come from an assertion, because DoubleInsertWithoutKeyTriggerRaises makes none -- it
    // dies on the uncaught platform error. Its control is empty-block on this loop body, which must
    // SURVIVE for the same reason: an emptied loop inserts nothing and raises nothing either.
    //
    // PREDICTED: killed, by a platform error, and tagged by NO screen (R138) -- never described as
    // "the suite caught it".
    procedure InsertTwiceWithKeyTrigger()
    var
        KeyProbe: Record "Data Key Probe";
        i: Integer;
    begin
        for i := 1 to 2 do begin
            KeyProbe.Init();
            KeyProbe.Insert(true);
        end;
    end;
}
