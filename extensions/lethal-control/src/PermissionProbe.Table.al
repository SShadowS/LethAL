namespace LethAL.Control;

/// <summary>
/// The permission canary's probe table (ROADMAP R26). Its SHAPE is irrelevant — one Code[20] key
/// and nothing else. Its PERMISSION DECLARATION is the entire experiment.
///
/// ############################################################################################
/// #  DO NOT ADD `InherentPermissions` TO THIS TABLE. THE OMISSION IS THE POINT OF THE OBJECT. #
/// ############################################################################################
///
/// Every OTHER table in this extension — "LC Mutation Active" (91000), "LC Target Artifact
/// Registry" (91001), "LC Lease" (91006) — declares `InherentPermissions = RIMD` deliberately:
/// they are read and written by the control codeunits from an OData session running under the
/// CALLING USER, who does not hold this extension's permission set (5C-A live spike). Each of
/// those carries a comment saying so. This table is the one place in the extension where the
/// ABSENCE of that line is load-bearing, so it will look — to a linter, a reviewer, or a future
/// you skimming for inconsistency — exactly like an oversight. It is not.
///
/// MEASURED on this container (2026-07-26), not inferred: a test codeunit that omits
/// `TestPermissions` runs Restrictive (the AL default) and a table WITHOUT `InherentPermissions`
/// then reports `read=No write=No` inside its body, its `Insert` failing with "Sorry, the current
/// permissions prevented the action". Flip that ONE property to `TestPermissions = Disabled` — same
/// app, same tables, same server, Microsoft's Permissions Mock (codeunit 131006) running in both
/// arms — and the identical probe reports `read=Yes write=Yes` and the `Insert` succeeds. The
/// declaration on the test codeunit is what decides it; the invocation path is not the variable.
/// "LC Permission Canary" therefore declares `TestPermissions = Disabled` (see its summary), and
/// this table's omission is what keeps the remaining measurement honest.
///
/// So "make this consistent with its siblings" would silently convert the canary into a probe that
/// answers `not-mocked` on every server, forever, no matter what the platform does: an inherent
/// grant cannot be stripped, so the write could never fail and the light could never turn red. That
/// is precisely the class of silent-wrong-answer this project exists to refuse. If you are
/// convinced this table should match the others, delete the canary outright instead — at least then
/// its absence is visible in the report rather than disguised as a clean result.
/// </summary>
table 91008 "LC Permission Probe"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    // NO InherentPermissions. See the summary above — this omission is the measurement.

    fields
    {
        field(1; "Primary Key"; Code[20]) { }
    }

    keys
    {
        key(PK; "Primary Key") { Clustered = true; }
    }
}
