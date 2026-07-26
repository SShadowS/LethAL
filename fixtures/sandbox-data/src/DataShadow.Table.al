// The table on the REFUSED side of `claimsRecordMethod`'s rule 3 (spec §4.1): "reject a name that
// resolves to a procedure declared in the project".
//
// Carried from the receiver predicate's own report: without a project table that declares a
// builtin-named procedure AND a record variable of that table (`Data Ops.ShadowedBuiltins`), the
// QUALIFIED half of rule 3 goes unexercised live. `Data Ops` holds that variable.
//
// Each procedure ACCUMULATES rather than assigns, so deleting any one of them changes the total
// the test asserts. An assigning version would let `Hits := 42` be overwritten by the next call
// and the deletion mutant would be equivalent — a fixture that cannot fail.
//
// Every call to these is a Tier-1 `lethal.void-method-call` site and must STAY one. A Tier-2
// operator that wrongly claimed `Shadow.TestField(42)` or `Shadow.SetRange('AA', 'ZZZ')` would win
// the §3.2 dedup precedence and REPLACE the correct Tier-1 mutant — which is why the committed
// baseline pins `operatorName` per mutant, not just the verdict.
table 79303 "Data Shadow"
{
    DataClassification = CustomerContent;

    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Hits; Integer) { }
    }

    keys
    {
        key(PK; "No.") { Clustered = true; }
    }

    // Shadows the builtin record method `TestField`. `RemoveTestField` must NOT claim
    // `Shadow.TestField(42)`: the receiver is a genuine record, so only rule 3 can refuse it.
    procedure TestField(Marker: Integer)
    begin
        Hits := Hits + Marker;
    end;

    // Shadows the builtin record method `SetRange`, with TWO arguments on purpose. The no-value
    // `SetRange(F)` negative elsewhere in this fixture cannot catch a predicate that matches any
    // same-named call carrying values; this one can, because `hasValueArguments` passes here and
    // only rule 3 stands between it and a wrong claim.
    procedure SetRange(FromNo: Code[20]; ToNo: Code[20])
    begin
        Hits := Hits + StrLen(FromNo) + StrLen(ToNo);
    end;

    // The user-defined `Commit` spec §6 asks for. Phase 2's `RemoveCommit` must not claim it.
    procedure Commit()
    begin
        Hits := Hits + 1;
    end;

    // ...plus a CALL to it, in the IMPLICIT-receiver form — which is what exercises the implicit
    // half of rule 3 (`declaresProcedure` on the enclosing table). A qualified `Shadow.Commit()`
    // alone would not.
    procedure BumpViaCommit(): Integer
    begin
        Commit();
        exit(Hits);
    end;

    // The SAME-FILE instance of the qualified rule-3 shape: a record variable of a table that
    // declares those procedures, declared in a file the symbol table can see the table in.
    //
    // `Data Ops.ShadowedBuiltins` holds the CROSS-FILE instance of the same shape, and the two
    // must produce the same answer. They do not today: `generateMutationSet`
    // (packages/runner/src/orchestrator.ts) builds one `SemanticContext` PER FILE, so
    // `projectTableDeclaresProcedure` finds no table at all from another file and the guard cannot
    // fire. Spec §4.1 says "a name that resolves to a procedure declared IN THE PROJECT", so the
    // cross-file half is a real gap — this pair is what makes it visible in the baseline instead
    // of invisible.
    procedure SelfShadowed(): Integer
    var
        Other: Record "Data Shadow";
    begin
        Other.TestField(5);
        Other.SetRange('A', 'BB');
        exit(Other.Hits);
    end;
}
