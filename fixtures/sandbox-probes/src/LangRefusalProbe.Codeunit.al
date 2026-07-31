// R66: the `TestPermissions` refusal detector is English-only (`PERMISSIONS_REFUSAL_RE` anchors on
// BC's clause "current permissions prevented the action"), and the roadmap records it as BLOCKED on
// "a language-independent signal measured against a localized BC server".
//
// That framing may be wrong, and this probe tests it. BC selects error-message resources by SESSION
// LANGUAGE, not by which server you are talking to, and AL can set the session language from inside
// a test body (`GlobalLanguage`). These containers already run `CRONUS Danmark A/S`, so the Danish
// resources are likely present. If so, R66 needs no new environment at all.
//
// Two things are measured in one call, because both are R66's named candidates:
//
//   1. The refusal TEXT under `GlobalLanguage(1030)` (da-DK) — does the English regex miss it, and
//      does the structural `(TableData <id> <name> <op>: <suite>)` parenthetical survive translation?
//   2. `GetLastErrorCode()` — language-independent by construction, but worth nothing unless BC
//      actually populates it for a permissions refusal. That is a fact about BC, not about English.
//
// **This codeunit deliberately does NOT declare `TestPermissions = Disabled`.** That is the whole
// mechanism (R1, measured A/B): the AL default is Restrictive, which strips a test body of write
// permission on its own app's tables, and the refusal is exactly what this probe needs to provoke.
// Every other test codeunit in this repo declares it; this one must not, and a future edit that
// "fixes" that declaration silently destroys the measurement.
codeunit 79216 "Lang Refusal Probe"
{
    Subtype = Test;

    [Test]
    procedure ReportsRefusalTextAndCodeInDanish()
    var
        Written: Boolean;
    begin
        // 1030 = da-DK. If the resources are absent BC falls back to English, which is itself the
        // answer: the container cannot produce a localized refusal and R66 does need another server.
        GlobalLanguage(1030);
        Written := TryInsertProbeRow();
        Error(
          'MEASURED lang=%1 | written=%2 | code=[%3] | text=[%4]',
          GlobalLanguage(),
          Written,
          GetLastErrorCode(),
          GetLastErrorText());
    end;

    // The English control, same call, same session, so the two texts can be compared rather than
    // one being read alone. Without it a Danish-looking string proves nothing about the regex.
    [Test]
    procedure ReportsRefusalTextAndCodeInEnglish()
    var
        Written: Boolean;
    begin
        GlobalLanguage(1033);
        Written := TryInsertProbeRow();
        Error(
          'MEASURED lang=%1 | written=%2 | code=[%3] | text=[%4]',
          GlobalLanguage(),
          Written,
          GetLastErrorCode(),
          GetLastErrorText());
    end;

    // NOT a [TryFunction]: the platform refuses `INSERT` inside one under `RunTests`, so the first
    // version of this probe measured its own wrapper (the third time that trap fired in this
    // session). `Codeunit.Run` catches the error without that restriction and leaves both
    // `GetLastErrorText` and `GetLastErrorCode` readable.
    local procedure TryInsertProbeRow(): Boolean
    var
        Probe: Record "Rec XRec Probe";
    begin
        exit(Codeunit.Run(Codeunit::"Lang Refusal Runner", Probe));
    end;
}
