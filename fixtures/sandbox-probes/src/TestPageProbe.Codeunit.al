// R69: does opening a `TestPage` hang, and is the hang specific to the FENCED session type?
//
// Measured 2026-07-31 on Cronus283 while building R30's fixture: a test whose body was
// `OpenView(); Close();` never returned on the fenced path — the session went `in-flight-unknown`
// at BASELINE, the run quarantined the tier and scored nothing at all
// (`killed=0 survived=0 noCoverage=0`), and recovery needed `force-reset-lease`.
//
// That is one observation on one page, and R69 as filed generalises it. This probe narrows it:
// the same trivial page, opened the same way, run through the HUB (`coverageMode: "procedure"`,
// GuiAllowed=Yes/ClientType=Web). If it passes there, the hang is a property of the SESSION TYPE
// rather than of TestPage or of a particular page — which matters because R58 made the fenced path
// the default for baselines, and 9 of Continia Document Output's 104 test files use TestPage.
//
// If it hangs here too, the finding is bigger and simpler: TestPage does not work under LethAL's
// runner at all, on either path.
codeunit 79218 "Test Page Probe"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure ReportsTestPageOpen()
    var
        Probe: Record "Rec XRec Probe";
        ProbeList: TestPage "Probe List";
    begin
        if not Probe.Get('TP1') then begin
            Probe.Init();
            Probe."No." := 'TP1';
            Probe.Amount := 42;
            Probe.Insert(false);
        end;

        ProbeList.OpenView();
        ProbeList.Close();
        // Reached only if the page opened AND closed. Raised so the result is carried back the same
        // way every other probe here reports — a passing test tells the runner nothing.
        Error('MEASURED testpage-open=OK | GuiAllowed=%1 | ClientType=%2', GuiAllowed, Format(CurrentClientType));
    end;
}
