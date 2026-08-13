// R136 arms G, H and J for the new `lethal.validate-to-assign`. Target: "Data Trigger Probe".
// Spec: docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md section 3.2. (Arm I, the
// IMPLICIT-receiver form, lives on the table itself -- see
// "Data Trigger Probe".ValidateLevelImplicit -- because there is no other way to measure that emit
// path live.)
//
// None of these three needs a database row: Validate runs OnValidate against the in-memory record
// with no row involved, which `Data Tests.BlankNoValidateFails` and `NoTriggerValidateRunsWeak`
// already establish (spec section 3.3 rule 3), so dropping the insert/modify calls the first draft
// had removes four collateral mutants and all key handling from this codeunit.
codeunit 79316 "Data Validate Ops"
{
    // ARM G -- the KILL, with a QUOTED field identifier ("Level"). The assignment
    // `Rec."Level" := NewLevel` skips OnValidate, "Level Doubled" stays 0, and
    // ValidateRunsTheFieldTrigger's assertion of the doubled value fails.
    //
    // PREDICTED: killed, by ValidateRunsTheFieldTrigger.
    procedure SetLevel(NewLevel: Integer): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe.Validate("Level", NewLevel);
        exit(Probe."Level Doubled");
    end;

    // ARM H -- the SURVIVOR, and the sharpest arm in the wave (spec section 3.2): the assignment
    // leaves "Level" itself CORRECT, so ValueOnlyAssertionMissesTheTriggerSkip's assertion of the
    // plain field value passes, while void-method-call at the SAME span kills because deleting the
    // call leaves "Level" at 0. Same span, two mutants, two different verdicts -- a bug class
    // Tier 1 cannot express on its own.
    //
    // PREDICTED: survived, by ValueOnlyAssertionMissesTheTriggerSkip.
    procedure SetLevelWeak(NewLevel: Integer): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe.Validate("Level", NewLevel);
        exit(Probe."Level");
    end;

    // ARM J -- the REFUSAL negative, the R82 arm F role. The single-argument
    // `Probe.Validate("Level")` has no assignment equivalent, so validate-to-assign must emit
    // NOTHING here (the exact-count argument guard refuses it). The hand assignment does not run
    // OnValidate, so "Level Doubled" would stay 0 if the following Validate call were ever
    // deleted -- which is exactly what its own void-method-call mutant does, pinned killed by
    // TouchLevelRunsTheTriggerAgain.
    //
    // PREDICTED: no validate-to-assign mutant at this site; the void-method-call deletion there is
    // killed.
    procedure TouchLevel(NewLevel: Integer): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe."Level" := NewLevel;
        Probe.Validate("Level");
        exit(Probe."Level Doubled");
    end;
}
