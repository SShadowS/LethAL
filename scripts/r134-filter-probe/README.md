# R134 filter probe — does SetFilter on an Integer field accept a non-numeric OR-alternative?

**Answer: NO.** `Record.SetFilter` raises immediately (before `Count()` even runs, from the
`SetFilter` call itself) when an Integer field's filter text carries an OR-alternative that is not
a valid integer literal:

```
The filter "<%1|FLT-NONE" is not valid for the Entry No. field on the R134 Filter Probe table.
The value "FLT-NONE" can't be evaluated into type Integer.
```

A **numeric** out-of-band decoy alternative, by contrast, works exactly as expected: no throw,
correct `Count()`.

Measured 2026-08-13 against **Cronus283** (the same container `fixtures/sandbox-data`/
`fixtures/sandbox-data-tests` target), via the `bc-dev` MCP tool's `bcdev_test_run`.

## Why this exists

`docs/superpowers/specs/2026-08-12-r134-filter-literal-design.md` section 2.7 fixes an
`astSubtreeHash` collision between fixture arms C and D by appending a HASH DECOY alternative to
each pair's survivor twin's filter text: arm B's filter becomes `'<>%1|FLT-NONE'` (field `"Main
No."`, `Code[20]`) and arm D's becomes `'<%1|FLT-NONE'` (field `"Entry No."`, **Integer**). The
fix was verified by computing `astSubtreeHash` directly on the arm text — a purely static,
AST-level check — not by running the filter against a live BC container. Whether BC's filter
evaluator accepts `'FLT-NONE'` as an OR-alternative on an INTEGER field was reasoned as "probably
fine, it's inert" but never measured, and the type difference between arm B's field (`Code[20]`,
a string type, where an arbitrary token is always a syntactically valid filter value) and arm D's
field (`Integer`, where a filter value must parse as a number) is exactly the kind of premise this
project's own discipline says to measure rather than assume.

Task B6 (fixture growth for R134) hit this directly: building arm D exactly as the spec's table
states would make arm D's own BASELINE call raise, before any mutation — a second, unplanned
baseline failure the tables gate's single-permitted-failure assertion would catch for a reason
that looks nothing like its cause, discovered only at the live gate (Task B8) instead of here.

## The probe

`table 71600 "R134 Filter Probe"` — the same shape as `fixtures/sandbox-data`'s `table 79302 "Data
Related"`: an Integer primary key (`"Entry No."`) plus a `Code[20]` grouping field (`"Main No."`).

`codeunit 71601 "R134 Filter Probe Tests"`, two `[Test]` methods:

1. `IntegerFilterWithNonNumericOrAlternative` — byte-for-byte arm D's own filter text with `%1`
   substituted (`SetFilter("Entry No.", '<%1|FLT-NONE', 3)`), wrapped in a `TryFunction` so the
   raise can be caught and its message reported via `Error()` rather than crashing the whole test
   run uninformatively.
2. `IntegerFilterWithNumericOrAlternative` — the candidate fix, `SetFilter("Entry No.",
   '<%1|999999999', 103)`, a decoy that is still numeric (a valid Integer literal) and still
   inert (no seeded row uses Entry No. 999999999).

## Result

```
bcdev_test_run (string decoy):  MEASURED (string decoy): THROWS -- SetFilter("Entry No.",
                                 '<%1|FLT-NONE', 3) raised at runtime: The filter "<%1|FLT-NONE"
                                 is not valid for the Entry No. field on the R134 Filter Probe
                                 table. The value "FLT-NONE" can't be evaluated into type Integer.

bcdev_test_run (numeric decoy):  MEASURED (numeric decoy): NO THROW -- SetFilter("Entry No.",
                                 '<2|999999999', 103) returned Count() = 2 (entries 101,102,103
                                 seeded; expected 2, matching <103: 101 and 102)
```

## What this settles

**It settles that arm D's filter text, exactly as the spec's table 3.1 states it
(`'<%1|FLT-NONE'`), cannot be built** — it breaks the arm's own baseline call, not just the
mutant. The fix Task B6 adopted in the committed fixture
(`fixtures/sandbox-data/src/DataFilterOps.Codeunit.al`) is a NUMERIC out-of-band decoy
(`'<%1|999999999'`) in place of the spec's non-numeric one, which this probe confirms is inert and
non-throwing, and which still differs arm D's original literal text from arm C's plain `'<%1'`
(the actual purpose section 2.7's hash decoy exists for — `astSubtreeHash` hashes a `text_literal`
node's text verbatim, so any distinct, inert alternative satisfies it; nothing about the decoy's
specific spelling is load-bearing beyond that).

**It does not settle** whether the same holds for non-Integer numeric types (`Decimal`, `Date`,
etc.) or for other kinds of malformed alternative (e.g. a string containing spaces, or a second
`%N` placeholder) — only the one substitution arm D actually needs.

## Reproducing

```bash
ALC="$HOME/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/alc.exe"
cp "U:/Git/LethAL/fixtures/sandbox-data/.alpackages/Microsoft_"*.app \
   "U:/Git/LethAL/fixtures/sandbox-data/.alpackages/System.app" \
   scripts/r134-filter-probe/.alpackages/
"$ALC" /project:"U:/Git/LethAL/scripts/r134-filter-probe" \
  /packagecachepath:"U:/Git/LethAL/scripts/r134-filter-probe/.alpackages" \
  /out:"U:/Git/LethAL/scripts/r134-filter-probe/r134-filter-probe.app"
```

```powershell
docker context use desktop-windows
$c = Get-Content 'U:\Git\LethAL\fixtures\sandbox-data\lethal.config.local.json' | ConvertFrom-Json
$cred = New-Object System.Management.Automation.PSCredential(
  $c.bcdev.username, (ConvertTo-SecureString $c.bcdev.password -AsPlainText -Force))
Publish-BcContainerApp -containerName Cronus283 -appFile 'U:\Git\LethAL\scripts\r134-filter-probe\r134-filter-probe.app' -useDevEndpoint -credential $cred -syncMode ForceSync -install
```

Then, via the `bc-dev` MCP tool (`project` pointed at this directory, `server=http://Cronus283`,
`serverInstance=BC`, `tenant=default`, `company=CRONUS Danmark A/S`): `bcdev_test_run` against
codeunit 71601.

Unpublish when finished:

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
UnPublish-BcContainerApp -containerName Cronus283 -name 'LethAL R134 Filter Probe' -unInstall -doNotSaveData -force
```
