# Layer 5C-A Task 8 — deploy-verifier redesign + target self-registration (design addendum)

Addendum to `docs/superpowers/specs/2026-07-20-layer-5c-server-side-runner-design.md`
(the layer authority). Resolves the two live-gated open items §13 left for Task 8 and the
register-gap Task 7 surfaced. Everything here is bcdev-path unless stated; al-runner shares the
schemata emit path and is protected explicitly (D).

## Motivating defects

1. **Register-gap.** Each `deploy()` mints a fresh random `artifactId`. The instrumented target
   registers `(targetAppId → artifactId)` into the LethAL Control registry only from its emitted
   Install codeunit (`OnInstallAppPerCompany`), which fires on a FRESH install but not on a
   republish. Every batch after the first republishes the already-installed target, so the registry
   goes stale and `RunMutant`'s artifact guard returns `artifact-mismatch` for the whole run.

2. **Deleted verifier probe.** Task 4/5 removed the in-target Mutation Control codeunit + its
   `MutationControl_Identity` web service — the exact endpoint `DeploymentVerifier` probes. `deploy()`
   still calls it, so a live publish verifies as `unavailable` → `indeterminate` → the session aborts.
   Unit tests fake the verifier, so this breaks LIVE only; the full bcdev itest has never run
   end-to-end through `RunMutant`.

## Probe evidence (live, Cronus281, 2026-07-21/22)

Whether `OnUpgradePerCompany` fires on the runner's publish path was unknown — `altool publishapp
--schemaupdatemode ForceSync` publishes via the DEV endpoint (`POST /BC/dev/apps`), and dev/RAD
publish historically skips upgrade codeunits. Probed with a throwaway app (`LethAL Upgrade Probe`,
depends on LethAL Control) whose Install writes `RegisterArtifact('upgprobe','installed')` and
Upgrade writes `'upgraded'`, read back via a `RunMutant` oracle (registry match → `status:ran`,
mismatch → `status:artifact-mismatch`):

- Publish v1.0.0.0 (fresh) → registry `'installed'` (OnInstall fired).
- Bump to v1.0.0.1, republish ForceSync → registry `'upgraded'` (**OnUpgradePerCompany fired**).

**Conclusion:** an emitted target Upgrade codeunit re-registers the target's baked `artifactId` on
every republish, PROVIDED the app version increases. The runner's app version is already
clock-monotonic (`reserveAppVersion`, app-version.ts), so it always increases. A pathological
non-bump leaves the registry stale → the verifier (B) reads a mismatch → safe abort, never a
corrupt verdict.

## Why not client-side registration

The rejected alternative — have `deploy()` OData-`RegisterArtifact` the compiled id after publish —
is deterministic but makes the verifier **circular**: reading back a registry the client just wrote
proves nothing about the published binary. Worse, a wrong binary (baked `artifactId` ≠ the
client-written one) would pass the guard on the `RunMutant` call's param yet fail the target's own
`Mutation Selector.Active → IsActive(…, bakedArtifactId, …)` comparison, silently leaving mutants
un-activated → all-survived, no error. That is the `mem:review_discipline` corrupt-verdict hazard.
The registry must be written ONLY by the target binary's own install/upgrade, so a verifier read
that equals the compiled id proves the published binary ran.

## A. Target self-registration on republish

- `packages/schemata/src/selector.ts`: add `emitRegisterUpgrade({objectId, targetAppId, artifactId})`
  → an Upgrade codeunit whose `OnUpgradePerCompany` calls
  `ControlState.RegisterArtifact('<targetAppId>', '<artifactId>')`, mirroring `emitRegisterInstall`.
  Object id = the freed `selectorIds.tableId` (79197; the in-target Mutation Active table is gone).
- `packages/schemata/src/project.ts writeInstrumentedProject`: also write
  `MutationUpgrade.Codeunit.al`.
- No client-side `RegisterArtifact` anywhere.

## B. DeploymentVerifier → registry read

- `extensions/lethal-control/src/ControlApi.Codeunit.al`: add
  `RegisteredArtifact(TargetAppId: Text): Text` → thin wrapper over
  `State.RegisteredArtifact(TargetAppId)`. Exposed as OData `LethALControl_RegisteredArtifact`.
  LethAL Control must be republished (its web service points at the codeunit object, so the new
  unbound action is callable without re-registering the service — but republish to ship the code).
- `packages/runner/src/deployment-verifier.ts`: replace the `postOData(…, "Identity")` call with a
  `LethALControl_RegisteredArtifact` POST (own request method — do NOT reuse `postOData`, which
  hardcodes the dead `MutationControl_` prefix; mirror `HarnessVerifier.fetchHarnessInfo`). Body
  `{ targetAppId: expected.appId }`. The action returns a bare artifactId string inside OData's
  scalar `value` (single parse, not the double-JSON `RunMutant` shape). Keep both 32-hex
  `isValidArtifactId` guards. `reported === expected.artifactId` → `accepted`; empty (no registry
  row) or malformed → `unavailable`; well-formed but different → `mismatch`. `decidePublishOutcome`
  unchanged (publishOk + accepted → accepted; else indeterminate/abort).

## C. bcdev `deploy()` dependency staging (bcdev-only)

The instrumented target's selector delegates to `Codeunit "LC Control State"`, so it cannot compile
without the LethAL Control dependency + symbol. Before alc, bcdev must (1) inject the LethAL Control
dependency into the instrumented `app.json`, (2) stage `lethal-control.app` into the package cache.
NOT in the shared emit path (al-runner would then need the symbol too — see D). Config gains a
path to `lethal-control.app` (+ the control app identity for the dependency); the itest sources
`extensions/lethal-control/lethal-control.app`. Task 4's live proof did this by hand.

## D. al-runner — drop the control-registration codeunits

`AlRunnerBackend.deploy()` does `cp(instrumentedDir, activeDir, {recursive:true})` — the FULL dir,
including `MutationRegister.Codeunit.al` (and now `MutationUpgrade.Codeunit.al`), both of which
reference `Codeunit "LC Control State"`. al-runner swaps in the static selector but has no LethAL
Control dependency, so those files fail its compile (unresolved `LC Control State`). After the copy
+ static-selector swap, al-runner must delete both control-registration codeunits — it uses the
static selector and never talks to the control extension. (Latent break from Task 4's shared emit;
the al-runner itest has not run live since.)

## E. Remove the Task 7 itest workaround

`packages/runner/itest/bcdev.itest.ts`: drop the inline `odataRegisterArtifact` in the probe
section. With A, the target self-registers its baked id on the scratchB republish; the workaround
would mask an A/B regression.

## F. Live gate + docs

- Prerequisite publish order: LethAL Control (with `RegisteredArtifact`) → instrumented target
  (dependency + self-registration) → sandbox-tests → sandbox-probes.
- LIVE GATE (foreground, do not poll): `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` reproduces
  **3/10/3** through `RunMutant` AND passes all protocol-invariant probes; `LETHAL_ITEST_ALRUNNER=1
  … bun run itest:alrunner` unchanged **3/13/0**. Any differing verdict / failing probe → BLOCKED.
- Docs: `fixtures/README.md` (probe app + harness-provisioning prerequisite + RunMutant execution
  model); correct `design.md` §6.2 to state Codeunit isolation is what is enforced (Function later);
  fill spec §15 evidence with the probe + gate results.
- Housekeeping (host-side, interactive): unpublish the throwaways —
  `UnPublish-BcContainerApp -appName "LC Spike Runner" -unInstall -force` and
  `UnPublish-BcContainerApp -appName "LethAL Upgrade Probe" -unInstall -force`.

## Testing / red-check

- Unit: verifier registry-read mapping (accepted / mismatch / unavailable / malformed) with a fake
  fetch; al-runner drops the register+upgrade codeunits (assert the copied dir no longer contains
  them). Red-check each by mutation per `mem:review_discipline`.
- Live is the authority: the gate (F) is the real proof A–E compose. A green unit suite that fails
  the live gate means a fixture-blind assumption — fix in one commit, re-probe.
