namespace LethAL.R389Probe;

/// <summary>
/// One procedure per route by which code in THIS app (which cannot name any test-app object) might
/// run a test-app codeunit it receives in a Variant. Every procedure is bounded (no loops) and
/// either returns a text saying what happened, or lets an error through unchanged. If the test-app
/// mock runs, its own error ('MARK R389 ran ...') comes through; that is the "it ran" signal.
/// The calling [Test] turns a normal return into Error('MEASURED ...'), so every outcome travels
/// as the test's failure text.
/// </summary>
codeunit 91502 "R389 Probe Routes"
{
    // ---------- C0: positive control (not a Variant route) ----------

    /// <summary>The mock handed over as the interface itself. MUST print the mock's MARK, or the
    /// mock's mark is not what the other routes would show.</summary>
    procedure C0_CallIface(I: Interface "R389 Probe Iface"): Text
    begin
        exit(I.Ping('C0'));
    end;

    // ---------- R1: Variant -> this app's own interface ----------

    // R1a (I := V) and R1b (C0_CallIface(V)) do NOT compile: AL0122 / AL0133. Their source and
    // the diagnostics are kept in ../refused/R1-implicit.al.txt.

    /// <summary>R1c: the EXPLICIT conversion the AL0122 message asks for: `V as` the interface.</summary>
    procedure R1c_IfaceAs(V: Variant): Text
    var
        I: Interface "R389 Probe Iface";
    begin
        I := V as "R389 Probe Iface";
        exit(I.Ping('R1c'));
    end;

    /// <summary>R1d: `V is` the interface first (reported), then `as` only when it says yes.</summary>
    procedure R1d_IfaceIsThenAs(V: Variant): Text
    var
        I: Interface "R389 Probe Iface";
    begin
        if not (V is "R389 Probe Iface") then
            exit('MEASURED R1d (V is R389 Probe Iface) = false');
        I := V as "R389 Probe Iface";
        exit(I.Ping('R1d'));
    end;

    // ---------- R2: Codeunit.Run on the Variant ----------

    /// <summary>R2a: Codeunit.Run with the Variant where the codeunit NUMBER goes.</summary>
    procedure R2a_RunVariantAsId(V: Variant): Text
    begin
        Codeunit.Run(V);
        exit('MEASURED R2a Codeunit.Run(V) returned with no error');
    end;

    /// <summary>R2b: R2a guarded by IsCodeunit, which also reports what the Variant says it holds.</summary>
    procedure R2b_IsCodeunitThenRun(V: Variant): Text
    begin
        if not V.IsCodeunit() then
            exit('MEASURED R2b V.IsCodeunit = false');
        Codeunit.Run(V);
        exit('MEASURED R2b IsCodeunit = true; Codeunit.Run(V) returned with no error');
    end;

    /// <summary>R2c: the return-value form, so a refusal is caught and its text reported.</summary>
    procedure R2c_RunVariantTry(V: Variant): Text
    begin
        if Codeunit.Run(V) then
            exit('MEASURED R2c Codeunit.Run(V) returned true');
        exit('MEASURED R2c Codeunit.Run(V) returned false: ' + GetLastErrorText());
    end;

    /// <summary>R2d: the Variant in the record slot of Codeunit.Run, running THIS app's helper.</summary>
    procedure R2d_RunWithVariantAsRecord(V: Variant): Text
    begin
        Codeunit.Run(Codeunit::"R389 Probe Helper", V);
        exit('MEASURED R2d returned with no error');
    end;

    // ---------- R4: anything else ----------

    /// <summary>R4a: assign to a Codeunit variable of an UNRELATED type, call a procedure.</summary>
    procedure R4a_UnrelatedCodeunitVar(V: Variant): Text
    var
        C: Codeunit "R389 Probe Helper";
    begin
        C := V;
        exit(C.Echo('R4a'));
    end;

    /// <summary>R4b: same, then .Run() on the variable (which OnRun runs?).</summary>
    procedure R4b_UnrelatedCodeunitVarRun(V: Variant): Text
    var
        C: Codeunit "R389 Probe Helper";
    begin
        C := V;
        C.Run();
        exit('MEASURED R4b C.Run() returned with no error');
    end;

    /// <summary>R4c: Format the Variant (what does external code learn about it?).</summary>
    procedure R4c_Format(V: Variant): Text
    begin
        exit('MEASURED R4c Format(V) = [' + Format(V) + ']');
    end;

    /// <summary>R4d: Format, then Evaluate an Integer out of it and Codeunit.Run that id. Bounded:
    /// runs only if Evaluate yields an id.</summary>
    procedure R4d_FormatEvaluateRun(V: Variant): Text
    var
        Id: Integer;
    begin
        if not Evaluate(Id, Format(V)) then
            exit('MEASURED R4d Format(V) = [' + Format(V) + '] does not evaluate to an Integer');
        Codeunit.Run(Id);
        exit(StrSubstNo('MEASURED R4d Codeunit.Run(%1) returned with no error', Id));
    end;

    /// <summary>R4e: RecordRef.GetTable on the Variant.</summary>
    procedure R4e_RecordRefGetTable(V: Variant): Text
    var
        RecRef: RecordRef;
    begin
        RecRef.GetTable(V);
        exit(StrSubstNo('MEASURED R4e GetTable returned; Number = %1', RecRef.Number()));
    end;

    /// <summary>R4f: Variant-to-Variant, then `as` the interface (does a second Variant change R1c?).</summary>
    procedure R4f_VariantChainToIface(V: Variant): Text
    var
        W: Variant;
    begin
        W := V;
        exit(R1c_IfaceAs(W));
    end;

    // ---------- R3: control, the Variant handed BACK to test-app code ----------

    /// <summary>R3: raise an event with the Variant; a test-app subscriber receives it. The walk
    /// already folds every subscriber, so this is the control for "test-app code runs it".</summary>
    procedure R3_HandBackByEvent(V: Variant): Text
    begin
        OnR389HandBack(V);
        exit('MEASURED R3 event raised; no subscriber raised an error');
    end;

    [IntegrationEvent(false, false)]
    procedure OnR389HandBack(V: Variant)
    begin
    end;

    // ---------- side observation (not a Variant route) ----------

    /// <summary>S1: Codeunit.Run by integer id needs no Variant and no reference to the test app.</summary>
    procedure S1_RunById(Id: Integer): Text
    begin
        Codeunit.Run(Id);
        exit(StrSubstNo('MEASURED S1 Codeunit.Run(%1) returned with no error', Id));
    end;
}
