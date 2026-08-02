# R13 probe — can a `PermissionReduce` mutant ever be killed?

Measured 2026-08-02 against **Cronus281** (BC 28.0.46665.49944, `LethAL Control` 1.0.0.14), through
the **fenced** path — `LethALControl_RunMutant` at baseline (`mutantId: ""`), which is where every
verdict this tool issues is produced. Re-runnable; see "Reproducing" below.

## Why this exists

R13 asked whether `design.md`'s sketched Tier-3 operator `PermissionReduce` (weaken an object's
`Permissions` property) can produce a kill. Seven arms in `fixtures/sandbox-probes`
(`Tier3*.Codeunit.al`) covered two modes and supported the conclusion "unkillable in both of the two
modes a suite can be in — there is no third mode."

**An adversarial review of the decision spec found the third mode, in the very project the census
ran on.** `U:/Git/do-rel2/Test/Src/E-Seal/CDOESealSetupTests.Codeunit.al` declares
`TestPermissions = Disabled` — so it counts inside the "every real suite declares it" evidence — and
then lowers its own session with `LibraryLowerPermissions.SetO365Basic()`. Permission checks are ON
and the session is not SUPER while production code runs. That is this probe.

## Design notes that are load-bearing

- **The table is Microsoft's `Item` (27), not a probe-owned table.** Under `SetO365Basic()` the
  session holds whatever O365 Basic carries on Microsoft tables. A table this probe invented would
  sit outside every stock permission set, so all arms would be refused for a reason that has nothing
  to do with the variable under test.
- **A9 exists to decide which cost bar applies**, not to describe BC: if a caller's grant covered a
  callee's write, the "route the write through a shadow object carrying a reduced grant" activation
  could not reduce anything.
- **The direct-write control is not optional.** Without it, "the grant arm succeeded" is
  indistinguishable from "the lowering silently did nothing" — R26's mistake, where a probe measured
  its own declaration instead of the platform.
- Results travel out through `Error()`. Every arm shows as a FAILED test; that is the transport.

## What was measured

| arm | who runs the write | callee's `Permissions` | result |
|---|---|---|---|
| A8-direct **(control)** | the test body itself | — | **refused** — `Sorry, the current permissions prevented the action. (TableData 27 Item Modify: LethAL R13 Probe)` |
| A8-grant | 71500 `R13 Grant Callee` | `tabledata Item = rm` | **`modified=Yes`** |
| A8-reduced | 71501 `R13 Reduced Callee` | `tabledata Item = r` | **refused** |
| A8-none | 71502 `R13 None Callee` | none | refused |
| A9 | 71503 grants `rm`, calls 71501 which grants `r` and writes | — | **refused** |

**A8: `PermissionReduce` IS killable.** Reducing `rm` to `r` — exactly what the mutant emits — turns
a succeeding write into a refusal, in a mode a real suite uses.

**A9: a caller's grant does NOT cover a write performed by a callee.** The grant is scoped to the
object whose own code performs the operation.

Neither result makes the operator worth building — see
`docs/superpowers/specs/2026-08-02-r13-tier3-decision.md` for the cost refusal and the reachability
bound (10 of 1,290 tests in the censused project lower permissions). What they do is make the
refusal one a future reader can argue with using a measurement.

## Reproducing

```bash
ALC="$HOME/.vscode/extensions/ms-dynamics-smb.al-18.0.2498801/bin/win32/alc.exe"
# symbols: any BC 28 .alpackages carrying Tests-TestLibraries + Permissions Mock
cp /u/Git/do-rel2/Test/.alpackages/Microsoft_*.app scripts/r13-probe/.alpackages/
"$ALC" /project:scripts/r13-probe /packagecachepath:scripts/r13-probe/.alpackages /out:/tmp/r13-probe.app
```

Publish through the dev endpoint (`altool publishapp` failed here with a detail-free
*"Publish operation failed"*; bccontainerhelper's dev-endpoint publish, which passes `tenant=default`,
succeeded):

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
Publish-BcContainerApp -containerName Cronus281 -appFile /tmp/r13-probe.app -useDevEndpoint -credential $cred -syncMode ForceSync
```

Then drive it. `drive.ts` calls `RunMutant` for one named method at a time and prints the server's
raw answer; it needs a target app with a REGISTERED artifact on that container (any published
instrumented target will do — the probe's own test codeunit id is what selects the tests):

```bash
bun scripts/r13-probe/drive.ts fixtures/sandbox-app/lethal.config.local.json \
  df1aa9ff-6539-4c86-a9d0-ad702b61ac9a 71504 \
  DirectWriteUnderLoweredSession GrantCalleeUnderLoweredSession ReducedCalleeUnderLoweredSession \
  NoneCalleeUnderLoweredSession CallerGrantCoversCalleeWrite
```

**Unpublish when done** — a stray test extension on a shared container is someone else's confusing
afternoon:

```powershell
$env:DOCKER_CONTEXT='desktop-windows'
UnPublish-BcContainerApp -containerName Cronus281 -name "LethAL R13 Probe" -unInstall -force
```
