# Layer 5C-A Task 8 — deploy-verifier redesign + target self-registration (design addendum)

Addendum to `docs/superpowers/specs/2026-07-20-layer-5c-server-side-runner-design.md`
(the layer authority). Resolves the two live-gated open items §13 left for Task 8 and the
register-gap Task 7 surfaced. Everything here is bcdev-path unless stated; al-runner shares the
schemata emit path and is protected explicitly (§D).

**Revision 4** — after three rounds of two-model adversarial review (gpt-5.6-sol + claude-fable-5).
Round 1 (both BLOCK) found that a registry-read verifier does NOT prove the *live binary's* baked
identity (registration and activation baked the artifactId from two independent literals; nothing
attested the running selector). Round 2 confirmed the R1 blockers CLOSED and refined §G's attestation
from a weak last-value artifact check into a sticky full-tuple binary-identity fence that does not
over-claim per-mutant coverage. Round 3 confirmed the R2 §G findings CLOSED and scoped the
clean-attestation qualification per deployed artifact with a fail-closed enforcement point. The
disposition tables (end) record every finding across all three rounds. Both models' final verdicts
resolve to SHIP-WITH-FIXES with the Round-3 fixes applied here; the residual concurrency items are
explicitly deferred to 5C-B's lease.

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
every republish, PROVIDED the app version increases. The runner's app version is clock-monotonic
(`reserveAppVersion`), so it always increases. This is evidence for THIS container/runtime/transport;
per §E-qual it becomes a per-container qualification gate, not a universal assumption.

## Scope & preconditions (what 5C-A does and does not guarantee)

5C-A has NO cross-process fence (parent spec §I). This design therefore assumes, as explicit
preconditions, (1) **no concurrent or external publication to a container while a session runs** —
the LethAL session is the only writer of that container's target app and registry; and (2) **at most
one instrumented LethAL target installed per container** — a second instrumented target (different
`targetAppId`) whose selector is on a test's call path would present a non-matching tuple and trip
§G's sticky mismatch, erroring every such run (loud, never a corrupt verdict, but it bricks the
backend — fable-R3-2). §F housekeeping unpublishes prior instrumented targets. Concurrency findings
(TOCTOU between the artifact guard and test execution; a binary replaced mid-run) belong to 5C-B's
machine-global lease and are out of scope here. Two consequences enforced now:

- bcdev is **single-flight** in 5C-A: `runSession` asserts `workers === 1` for the authoritative
  (bcdev) backend. Parallel bcdev workers share the one `LC Mutation Active` row and would corrupt
  each other's activation — refused loudly, not silently tolerated.
- The per-run attestation (§G) is defense-in-depth: it turns the out-of-scope concurrent/replaced
  cases from silent `survived` into a loud `error`, even though preventing them is 5C-B's job.

## Correctness model — three problems, one identity, one attestation

Three artifactId comparisons exist: the target's `Mutation Selector.Active` → `IsActive(T, BAKED, m)`
(uses the id baked into the live binary); `RunMutant`'s guard `RegisteredArtifact(T) == SENT`; the
transport's echo check `echoed == SENT` (which only catches transport corruption — the server builds
the echo from the request, so it attests nothing about the binary). The gap Revision 1 missed: the
**live binary's BAKED id is never compared to anything we verified.** Registry equality is at best
"self-registration by some binary was observed," not "the running binary is ours." Closed two ways:

- **Single-source the baked identity (§A).** The selector is the ONE place `targetAppId`/`artifactId`
  are baked; both registration codeunits read them from the selector, so `RegisteredArtifact` can
  never diverge from what `Active` uses. Given the no-external-writer precondition, registry equality
  then does imply `live-baked == expected`.
- **Attest the live binary per run (§G).** `IsActive` records the baked id the running selector
  presented; `RunMutant` returns it; the transport rejects `observed ≠ sent`. This proves the
  *running* binary's identity directly, independent of the registry, and is the real correctness
  fence.

## A. Target self-registration on republish, single-sourced identity

- `packages/schemata/src/selector.ts`:
  - `emitMutationSelector` gains a `TargetAppId(): Text` procedure alongside the existing
    `ArtifactId(): Text`; `emitStaticSelector` gains the same (procedure-set parity rule,
    `mem:conventions` — al-runner overwrites the selector and must expose the identical set).
  - `emitRegisterInstall` and a new `emitRegisterUpgrade` BOTH obtain identity from the selector, not
    from separate emitter string arguments:
    `var Selector: Codeunit "Mutation Selector"; State.RegisterArtifact(Selector.TargetAppId(), Selector.ArtifactId());`
    (Upgrade codeunit: `Subtype = Upgrade; trigger OnUpgradePerCompany()`.) Object ids: Install =
    `selectorIds.controlId` (79198, unchanged), Upgrade = the freed `selectorIds.tableId` (79197).
  - Fix the stale `emitRegisterInstall` doc comment ("belt-and-suspenders alongside the client's
    post-publish OData `RegisterArtifact`") — there is no client-side write (§B2).
- `packages/schemata/src/project.ts writeInstrumentedProject`: also write `MutationUpgrade.Codeunit.al`.
  Export the emitted control-codeunit filenames as constants so §D can delete them by shared name
  (a rename here must not silently reintroduce the al-runner break).
- Red test: emit a selector/registration pair whose baked ids intentionally differ and assert the
  build/verify path rejects it (guards against a future divergence regression).

## B. DeploymentVerifier → registry read (pre-flight sanity, not the sole proof)

- `extensions/lethal-control/src/ControlApi.Codeunit.al`: add `RegisteredArtifact(TargetAppId): Text`
  → thin wrapper over `State.RegisteredArtifact`. Exposed as OData `LethALControl_RegisteredArtifact`
  (read-only). Republish LethAL Control.
- `packages/runner/src/deployment-verifier.ts`: replace the `postOData(…, "Identity")` call with a
  `LethALControl_RegisteredArtifact` POST — its OWN request method (do NOT reuse `postOData`, which
  hardcodes the dead `MutationControl_` prefix; mirror `HarnessVerifier.fetchHarnessInfo`). Body
  `{ targetAppId: expected.appId }`. The action returns a bare artifactId string inside OData's
  scalar `value` (single parse — unlike `RunMutant`'s double-JSON). Keep both 32-hex
  `isValidArtifactId` guards. `reported === expected.artifactId` → `accepted`; empty (no row) or
  malformed → `unavailable`; well-formed but different → `mismatch`. `decidePublishOutcome` unchanged.
- Reworded contract: this proves "self-registration by our binary was observed" (sound under §A +
  the no-external-writer precondition), a cheap pre-flight before running 16 mutants. The binding
  proof that the *running* binary is ours is §G's per-run attestation.

## B2. Registration is in-process only (no OData write)

Remove the `RegisterArtifact` procedure from `LC Control API` (the published OData codeunit) — the
service framework exposes every public procedure, so leaving it there keeps the registry
client-writable and contradicts the single-writer invariant. The target's install/upgrade codeunits
call `LC Control State.RegisterArtifact` directly across the app dependency, so no OData write action
is needed. `HarnessInfo` and `RunMutant` remain exposed. (Nothing in `packages/runner/src` calls the
OData write; only the Task 7 itest did, and §E removes that.)

## C. bcdev `deploy()` dependency staging (bcdev-only, private staging copy)

The instrumented target's selector delegates to `Codeunit "LC Control State"`, so it cannot compile
without the LethAL Control dependency + symbol. In a PRIVATE compile-staging copy (never the shared
instrumented dir — al-runner reads that), bcdev must (1) inject the LethAL Control dependency into
the staged `app.json`, (2) stage `lethal-control.app` into the package cache, before alc. Config
gains a path to `lethal-control.app` + the control app identity for the dependency; the itest sources
`extensions/lethal-control/lethal-control.app`. Task 4's live proof did this by hand.

## D. al-runner — drop the control-registration codeunits (in `deploy()`, by shared name)

`AlRunnerBackend.deploy()` does `cp(instrumentedDir, activeDir, {recursive:true})` — the FULL dir,
including `MutationRegister.Codeunit.al` (and now `MutationUpgrade.Codeunit.al`), both referencing
`Codeunit "LC Control State"`. al-runner has no control dependency, so those files fail its compile.
In `deploy()`, immediately after the copy and before any lazy compile: `rm(..., {force:true})` both
files (force so synthetic fixtures lacking them don't fail), using the filename constants exported
from `project.ts`. The static-selector swap stays where it is; deletion must NOT be deferred to
`activate()` (that would leave a post-`deploy()` `run()` compiling the delegating files with no
control dependency). al-runner never talks to the control extension.

The documented no-deploy path (callers driving `activate()`/`run()` straight against
`cfg.instrumentedDir`) would still see the two control codeunits. That failure is LOUD (a compile
error → `pre-dispatch-rejected`), not a false verdict, so it is not a blocker — but to be safe,
delete-if-present the two files in the compile-staging path as well (idempotent with the `deploy()`
delete). (fable G-5 / sol#8.)

## E. Remove the Task 7 itest workaround

`packages/runner/itest/bcdev.itest.ts`: drop the inline `odataRegisterArtifact` in the probe section
(and its helper — the OData write action is gone, §B2). With §A, the target self-registers its baked
id on the scratchB republish; the workaround would mask an A/B/G regression.

## E-qual. Per-container upgrade-trigger qualification

The probe evidence is one container/runtime/transport. Make install/upgrade firing a qualification
gate, not a universal fact: after publish, §G's attestation on the first covered-mutant run confirms
the running binary is the one just compiled. If attestation fails on a container where the upgrade
trigger silently did not run (binary possibly changed), the session aborts and the container is
quarantined (parent spec §8 tier quarantine) — never a corrupt verdict.

## F. Live gate + docs

- Prerequisite publish order: LethAL Control (with `RegisteredArtifact`, without OData
  `RegisterArtifact`) → instrumented target (dependency + self-registration) → sandbox-tests →
  sandbox-probes.
- LIVE GATE (foreground, do not poll): `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` reproduces
  **3/10/3** through `RunMutant`, passes all protocol-invariant probes, records at least one clean
  attestation (`observedAny && !identityMismatch`) FOR EVERY deployed artifact that contributes
  verdicts, and NO `identityMismatch` on any run; `LETHAL_ITEST_ALRUNNER=1 … bun run itest:alrunner`
  unchanged **3/13/0**. Any differing verdict / failing probe / attestation mismatch /
  never-attested artifact → BLOCKED.
- Docs: `fixtures/README.md` (probe app + harness-provisioning prerequisite + RunMutant execution
  model + attestation); correct `design.md` §6.2 to state Codeunit isolation is what is enforced
  (Function later); fill spec §15 evidence.
- Housekeeping (host-side, interactive): `UnPublish-BcContainerApp -appName "LC Spike Runner"
  -unInstall -force` and `… -appName "LethAL Upgrade Probe" -unInstall -force`; also unpublish any
  prior instrumented target so at most one is installed (precondition 2).

## G. Per-run target attestation (binary-identity fence)

Attestation proves ONE thing: the selector that ran during this call belongs to the binary we
deployed. It is NOT coverage confirmation — it does not prove the requested mutant's own site
executed (any instrumented site presents the same baked identity), and it never binds a kill/survive
verdict. Per-mutant coverage stays the hub's job with its existing procedure-level over-approximation
(unchanged from prior layers; out of scope here). The mechanism is a STICKY full-tuple mismatch flag,
never a "last observed" value (a last-value would let a stale in-process object overwrite a wrong
binary's observation with a matching one and hide it — sol#3).

- `extensions/lethal-control/src/ControlState.Codeunit.al`: add SingleInstance fields
  `ExpectedTargetAppId: Text`, `ExpectedArtifactId: Text`, `ObservedAny: Boolean`,
  `ObservedIdentityMismatch: Boolean`.
  - `SetActive` — at the TOP, before any write/commit/callback — stores `Expected*` from its
    `(TargetAppId, ArtifactId)` arguments and resets `ObservedAny := false`,
    `ObservedIdentityMismatch := false` (run-scoped). `ClearActive` resets them too (so a future
    direct reader can't consume a stale value; today every reader goes through `SetActive` first).
  - `IsActive` — at the TOP, BEFORE the `CachedMutantId = ''` early exit — sets `ObservedAny := true`
    and, if `(presented TargetAppId ≠ ExpectedTargetAppId) OR (presented ArtifactId ≠
    ExpectedArtifactId)`, sets `ObservedIdentityMismatch := true` (sticky — never cleared mid-run).
    Captures identity on any instrumented-site execution, including a baseline (`mutantId = ''`) run.
  - Getters `AttestationObservedAny(): Boolean`, `AttestationMismatch(): Boolean`.
- `ControlApi.RunMutant`: after `RunOneMethod`, before `ClearActive`, add
  `{ observedAny, identityMismatch }` to the result.
- `packages/runner/src/run-mutant-transport.ts`: `identityMismatch === true` → `error` "wrong
  target/binary observed during run" (never a verdict). `observedAny === false` → allowed (no
  instrumented site executed — e.g. a self-contained protocol probe); do NOT treat empty as error
  (bcdev coverage over-approximates — a covered mutant's guard line can be branch-skipped, so
  empty-as-error would falsely reject correct runs and spuriously fail the gate — fable G-1/sol#2).
- Per-artifact qualification, fail-closed (orchestrator): the clean-attestation latch is keyed by the
  accepted deployment artifact `(targetAppId, artifactId)`, NOT the whole session — every batch
  republishes a fresh artifactId, and one batch's clean observation must never vouch for a later
  batch's binary (sol-R3). Require AT LEAST ONE run against THAT artifact with `observedAny === true
  && identityMismatch === false` before ANY of that artifact's verdicts may leave the orchestrator.
  Enforcement point (fable-R3-1): no verdict is reported, persisted, cached, or printed until its
  artifact is confirmed; if an artifact NEVER attests (e.g. a wrong binary with zero instrumented
  sites — every run `observedAny=false`, every test passes → would otherwise accumulate false
  `survived`), that artifact's ENTIRE set of verdicts is DISCARDED and the container quarantined
  (spec §8 / §E-qual) — never truncated-and-shipped. A wrong binary that DOES run a guard presents a
  different tuple → `identityMismatch` → immediate error. This replaces per-run empty-as-error and
  closes both the wholesale-wrong-binary and the stale-code-after-republish cases without falsely
  erroring individual empty runs.
- The orchestrator distinguishes mutation-verdict runs from Task-7 protocol probes EXPLICITLY (not by
  "non-empty mutantId"): probes intentionally execute no instrumented site and are exempt from the
  session-level clean-observation requirement (sol#6).

Session lifetime assumption (verify in the live gate, §F): `ObservedAny`/`ObservedIdentityMismatch`
are uncommitted SingleInstance fields, so `IsActive` (during test execution) and `RunMutant`'s read
must run in the SAME NST session. This holds for Codeunit isolation (the isolation codeunit runs the
test body in the same session; SingleInstance in-memory state is not transactional, so a rollback
does not clear it), but if a future isolation mode spawned a separate session the fields would read
empty and the session-level requirement would quarantine loudly — a fail-safe direction, but call it
out so a gate failure is diagnosable (fable G-2).

## H. Transport & harness hardening (adopted review findings)

- `run-mutant-transport.ts` fetch classification: once `fetchFn` has been invoked, ANY async
  rejection that is not our own timeout abort is `in-flight-unknown` (the request may have reached BC
  and left a mutant active), NOT `pre-dispatch-rejected`. Only a synchronous request-construction
  throw is pre-dispatch. (Revision 1 mislabeled a post-dispatch connection reset as retry-safe,
  contradicting parent spec §7's never-retry-after-dispatch rule.)
- `bcdev-backend.ts`: make `harnessVerifier` a REQUIRED member of the deployment object and call it
  unconditionally before compile/publish and before binding the RunMutant transport — not an optional
  that silently skips when absent.
- Registry key invariant (state, don't code): `RegisteredArtifact`/`RegisterArtifact` compare
  `Target App Id` as case-sensitive `Text`; all writers/readers derive it from the same `app.json`
  `id` string, so no normalization (brace/case) may be introduced at one site only.

## Testing / red-check

- Unit: verifier registry-read mapping (accepted / mismatch / unavailable / malformed) with a fake
  fetch; transport observed-id attestation (match → verdict, mismatch → error, empty → allowed);
  transport post-dispatch reject → in-flight-unknown; al-runner drops both control codeunits (assert
  the copied dir no longer contains them, by the shared constants); selector/registration
  divergence red test (§A). Red-check each by mutation per `mem:review_discipline`.
- Live is the authority: the gate (§F) proves A–H compose. A green unit suite that fails the live
  gate means a fixture-blind assumption — fix in one commit, re-probe.

## Adversarial review disposition (Revision 1 → 2)

| # (sol/fable) | Finding | Disposition |
|---|---|---|
| sol1 / fable3 | Registration & activation bake identity from independent literals; live baked id never verified → false `survived` | **Adopted** — §A single-source from selector + §G per-run attestation + §A red test |
| sol2 / fable1 | Registry still client-writable over OData → forgeable | **Adopted** — §B2 remove OData `RegisterArtifact`; registration in-process only |
| fable2 | `Commit()` in `RegisterArtifact` decouples row from publish success | **Adopted (via §G)** — attestation proves the running binary regardless of registry-commit timing; failed publish already → `anomalous` |
| sol3 / fable4 | Concurrent publish / parallel workers → TOCTOU false survivor | **Scoped to 5C-B lease** + mitigated: bcdev single-flight assertion (workers=1) + §G attestation turns the single-process case loud |
| sol4 / sol5 | Registry equality is historical, not proof of current binary; env-specific upgrade evidence | **Adopted** — §B reworded to "self-registration observed"; §G attestation is the current-binary proof; §E-qual makes upgrade-firing a per-container gate |
| sol6 | Post-dispatch fetch reject mislabeled `pre-dispatch-rejected` | **Adopted** — §H reclassify to `in-flight-unknown` |
| sol7 | `harnessVerifier` optional/skippable | **Adopted** — §H required + unconditional |
| sol8 / fable5 | al-runner deletion ordering / no-deploy path / shared `app.json` mutation | **Adopted** — §D delete in `deploy()` by shared constant; §C private staging copy |
| fable6 | Stale `emitRegisterInstall` comment invites re-adding the write | **Adopted** — §A fixes the comment same commit |
| fable7 | Registry key case-sensitivity unstated | **Adopted** — §H invariant stated |
| — | §B OData single-parse mapping; failed-publish→anomalous; not reusing `postOData`; §C layering; §E intent | **Confirmed sound** by both models — kept as-is |

### Revision 2 → 3 (second review round; both models confirmed R1 blockers CLOSED)

| # (sol/fable) | Finding | Disposition |
|---|---|---|
| sol-G1 | Non-empty attestation proves the binary ran, NOT that mutant m's site executed → must not bind per-mutant verdicts | **Adopted** — §G recast as a binary-identity fence only; per-mutant coverage stays the hub's job (over-approximation unchanged, out of scope) |
| sol-G3 | "Last observed" isn't sticky — mixed A/B execution overwrites B→A and hides the wrong binary | **Adopted** — §G uses a STICKY `ObservedIdentityMismatch` flag, never a last-value |
| sol-G4 | Artifact-only observation omits `targetAppId` | **Adopted** — §G attests the full `(targetAppId, artifactId)` tuple |
| fable-G1 / sol-G2 | "empty-on-covered = error" falsely rejects correct runs (coverage over-approximates; guard line branch-skipped) | **Adopted** — dropped; replaced by session-level ≥1-clean-observation-or-quarantine |
| fable-G2 | SingleInstance field lifetime relies on same-NST-session for `IsActive` + `RunMutant` read | **Adopted** — stated as a §G assumption, verified by the §F gate (fail-safe: quarantine) |
| sol-G5 / fable-G4 | Reset lifetime / also reset in `ClearActive` | **Adopted** — reset at top of `SetActive` and in `ClearActive` |
| sol-G6 | Distinguish protocol probes from verdict runs explicitly, not by non-empty `mutantId` | **Adopted** — §G orchestrator exempts probes explicitly |
| fable-G5 / sol-G8 | al-runner no-deploy path still compiles the control codeunits (loud, not silent) | **Adopted (demoted)** — §D delete-if-present in the compile-staging path too |
| sol-#3 concurrency residual (mixed A/B), sol-#4 tuple | cross-process replacement | **Scoped to 5C-B lease**; §G sticky full-tuple turns the single-process manifestation loud |
| — | R1 blockers #1/#2 (split-identity, client-writable) | **Confirmed CLOSED** by both models |

### Revision 3 → 4 (third/final review round; both confirmed R2 §G findings CLOSED)

| # (sol/fable) | Finding | Disposition |
|---|---|---|
| sol-R3 | Session-wide clean-attestation latch vouches across batches; a fresh per-batch artifact B running stale A code (B's site never instrumented in A) → `observedAny=false` allowed → false `survived` | **Adopted** — §G latch keyed per accepted artifact `(targetAppId, artifactId)`; ≥1 clean observation required per verdict-contributing artifact |
| fable-R3-1 | Enforcement point undefined; a wrong binary with zero instrumented sites yields all-empty→all-pass→false `survived` if verdicts stream before the check | **Adopted** — §G fail-closed: no verdict leaves the orchestrator until its artifact is confirmed; never-attested → discard that artifact's whole verdict set + quarantine |
| fable-R3-2 | Sticky mismatch also trips on a SECOND instrumented target installed → bricks the backend | **Adopted** — precondition "at most one instrumented target per container" + §F unpublish prior targets |
| fable-R3-3/4/5, sol | stale active row, background session, sticky-flag ordering | **Confirmed sound** — no false verdict |
| — | R2 §G findings (sol-G1/G3/G4, fable-G1/G2) | **Confirmed CLOSED** by both models; sol found no false-killed sequence |
