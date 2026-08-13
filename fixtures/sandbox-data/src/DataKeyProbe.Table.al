// R136 arm K's own table, kept SEPARATE from "Data Trigger Probe" on purpose (spec section 3.1):
// arm K needs an OnInsert that assigns the PRIMARY KEY when it is blank, and putting that on the
// shared table would couple arms A/B/C to it -- a mutant in this trigger would then decide THEIR
// verdicts too. One extra table object is cheaper than that coupling.
//
// This is R138 made live: `swap-modify-flag`'s Insert(true) -> Insert(false) on a table whose
// OnInsert assigns the key is a PLATFORM-ARTIFACT kill that no screen tags today
// (`platformArtifactKills` tags only the write-transaction mechanism `lethal.remove-commit`
// reports). See `codeunit 79314 "Data Flag Ops".InsertTwiceWithKeyTrigger` for the mechanism.
table 79331 "Data Key Probe"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20]) { }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    // Assigns the key from a row count, the same shape as a No. Series assignment on real code.
    // Reached only through OnInsert, so Insert(false) skips the assignment entirely rather than
    // merely leaving it unrun on an already-keyed row.
    //
    // A SECOND, unrelated route to the identical platform-kill mechanism lives in this one `if`:
    // `lethal.negate-conditional` on `"No." = ''` produces `"No." <> ''`, which is false on every
    // freshly Init()'d record, so the assignment never runs either. Same duplicate-key error, same
    // untagged platform artifact (R138) -- but via a different operator than arm K's own
    // `swap-modify-flag` mutant on `Insert(true)`. Pre-commit this verdict deliberately rather than
    // discovering it as a surprise at the live gate.
    trigger OnInsert()
    begin
        if "No." = '' then
            "No." := 'KEY-' + Format(Count() + 1);
    end;
}
