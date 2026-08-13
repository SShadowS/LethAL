# R136 arm C probe -- does `Delete(true)` work with no preceding `Get`/`Find`?

**Answer: YES.** `Rec."No." := X; Rec.Delete(true);` on a record variable that was never
`Get`/`Find`/`Insert`'d by that same variable -- only its primary key field assigned -- correctly
identifies the row by primary key, deletes it, and runs `OnDelete`. No runtime error is raised
locating the row by primary key alone.

Measured 2026-08-13 against **Cronus283** (the same container `fixtures/sandbox-data`/
`fixtures/sandbox-data-tests` target), via the `bc-dev` MCP tool's `bcdev_test_run` /
`bcdev_test_orchestrate` (the standard BC dev-endpoint test runner, not LethAL's own fenced
`RunMutant` path -- this question has nothing to do with mutant execution or sessions, so the
lighter path applies).

## Why this exists

Task A7 committed `fixtures/sandbox-data/src/DataFlagOps.Codeunit.al`'s arm C
(`DeleteWithTrigger`) in this shape:

```al
procedure DeleteWithTrigger(No: Code[20]): Boolean
var
    Probe: Record "Data Trigger Probe";
    Tomb: Record "Data Trigger Probe";
begin
    Probe."No." := No;
    Probe.Delete(true);
    exit(Tomb.Get('TOMB-' + No));
end;
```

`Probe` is never `Get`'d, `Find`'d or `Insert`'d by this procedure -- the row is seeded separately,
by the covering test, per spec section 3.3 rule 3 ("statements in the target app are not free").
Whether `Delete(true)` on a record variable positioned ONLY by assigning its primary key actually
locates and deletes the right row (and runs `OnDelete`) was reasoned about, not measured, when arm C
was written -- flagged as a concern in the A7 report. A wrong answer here would not merely mislabel
one mutant: it would make the arm's own BASELINE call raise (e.g. "the record does not exist"),
which surfaces as a SECOND baseline test failure. The tables gate asserts exactly ONE permitted
baseline failure by name (`Data Tests.PageActionComputesNonZero`), so a wrong assumption here fails
the live gate for a reason that looks nothing like its cause, after a run that costs minutes against
a real container.

## The probe

`table 71570 "R136 ArmC Probe"` -- the identical `OnDelete` shape as
`fixtures/sandbox-data/src/DataTriggerProbe.Table.al`: a tombstone row inserted with a `TOMB-`
prefix.

`codeunit 71571 "R136 ArmC Probe Tests"`, one `[Test]`,
`DeleteWithoutGetRunsOnDelete`:

1. Idempotent cleanup (`Delete(false)` only, same discipline as the committed fixture).
2. Seeds the row through a SEPARATE record variable (`Seed`), mirroring "the row is inserted by the
   test, not the arm".
3. THE MEASURED SHAPE: a fresh, unrelated record variable (`Probe`) gets only its primary key
   assigned, then `Probe.Delete(true);` -- byte for byte arm C's own body.
4. Checks whether the tombstone appeared, and reports the answer via `Error()` (the transport this
   repo's probes use; the test shows as `failed` on both outcomes and that is expected, not a
   broken experiment).

## Result

```
bcdev_test_run:        MEASURED: PASS -- Delete(true) on a key-only record (no prior Get/Find)
                        ran OnDelete and left the tombstone. No runtime error was raised locating
                        the row by primary key alone.

bcdev_test_orchestrate (3 runs): classification "stableFailed" (i.e. stably reproduces the same
                        PASS message every time), 0 flaky, 0 inconsistent.
```

No callstack pointed at the `Delete(true)` line itself as a failure site -- the callstack in every
run is the test's OWN `Error()` call at line 24, confirming `Delete(true)` returned control normally
rather than raising.

## What this settles

**It settles the open question in the A7 report.** Arm C's `DeleteWithTrigger` behaves exactly as
its header comment predicts: `Delete(true)` on a key-only record variable deletes the seeded row and
runs `OnDelete`, so the mechanism arm C's PREDICTED KILLED verdict depends on (Delete(false) skips
`OnDelete`, no tombstone appears) is not undermined by an unrelated baseline failure. The committed
fixture's arm C needs no change.

**It does not measure** whether the same holds on tables with more complex keys, `SIFT` fields, or
non-clustered primary keys -- only the shape `Data Trigger Probe` actually uses (a single `Code[20]`
clustered primary key, `OnDelete` reading only that field).

## Reproducing

```bash
ALC="$HOME/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/alc.exe"
cp "fixtures/sandbox-data-tests/.alpackages/Microsoft_"*.app \
   "fixtures/sandbox-data-tests/.alpackages/System.app" \
   scripts/r136-armc-probe/.alpackages/
"$ALC" /project:"U:/Git/LethAL/scripts/r136-armc-probe" \
  /packagecachepath:"U:/Git/LethAL/scripts/r136-armc-probe/.alpackages" \
  /out:"U:/Git/LethAL/scripts/r136-armc-probe/r136-armc-probe.app"
```

```powershell
docker context use desktop-windows
$c = Get-Content 'U:\Git\LethAL\fixtures\sandbox-data\lethal.config.local.json' | ConvertFrom-Json
$cred = New-Object System.Management.Automation.PSCredential(
  $c.bcdev.username, (ConvertTo-SecureString $c.bcdev.password -AsPlainText -Force))
Publish-BcContainerApp -containerName Cronus283 -appFile 'U:\Git\LethAL\scripts\r136-armc-probe\r136-armc-probe.app' -useDevEndpoint -credential $cred -syncMode ForceSync -install
```

Then, via the `bc-dev` MCP tool (`project` pointed at this directory, `server`/`serverInstance`/
`tenant`/`company` from `fixtures/sandbox-data/lethal.config.local.json`'s `bcdev` block):
`bcdev_test_discover`, then `bcdev_test_run` (or `bcdev_test_orchestrate` for repeatability) against
codeunit 71571.

Unpublish when finished:

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
UnPublish-BcContainerApp -containerName Cronus283 -name 'LethAL R136 ArmC Probe' -unInstall -doNotSaveData -force
```
