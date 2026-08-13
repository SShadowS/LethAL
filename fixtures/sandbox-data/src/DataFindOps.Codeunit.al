// R136 arms D, E and F for the new `lethal.swap-find-direction`. Target: "Data Trigger Probe".
// Spec: docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md section 3.2.
//
// Arms D and E each need an out-of-range DECOY row seeded by their own covering test, sorting
// BEFORE the filtered range for the FindFirst arm and AFTER it for the FindLast arm, with a Level
// differing from the asserted value. Without it, the collateral remove-setrange mutant at the arm's
// own SetRange is equivalent with respect to the seeded data and survives for a reason unrelated to
// this fixture's intent (spec section 3.3 rule 1).
codeunit 79315 "Data Find Ops"
{
    // ARM D -- the KILL for FindFirst -> FindLast, in EXPRESSION position (the call is an `if`
    // condition). FindFirstPicksTheLowestKeyInRange seeds two in-range rows plus a decoy that sorts
    // BEFORE the range; swapped to FindLast the site lands on the HIGH row instead and the asserted
    // LOW Level fails to match.
    //
    // PREDICTED: killed, by FindFirstPicksTheLowestKeyInRange.
    procedure FirstLevelInRange(FromNo: Code[20]; ToNo: Code[20]): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe.SetRange("No.", FromNo, ToNo);
        if Probe.FindFirst() then
            exit(Probe."Level");
    end;

    // ARM E -- the KILL for the other direction, so both directions are measured live. The decoy
    // sorts AFTER the range this time (rule 1 is directional, not just for one arm): swapped to
    // FindFirst the site lands on the LOW row instead of the asserted HIGH one.
    //
    // PREDICTED: killed, by FindLastPicksTheHighestKeyInRange.
    procedure LastLevelInRange(FromNo: Code[20]; ToNo: Code[20]): Integer
    var
        Probe: Record "Data Trigger Probe";
    begin
        Probe.SetRange("No.", FromNo, ToNo);
        if Probe.FindLast() then
            exit(Probe."Level");
    end;

    // ARM F -- the EQUIVALENT-to-this-suite SURVIVOR, and the second expression-position shape
    // (inside an `exit`). No filter and no parameters: the first draft's SetRange was DELETED
    // (spec section 3.2 amendment 7) because removing a filter cannot change an existence answer
    // while an in-range row is present, so its remove-setrange collateral was equivalent BY
    // CONSTRUCTION and would have been misread as a fixture defect. An existence-only assertion
    // cannot see a direction reversal, which is exactly the limit swap-find-direction's equivalence
    // class documents.
    //
    // PREDICTED: survived, by ExistenceOnlyAssertionMissesTheDirection.
    procedure AnyRow(): Boolean
    var
        Probe: Record "Data Trigger Probe";
    begin
        exit(Probe.FindFirst());
    end;
}
