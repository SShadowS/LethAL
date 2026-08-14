# R141 filter probe — does BC accept the not-blank filter idiom `<>''`, and what do the arm's mutants count?

**Answer: YES, it is accepted, and all three collateral mutants change the count.** Measured
2026-08-14 against **Cronus283** (the container `fixtures/sandbox-data` targets) via the `bc-dev`
MCP tool's `bcdev_test_run`:

```
MEASURED: NO THROW -- baseline=2 (expect 2) noSetFilter=3 (expect 3) noSetRange=3 (expect 3)
          filterAsBCReportsIt=<>''
```

## Why this exists

R141 asks for one fixture arm whose `SetFilter` literal carries a character that
`lethal.flip-filter-literal`'s mini-parser refuses outright (`REFUSED_CHARACTERS = /[*?@()'&]/` in
`packages/builtin-tier2/src/filter-expression.ts`), so that the CHARACTER refusal is finally
exercised against a real server instead of only by one offline unit test. The row names the inner
quote as the highest-value choice, because `<>''` (not blank) is the commonest `<>` shape in real
AL, and a broken character refusal on that population would hand BC a string the mini-parser never
validated — a runtime filter error scoring `killed` with no assertion earning it.

Two things had to be measured before that arm could be written, and neither could be reasoned out:

1. **Does BC accept a filter whose text is `<>''`?** If it raised, the arm's own BASELINE call would
   fail, the gate would refuse, and a full live run would be spent learning it — exactly the mistake
   `scripts/r134-filter-probe` caught for R134 arm D.
2. **What do the arm's collateral mutants count?** The pre-commitment must state a verdict per
   mutant BEFORE the live run. A verdict resting on arithmetic nobody checked is a prediction of a
   different kind.

## The probe

`table 71520 "R141 Filter Probe"` — the same shape as `fixtures/sandbox-data`'s `table 79302 "Data
Related"` (`"Entry No."` Integer PK, `"Main No."` Code[20]).

`codeunit 71521 "R141 Filter Probe Tests"`, one `[Test]` method seeding the planned arm's exact
data: Entry No. band 79200..79203 holding 79200 `FLT-I`, 79201 `FLT-I`, 79202 **blank**, plus an
out-of-band residue decoy 79210 `FLT-I-DECOY`. It then measures three counts, the filtered call
wrapped in a `[TryFunction]` so a raise is reported rather than crashing the run:

| what | call | measured |
| --- | --- | --- |
| baseline | `SetRange("Entry No.", 79200, 79203)` + `SetFilter("Main No.", '<>''''')` | **2** |
| `void-method-call` mutant (SetFilter deleted) | `SetRange` alone | **3** |
| `remove-setrange` mutant (SetRange deleted) | `SetFilter` alone | **3** |

`GetFilter("Main No.")` reports `<>''`, i.e. BC receives exactly the two-inner-quote content the AL
literal `'<>'''''` encodes, and reads it as "not blank".

## What this settles

- The `<>''` arm is buildable: the baseline call does not raise, and it returns a count that differs
  from all three of its mutants' counts, so every collateral verdict is a KILL earned by the arm's
  own assertion rather than by a platform error.
- The blank row inside the band is load-bearing. Without it the filter would match the whole band
  and the baseline could not tell a working filter from a deleted one.
- The out-of-band decoy is load-bearing for `remove-setrange`. Without it the unscoped filter would
  also count 2 and that mutant would survive on data starvation.

**It does not settle** anything about the flip mutant, because there is no flip mutant: the point of
the arm is that `flip-filter-literal` emits nothing at a site whose literal carries a refused
character. That prediction is offline and is asserted by the census plus
`assertFilterLiteralEvidence` in `packages/runner/itest/tables.itest.ts`.

## Reproducing

```bash
ALC="$HOME/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/alc.exe"
mkdir -p scripts/r141-filter-probe/.alpackages
cp "U:/Git/LethAL/fixtures/sandbox-data/.alpackages/Microsoft_"*.app \
   "U:/Git/LethAL/fixtures/sandbox-data/.alpackages/System.app" \
   scripts/r141-filter-probe/.alpackages/
"$ALC" /project:"U:/Git/LethAL/scripts/r141-filter-probe" \
  /packagecachepath:"U:/Git/LethAL/scripts/r141-filter-probe/.alpackages" \
  /out:"U:/Git/LethAL/scripts/r141-filter-probe/r141-filter-probe.app"
```

```powershell
docker context use desktop-windows
$c = Get-Content 'U:\Git\LethAL\fixtures\sandbox-data\lethal.config.local.json' | ConvertFrom-Json
$cred = New-Object System.Management.Automation.PSCredential(
  $c.bcdev.username, (ConvertTo-SecureString $c.bcdev.password -AsPlainText -Force))
Publish-BcContainerApp -containerName Cronus283 -appFile 'U:\Git\LethAL\scripts\r141-filter-probe\r141-filter-probe.app' -useDevEndpoint -credential $cred -syncMode ForceSync -install
```

Then, via the `bc-dev` MCP tool (`project` pointed at this directory, `server=http://Cronus283`,
`serverInstance=BC`, `tenant=default`, `company=CRONUS Danmark A/S`): `bcdev_test_run` against
codeunit 71521. The test is EXPECTED to report `failed` — that is how `Error()` carries the numbers
out.

Unpublish when finished (done on 2026-08-14 after the measurement above):

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
UnPublish-BcContainerApp -containerName Cronus283 -name 'LethAL R141 Filter Probe' -unInstall -doNotSaveData -force
```
