// R134 filter probe -- MEASURES, rather than reasons about, whether `Record.SetFilter`/`Count` on
// an INTEGER field raises a runtime error when the filter text carries an OR-alternative that is
// not a valid integer literal.
//
// This is the exact shape docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md section
// 2.7 requires for arm D's hash decoy: "Entry No." (Integer) filtered with '<%1|FLT-NONE', where
// 'FLT-NONE' is not a number. Section 2.7 measured that the decoy fixes an astSubtreeHash collision
// (a purely static, AST-level check); it did not measure whether BC accepts the decoy's text at
// RUNTIME on a field whose type is Integer rather than Code. A wrong assumption here would not
// merely mislabel one mutant -- it would make arm D's own BASELINE call raise, which is a second
// unplanned baseline failure the tables gate's single-permitted-failure assertion would catch for a
// reason that looks nothing like its cause.
codeunit 71601 "R134 Filter Probe Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure IntegerFilterWithNonNumericOrAlternative()
    var
        Probe: Record "R134 Filter Probe";
        Actual: Integer;
        ErrorMsg: Text;
    begin
        // Clean slate.
        Probe.SetRange("Main No.", 'PROBE');
        Probe.DeleteAll(false);

        Probe.Init();
        Probe."Entry No." := 1;
        Probe."Main No." := 'PROBE';
        Probe.Insert(false);

        Probe.Init();
        Probe."Entry No." := 2;
        Probe."Main No." := 'PROBE';
        Probe.Insert(false);

        Probe.Init();
        Probe."Entry No." := 3;
        Probe."Main No." := 'PROBE';
        Probe.Insert(false);

        // THE MEASURED SHAPE, byte for byte arm D's own filter text with %1 substituted:
        // SetFilter("Entry No.", '<%1|FLT-NONE', 3).
        if not TryCountWithDecoy(Actual) then begin
            ErrorMsg := GetLastErrorText();
            Error('MEASURED (string decoy): THROWS -- SetFilter("Entry No.", ''<%1|FLT-NONE'', 3) raised at runtime: %1', ErrorMsg);
        end;

        Error('MEASURED (string decoy): NO THROW -- SetFilter("Entry No.", ''<%1|FLT-NONE'', 3) returned Count() = %1', Actual);
    end;

    [Test]
    procedure IntegerFilterWithNumericOrAlternative()
    var
        Probe: Record "R134 Filter Probe";
        Actual: Integer;
        ErrorMsg: Text;
    begin
        // Clean slate.
        Probe.SetRange("Main No.", 'PROBE2');
        Probe.DeleteAll(false);

        Probe.Init();
        Probe."Entry No." := 101;
        Probe."Main No." := 'PROBE2';
        Probe.Insert(false);

        Probe.Init();
        Probe."Entry No." := 102;
        Probe."Main No." := 'PROBE2';
        Probe.Insert(false);

        Probe.Init();
        Probe."Entry No." := 103;
        Probe."Main No." := 'PROBE2';
        Probe.Insert(false);

        // THE CANDIDATE FIX: a NUMERIC, out-of-band decoy alternative instead of the spec's
        // non-numeric 'FLT-NONE'. Still inert (no seeded row uses Entry No. 999999999), still
        // produces filter text distinct from arm C's plain '<%1', but is a valid Integer literal.
        if not TryCountWithNumericDecoy(Actual) then begin
            ErrorMsg := GetLastErrorText();
            Error('MEASURED (numeric decoy): THROWS -- SetFilter("Entry No.", ''<%1|999999999'', 103) raised at runtime: %1', ErrorMsg);
        end;

        Error('MEASURED (numeric decoy): NO THROW -- SetFilter("Entry No.", ''<%1|999999999'', 103) returned Count() = %1 (entries 101,102,103 seeded; expected 2, matching <103: 101 and 102)', Actual);
    end;

    [TryFunction]
    local procedure TryCountWithDecoy(var Result: Integer)
    var
        Probe: Record "R134 Filter Probe";
    begin
        Probe.SetRange("Main No.", 'PROBE');
        Probe.SetFilter("Entry No.", '<%1|FLT-NONE', 3);
        Result := Probe.Count();
    end;

    [TryFunction]
    local procedure TryCountWithNumericDecoy(var Result: Integer)
    var
        Probe: Record "R134 Filter Probe";
    begin
        Probe.SetRange("Main No.", 'PROBE2');
        Probe.SetFilter("Entry No.", '<%1|999999999', 103);
        Result := Probe.Count();
    end;
}
