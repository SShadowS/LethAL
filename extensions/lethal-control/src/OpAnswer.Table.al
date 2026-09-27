namespace LethAL.Control;

/// <summary>R236b: the last answer of a RunMutant, RunMutantWithCoverage (or, when R236b's Phase A
/// requires it, RunMutantMany) call that RAN tests, kept so a client whose HTTP reply was lost after
/// the headers can read it back instead of quarantining the run. MEASURED (R236, 2026-09-26): BC sent
/// 200 headers and then lost the END of the reply on the TestPage baseline call.
///
/// Written and COMMITTED as the action's last statement, and ONLY for an answer that ran: a refusal
/// (including a same-key duplicate the fence refuses) writes nothing, so it can never overwrite the
/// answer of the op that did run. A committed row proves the action's AL answer construction
/// completed. It does NOT prove the HTTP request or the session ended: returning the text, the
/// platform's response handling and session teardown still follow.</summary>
table 91013 "LC Op Answer"
{
    DataClassification = SystemMetadata;
    DataPerCompany = false;
    // Same reasoning as "LC Lease": the OData runner session runs as the calling user.
    InherentPermissions = RIMD;

    fields
    {
        field(1; "Primary Key"; Code[10]) { }
        field(2; "Attempt Id"; Text[64]) { }
        field(3; "Op Seq"; BigInteger) { }
        field(4; "Lease Epoch"; Integer) { }
        field(5; "Server Generation"; Text[32]) { }
        field(6; "Kept At"; DateTime) { }
        field(7; Answer; Blob) { }
    }

    keys
    {
        key(PK; "Primary Key") { Clustered = true; }
    }
}
