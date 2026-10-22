namespace LethAL.R389Probe.Tests;

using LethAL.R389Probe;

/// <summary>
/// One [Test] per route. EVERY test is expected to FAIL: the failure text is the measurement.
///   'MARK R389 ran ...'  the test-app mock ran (the route CAN run test-app code);
///   'MEASURED ...'       the route returned or reported without running it;
///   anything else        a platform error (the route is refused at runtime); record it verbatim.
/// The Variant is built from the mock directly ("FromCodeunit") or through an interface variable
/// ("FromIface"), the two shapes R-389's walk would have to trace.
/// </summary>
codeunit 91532 "R389 Probe Tests"
{
    Subtype = Test;

    var
        Routes: Codeunit "R389 Probe Routes";

    local procedure FromCodeunit(): Variant
    var
        Mock: Codeunit "R389 Probe Mock";
        V: Variant;
    begin
        V := Mock;
        exit(V);
    end;

    local procedure FromIface(): Variant
    var
        Mock: Codeunit "R389 Probe Mock";
        I: Interface "R389 Probe Iface";
        V: Variant;
    begin
        I := Mock;
        V := I;
        exit(V);
    end;

    local procedure Report(Route: Text; Result: Text)
    begin
        Error('MEASURED %1 returned normally: %2', Route, Result);
    end;

    // ---------- C0: positive control ----------

    [Test]
    procedure C0_IfaceDirect()
    var
        Mock: Codeunit "R389 Probe Mock";
        I: Interface "R389 Probe Iface";
    begin
        I := Mock;
        Report('C0', Routes.C0_CallIface(I));
    end;

    // ---------- R1: Variant -> the external app's own interface ----------

    [Test]
    procedure R1c_As_FromCodeunit()
    begin
        Report('R1c/FromCodeunit', Routes.R1c_IfaceAs(FromCodeunit()));
    end;

    [Test]
    procedure R1c_As_FromIface()
    begin
        Report('R1c/FromIface', Routes.R1c_IfaceAs(FromIface()));
    end;

    [Test]
    procedure R1d_IsThenAs_FromCodeunit()
    begin
        Report('R1d/FromCodeunit', Routes.R1d_IfaceIsThenAs(FromCodeunit()));
    end;

    [Test]
    procedure R1d_IsThenAs_FromIface()
    begin
        Report('R1d/FromIface', Routes.R1d_IfaceIsThenAs(FromIface()));
    end;

    /// <summary>Negative control for `is`: an Integer must say false.</summary>
    [Test]
    procedure R1d_Control_Integer()
    var
        V: Variant;
    begin
        V := 91530;
        Report('R1d/Integer', Routes.R1d_IfaceIsThenAs(V));
    end;

    /// <summary>Negative control for `is`: a codeunit that does NOT implement the interface.</summary>
    [Test]
    procedure R1d_Control_NonImplementer()
    var
        Helper: Codeunit "R389 Probe Helper";
        V: Variant;
    begin
        V := Helper;
        Report('R1d/NonImplementer', Routes.R1d_IfaceIsThenAs(V));
    end;

    // ---------- R2: Codeunit.Run on the Variant ----------

    [Test]
    procedure R2a_RunVariantAsId()
    begin
        Report('R2a', Routes.R2a_RunVariantAsId(FromCodeunit()));
    end;

    [Test]
    procedure R2b_IsCodeunitThenRun_FromCodeunit()
    begin
        Report('R2b/FromCodeunit', Routes.R2b_IsCodeunitThenRun(FromCodeunit()));
    end;

    [Test]
    procedure R2b_IsCodeunitThenRun_FromIface()
    begin
        Report('R2b/FromIface', Routes.R2b_IsCodeunitThenRun(FromIface()));
    end;

    [Test]
    procedure R2c_RunVariantTry()
    begin
        Report('R2c', Routes.R2c_RunVariantTry(FromCodeunit()));
    end;

    [Test]
    procedure R2d_RunWithVariantAsRecord()
    begin
        Report('R2d', Routes.R2d_RunWithVariantAsRecord(FromCodeunit()));
    end;

    // ---------- R3: control, handed back to test-app code ----------

    [Test]
    procedure R3_HandBackByEvent()
    begin
        Report('R3', Routes.R3_HandBackByEvent(FromCodeunit()));
    end;

    // ---------- R4: anything else ----------

    [Test]
    procedure R4a_UnrelatedCodeunitVar()
    begin
        Report('R4a', Routes.R4a_UnrelatedCodeunitVar(FromCodeunit()));
    end;

    [Test]
    procedure R4b_UnrelatedCodeunitVarRun()
    begin
        Report('R4b', Routes.R4b_UnrelatedCodeunitVarRun(FromCodeunit()));
    end;

    [Test]
    procedure R4c_Format_FromCodeunit()
    begin
        Report('R4c/FromCodeunit', Routes.R4c_Format(FromCodeunit()));
    end;

    [Test]
    procedure R4c_Format_FromIface()
    begin
        Report('R4c/FromIface', Routes.R4c_Format(FromIface()));
    end;

    [Test]
    procedure R4d_FormatEvaluateRun()
    begin
        Report('R4d', Routes.R4d_FormatEvaluateRun(FromCodeunit()));
    end;

    [Test]
    procedure R4e_RecordRefGetTable()
    begin
        Report('R4e', Routes.R4e_RecordRefGetTable(FromCodeunit()));
    end;

    [Test]
    procedure R4f_VariantChainToIface()
    begin
        Report('R4f', Routes.R4f_VariantChainToIface(FromCodeunit()));
    end;

    // ---------- S1: side observation, Codeunit.Run by integer id ----------

    [Test]
    procedure S1_RunById()
    begin
        Report('S1', Routes.S1_RunById(Codeunit::"R389 Probe Mock"));
    end;
}
