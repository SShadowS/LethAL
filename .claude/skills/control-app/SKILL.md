---
name: control-app
description: Rebuild the LethAL Control BC extension and publish it to the target containers. Use after editing anything under extensions/lethal-control, after bumping its app.json version, or when a live gate refuses with "The deployed LethAL Control app reports version X, older than the Y this client requires". Compiles with alc, stages lethal-control.app, then publishes to every container the fixture configs name.
---

# Rebuild and publish LethAL Control

`extensions/lethal-control/lethal-control.app` is **gitignored** — a local build every machine makes
for itself, which no pull refreshes. Editing the AL does not rebuild it, and nothing republishes it
to a container automatically before the harness check runs. So the source, the local `.app`, and
what the container actually runs are three separate things that drift independently.

The symptom is always the same and always late:

```
backend not ready: The deployed LethAL Control app reports version 1.0.0.9, older than the
1.0.0.10 this client requires — your control app predates this client.
```

## Before building: the lockstep

`MIN_CONTROL_VERSION` in `packages/runner/src/harness.ts` must **equal** `app.json`'s `version`. A
test pins it (R28). If you bumped one, bump the other before compiling — a control app built ahead
of the minimum passes; a minimum ahead of the app makes a freshly built app fail its own gate.

Bump the version at all only when the wire surface changed in a way a client can depend on (a new
action, a new field on the marker). It is `MIN_CONTROL_VERSION` that gates, deliberately, rather
than `protocolVersion` — the protocol moves only when an existing wire contract BREAKS, and adding
an action breaks nothing.

## 1. Compile

`alc` lives under the AL VS Code extension. Output goes next to the previous versioned builds, which
are kept as a record:

```bash
ALC=$(ls ~/.vscode/extensions/ms-dynamics-smb.al-*/bin/win32/alc.exe ~/.vscode/extensions/ms-dynamics-smb.al-*/bin/alc.exe 2>/dev/null | sort | tail -1)
VER=$(python -c "import json,io;print(json.load(io.open('extensions/lethal-control/app.json',encoding='utf-8-sig'))['version'])")
"$ALC" "/project:U:/Git/LethAL/extensions/lethal-control" \
       "/packagecachepath:U:/Git/LethAL/extensions/lethal-control/.alpackages" \
       "/out:U:/Git/LethAL/extensions/lethal-control/LethAL_LethAL Control_${VER}.app"
```

A clean compile prints only the start/end lines. Any diagnostic is a stop — do not publish a build
you have not read the output of.

## 2. Stage it as the local build

The runner and `controlSymbolPath` both read `lethal-control.app`, not the versioned filename:

```bash
cp "extensions/lethal-control/LethAL_LethAL Control_${VER}.app" extensions/lethal-control/lethal-control.app
```

## 3. Publish to every container that matters

**Which containers**: read them from the gitignored fixture configs rather than assuming — the two
fixtures target *different* containers, and a gate against the one you forgot will refuse.

```bash
grep -h '"server"' fixtures/*/lethal.config.local.json
```

Today that is `Cronus281` (sandbox-app: `itest:bcdev`) and `Cronus283` (sandbox-data:
`itest:tables`). Publish to each:

```powershell
$env:DOCKER_CONTEXT='desktop-windows'   # the session default is the LINUX engine; without this
                                        # every command reports the container does not exist
Publish-BcContainerApp -containerName <name> `
  -appFile "U:\Git\LethAL\extensions\lethal-control\LethAL_LethAL Control_<ver>.app" `
  -skipVerification -sync -upgrade
```

`-upgrade` is what makes a version bump land: publishing does not replace, and without it BC refuses
with "tenant already uses a different version of it with the same app ID".

## 4. Verify

Cheapest proof is the gate itself refusing to refuse:

```bash
LETHAL_ITEST_BCDEV=1 bun run itest:bcdev
```

Expect **3 killed / 10 survived / 3 no-coverage**, twice. If it still reports the old version, the
publish went to the wrong container or the wrong context.

## Rebuilding a container that came back EMPTY

A restarted container can come back as clean BC with every non-Microsoft app gone. Measured
2026-08-19: all six Cronus containers reported 192 apps, every one Microsoft, so `doctor` failed with
`HarnessInfo … HTTP 404` and no gate could run.

Check before assuming a version problem:

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
Get-BcContainerAppInfo -containerName <name> | Where-Object { $_.Publisher -ne 'Microsoft' }
```

Nothing returned means a full rebuild, in this order.

**1. The control app, at GLOBAL scope.** LethAL never replaces it, so the ordinary
`Publish-BcContainerApp -sync -install` above is right. It goes FIRST because every
instrumented target declares a dependency on it: that is what makes `-unInstall -force`
cascade (see below), and it is why a target cannot be published back before the control app
is up.

**2. Every fixture target and test app, through the DEV ENDPOINT.** This is the part that is easy to
get wrong, and the failure arrives late:

```
The extension could not be deployed, because it tries to replace the existing AppSource app
'LethAL Sandbox Data' … which is a dependency to the following AppSource apps:
'LethAL Sandbox Data Tests by LethAL'.
```

Published at global scope a target becomes an AppSource app that its own test app depends on, and BC
then refuses the replace LethAL performs on **every run**. The publish succeeds; the first gate
fails. So:

```powershell
$cfg  = Get-Content '<fixture>\lethal.config.local.json' -Raw | ConvertFrom-Json
$cred = New-Object System.Management.Automation.PSCredential(
          $cfg.bcdev.username, (ConvertTo-SecureString $cfg.bcdev.password -AsPlainText -Force))
Publish-BcContainerApp -containerName <name> -appFile <app> `
  -skipVerification -sync -install -useDevEndpoint -credential $cred
```

`-useDevEndpoint` REQUIRES `-credential` ("You need to specify credentials when you are not using
Windows Authentication"); the fixture config already holds them, so read them from there rather than
prompting, and never echo them.

If the apps were already published globally, unpublish DEPENDENTS FIRST and then their targets
(`UnPublish-BcContainerApp -unInstall -force`), then republish both through the dev endpoint.

**3. Which apps, and where.** Read the containers from the configs, never from memory. As of
2026-08-19:

| container | apps |
| --- | --- |
| Cronus283 | `sandbox-data`, `sandbox-data-tests` |
| Cronus281 | `sandbox-app`, `sandbox-tests`, `gift-card`, `gift-card-tests`, `sandbox-probes`, `sandbox-hang`, `sandbox-hang-tests` |

`sandbox-probes` and the `sandbox-hang` pair are the two easy to forget, and each fails a DIFFERENT
gate in a way that does not name the missing app. Without `sandbox-probes`, `itest:bcdev`'s verdicts
are correct and its protocol-invariant probe fails with *"expected exactly one method
ZzFailsIfMarkerPresent, found 0"*. Without the hang pair, `itest:hang` refuses with
`StaleTestAppError`.

**4. Microsoft's test libraries** (`Library Assert`, `Test Runner`, `Any`, `Library Variable
Storage`, `Permissions Mock`) must be installed Global. They were already present on a fresh
container; check rather than assume, because R132's twin pair depends on `Library Assert`.

**5. Verify all four gates**, not just the one you were working on:
`itest:bcdev` 3/10/3 plus its invariant probes, `itest:tables` at its frozen figures, `itest:hang`
PASS, and `campaign compare` on the demo.

## Notes

- Publishing to a container is **outward-facing**: confirm before doing it unless the user has
  already said to build and publish.
- Removal (rare) needs `UnPublish-BcContainerApp` under the Windows Docker context, naming
  `-publisher` AND `-version` once two versions exist.
- **`-unInstall -force` UNINSTALLS EVERY DEPENDENT APP, silently, and the gate that follows blames
  something else.** Measured 2026-08-02 removing 1.0.0.13: `LethAL Sandbox Tests` came off Cronus281
  and `LethAL Sandbox Data` + `LethAL Sandbox Data Tests` came off Cronus283. They stay PUBLISHED, so
  `Get-BcContainerAppInfo` still lists them and only `IsInstalled` flips. `itest:bcdev` then reported
  `baselineGreen=false` with **0 of 2 baseline tests failing** — a contradiction that is the actual
  signature — and the store held `RunMutant returned 0 test lines, expected exactly 1`. Before
  unpublishing, record what is installed, and reinstall it afterwards:
  ```powershell
  Get-BcContainerAppInfo -containerName <name> -tenantSpecificProperties |
    Where-Object { $_.Name -like "LethAL*" -and $_.IsInstalled } | Select-Object Name,Version
  # ... then, after the control app is back ...
  Install-BcContainerApp -containerName <name> -appName "<name>" -appVersion "<ver>"
  ```
- **Deleting a TABLE from the control app cannot ship as an upgrade.** BC refuses:
  *"Table 91011 LC Batch Queue :: The table cannot be located. Removing tables is not allowed unless
  they are temporary or are being moved by migration to another app."* `Publish-BcContainerApp
  -sync -upgrade` publishes the new version but leaves it UNINSTALLED. The sequence that works on a
  dev container, whose tenant data is disposable: unpublish the old version (see the cascade warning
  above), `Sync-BcContainerApp -Mode ForceSync -Force`, then — because the tenant still records an
  earlier version — `Start-BcContainerAppDataUpgrade`, not `Install-BcContainerApp`, which refuses
  with *"an earlier version was already installed"*.
- If a publish fails with *"already synchronized … different set of tables"*, the tenant kept a
  schema ghost. Unpublish first, THEN `Sync-NAVApp -ServerInstance BC -Name "LethAL Control" -Mode
  Clean -Force` inside the container, then publish. Order matters — cleaning while it is still
  published does nothing.
- **A dev-endpoint publish can be refused by a version that no longer exists.** After unpublishing
  the fixture apps (2026-08-20, the R169 id move), republishing `LethAL Sandbox Data 1.0.0.4`
  failed with *"Cannot install the extension ... because a newer version 1.0.20685.12603 was
  already installed"* while `Get-NAVAppInfo` on the same container listed the app not at all, at
  any scope, on any tenant. Both facts are true: the tenant kept an install record the unpublish
  did not clear. The number is not BC's, it is LethAL's own — `reserveAppVersion`
  (`packages/runner/src/app-version.ts`) mints `<major>.<minor>.<daysSinceEpoch>.<secondsOfDay/2>`
  for every instrumented publish, so a fixture that has ever been run against carries a resident
  version far above its `app.json`, and the ORIGINAL app is a downgrade. Same remedy as the schema
  ghost and it works for any app, not just the control app:
  ```powershell
  Invoke-ScriptInBcContainer -containerName <name> -scriptblock {
    foreach ($n in @('LethAL Sandbox Data','LethAL Sandbox Data Tests')) {
      Sync-NAVApp -ServerInstance BC -Name $n -Mode Clean -Force
    }
  }
  ```
  All eight fixture apps needed it, and all eight published on the retry. Do NOT reach for a
  version bump to clear it: that leaves the container carrying a fixture whose version does not
  match the `app.json` in the repo, which is the state this whole section exists to avoid.
