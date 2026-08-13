// R136's shared trigger-probe table -- the target for `swap-modify-flag`'s Insert/Delete extension,
// `swap-find-direction`, and `validate-to-assign`. Read `codeunit 79311 "Data Swap Ops"` first; this
// fixture follows its shape (each arm names its PREDICTED verdict and mechanism).
//
// Spec: docs/superpowers/specs/2026-08-12-r136-tier2-trio-design.md section 3. The three arm
// codeunits (`Data Flag Ops`, `Data Find Ops`, `Data Validate Ops`) target this table; arm K alone
// also targets the separate `table 79331 "Data Key Probe"`.
//
// Three triggers/fields carry the three operators' observability, and nothing else:
//   - OnInsert sets a Boolean, so skipping the insert trigger (arms A/B) is observable.
//   - OnDelete inserts a TOMBSTONE row (`TOMB-` + "No."), so skipping the delete trigger (arm C) is
//     observable. This makes OnDelete a UNIQUE-KEY WRITE: running it twice for the same "No." raises
//     a duplicate key, which is why every delete anywhere in this suite other than arm C's own uses
//     Delete(false) (spec section 3.3 rule 7).
//   - "Level"'s OnValidate doubles it into "Level Doubled", so skipping the validate chain (arms
//     G/H/I/J) is observable while "Level" itself stays correct -- the bug class Tier 1 cannot
//     express (arm H).
//
// Key-length invariant, numeric: every "No." written to this table anywhere in the suite is at most
// 15 characters, because the tombstone prefix 'TOMB-' is 5 and the field is Code[20] (R82 arm E is
// the standing precedent for why this is arithmetic, not a style note -- a length overflow produces
// a false kill under a test that asserts nothing).
//
// The doubling trigger is written UNQUALIFIED ("Level Doubled" := "Level" * 2;), not Rec.-qualified:
// a Rec.-qualified READ inside a field OnValidate is claimed by `lethal.swap-rec-xrec`, which would
// add an unplanned mutant. Do not "improve" it with receivers.
table 79330 "Data Trigger Probe"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Inserted By Trigger"; Boolean) { }
        field(3; "Level"; Integer)
        {
            trigger OnValidate()
            begin
                "Level Doubled" := "Level" * 2;
            end;
        }
        field(4; "Level Doubled"; Integer) { }
        field(5; Tombstone; Boolean) { }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    trigger OnInsert()
    begin
        "Inserted By Trigger" := true;
    end;

    trigger OnDelete()
    var
        Tomb: Record "Data Trigger Probe";
    begin
        Tomb."No." := 'TOMB-' + "No.";
        Tomb.Tombstone := true;
        Tomb.Insert(false);
    end;

    // ARM I -- the IMPLICIT-receiver `validate-to-assign` emit path, a distinct branch of
    // generate() from the qualified-call arms G/H/J in "Data Validate Ops". After the R136 review's
    // finding 4 the mutant becomes `Rec."Level" := NewLevel`, so this arm is what proves live that
    // the synthesised `Rec.` prefix compiles, deploys and scores inside a TABLE object rather than a
    // codeunit. No row is read or written -- Validate runs OnValidate against the in-memory record,
    // which `Data Tests.BlankNoValidateFails` and `NoTriggerValidateRunsWeak` already establish works
    // with no preceding Get/Insert (spec section 3.3 rule 3).
    //
    // PREDICTED: killed, by ImplicitValidateRunsInsideTheTable. The assignment skips OnValidate,
    // "Level Doubled" stays 0, the test's non-zero assertion of the doubled value fails.
    procedure ValidateLevelImplicit(NewLevel: Integer): Integer
    begin
        Validate("Level", NewLevel);
        exit("Level Doubled");
    end;
}
