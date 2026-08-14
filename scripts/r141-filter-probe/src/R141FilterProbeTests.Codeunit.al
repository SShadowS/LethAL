// R141 filter probe -- MEASURES, rather than reasons about, what BC does with the not-blank filter
// idiom on a Code[20] field, and what each of the planned fixture arm's collateral mutants would
// count.
//
// R141 asks for one fixture arm whose SetFilter literal carries a character the mini-parser refuses
// (`REFUSED_CHARACTERS = /[*?@()'&]/` in packages/builtin-tier2/src/filter-expression.ts), so the
// CHARACTER refusal is exercised against a real server rather than only offline. The highest-value
// character is the inner quote, because `<>''` (not blank) is the commonest `<>` shape in real AL.
//
// Two things must be measured before that arm can be written, and neither can be reasoned out:
//
//   1. Does BC accept a filter whose text is `<>''`? If it raises, the arm's own BASELINE call
//      fails and the gate refuses -- a full live run spent learning what this probe costs minutes
//      to learn (the exact mistake the R134 probe caught for arm D).
//   2. What do the three collateral mutants count? The arm's pre-commitment must state a verdict
//      per mutant BEFORE the live run, and a verdict resting on arithmetic nobody checked is a
//      prediction of a different kind.
//
// Seeding mirrors the planned arm exactly: an Entry No. band 79200..79203 holding three rows, two
// tagged and one BLANK, plus a residue decoy tagged row OUTSIDE the band at 79210.
//
// Results travel out through Error() -- a passing test reports nothing. Every [Test] here is
// EXPECTED to show as failed.
codeunit 71521 "R141 Filter Probe Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure NotBlankIdiomOnACodeField()
    var
        Baseline: Integer;
        NoSetFilter: Integer;
        NoSetRange: Integer;
        FilterText: Text;
        ErrorMsg: Text;
    begin
        Seed();

        // 1. THE MEASURED SHAPE: the arm's baseline call, scoped to its own band and then filtered
        // to the non-blank rows. Expected 2 of the band's 3 rows, if BC accepts the idiom at all.
        if not TryBaseline(Baseline, FilterText) then begin
            ErrorMsg := GetLastErrorText();
            Error('MEASURED: THROWS -- SetRange(band) + SetFilter("Main No.", ''<>'''''''') raised: %1', ErrorMsg);
        end;

        // 2. The `void-method-call` mutant: the SetFilter deleted, the SetRange left. Counts the
        // whole band, blank row included.
        NoSetFilter := CountBandOnly();

        // 3. The `remove-setrange` mutant: the SetRange deleted, the SetFilter left. Counts every
        // non-blank row in the table, so the out-of-band decoy joins in.
        if not TryFilterOnly(NoSetRange) then begin
            ErrorMsg := GetLastErrorText();
            Error('MEASURED: baseline=%1 filterText=%2 noSetFilter=%3, but the unscoped filter raised: %4', Baseline, FilterText, NoSetFilter, ErrorMsg);
        end;

        Error('MEASURED: NO THROW -- baseline=%1 (expect 2) noSetFilter=%2 (expect 3) noSetRange=%3 (expect 3) filterAsBCReportsIt=%4', Baseline, NoSetFilter, NoSetRange, FilterText);
    end;

    local procedure Seed()
    var
        Probe: Record "R141 Filter Probe";
    begin
        Probe.DeleteAll(false);

        AddRow(79200, 'FLT-I');
        AddRow(79201, 'FLT-I');
        // The blank row: inside the band, excluded by the not-blank filter. Without it the filter
        // matches everything in the band and the baseline cannot tell a working filter from a
        // deleted one.
        AddRow(79202, '');
        // The residue decoy: non-blank, OUTSIDE the band, so only the unscoped mutant sees it.
        AddRow(79210, 'FLT-I-DECOY');
    end;

    local procedure AddRow(EntryNo: Integer; MainNo: Code[20])
    var
        Probe: Record "R141 Filter Probe";
    begin
        Probe.Init();
        Probe."Entry No." := EntryNo;
        Probe."Main No." := MainNo;
        Probe.Insert(false);
    end;

    [TryFunction]
    local procedure TryBaseline(var Result: Integer; var FilterText: Text)
    var
        Probe: Record "R141 Filter Probe";
    begin
        Probe.SetRange("Entry No.", 79200, 79203);
        Probe.SetFilter("Main No.", '<>''''');
        FilterText := Probe.GetFilter("Main No.");
        Result := Probe.Count();
    end;

    local procedure CountBandOnly(): Integer
    var
        Probe: Record "R141 Filter Probe";
    begin
        Probe.SetRange("Entry No.", 79200, 79203);
        exit(Probe.Count());
    end;

    [TryFunction]
    local procedure TryFilterOnly(var Result: Integer)
    var
        Probe: Record "R141 Filter Probe";
    begin
        Probe.SetFilter("Main No.", '<>''''');
        Result := Probe.Count();
    end;
}
