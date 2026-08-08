# R83 probe — is `InherentPermissions` a better `PermissionReduce` target than `Permissions`?

**Answer: no, for two independent measured reasons.** It cannot constrain, and at the only shape a
real project uses it the only possible mutation is a measured no-op.

Measured 2026-08-08 against **Cronus281** (BC 28.0.46665.49944, `LethAL Control` 1.0.0.16), through
the **fenced** path — `LethALControl_RunMutant` at baseline (`mutantId: ""`), which is where every
verdict this tool issues is produced. Re-runnable; see "Reproducing" below.

## Why this exists

R13 measured that `Permissions` is purely ADDITIVE: it grants indirect rights to code executing in
the object, so reducing it is observable only in a session that already lacks the right — which is
why a `PermissionReduce` kill needs the rare permission-lowering test. R83 asked whether
`InherentPermissions` is different, recorded the footprint (Continia Document Output: 2 occurrences
across 554 files, both on CODEUNITS, both `InherentPermissions = X`), and said plainly that the
semantics were unmeasured — that "it constrains rather than grants" came from reading the AL
compiler's option list rather than from any run.

## Two facts the COMPILER settled before anything ran

Both are grammar, both are load-bearing, and neither was in the row:

```
error AL0776: The identifier 'tabledata' is not a valid permission value
    (on `InherentPermissions = tabledata Item = rm;`)
error AL0195: Invalid permission kind. Expected: 'X'
    (on `InherentPermissions = R;` — on a CODEUNIT)
```

So `InherentPermissions` cannot name a table at all, and on a codeunit it accepts exactly one
letter. **At a codeunit site there is nothing to WEAKEN** — no smaller letter set, no table clause.
The only edit a `PermissionReduce` operator could make there is DELETION. On a table it does accept
`R` / `RIMD`.

## Design notes that are load-bearing

- **Two halves, because the property means different things in the two places it can sit.** The C
  arms are codeunits writing to Microsoft's `Item` under a LOWERED session; the D arms are
  probe-owned tables under SUPER.
- **The C arms use `Item` (27), not a probe table**, and are run under
  `LibraryLowerPermissions.SetO365Basic()` — R13's mode, the one real suites use. A probe-owned
  table would sit outside every stock permission set and every arm would be refused for a reason
  unrelated to the variable.
- **The D arms are deliberately NOT lowered.** R83's question is literally "can it refuse an
  operation a SUPER session would otherwise be allowed", so lowering would answer a different one.
- **The control is not optional.** C0 writes directly from the lowered test body; if it succeeded,
  the lowering did not take and every C arm below would be measuring nothing. That is R26's mistake
  (a probe measuring its own declaration instead of the platform) written as an arm.
- **The D arms are a THREE-way comparison**, so the answer cannot be ambiguous: D0 succeeding with
  D1 refused would mean it constrains; D0 refused with D2 succeeding would mean it is additive.
- Results travel out through `Error()`. Every arm shows as a FAILED test; that is the transport.

## What was measured

### C arms — codeunit, `Item`, lowered session

| arm | callee's properties | result |
|---|---|---|
| C0 **(control)** | written directly by the test body | **refused** — `Sorry, the current permissions prevented the action. (TableData 27 Item Modify: LethAL R83 Probe)` |
| C1 | `Permissions = tabledata Item = rm` | **`modified=Yes`** |
| C2 | `InherentPermissions = X` only | **refused**, same message as C0 |
| C3 | no permission property at all | **refused**, same message as C0 |
| C4 | `Permissions = tabledata Item = rm` **+** `InherentPermissions = X` | **`modified=Yes`** |

**C2 == C3**: `InherentPermissions = X` grants nothing about a table operation.
**C4 == C1**: it takes nothing away from a `Permissions` grant either. It is INERT here, in both
directions. Deleting it at either of Document Output's two real sites changes nothing observable.

### D arms — probe-owned tables, SUPER session

Three tables identical in every respect except the declaration, each taking the same `Insert` from
the same test body in the same session.

| arm | table's `InherentPermissions` | result |
|---|---|---|
| D0 | none | **`inserted=Yes`** |
| D1 | `R` (read, no insert) | **`inserted=Yes`** |
| D2 | `RIMD` | **`inserted=Yes`** |

**D1 did not refuse.** Declaring read-only on the table did not stop an insert the session was
otherwise allowed to perform. `InherentPermissions` does not CONSTRAIN — it is additive, exactly
like `Permissions` (R13), and R83's suspicion that it might be different is measured false.

D0 succeeding also means the calling-user gap that makes `LethAL Control`'s own tables carry
`InherentPermissions = RIMD` (the 5C-A finding) did not bite in this session, so D1's non-refusal is
a genuine "did not constrain a permitted operation" rather than "everything was permitted anyway
being indistinguishable from everything being refused".

## What this does NOT establish

- **Not a table site under a LOWERED session.** In that mode D0 would be refused for the
  outside-every-permission-set reason above, so the comparison could not be made. What it would
  show is `InherentPermissions` GRANTING, which D2's existence in `LethAL Control` already
  demonstrates in production.
- **Not `InherentEntitlements`.** A different property, untouched here.
- **Not the SaaS permission model.** One on-prem container, one BC build.

## Reproducing

```bash
ALC="$HOME/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/alc.exe"
# symbols: any BC 28 .alpackages carrying Tests-TestLibraries + Permissions Mock
cp scripts/r13-probe/.alpackages/*.app scripts/r83-probe/.alpackages/
"$ALC" /project:"U:/Git/LethAL/scripts/r83-probe" \
  /packagecachepath:"U:/Git/LethAL/scripts/r83-probe/.alpackages" \
  /out:"U:/Git/LethAL/scripts/r83-probe/r83-probe.app"
```

Credentials come from the gitignored `fixtures/sandbox-app/lethal.config.local.json` (`bcdev.env`),
never from a literal here — this repo is public.

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
$c = Get-Content 'U:\Git\LethAL\fixtures\sandbox-app\lethal.config.local.json' | ConvertFrom-Json
$cred = New-Object System.Management.Automation.PSCredential(
  $c.bcdev.username, (ConvertTo-SecureString $c.bcdev.password -AsPlainText -Force))
Publish-BcContainerApp -containerName Cronus281 -appFile 'U:\Git\LethAL\scripts\r83-probe\r83-probe.app' -useDevEndpoint -credential $cred -syncMode ForceSync
```

```bash
bun scripts/r83-probe/drive.ts fixtures/sandbox-app/lethal.config.local.json \
  df1aa9ff-6539-4c86-a9d0-ad702b61ac9a 71524 \
  DirectWriteUnderLoweredSession GrantCalleeUnderLoweredSession InherentOnlyUnderLoweredSession \
  NoneCalleeUnderLoweredSession SiteShapeUnderLoweredSession \
  OpenTableInsert ReadOnlyTableInsert FullTableInsert
```

**Unpublish when done** — a stray test extension on a shared container is someone else's confusing
afternoon. Note this probe carries TABLES, so a later republish after changing them hits the schema
ghost; `Sync-NAVApp -Mode Clean` while UNPUBLISHED is the cure, in that order.

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
UnPublish-BcContainerApp -containerName Cronus281 -name "LethAL R83 Probe" -unInstall -force
```
