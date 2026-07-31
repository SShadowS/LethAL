# LethAL sandbox fixture

Two tiny AL apps used by `packages/runner`'s unit tests, the `lethal` CLI's
manual smoke-testing, and the env-gated integration scripts in
`packages/runner/itest/`. Not intended for production use.

## Object ids

| Codeunit | Id | App | Purpose |
|---|---|---|---|
| `Sandbox Logic` | 79000 | `sandbox-app` | Mutation target — every Tier 1 operator finds ≥1 site here. |
| `Sandbox Pricing` | 79001 | `sandbox-app` | Mutation target, deliberately **untested** by any test method. |
| `Sandbox Tests` | 79100 | `sandbox-tests` | `Subtype = Test` codeunit exercising `Sandbox Logic`. Asserts via `Error()` — no Library Assert dependency. Must NOT carry a `TestIsolation` property — `TestIsolation` is a **TestRunner**-codeunit property in real BC; setting it on a `Subtype = Test` codeunit is rejected by the AL compiler (`AL0223`). Isolation is chosen by whichever TestRunner codeunit invokes the tests and Layer 4 does not verify it — see the note below. |

`sandbox-app/app.json` reserves `idRanges` 79000–79199; `sandbox-tests/app.json` depends on
`sandbox-app` only (id `df1aa9ff-6539-4c86-a9d0-ad702b61ac9a`) and declares the same
`idRanges` window for its own codeunit 79100.

The injected Mutation Selector/Control/Active object ids (`79197`–`79199`, see
`DEFAULT_SELECTOR_IDS` in `packages/runner/src/cli.ts`) must also fall inside this window.
They didn't always: the original ids (`50000`–`50002`) compiled fine against al-runner but
fail real `alc.exe` with `AL0297` ("object identifier is not valid ... allowed ranges") —
verified against a real BC server 2026-07-18. al-runner's compiler simply doesn't enforce
`idRanges` the way the real Microsoft AL compiler does, so this went undetected until the
first live bcdev compile.

## Layer 5C-A — server-side execution harness (`LethAL Control` + probe app)

Since Layer 5C-A the bcdev backend no longer drives per-mutant tests through the hub. Instead a
separate BC extension, **`LethAL Control`** (`extensions/lethal-control/`, app id
`5e7a1c00-1111-4c00-8c00-1e7a1c000701`, runtime 16, ids 71000–71099), owns a single OData action
`LethALControl_RunMutant` that, in one server-side call, **activates a mutant → runs exactly one
named test method under Codeunit isolation → clears the active mutant** (always, on every terminal
path, so the container is left unmutated after each call). The instrumented target's
`Mutation Selector.Active(id)` is a thin delegate into `LC Control State.IsActive(targetAppId,
artifactId, mutantId)`; the target carries no active-mutant table of its own.

### Objects added
| Object | Id | App | Purpose |
|---|---|---|---|
| `LC Mutation Active` (table) | 71000 | `LethAL Control` | The single active-mutant tuple (DataPerCompany=false). |
| `LC Target Artifact Registry` (table) | 71001 | `LethAL Control` | `targetAppId → artifactId` the target self-registered. |
| `LC Control State` (codeunit) | 71002 | `LethAL Control` | SingleInstance state: active tuple, registry, per-run attestation. |
| `LC Control API` (codeunit) | 71003 | `LethAL Control` | OData surface: `HarnessInfo`, `RegisteredArtifact` (read), `RunMutant`. |
| `LC Control Install` / `Upgrade` | 71004 / 71005 | `LethAL Control` | Reconcile the `LethALControl` web-service row on install/upgrade. |
| `Sandbox Probe Marker` (table) | 79200 | `sandbox-probes` | Order-matters witness (shared row across two probe methods). |
| `Order Matters Probe` (codeunit) | 79210 | `sandbox-probes` | Two `[Test]` methods proving single-method selection. |
| `Fail Probe` (codeunit) | 79211 | `sandbox-probes` | Exact-error round-trip witness. |

The instrumented target also emits, into its own id window (79197–79199), a `Mutation Register`
install codeunit **and** a `Mutation Upgrade` codeunit (object id 79197, the freed `tableId`) — both
read identity from the `Mutation Selector` and call `LC Control State.RegisterArtifact`, so the
target self-registers its baked `artifactId` on a fresh install AND on every ForceSync republish
(`OnUpgradePerCompany` fires on an altool dev-endpoint ForceSync republish when the app version
increases — live-probed on Cronus281, 2026-07-22).

### `sandbox-probes` app
`fixtures/sandbox-probes/` (app id `a3b1c2d4-7788-4a10-9f3e-0c1122334455`, ids 79200–79299, no
dependencies) holds protocol-invariant probe codeunits. They are **NOT** discovered by `runSession`
(so the frozen 3/10/3 table stays unchanged — probes are additional, not counted); the bcdev itest
drives them directly through `RunMutantTransport`. They witness: single-method selection
(order-matters), the exact-error round-trip, run-scoped clear, and artifact-mismatch behaviour.

### Harness-provisioning prerequisite (publish order)
The bcdev path requires this order on the container (Cronus281):
1. **`LethAL Control`** — its `HarnessInfo` must report the expected app id, protocol version ≥ 1,
   `Codeunit` isolation, and `codeunit` test type; the session verifies this BEFORE any compile/
   publish (a missing or incompatible harness fails the session loudly, never a silent bad verdict).
2. The **instrumented sandbox target** — the bcdev backend compiles it in a private staging copy
   with the `LethAL Control` dependency injected into the staged `app.json` and `lethal-control.app`
   staged into the package cache (bcdev-only — al-runner shares the emit path and strips the two
   control-registration codeunits, so it stays dependency-free).
3. **`sandbox-tests`**, then **`sandbox-probes`**.

### Attestation fence (the correctness guarantee)
`RunMutant` returns `{observedAny, identityMismatch}` per call: `LC Control State.IsActive` records,
per run, the `(targetAppId, artifactId)` the LIVE selector presented, as a sticky mismatch flag. The
transport rejects `identityMismatch: true` as `error` (never a verdict — a wrong/stale binary), and
the orchestrator requires **at least one clean attestation** (`observedAny && !identityMismatch`) per
deployed artifact before any of that artifact's verdicts may leave the session — otherwise the
verdicts are discarded and the container quarantined (fail-closed). This proves the running binary is
the one just compiled, closing the "silent all-survived on a wrong binary" hole.

### Preconditions (5C-A, not enforced in-code — 5C-B adds the machine-global lease)
- No concurrent or external publication to a container while a session runs (the session is the only
  writer of that container's target app and registry).
- At most ONE instrumented LethAL target installed per container (a second one whose selector is on a
  test's call path would trip the attestation mismatch and error every such run).
- bcdev is single-flight: `runSession` asserts `workers === 1` for the authoritative backend (the
  single `LC Mutation Active` row is not lease-protected against parallel `RunMutant` calls).

## Layer 5C-B1 — machine-global lease + two-phase fence

Layer 5C-B1 closes the gap the "Preconditions" list above states but does not enforce: it gives
`LethAL Control` a machine-global lease (table `LC Lease`, id 71006) and turns `RunMutant` into a
two-phase fence, so two concurrent LethAL sessions against one container can no longer interleave a
publish with a mutant run and record a false verdict. See `design.md` §6.8 for the mechanism and
`docs/superpowers/specs/2026-07-24-layer-5c-b1-lease-fence-design.md` for the full design, review
history, and live-gate evidence.

### Single-tenant containers only — read this before pointing LethAL at a shared container

**LethAL 5C-B1 is supported only on a single-tenant BC container.** App publication in Business
Central is service-instance-wide, not per-tenant: if a second tenant publishes to the same service
instance, that publish happens **entirely outside the lease**, and the false-verdict window the lease
exists to close stays open for that configuration.

This is a **documented support constraint, not an enforced one** — a deliberate human decision, not
an oversight. AL cannot enumerate tenants from an extension: System Application codeunit 417
(`Tenant Information`) exposes only the current tenant (`GetTenantId`/`GetTenantDisplayName`), never a
tenant count or list. `HarnessInfo` therefore reports `tenantCountReachable: false`, and the runner
client surfaces `tenantGate: "unenforced"` plus a console warning (once per process, not once per
`HarnessInfo` check — a single session calls `verify()` several times, and repeating the same
paragraph on every call trains a reader to scroll past it) — it cannot refuse a multi-tenant
container the way it refuses an incompatible protocol version.

**This gate is unenforceable in-band, full stop.** There is no LethAL flag, config key, or future
protocol version that closes this from inside the AL extension — AL genuinely cannot see the tenant
list. Single-tenancy must be verified out of band, every time, before pointing 5C-B1 at a container
you don't already know is single-tenant.

**Before running 5C-B1 against any container you don't already know is single-tenant, verify it
out of band:**

```powershell
Get-BcContainerTenants -containerName <name>
# or
Get-NAVTenant -ServerInstance <instance>
```

If more than one tenant is listed, do not run concurrent LethAL sessions against that container —
the lease will not protect you.

### Recovering from `container-needs-recycle`

A durable `container-needs-recycle` quarantine means an operation marker was left behind by a holder
presumed dead (an orphaned op past grace, or a session that ended with an unreconcilable marker).
Recovery is one procedure, in order — **a restart alone does NOT clear the committed marker**:

1. **Restart the NST or the whole container** (`Restart-BcContainerServiceTier` /
   `Restart-BcContainer`) — kills any AL operation that might still be running.
2. **`ForceResetLease`** — an authenticated recovery action. It authorizes the caller by requiring the
   CURRENT `Server Generation` echoed back, which comes from `HarnessInfo(clientProtocol: 2)`. In one
   transaction it mints a NEW `Server Generation`, clears the marker/token/client-nonce, bumps the
   `Epoch`, and clears the committed `LC Mutation Active` row (so a fresh session can't inherit a
   stale active mutant from before recovery).

   ```bash
   lethal force-reset-lease --server http://cronus281 --instance BC --config lethal.config.json
   ```

   `lethal force-reset-lease` (`packages/runner/src/cli.ts`'s `performForceResetLease`) does exactly
   the two-call sequence below itself: it reads the bcdev section's company/username/password/tenant
   from `--config` (the SAME file `lethal run` uses), reads the CURRENT `Server Generation` live via
   `HarnessInfo`, and echoes exactly that value into `ForceResetLease` — it never accepts a
   caller-supplied or cached generation, since that echo is the reset's whole authorization. It prints
   the old/new generation, the new epoch, and confirms the committed `LC Mutation Active` row was
   cleared before exiting 0; a refused or unreachable reset exits non-zero with a message naming what
   to do next (e.g. "restart the NST first" if `HarnessInfo` itself can't be reached).

   **Manual fallback** (no `lethal.config.json` handy, or debugging the extension directly): the same
   two OData calls by hand. Both are `POST`s to
   `http://<server>:7048/<instance>/ODataV4/LethALControl_<Action>?company=<url-encoded company>&tenant=<tenant>`
   with Basic auth and `content-type: application/json`. **Each response is an OData scalar
   `{"value":"<json-string>"}` — the payload is inside `value` as a string, so it must be parsed
   twice.** (This is exactly what `packages/runner/itest/lease.itest.ts` does in the stale-publish
   probe; read it if you want a working reference.)

   ```bash
   BASE='http://cronus281:7048/BC/ODataV4'
   Q='company=CRONUS%20Danmark%20A%2FS&tenant=default'
   AUTH='-u admin:<password>'

   # 2a. Read the CURRENT Server Generation (the authorization token for the reset).
   curl -s $AUTH -H 'content-type: application/json' \
     -d '{"clientProtocol":2}' "$BASE/LethALControl_HarnessInfo?$Q" \
     | jq -r .value | jq -r .serverGeneration
   #    -> e.g. 9f2c...  (32 hex chars; this is what step 2b must echo back)

   # 2b. Reset, echoing that exact generation. Expect {"reset":true,"serverGeneration":<NEW>,...}
   curl -s $AUTH -H 'content-type: application/json' \
     -d '{"expectedGeneration":"<the value from 2a>"}' "$BASE/LethALControl_ForceResetLease?$Q" \
     | jq -r .value | jq
   ```

   A `reset:false` (or an echoed generation that no longer matches) means the row changed under you —
   re-read 2a and retry (`lethal force-reset-lease` just re-run does the same thing). The
   `serverGeneration` that comes back is a **new** one, different from the value you echoed; that is
   the reset landing. Note that the generation echo buys **replay protection only, not proof the NST
   was restarted** — see deviation D1 in the spec (§14): `Server Generation` is persistent, so the
   server cannot verify step 1 happened. Doing step 1 first is operator discipline neither the server
   nor `lethal force-reset-lease` will enforce for you.
3. **A post-recovery probe** confirming the container is actually clean (baseline/active-state check).
4. **`lethal clear-quarantine`** — only after steps 1-3, and only against the real
   `~/.lethal/quarantine` store (see the "Wedged-tier reproduction" section below — there is
   deliberately no override flag to point it elsewhere).

### Troubleshooting: "tier is quarantined" on a run you expect to succeed

A durable quarantine record in `~/.lethal/quarantine` blocks **every** later run against that tier —
including a run that would otherwise be completely fine — until the record is removed. If a session
aborts with "tier is quarantined" and you didn't expect it, **check `~/.lethal/quarantine` first**: a
stale record left over from an earlier failed or interrupted run is the common cause, not a live
problem with the container. The record names the mutant involved and carries the transport's own
failure message, so read it before assuming the container itself needs recovery.

## Note: no `TestIsolation` preflight

Layer 4 briefly shipped a preflight (`findMissingTestIsolation`, `packages/runner/src/discovery.ts`)
that scanned `[Test]` codeunit sources for `TestIsolation = Function;` and aborted session-isolation
backend runs when it was missing. That check was removed: `TestIsolation` is a **TestRunner**-codeunit
property, not a `Subtype = Test` one — real BC rejects it on a Test codeunit with `AL0223`
("The Property 'TestIsolation' can only be used if the property 'Subtype' is set to 'TestRunner'").
Isolation is therefore chosen by whichever TestRunner codeunit invokes the tests and cannot be
verified by scanning test-codeunit sources. Layer 4 does not check it — it's an out-of-band concern,
verified manually against the real backend instead (see `--test-isolation method` in
`al-runner-backend.ts`'s `run()`, verified against the real al-runner CLI).

## Tier-2 Phase 0 — the `sandbox-data` table fixture

`fixtures/sandbox-data` (+ `sandbox-data-tests`) is the table-trigger counterpart to
`sandbox-app`. It started as two tables carrying an object-level `OnInsert` and two field-level
`OnValidate` triggers, plus a procedure no test calls, to prove that mutants living inside table
triggers are generated, attributed, instrumented, executed and killed — the Phase 0 exit
criteria for the trigger half of Tier 2. Tier-2 Phase 1 extended it (§Phase 1 below); the Phase-0
objects and their four tests are unchanged inside it.

Neither table declares `InherentPermissions`, and none must. That property was added once, to
work around the fenced `RunMutant` path refusing writes, and it was **masking a fixture defect**:
`Data Tests` never declared `TestPermissions = Disabled`, so it defaulted to Restrictive and
Microsoft's Permissions Mock refused every write from its body — on every runner, not just
LethAL's. Measured by A/B on that one property (commit `769f667`); a real BC suite declares it
(the Continia Document Output suite: 77 of 77 test codeunits) and carries `InherentPermissions`
on zero tables. **Every `Subtype = Test` codeunit here must declare `TestPermissions = Disabled`;
no table here may reintroduce `InherentPermissions`.**

### bcdev (authoritative) — live gate, 2026-07-25, Cronus282 — Phase-0 half only

The table below is the Phase-0 fixture's frozen result, kept because it is still the clearest
statement of what the Phase-0 half of the fixture proves. It is NOT this fixture's current
aggregate: Phase 1 grew it to 75 deployed mutants, and R30 grew it again to 84 —
`tables.itest.ts`'s `EXPECTED` now asserts the live-measured **69 killed / 9 survived / 6
no-coverage** (see §Phase 1 and §"Extension objects" below). The Phase-0 objects and their tests
are unchanged inside that larger set.

| Mutant | Site | Operator | Verdict | Why |
|---|---|---|---|---|
| M0001 | `DataMain` field `No.` OnValidate body | empty-block | **killed** | `BlankNoValidateFails` — the guard's `Error` no longer fires. |
| M0002 | same trigger's `if` | negate-conditional | **killed** | Same test — `= ''` → `<> ''` stops raising on a blank. |
| M0003 | `DataMain` OnInsert body | empty-block | survived | `InsertDoublesAmountWeak` is weak on purpose — it asserts nothing. |
| M0004 | `TouchCount()` body | empty-block | no-coverage | No test calls `TouchCount`. |
| M0005 | `TouchCount()` return | return-value | no-coverage | Same. |
| M0006 | `DataNoTrigger` field OnValidate body | empty-block | **killed** | `TooLongNoValidateFails`. |
| M0007 | same trigger's `>` | conditional-boundary | survived | `NoTriggerValidateRunsWeak` asserts nothing. |

3 killed / 2 survived / 2 no-coverage — mutation score 60.0%, zero errors, zero unstable.

**The Phase-1 result is a committed gate, not just documentation:** `bun run itest:tables`
(`packages/runner/itest/tables.itest.ts`, env-gated on `LETHAL_ITEST_TABLES=1`) asserts the
aggregate counts, the score, and `SessionReport.untargetedTriggerCount` (see §Phase 1), then diffs
per mutant against `packages/runner/itest/tables.baseline.json` exactly as the Tier-1 gates do.
(The per-mutant map is asserted only by that baseline file — the inline 7-entry
`EXPECTED.verdicts` map was removed when the fixture grew to 75 deployed mutants, since a 7-key
map cannot match 75 results and asserting it proved nothing.) It also reads the
`mutant-manifest.json` the run actually deployed and asserts that at least one **killed** and at
least one **survived** mutant sit at a site whose manifest entry carries a `triggerName` — Phase
0's claim itself rather than a proxy for it (`MutantOutcome` carries no trigger info). It reads
`fixtures/sandbox-data/lethal.config.local.json` — **not** sandbox-app's; the two fixtures target
different containers.

> **`tables.baseline.json` is absent right now, deliberately.** The recorded file could never
> match itself: `diffMutants` treated a repeated semantic identity as a difference, and this
> fixture legitimately has 75 records over 67 distinct keys (one group six deep — six textually
> identical statements in `Data Ops` hash the same). Every run after the recording one therefore
> failed, and the failure advice ("delete, re-run, re-record") regenerated the same unusable file.
> `diffMutants` now compares per-key MULTISETS, the file was deleted, and the next
> `bun run itest:tables` re-records it — review the diff and commit it. A committed baseline that
> cannot match itself is now a unit-test failure (`packages/runner/tests/mutant-equality.test.ts`,
> "committed itest baselines"), not something a live gate discovers minutes into a run.

**Correction (2026-07-26, measured on Cronus282): BC DOES report coverage for table-trigger
code.** `bcdev_test_run` with `coverage: "procedure"` returned, for table 79300, `methodId
-1650094725` for one test and `2060272969` for another. The earlier claim that it reports none was
an artifact of the pipeline discarding the observation: `SymbolReference.json` records no trigger,
so `AppMethodIndex.lookup` cannot NAME the methodId, and `buildCoverageMap` then dropped the
observation entirely whenever the local-procedure fallback was also empty — which is exactly the
case for `Data Main`, whose procedures are all public. The object lost credit along with the
member, `byObject["table:79300"]` held only the one sibling test whose methodId happened to
resolve, the object-level fallback answered non-empty-but-wrong, the all-green-tests fallback never
fired, and every table-trigger mutant ran against one irrelevant test. Perverse shape: a table with
public procedures scored WORSE than one with none (`Data No Trigger`'s empty `byObject` fell
through correctly). **10 of 20 survivors on the Phase-1 fixture were false**; each was then driven
individually through the fenced path against its intended killer and killed, making the honest
result **63 killed / 10 survived / 2 no-coverage**, not 53/20/2 — re-recorded live and frozen in
`532c5fb`, and what `EXPECTED` in `tables.itest.ts` asserts today.

The fix: an observation whose methodId resolves to no name and has no local-procedure fallback is
emitted as an **object-level** `CoverageEntry` (`objectType`/`objectId`, `procedure` ABSENT — never
`""`, which would key `byMember` as `table:79300::` and collide with the empty member key a trigger
mutant itself builds). `buildCoverageIndex` joins such an entry to `byObject` and skips it for
`byMember` structurally.

A trigger mutant is still **member-invisible** — no trigger appears in `SymbolReference.json`, so
no trigger's member-level key can ever hit. `coverageFilter` therefore falls back,
most-precise-first: member key → object-level → all green tests. The two fallbacks are gated
**differently**:

- **object-level** (any test that covered anything in *this* object) applies to **any trigger**,
  whatever object kind it sits in. `SymbolReference.json` records no trigger at all, so no
  trigger's member-level key can ever hit — for a codeunit's `trigger OnRun` this is its only
  route to being executed, and gating it on table-ness silently reported mutants in covered
  codeunit triggers as `no-coverage`. The widening is evidence-based: the key carries the object
  type, so it can only return tests that measurably ran something in that same object.
- **all green tests** stays **table-only**. "Coverage sees nothing in this object at all, yet the
  trigger is still reachable" is what the measurement above established, and it established it
  for tables. A mutant in a wholly-uncovered codeunit or page keeps the honest `no-coverage`
  bucket. How often it fires is reported as **data**, not just announced on stderr:
  `SessionReport.untargetedTriggerCount` (printed after the score as `COVERAGE FALLBACK:` when
  non-zero, and in `--out` JSON). A stderr warning cannot be asserted, and this is the ONLY
  observable that separates "attributed precisely" from "gave up" — the verdicts do not move when
  it regresses, because on a suite where most tests touch the table both regimes kill the same
  mutants. `tables.itest.ts` pins it at 0.

Coverage is keyed on the **(objectType, objectId) pair** throughout, because a BC object id is
unique only within its type.

### al-runner — measured 2026-07-25, and why it kills nothing here

`bun run scripts/probe-alrunner-tables.ts` (same shape as the al-runner itest, pointed at this
fixture) reports **0 killed / 7 survived / 0 no-coverage** against bcdev's 3 kills. Two separate
facts explain it, and only the second is a defect:

1. **al-runner does execute table triggers, and the injected guard fires inside table code.**
   Directly probed: an `OnInsert` that doubles `Amount` produces 10 from 5 there, and a field
   `OnValidate` raises its own `Error` with the exact text. Statically activating M0001
   (`emitStaticSelector` with `activeId = 'M0001'`) makes that error disappear — so the
   `MutationSelector.Active(...)` guard injected into a table's `var` section works.
2. **al-runner's `asserterror` never fails a test.** `asserterror I := 1;` — a statement that
   cannot raise — is reported `pass` (al-runner v1.0.31-era build, 2026-07-25). Under M0001 the
   fixture's `asserterror DataMain.Validate("No.", '')` still passes with `GetLastErrorText()`
   empty. All three of bcdev's kills come from `asserterror` tests, so all three become false
   survivors.

Consequence for users: **on the al-runner backend, any mutation whose only killer is an
`asserterror` assertion is reported as survived.** That under-reports the mutation score
(survivors are safe-direction, a missed kill is never a false kill) but it is silent, so the CLI
warns whenever a non-authoritative backend is selected. Confirm survivors against bcdev.

**R7 update, 2026-07-26 — a startup canary, not just a warning.** A static warning printed on
every al-runner session names a defect frozen at the moment someone measured it by hand; it
cannot tell a fixed al-runner build apart from a broken one. `packages/runner/src/al-runner-canary.ts`
replaces it: `runFromCli`'s al-runner branch (`announceAlRunnerCanary`) now runs
`asserterror I := 1;` — a statement that cannot raise — through the ACTUAL configured binary at
the start of every `--backend al-runner` session, and reports whether the defect reproduced on
THIS build (`defect-confirmed` / `defect-not-reproduced` / `inconclusive`, printed via
`alRunnerCanaryWarnings`) instead of restating the 2026-07-25 finding as fact regardless of what
binary is actually installed. **Loud-warn, not hard-refuse:** the backend already declares
`authoritative: false`, the defect only under-reports (survivors are safe-direction — never a
false kill), and refusing to run at all would block legitimate offline smoke-testing over a
third-party binary's bug rather than this project's own code. A hard refusal also cannot adapt if
al-runner is ever patched upstream, where a canary automatically stops warning the moment the
defect stops reproducing. Verified end-to-end against the real `al-runner.exe` on this machine
(still v1.0.31-era, 2026-07-26): the canary reports `defect-confirmed` and the CLI's live output
carries the R7 line, with the frozen baseline below unaffected — the canary changes no verdict, it
only adds a diagnostic.

**R8 — the table global var divergence, root-caused 2026-07-26.** A table's global var does not
carry its trigger's write back out: after `Validate("No.", 'B2')`, the fixture's `TouchCount()`
returns 0 there even though the trigger body demonstrably ran. Three throwaway diagnostic probes
against al-runner.exe directly (same table/trigger/procedure shape, run in isolation, each
probe's own outcome read from an unguarded `Error()` message rather than through R7's broken
`asserterror` path) pinned the cause down precisely:

1. **The write is real.** Rigging the trigger to `Error()` with its own in-frame value of
   `Touched` immediately after incrementing it reports `Touched=1` — the assignment executes.
2. **The field write survives the call boundary; the global does not.** Reading `"No."` (a real
   field) from the caller's frame after `Validate()` returns correctly shows `'B2'`. Reading
   `TouchCount()` (which reads the non-field global `Touched`) from that SAME caller frame
   reports 0.
3. **A NESTED call to `TouchCount()` made from inside the trigger's own execution — before
   control returns to the caller — correctly reads 1.** So the boundary that loses the value is
   specifically "return from `Validate()`, then make a separate, later top-level dispatch onto
   the same record variable" — not "the record instance is unshared" in general (fields prove
   that's false) and not "TouchCount() itself reads the wrong place" (the nested call proves
   that's false too).

Conclusion: al-runner persists a `Record` variable's FIELD buffer across separate calls
correctly (matching real AL/BC semantics — verified independently, not merely assumed), but does
not persist a table object's own non-field GLOBAL variables the same way; each fresh top-level
dispatch onto the table object appears to reset them, while a call nested within one dispatch
correctly shares the single in-progress instantiation. **Third-party, upstream, documented —
legitimate as an outcome per this project's own bar**, not a gap needing a LethAL-side fix.
**Detectable, and now detected**: the same canary mechanism built for R7 carries a second probe
(`GlobalVarSurvivesValidate`, same `al-runner-canary.ts`) that runs exactly this pattern —
`Rec.Validate("No.", 'X')` then `Rec.TouchCount()` on the same variable, asserted via a plain
`Error()` rather than `asserterror` so R7's own defect cannot contaminate this probe's signal —
and reports `defect-confirmed`/`defect-not-reproduced`/`inconclusive` for it every session, the
same as R7. Verified end-to-end against the real binary on this machine: reports
`defect-confirmed`. Any mutant whose only observable effect is table-global (non-field) state may
still be misjudged on this backend when the canary confirms the defect present; field-only and
return-value mutants are unaffected.

### Tier-2 Phase 1 — the shapes that make a broken operator fail

Phase 1 extended `sandbox-data` from 7 to **75 deployed mutants** — 81 raw specs, of which **6**
Tier-1 `void-method-call` specs lose the §3.2 dedup to a Tier-2 deletion at the same site. **R30
then took it to 84 deployed mutants — 93 raw specs, 9 dropped by dedup** (see §"Extension objects"
below). Both numbers are reproducible offline, no server needed: `generateMutationSet` returns 93
(which `tables.itest.ts` asserts before it deploys anything), `dedupeSpecs` drops 9, and
69 + 9 + 6 = 84 scored mutants come back from the live gate. Every shape below exists because its ABSENCE lets a
broken operator pass — a fixture that only exercises the happy path tells you nothing. Design
spec: `docs/superpowers/specs/2026-07-25-tier2-mutation-operators-design.md` §6.

| Required shape | Where it lives |
|---|---|
| Out-of-filter **decoy rows** | `CountForMainIgnoresDecoys` (3 decoys), `CountInCategoryUppercaseSetRange` (category `CB`) |
| Seeded **related-table rows** | `CategoryGuardNeedsCalcFields` — two `Data Related` rows summing to 1300 |
| **`asserterror` negative tests** | `BlankNoValidateFails`, `TooLongNoValidateFails`, `ProcessedRequiresCategory`, `CategoryGuardNeedsCalcFields`, `RequireCategoryAFails` |
| A **`Validate()`-driven path** | every test above plus `FlaggedFiresModifyTrigger` |
| **Implicit-receiver positives in trigger bodies** | `Data Main` fields `Category` (`CalcFields`), `Processed` (`TestField`), `Flagged` (`Modify(true)`) |
| **Case variants** | `Data Ops.MarkProcessed` (`MODIFY(TRUE)`), `Data Main.CountInCategory` (`Rec.SETRANGE`) |
| **Both `TestField` overloads** | `Data Ops.RequireCategoryA` (two-argument), `Data Ops.TouchCategory` + the `Processed` trigger (one-argument) |
| A **weak positive test** calling `TestField` without asserting | `TouchCategoryWeak` |
| Negative: user-defined `procedure Commit()` **plus a call to it** | `Data Shadow.Commit` / `Data Shadow.BumpViaCommit` |
| Negative: `Insert(false)` | `Data Ops.InsertWithoutTrigger` |
| Negative: no-value `SetRange(F)` | `Data Ops.CountIgnoringMainFilter` |
| Negative: no-argument `SetLoadFields()` | `Data Ops.LoadAmount` |
| Negative: `Modify(SomeBoolean)` | `Data Ops.MarkWithFlag` |
| Negative: user-defined builtin-named methods **taking arguments, with side effects** | `Data Loader.SetLoadFields` / `Data Validator.TestField` / `Data Builder.SetRange`, called from `Data Ops.RunUserDefinedBuiltins` |
| Negative: a project **table** declaring a builtin-named procedure **and a record variable of it** | `Data Shadow` + `Data Ops.ShadowedBuiltins` (cross-file) and `Data Shadow.SelfShadowed` (same-file) |

Two rules the fixture depends on, both easy to break by accident:

- **A negative target is only useful if the suite pins a verdict on it.** Tier 2 outranks Tier 1
  in the §3.2 dedup precedence, so a wrongly-claimed negative does not add a mutant — it REPLACES
  the correct `lethal.void-method-call` one. That surfaces as a changed `operatorName` on a mutant
  whose verdict never moved, which is why every negative here has a test that kills its Tier-1
  mutant, and why the committed baseline keys on `operatorName`, not just the verdict.
- **Where a positive lives decides whether it can be killed at all** — for a reason that CHANGED
  in `0a463fd`, so read the current one rather than the historical one. A table trigger is
  member-invisible (`SymbolReference.json` records no trigger), but a coverage observation that
  names no member now credits the OBJECT, so any test that reaches the trigger puts itself in
  `byObject["table:<id>"]` and `coverageFilter`'s FALLBACK 1 answers precisely. FALLBACK 2 ("every
  green test") is the net for a table nothing covers at all, and on this fixture it catches
  nobody: `tables.itest.ts` asserts `untargetedTriggerCount === 0`. Table PROCEDURE mutants still
  need a member-level entry, and BC DOES emit one — `Data Main.CountInCategory` is a table
  procedure and it scores; the only two `no-coverage` mutants in the whole run are `TouchCount`'s,
  a table procedure no test calls, which is the honest answer. Each operator's guaranteed kill is
  still hosted either in a trigger (`RemoveCalcFields`, and one each of
  `RemoveTestField`/`SwapModifyFlag`) or in a codeunit (`RemoveSetRange`, and the other
  `RemoveTestField`/`SwapModifyFlag`) — a spread worth keeping, since it makes no operator's only
  evidence depend on one coverage path.

**The cross-file / same-file shadowing pair, and what it now proves.** `Data Ops.ShadowedBuiltins`
and `Data Shadow.SelfShadowed` are the same shape — a record whose own table declares that
procedure — reached cross-file and same-file. They used to DISAGREE, because `generateMutationSet`
built one `SemanticContext` per file: `projectDeclaresProcedureOnTable` saw no table from another
file, rule 3's qualified half could not fire, and `Shadow.TestField(42)` /
`Shadow.SetRange('AA', 'ZZZ')` were wrongly claimed by Tier 2. **Fixed in `0c4989b`**
(`packages/runner/src/orchestrator.ts` parses every file first and builds ONE project-wide
context, matching spec §4.1's "declared **in the project**"), and the fixture now proves the fix
rather than the bug: both halves refuse, every one of `Data Shadow`'s 10 mutants is Tier-1
(`lethal.empty-block` / `lethal.void-method-call` / `lethal.return-value`), and the object carries
no Tier-2 mutant at all. Keep the pair — it is the regression guard that would catch a return to
per-file contexts, and because Tier 2 outranks Tier 1 in dedup, the symptom would be a changed
`operatorName` on mutants whose verdicts never move.

### Extension objects (R30) — the first ones any gate executes

Extension support in the Tier-2 receiver predicate shipped 2026-07-28 with unit tests and a
measurement on Continia Document Output, but **no fixture declared an extension**, so none of it had
ever been instrumented, compiled by `alc`, published, installed or run. `sandbox-data` now carries
three objects that close that, and the frozen figures moved 64/9/2 → 69/9/6 because of them.

| Object | What it proves | Verdicts |
|---|---|---|
| `tableextension "Data Main Ext"` (`DataMainExt.TableExt.al`) | `TestField(Category)` on the IMPLICIT `Rec` claims only if `Rec` inside a `tableextension` resolves to the EXTENDED table; `Related.SetRange(...)` claims only if the extension's own members are indexed for variable SCOPE. Reached from a test because a `tableextension`'s public procedures are callable on a variable of the extended table's type. | 5 deployed, **all killed** by `ExtRequireCategoryFails` / `ExtCountRelatedIgnoresDecoys` |
| `page "Data Main List"` (`DataMainList.Page.al`) | Deliberately code-free — it is only a host, and contributes zero mutation sites. | — |
| `pageextension "Data Main List Ext"` (`DataMainListExt.PageExt.al`) | A `SetRange` on a record declared in the pageextension's own `var` section — the site R30's last half makes claimable — plus live proof that a pageextension-carried guard instruments, compiles, publishes and installs, and that its trigger mutants are attributed to `objectType: pageextension` rather than to the base page. | 4 deployed, **all `no-coverage`** |

**Why the pageextension's mutants are `no-coverage`, and why that is recorded rather than fixed.** A
pageextension's code is unreachable from a test codeunit — nothing outside the page can name its
procedures — so the only way in is a `TestPage`. That test was written, published and run against
Cronus283 on 2026-07-31: the fenced session went `in-flight-unknown` on it at BASELINE and the run
quarantined the tier, scoring nothing at all (`killed=0 survived=0 noCoverage=0`).

**The cause first recorded here was wrong.** "Opening a TestPage on the fenced path hangs" did not
survive its own probe: a code-free page opened the same way (`fixtures/sandbox-probes`,
`ProbeList.Page.al` + `TestPageProbe.Codeunit.al`) fails on the fenced path in **87 ms** with
`System.NotSupportedException ... NavSession.CreateNavTestService()`, and the run completes with no
quarantine — while the same test on the hub opens and closes fine. So `TestPage` is REFUSED in a
`GuiAllowed=No`/`ClientType=ODataV4` session, not slow, and a suite that uses it loses those tests
from the green set rather than wedging the run. What hung on Cronus283 remains unexplained. Both
halves are **R69**, which is sized on a real project: 9 of Document Output's 104 test files declare
a TestPage.

So the `pageextension` half of R30's receiver resolution is **claimed, deployed and unproven live**:
the operator claims the site, the mutant is compiled into the published artifact, and nothing ever
executes it. The `tableextension` half is proven end to end.

Two traps worth keeping written down, both hit while building this:

- **A variable declared in a TRIGGER's own `var` section is never resolved**, in any object kind —
  `lookupVar` handles procedure locals, procedure parameters and object globals only. The first
  version of the pageextension declared its records inside `OnOpenPage` and generated four specs,
  none of them `remove-setrange`. Moving them to the object's `var` section fixed it. That gap is
  **R68**.
- **The fixture apps are TENANT-scoped.** Republishing the test app with
  `Publish-BcContainerApp ... -scope Tenant -tenant default` is required; the Global-scope default
  cannot see the tenant-scoped target and fails its server-side recompile with `AL1024`.

## Expected verdict table (hand-computed)

Generated by walking `fixtures/sandbox-app/src/*.al` through every Tier 1 operator
(`packages/builtin-tier1`) and reasoning through `fixtures/sandbox-tests/src/SandboxTests.Codeunit.al`
by hand — see `packages/runner/itest/al-runner.itest.ts` and `bcdev.itest.ts`, which assert
exactly this table. If the fixture AL or tests ever change, recompute this table and update
both itest scripts in the same commit.

`empty-block` targets **every** non-empty `begin...end` block whose parent is a procedure,
trigger, or control-flow statement — including a procedure's own top-level body, not just
nested `if`/`while` blocks (confirmed by `packages/builtin-tier1/tests/empty-block.test.ts`).

| Procedure | Operator | Mutation | bcdev verdict | al-runner verdict | Why |
|---|---|---|---|---|---|
| `IsOverBudget` | conditional-boundary | `>` → `>=` | **killed** | **killed** | `OverBudgetDetected`'s equal-amounts case (100 vs 100) distinguishes `>` from `>=`. |
| `IsOverBudget` | return-value | `exit(Amount>Budget)` → `exit(not(...))` | **killed** | **killed** | Negates every case; the 101-vs-100 assertion catches it. |
| `IsOverBudget` | empty-block (body) | body → `begin end` | **killed** | **killed** | No `exit` call ⇒ always returns `false`; the 101-vs-100 assertion catches it. |
| `ClampPercent` | conditional-boundary ×2 | `<`→`<=`, `>`→`>=` | survived | survived | `ClampPercentRuns` calls `ClampPercent(50)` but asserts nothing on the result. |
| `ClampPercent` | negate-conditional | `or`→`and` | survived | survived | `ClampPercentRuns` asserts nothing, and its input (50) satisfies neither operand, so `or` vs `and` is unobservable there regardless. |
| `ClampPercent` | return-value | `exit(Value)`→`exit(0)` | survived | survived | Same — no assertion on the return value. |
| `ClampPercent` | empty-block (body) | body → `begin end` | survived | survived | Same. |
| `ApplyAudit` | void-method-call | removes `LogAudit(Amount)` call | survived | survived | `LogAudit` has no observable effect regardless of whether it runs. |
| `ApplyAudit` | empty-block (body) | body → `begin end` | survived | survived | Same. |
| `LogAudit` (local) | negate-conditional | `<>`→`=` | survived | survived | Neither branch of `LogAudit` produces an observable effect. |
| `LogAudit` (local) | empty-block (body) | body → `begin end` | survived | survived | Same. |
| `LogAudit` (local) | empty-block (if-block) | inner block → `begin end` | survived | survived | Same — this is the `// EmptyBlock target` comment site. |
| `DiscountedPrice` | conditional-boundary | `>=`→`>` | **no-coverage** | survived | No test calls `DiscountedPrice` at all. bcdev reports procedure coverage ⇒ uncovered; al-runner has `coverage:"none"` ⇒ runs anyway and survives. |
| `DiscountedPrice` | return-value | formula → `exit(0.0)` | **no-coverage** | survived | Same. |
| `DiscountedPrice` | empty-block (body) | body → `begin end` | **no-coverage** | survived | Same. |

**Totals (16 mutant sites):**

| Backend | killed | survived | no-coverage | mutation score |
|---|---|---|---|---|
| bcdev (`coverage:"procedure"`) | 3 | 10 | 3 | 3/13 = 23.1% |
| al-runner (`coverage:"none"`) | 3 | 13 | 0 | 3/16 = 18.75% |

Both backends must reproduce this table exactly, and two consecutive runs against the same
backend must be 100% verdict-identical (the determinism exit criterion — design.md §13).

Verify with `bun packages/runner/src/cli.ts run --project fixtures/sandbox-app --tests
fixtures/sandbox-tests --backend al-runner --dry-run` — it prints `16 mutant site(s)` and, per
file/line, exactly two `lethal.negate-conditional` sites (`SandboxLogic.Codeunit.al:10` in
`ClampPercent` and `:22` inside `LogAudit`).

## Coalescing (Layer 4.3)

Layer 4.3 replaced nested mutation guards (which grew `2^depth`) with a flat `if/else
if/else` dispatch chain per containment component, and collapsed session compilation from up
to 3 batched artifacts down to **one**: `planArtifacts` (`packages/runner/src/orchestrator.ts`)
now always returns a single artifact holding every mutant, since overlapping mutation sites
coalesce into one flat dispatch chain at compile time (`compileSchemataForFile`) instead of
needing separate compiles to keep them from interfering.

**Measured growth** (`bun run itest:growth`, `packages/runner/itest/growth.itest.ts` — no
server, no env gate, exercises only the schemata compiler against this fixture):

```
mutants:              16
original source:      957 bytes
instrumented source:  3440 bytes
fixed scaffolding:    1524 bytes (Mutation* files — constant per artifact, excluded from growth)
total emitted:        4964 bytes (5.19x incl. scaffolding)
source growth:        3.59x  (~155 marginal bytes/mutant)
LINEAR-ish: source growth is below one full copy per mutant
```

The measurement separates **fixed scaffolding** (`MutationSelector.Codeunit.al`,
`MutationControl.Codeunit.al`, `MutationActive.Table.al` — written once per artifact,
byte-identical regardless of mutant count) from **instrumented source**, which is what
actually grows with mutants. An earlier version of this itest summed both and reported
5.18x / 310 bytes-per-mutant; 31% of those bytes were the constant scaffolding, so the
"per-mutant" figure was not a marginal cost and would have distorted any future
cross-fixture growth curve. True source growth on this fixture is **3.59x**, at **~155
marginal bytes per mutant** (`(instrumented source − original) / mutants`).

## Running against an external environment tool (`envTool`)

Layer 6C. Spec: `docs/superpowers/specs/2026-07-26-custom-env-tool-design.md`. Plan:
`docs/superpowers/plans/2026-07-26-custom-env-tool.md`. Roadmap: R15.

Everything above this section assumes a BC container LethAL reaches directly (`server` +
`serverInstance` in the `bcdev` config, published to with `altool`). `envTool` is a second way to
reach a bcdev-backed environment: a project points LethAL at an **external CLI** that owns the
environment's lifecycle — create it, start it, tell LethAL where it is, publish an app to it, tear
it down — described entirely as config (a tool path plus argv templates). LethAL vendors no
tool-specific code; the first and only consumer today is Continia's `continia.exe`
(`U:/Git/CLI/continia.exe`). The tool only **provisions**. Every verdict still comes from the
unchanged fenced `RunMutant` path (Layer 5C-B1) via the bcdev backend — `envTool` never becomes a
new execution backend.

### The worked config

From the design spec, unchanged (this is the actual shape `validateEnvToolConfig`,
`packages/runner/src/env-tool.ts`, accepts — read it for the authoritative field list):

```jsonc
{
  "bcdev": {
    "company": "CRONUS Danmark A/S",
    "tenant": "default",
    "controlSymbolPath": "U:/Git/LethAL/extensions/lethal-control/lethal-control.app"
    // no server/serverInstance/username/password/baseUrl/port — envTool resolves those.
    // Hand-writing any of them alongside an envTool section is a validation error: declaring a
    // field in both envTool.reads and the bcdev section is "two sources, one value", which is how
    // two clients end up pointed at different endpoints.
  },
  "envTool": {
    "toolPath": "U:/Git/CLI/continia.exe",
    "cwd": ".",                                  // optional; default = project dir
    "env": { "CONTINIA_API_TOKEN": "${CONTINIA_API_TOKEN}" },
    "vars": { "profile": "bc28-w1", "envName": "lethal-{runId}" },
    "envId": "${CONTINIA_ENV_ID}",               // optional — absent means "create one"
    "timeoutSeconds": 900,
    "publishApps": ["U:/Git/LethAL/fixtures/sandbox-tests/out/tests.app"],

    "createEnv": {
      "command": ["env", "create", "--name", "{envName}", "--profile", "{profile}", "--json"],
      "reads":   { "envId": "id" }
    },
    "startEnv":  { "command": ["env", "start", "{envId}"] },
    "readyWhen": {
      "command": ["env", "get", "{envId}", "--json"],
      "reads":   { "status": "status" },
      "equals":  "Running",
      "pollSeconds": 20,
      "timeoutSeconds": 1800
    },
    "resolve": [
      { "command": ["env", "get", "{envId}", "--json"],
        "reads": { "baseUrl": "url", "expiresUtc": "expiresUtc" } },
      { "command": ["env", "users", "{envId}", "--json"],
        "reads": { "username": "0.username", "password": "0.password" } }
    ],
    "downloadSymbols": { "command": ["deps", "download", "{envId}", "{projectDir}", "--json"] },
    "publish":         { "command": ["publish", "{envId}", "{appFile}",
                                     "--sync-mode", "ForceSync", "--json"] },
    "deleteEnv":       { "command": ["env", "delete", "{envId}"] }
  }
}
```

```sh
# .env — gitignored. Bun loads .env from the PROCESS CWD ONLY, never from a subdirectory — there
# is no separate loader to write or maintain (packages/runner/src/cli.ts passes process.env
# straight into validateEnvToolConfig). `bun run itest:envtool` and a plain `lethal run` both
# invoke `bun` from the REPO ROOT, so this file belongs at the repo root, not "next to the
# project" — a .env dropped into fixtures/sandbox-app or any other project dir is silently never
# read. A real environment variable always wins over a .env entry.
CONTINIA_API_TOKEN=…
CONTINIA_ENV_ID=env-4711        # omit to make every run create and delete its own env
```

`${VAR}` is valid in any config **value** and is resolved from `process.env` after `.env` loads; an
unset (or empty) variable throws at validation time naming both the variable and the config field
that referenced it — before any process is spawned. `{placeholder}` is valid only inside a
`command` array element: the closed set is `{envId}`, `{appFile}`, `{projectDir}`, `{testDir}`,
`{packageCache}`, `{runId}`, plus whatever the config's own `vars` map declares.

### Flags

- **`--keep-env`** — suppresses `deleteEnv` for an environment this run created. A no-op (with a
  console warning) when the config has no `envTool` section, or when `envId` came from config (a
  config-supplied environment is never deleted regardless of this flag). Refused outright at parse
  time together with `--backend al-runner`, since al-runner has no environment to keep.
- **`--allow-expiring-env`** — overrides the expiry refusal below. Also refused together with
  `--backend al-runner`.

### Lifecycle, in order (`startEnvToolSession`, `packages/runner/src/env-tool-session.ts`)

Resolution runs exactly **once per process**, before `buildBackend`, `leaseSessionFor` and
`resourceIdentityFor` all consume its output — a naive per-seam re-resolve would, in create-mode,
provision a second and third environment.

1. **envId** — taken from config, or `createEnv` runs and `envId` is read from its JSON output.
2. **start + wait** (create-mode only) — `startEnv` runs, then `readyWhen` polls (`pollSeconds`,
   default 20s) until its `status` read equals `readyWhen.equals`, or `timeoutSeconds` (default
   1800s) elapses. Every status transition is logged — a silent six-minute wait is indistinguishable
   from a hang.
3. **resolve** — each block in `resolve` runs in order; their `reads` outputs merge into one map.
   `baseUrl`, `username` and `password` must end up produced by some block, or validation fails
   before anything spawns. If the config declares `requireStatus` (reuse-mode only), the resolved
   `status` is checked here, before anything is published — see "A reused environment that is not
   ready" below.
4. **expiry check** — if `resolve` produced `expiresUtc` and it falls within the next hour, the
   session refuses to start (see "Expiry: refuse, do not warn" below) unless `--allow-expiring-env`
   was given.
5. **derive `server` / `serverInstance` / `port`** from the resolved `baseUrl` (unless a block
   declared explicit `reads` entries for `server`/`serverInstance`) — see "The port trap" below.
6. **symbols** — `downloadSymbols` runs if `bcdev.packageCachePath` is absent; its output populates
   `<projectDir>/.alpackages`, which `{packageCache}` expands to.
7. **prepublish** — every entry in `publishApps` is published, in declared order, through the
   `publish` template (the test app and its dependencies — see "The test app problem" below).
8. **control app** — `HarnessVerifier` checks first; `lethal-control.app` is published ONLY if it
   does not already answer correctly, then verified again. Deliberately verify-before-publish: the
   machine-global lease (5C-B1) lives in the control app's own tables, and republishing runs its
   install/upgrade codeunits, which would disturb a concurrent session's lease and
   `serverGeneration` on a shared long-lived environment.
9. **per batch** — the instrumented `.app` publishes through the same `publish` template;
   `DeploymentVerifier` confirms the artifact id that actually landed (unchanged bcdev semantics).
10. **per mutant** — LethAL's fenced `RunMutant` OData call. Completely unchanged code; `envTool`
    never touches this path.
11. **teardown** — `deleteEnv` runs only if this session created the environment, and only if
    neither `--keep-env` nor a quarantine applies (a quarantined session keeps the environment on
    purpose — deleting it would destroy the evidence of what wedged). A failing `deleteEnv` is
    logged with the manual delete command and never changes the session's report or exit code.

The tool is spawned a handful of times per session, never once per mutant, so its latency does not
multiply across the mutant set.

### The test app problem

LethAL's normal contract is that the test app is already on the server — publishing it is the
user's own workflow, not LethAL's job. That is impossible for an environment that did not exist
until LethAL created it: a fresh Continia environment from a BC profile carries no user test app, so
a create-mode run would discover tests from source and then fail every one of them at execution.
`publishApps` closes that gap — an optional ordered list of pre-built `.app` paths published at
session start (step 7 above), before the control app. **Create-mode requires it**: a config with no
`envId` and no `publishApps` is a validation error naming the reason. Reuse-mode ignores it if
absent.

### A reused environment that is not ready (R34)

A long-lived environment idles. Observed live 2026-07-26: the gate environment had drifted to
`Stopped`, and LethAL resolved it perfectly happily — `env get` still answers, the URL is still
derived from the id — then published into a dead endpoint and died minutes later inside the
transport with an error that named nothing useful. **LethAL refuses instead of starting it**:
the environment belongs to whoever configured it, and silently starting someone else's environment
(billing it, disturbing whoever else is on it) is worse than stopping with a clear message.

Opt in with a `status` read on a `resolve` block plus the value that means ready:

```jsonc
{
  "envTool": {
    "envId": "${CONTINIA_ENV_ID}",
    "resolve": [
      { "command": ["env", "get", "{envId}", "--json"],
        "reads": { "baseUrl": "url", "expiresUtc": "expiresUtc", "status": "status" } },
      { "command": ["env", "users", "{envId}", "--json"],
        "reads": { "username": "0.username", "password": "0.password" } }
    ],
    "requireStatus": { "equals": "Running" }   // ← the TOOL's word for ready, not LethAL's
  }
}
```

A run against a stopped environment now ends before the first publish with:

```
environment env-4711 reports status "Stopped", not "Running" (envTool.requireStatus.equals) —
refusing to publish into an environment that is not ready. LethAL will not start an environment
it does not own: start it with your own environment tool, wait until it reports "Running", then
re-run.
```

Both halves are config, deliberately: `Running` is Continia's vocabulary, and nothing in LethAL's
source knows it. A tool whose ready state is spelled `Active` writes `"equals": "Active"`, and
`${VAR}` works here like anywhere else.

Rules `validateEnvToolConfig` enforces up front, before any process is spawned:

- **Entirely optional.** A config with no `requireStatus` behaves exactly as it did before — no
  status is read, nothing is checked. Every config written before this existed keeps working.
- **The status must come from `resolve`.** An expectation that nothing feeds is a config error, not
  a check that silently passes. A `status` read on `readyWhen` does not count: that block never
  runs for a reused environment, and is rejected naming exactly that.
- **Reuse-mode only.** In create-mode LethAL starts the environment itself and `readyWhen` already
  polls it to ready, so `requireStatus` there is rejected rather than silently inert. That also
  means the dual-purpose config above (create blocks *and* an `envId`) cannot carry both a
  `readyWhen` status read and a `resolve` status read — one key, one producer — so a config that
  wants this protection is a reuse-mode config.

### The measured provisioning facts — why this shape exists

Spiked 2026-07-26 against the real Continia portal, creating and deleting one DK BC 28.0
environment:

| phase | result |
|---|---|
| `env create` | returns promptly, status **`Draft`** — inert, nothing listening |
| `env start` | ~2 s, prints "start requested" — also async |
| `Draft → Starting` | ~1 s after the start request |
| `Starting → Running` | **390 s** |
| BC endpoint answers `200` | **391 s** after the start request |

Status vocabulary: `Draft`, `Deploying`, `Starting`, `Running`, `Stopped` — `env start`/`env stop`
are PATCHes of that field. **`Deploying` was not in the first measurement** and only appeared during
the create-mode gate run of 2026-07-26 (`Deploying → Starting → Running`), so treat this list as
observed rather than exhaustive: `readyWhen` matches on the ready value (`Running`) and polls
through whatever else the portal reports, which is why it is written as an equality test on the
target rather than a state machine over the transitions. A fresh environment already contains the
companies `CRONUS Danmark A/S` and `My Company`. The environment's URL is `{origin}/{envId}`,
derived from the id, so a stop/start cannot move it.

This is why `startEnv` and `readyWhen` are **mandatory in create-mode**: publishing to a `Draft`
environment fails against a dead endpoint. It is also why reuse (`envId` supplied in config or via
`${CONTINIA_ENV_ID}`) is the default posture for repeat runs — ephemeral (create-mode) costs ~6.5
minutes before a single mutant runs, every time.

### The port trap — not Continia-specific

bc-dev-mcp's OnPrem dev-endpoint resolution computes
`port = c.port ?? (u.port ? Number(u.port) : 7049)` (`bc-dev-mcp/src/core/urls.ts`) — it falls back
to port 7049 whenever neither the connection URL nor an explicit `port` override supplies one.
Embedding `:443` into the server string does not help: the WHATWG URL API normalizes away a default
port (`new URL("https://host:443").port === ""`), so only a genuine, separate `port` field reaches
bc-dev-mcp's own override. Continia's hosted portal fronts every environment through a single HTTPS
reverse proxy, path-routed by environment id, with nothing listening on 7049 there — so
`bcdev_status` fails (`Dev endpoint unreachable at https://host:7049/...`) unless `port` is
supplied, and with `port: 443` it succeeds.

This is a general trap, not a Continia quirk: **every port-less HTTPS server** silently falls back
to 7049 unless something derives the real port. LethAL now derives it itself: `deriveMcpPort`
(`packages/runner/src/env-tool-session.ts`) takes the resolved `baseUrl`'s explicit port if the URL
text carries one, else 443 for `https:` / 80 for `http:`, and passes it as `BcDevConfigSection.port`
— a field that exists for exactly this reason and is threaded through
`BcDevMcpBackend.connectionParams()`. Without it, LethAL cannot reach any path-routed HTTPS BC
portal, Continia or otherwise.

The live probe against a real Continia environment (Task 1 of the plan, corrected 2026-07-26 after
an earlier cold-start-confounded pass wrongly recorded `"none"`) confirmed `bcdev_status` connects
and returns coverage once given `port: 443`:
`{"webApiVersion":"7.0","runtimeVersion":"17.0","supportsTestRunning":true,"supportsCoreSignalR":true,"supportsSourceDownload":true}`
— full **`coverage: "procedure"`** fidelity, identical to a container run. A `coverage: "none"`
fallback mode still exists in the backend (constructor input, default `"procedure"`) as a documented
contingency for some future `envTool` target bc-dev-mcp genuinely cannot reach, but this deployment
does not need it.

### Expiry: refuse, do not warn

If a config declares a `reads` entry for `expiresUtc` and the environment expires within the hour,
`startEnvToolSession` refuses to start rather than warning, unless `--allow-expiring-env` overrides
it. An environment that expires mid-run does not merely fail: the in-flight call becomes
`in-flight-unknown` and durably quarantines the tier, which then needs an operator
`clear-quarantine`. Refusing costs a re-run; not refusing costs a manual recovery.

### Recovering a leaked environment

A created `envId` is written to `~/.lethal/env-state/<runId>.json` **before** anything else runs —
a stable location, not session scratch, because a crashed process cannot print and a `mkdtemp`
directory cannot be found afterwards. The file records the `envId`, the exact resolved `deleteEnv`
argv, and the start time (`recordCreatedEnv`, `env-tool-session.ts`), and is removed once
`deleteEnv` actually succeeds. Every `lethal run` against an `envTool` config scans this directory
at session start and `console.warn`s each stale entry it finds, naming the envId and the exact
delete command already recorded (`warnStaleEnvRecords`, `env-tool-session.ts`); removal itself is
manual and deliberate, since LethAL cannot know whether another session still owns the
environment.

The one window this file cannot close: a crash **during** `createEnv` itself, before the
environment's id is ever read back into LethAL — nothing has been written yet because the id does
not exist until the call returns. Recovery for that case is the tool's own listing command
(`continia env list`), not LethAL.

Honest reading: this is **one data point on one small fixture**, not a growth curve. A single
measurement cannot by itself distinguish "linear in mutant count" from "some other sub-2^depth
curve" — that needs multiple fixtures at varying mutant counts/nesting depths plotted against
each other, which this task does not attempt. What it *does* show concretely: 16 mutants
produced 3.59x source growth (5.19x counting the fixed scaffolding), not 16x (one full source
copy per mutant) and nowhere near the `2^depth` blowup the old nested-guard scheme would have
produced once two or more mutants shared a containing block — coalescing is emitting one
dispatch chain per component, not one duplicated copy of the file per mutant.

**Known limitation (final review I4, recorded, deliberately not fixed on this branch):
compile-failure bisection can never trigger on the al-runner backend.** `AlRunnerBackend.
deploy()` only copies the instrumented directory — al-runner compiles per `run()` call — so a
bad emitted branch (a broken custom operator, say) never fails at deploy time there. It
surfaces instead as every baseline test erroring, `greenTests.length === 0`, and every mutant
recorded `error` with note "no green baseline tests": no bisection, no named culprit. The
design spec §6 blast-radius bound therefore holds only for compile-at-deploy backends
(bcdev). Whether to bisect the baseline-red path too, add a compile probe to al-runner's
deploy, or accept the limitation permanently is a scope decision deferred to the maintainer.

**Verdicts unchanged, verified live (2026-07-19)** against both backends, using the real
`al-runner.exe` binary and a real BC dev server — exactly the known-good tables from before
this layer:

| Backend | killed | survived | no-coverage | score |
|---|---|---|---|---|
| al-runner | 3 | 13 | 0 | 18.8% |
| bcdev | 3 | 10 | 3 | 23.1% |

`LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` and `LETHAL_ITEST_BCDEV=1 bun run
itest:bcdev` both print their respective `... itest: PASS` (each runs the session twice and
asserts the two runs are verdict-identical, the determinism exit criterion, in addition to
matching the table above). Coalescing is a pure compile-shape change: one artifact instead of
three, same mutants, same kills, same survivors.

**Environmental hiccup during this verification, not a coalescing bug:** the first live bcdev
attempt failed every mutant with `error` (bisected to a single mutant every time — an artifact
of `bisectFailingMutant` always narrowing to index 0 when the same failure reproduces
regardless of subset, not evidence of a real per-mutant compile defect; since the final-review
I3 fix, bisection confirms the candidate before naming it — it must fail alone AND the
complement must compile without it — and reports this shape as environmental instead). Root cause: this
task's `lethal.sqlite` had been reset, restarting `runId` at 1, while the dev server already
had `1.0.27.3` installed from earlier live verification — every republish attempt at a lower
version was rejected by BC (`Cannot install the extension ... because a newer version 1.0.27.3
was already installed`), exactly the known limitation documented above under "App version
monotonicity". Confirmed via a manual `alc.exe` compile of the exact instrumented directory
(succeeded, exit 0, valid `.app`) and a manual `altool publishapp` of that same `.app` (failed
with the version message above) — the compiler and the coalesced emission were never at fault.
Fixed by bumping the results DB's `runs` autoincrement sequence past the server's installed
run, per the documented remedy ("start from a higher runId"); both live checks above are from
after that fix.

### Fixed: parenthesized-operand logical expressions were silently skipped

Until 2026-07-18 the fixture produced 15 sites, not 16, because `negate-conditional` never
targeted `ClampPercent`'s `(Value < 0) or (Value > 100)`.

Root cause: both `negate-conditional` and `conditional-boundary` located their operator via
`node.childForFieldName("operator")`, and tree-sitter-al surfaces that field from a
**descendant** when the operands are parenthesized — for `(V < 0) or (V > 100)` it returns the
nested `<`, not the top-level `or`. The `namedChildren` fallback missed it too, because the two
node kinds disagree about what is "named":

- `comparison_expression` `A = 0` → named `[identifier, comparison_operator, integer]`
- `logical_expression` `A and B` → named `[identifier, identifier]` (`and` is **anonymous**)

`targets()` then tested `<` against `LOGICAL_FLIP` (only `and`/`or`), found nothing, and skipped
the site silently.

Fix: `findOperatorToken` in `packages/builtin-tier1/src/mutate-helpers.ts`, shared by both
operators. It reads `node.children` — which includes anonymous tokens, making both kinds
uniformly `[left, operator, right]` — and takes the middle child, so it can only ever return the
node's own operator, never a descendant's. Regression tests live in
`tests/negate-conditional.test.ts` and `tests/conditional-boundary.test.ts`.

## Server preconditions for the bcdev backend (verified live 2026-07-18)

Running LethAL against a real BC server has operational preconditions that unit tests
cannot express. All four below were discovered by actually running `itest:bcdev`, each
confirmed by an error message from BC itself.

**1. The target app must NOT be published Global or PerTenant.**
`altool publishapp` posts to `/BC/dev/apps`, i.e. the *Development* scope. If a copy of
the same app id is already published Global, BC refuses outright:

> The extension could not be deployed because it is already deployed as a global
> application or a per tenant application.

Unpublish any Global copy first (`UnPublish-BcContainerApp -name "<app>" -unInstall -force`).

**2. The test app must already be on the server, and it needs the target app's symbols
to compile.** LethAL deploys only the instrumented *target* app; publishing the test app
is the user's own workflow, not LethAL's job. Server-side compilation of the test app
cannot see a dev-scoped dependency's symbols, so publish both from local builds instead:

```powershell
# compile the target, drop its .app into the test project's symbol cache
alc /project:<target> /packagecachepath:<target>\.alpackages /out:<tests>\.alpackages\<app>.app
alc /project:<tests>  /packagecachepath:<tests>\.alpackages  /out:<tmp>\tests.app
# then dev-publish BOTH via altool (same scope, so they resolve each other)
altool publishapp <tests>\.alpackages\<app>.app --server ... --authentication UserPassword
altool publishapp <tmp>\tests.app              --server ... --authentication UserPassword
```

**3. App version monotonicity.** The instrumented app is published as
`1.0.<runId>.<batchIdx>`. BC rejects any version lower than the one installed:

> Cannot install the extension ... because a newer version 1.0.2.2 was already installed.

`runId` comes from the results DB, so **the bcdev itest uses a persistent
`lethal.sqlite`, not `:memory:`** — an in-memory store restarts `runId` at 1 every
invocation and republishes below the previous run's high-water mark, failing every
deploy. Known limitation: a fresh results DB pointed at a server that already carries a
higher version will fail the same way; drop the stale app or start from a higher runId.

**4. Test codeunits must not carry `TestIsolation`** — see the section above (AL0223).

## Deployment identity (Layer 5A)

Layer 5A made deployment an object with an identity: compile once to an immutable,
content-addressed artifact carrying a random `artifactId` and a monotonic `appVersion`, publish
as a separate step, and verify what actually landed via a `MutationControl_Identity` web-service
action — instead of trusting `altool`'s exit code alone. See
`docs/superpowers/specs/2026-07-19-layer-5a-deployment-identity-design.md` for the full design
and `packages/runner/itest/stale-publish.itest.ts` for the two live probes below
(`LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish`).

### Version scheme

`<sourceMajor>.<sourceMinor>.<daysSinceUnixEpoch>.<secondsOfDay ÷ 2>` (`app-version.ts`).
Major/minor come from the target project's own `app.json`; the last two components are
clock-derived and monotonic by construction — there is no stored counter to lose or reset. A
session-scoped `lastIssued` value guarantees strict increase even when the 2-second clock
resolution doesn't advance between two artifacts, or steps backwards.

**The original bug is fixed:** the pre-5A scheme stamped `1.0.<runId>.<batchIdx>`, where `runId`
came from the project-local `lethal.sqlite`; deleting that file reset `runId` to 1 and broke
publishing against any container already holding a higher version (see "Server preconditions"
item 3 above). Verified live 2026-07-20: deleted `fixtures/sandbox-app/lethal.sqlite`,
re-ran `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` immediately afterward, and publishing
succeeded with no version conflict — `bcdev itest: PASS`, verdict table unchanged:

| Backend | killed | survived | no-coverage | score |
|---|---|---|---|---|
| bcdev | 3 | 10 | 3 | 23.1% |
| al-runner | 3 | 13 | 0 | 18.8% |

Clock-derived versions have no stored counter, so there is nothing left for deleting the results
DB to reset.

### Stale-publication probes (design spec §9) — live results, 2026-07-20

**Probe A — deterministic stale dispatch: PASS.** Reserved and compiled artifact A at version
`V` without publishing it; reserved, compiled, published and verified artifact B at `V+1`; then
published A. Observed: A's `altool publishapp` failed, and BC's own rejection named B's version
verbatim (`Cannot install the extension LethAL Sandbox App by LethAL <V> because a newer version
<V+1> was already installed.`) — `parseVersionConflict` correctly extracted `V+1`, matching B's
compiled version exactly. `MutationControl_Identity` continued to report B's artifact id
afterward, and a **fresh live test run** (baseline `OverBudgetDetected` pass with no mutant
active → activate B's own `IsOverBudget` return-value mutant → same test fails → clear → passes
again) confirmed the server was genuinely running B's code throughout, not just that one OData
call returned a particular string.

**Probe B — concurrent race: FAILED (Layer 5A's hard-stop condition).** Compiled A at `V` and B
at `V+1`, then started both publications concurrently (two independent, real `altool.exe`
processes racing the actual server, not simulated). Round 1 of the planned 3:

- Both `altool publishapp` calls returned. B: `exitCode 0` (apparent success). A: `exitCode 1`,
  with BC's own message revealing what actually happened server-side —
  `Publishing failed due to 'Cannot install the extension LethAL Sandbox App by LethAL <V>
  because a newer version <V+1> was already installed.'. The original extensions could not be
  restored due to Cannot install the extension LethAL Sandbox App by LethAL <V_prev> because a
  newer version <V+1> was already installed.. Extensions that were previously installed but
  could not be reinstalled. These extensions should be manually reinstalled. ... LethAL Sandbox
  App by LethAL / LethAL Sandbox Tests by LethAL`.
- Post-hoc, `MutationControl_Identity` returned **HTTP 404** — confirmed non-transient by
  re-checking 3 times over ~10 seconds. A raw test-run probe against whatever was actually
  running returned `outcome: "skip"` for both fixture tests. **Both the target app AND its
  dependent test app ended up completely uninstalled** — not "A became final instead of B," a
  strictly worse outcome neither app installed at all.

**Root cause:** `altool publishapp --schemaupdatemode ForceSync`'s own replace protocol appears
to be uninstall-old-then-install-new, with a fallback to reinstall the original on failure. Under
a genuine concurrent race, A's publish lost the version check, and its own fallback attempt to
*restore the app it had just uninstalled* ALSO lost the version check (a newer version — B — had
landed in the interim) — leaving nothing installed. LethAL's monotonic versioning worked exactly
as designed at the level BC exposes to it (`Identity()` never once reported A as final; the
downgrade rejection fired correctly both times); the hazard is a race INSIDE BC's own
replace/rollback machinery that LethAL's client-side version scheme cannot see or prevent,
because it happens across two independent OS processes with no shared lock. This is exactly why
spec §9 requires Probe B (a real concurrent race) separately from Probe A (sequential) — this
failure mode is invisible to any test that serializes the two publishes.

Per spec §9 / the task's explicit instruction, subsequent rounds (2 and 3 of the planned 3) were
**not** attempted after round 1 reproduced the hard-stop condition — re-running a known-destructive
race against shared, live infrastructure would not change the verdict and risks compounding
damage. **Conclusion: monotonic versioning alone is not a sufficient deployment-order barrier
for this toolchain under concurrent publishes.** Per design spec §9, Layer 5A's live exit
criteria are not met as currently scoped; closing this gap needs either client-side serialization
of publishes to the same target (a mutex around `ContainerDeployer.publish()` per app/container —
plausibly a 5C/5D concern, since it's adjacent to the fencing work already deferred there) or a
different, non-racy publish strategy that doesn't depend on BC's own replace-atomicity.

**Recovery procedure exercised live:** the target app self-heals on the next normal (sequential,
non-racing) `lethal` publish — no manual step needed. The dependent test app does **not**
self-heal (LethAL never publishes it — see "Server preconditions" item 2 above) and needed a
manual `alc`/`altool` republish following that same section's recipe. After recovery,
`LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` passed cleanly with the unchanged verdict table.

### Task 8b: per-container publish serialization closes the Probe B hazard

BC's `altool publishapp --schemaupdatemode ForceSync` replace protocol is **not
concurrency-safe** — the root cause above is a race inside BC's own server-side
uninstall-then-reinstall machinery, not a LethAL version-scheme defect. Task 8b's fix is
narrowly client-side: **LethAL now serializes `ContainerDeployer.publish()` calls per canonical
container key, in-process**, so this process itself never dispatches two overlapping `altool`
processes at the same container.

`canonicalContainerKey` (`packages/runner/src/publish-serializer.ts`) normalizes
`server`/`serverInstance`/`tenant` into one identity string (lowercased, trailing-slash-stripped
server; omitted tenant treated as `"default"`) so two configs naming the same physical container
collapse to the same lock. `serializePublish` holds a **process-global, module-level**
`Map<string, Promise<void>>` of queue tails keyed by that identity — deliberately not attached
to any single `ContainerDeployer` instance, so two deployer instances constructed separately but
pointed at the same container still serialize against each other, while publishes to
*different* containers keep running fully concurrently (required for the later container-pool
layer). `ContainerDeployer.publish()` wraps its existing body (digest re-check + `altool` spawn,
unchanged) in this serializer; a rejecting publish still releases the lock for the next queued
call on that key, so one failed publish can never deadlock a later one.

**Scope — stated limitation, not closed here:** this is an in-process mutex. It guarantees no
two publishes issued by *this* LethAL process ever overlap on one container. It does **not**,
and structurally cannot, make two separate LethAL *processes* (e.g. two terminal sessions, or
two CI jobs) racing the same container safe — nothing here is visible outside this process's
memory. That cross-process case remains **Layer 5C's machine-global lease**, deliberately
deferred, not addressed by this task.

**Live re-verification, 2026-07-20**, `LETHAL_ITEST_BCDEV=1 bun run itest:stale-publish` against
the same real container (`http://Cronus281`) that reproduced the hard-stop above — both probes,
every round, verbatim:

```
=== Probe A: deterministic stale dispatch ===
  compiled A: version=1.0.20654.13942 id=c2ac6c852d86d72ef38e4fd15f8f5429 (NOT published yet)
  compiled B: version=1.0.20654.13943 id=1601a7064002c91a2e92b2a6a02b38d0
  published + verified B
  fresh-behaviour probe confirms B (baseline pass -> mutant fail -> clear pass)
  A's publish rejected as expected: altool publishapp failed (exit 1):
Probe A: PASS

=== Probe B: concurrent race (3 rounds) ===
  round 1: A=1.0.20654.13945/9a89d801f66306a02cc60808bbb47c3e B=1.0.20654.13946/1ea794d7deff82a2c665cebfe051df9d, publishing concurrently...
    publish results: [{"who":"A","ok":true},{"who":"B","ok":true}]
    serializer held publishes one-at-a-time (max in-flight: 1)
  round 1: PASS — B is final, A never was, fresh behaviour confirms B
  round 2: A=1.0.20654.13947/778c79b84a248ae7b4e591ed0ee3fab0 B=1.0.20654.13948/da2323b995eb126c8fc3eb0de1a7c86e, publishing concurrently...
    publish results: [{"who":"A","ok":true},{"who":"B","ok":true}]
    serializer held publishes one-at-a-time (max in-flight: 1)
  round 2: PASS — B is final, A never was, fresh behaviour confirms B
  round 3: A=1.0.20654.13949/2b732bb575b3286c8ec1a124c8a2ca3c B=1.0.20654.13950/50b76cc98d3df231a6facd3ed57c4d9a, publishing concurrently...
    publish results: [{"who":"A","ok":true},{"who":"B","ok":true}]
    serializer held publishes one-at-a-time (max in-flight: 1)
  round 3: PASS — B is final, A never was, fresh behaviour confirms B
Probe B: PASS

stale-publish itest: PASS (Probe A + Probe B)
```

`maxInFlight` (an in-flight counter wrapped directly around the real `altool.exe` OS-process
spawn — the same counter-based technique the unit tests use, never wall-clock timing) never
exceeded 1 in any round, proving the mechanism (the serializer actually held the two publishes
one-at-a-time), not just the outcome (B ending up final). Unlike the original failing run, both
`publish()` calls in every round now resolve successfully (`ok:true`/`ok:true`) — because the
two `altool` processes no longer race each other server-side, A installs cleanly first, then B
installs cleanly as a strictly higher version, with no uninstall/reinstall collision. Immediately
after, `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` reproduced the unchanged verdict table:

| Backend | killed | survived | no-coverage | score |
|---|---|---|---|---|
| bcdev | 3 | 10 | 3 | 23.1% |

Unit coverage (`packages/runner/tests/publish-serializer.test.ts`) asserts serialization with a
shared in-flight counter, never timing: N concurrent same-key calls never let the counter exceed
1; concurrent different-key calls let it reach ≥2 (proving different containers are NOT
serialized against each other); a throwing `fn` still releases the lock so a later same-key call
runs, not deadlocked; and `canonicalContainerKey` collapses `http://Cronus281/` + `BC` +
`"default"` and `http://cronus281` + `BC` + an omitted tenant to the identical key. Mutation
red-check: temporarily replacing `serializePublish`'s body with a direct `fn()` call (no gating)
turned the same-key "max in-flight ≤ 1" test red (observed `counter.max` of 5, not 1) before the
fix was restored — confirming the test actually exercises the serialization, not passing for the
wrong reason.

### A second, independent bug this task's live run found and fixed

While diagnosing Probe A's first failed attempt, a genuine defect surfaced in
`ContainerDeployer.publish()` (`packages/runner/src/publisher.ts`): on a real `altool` failure,
BC's machine-parseable rejection text (the exact string `parseVersionConflict` looks for) lands
on **stdout**, while `altool` prints only a generic one-line wrapper
(`Publish failed: Publish operation failed. Check the output for details.`) to **stderr**. The
original code built its error message from `res.stderr || res.stdout` — since stderr is
non-empty on every real failure, stdout (carrying the actual detail) was silently discarded.
This meant `orchestrator.ts`'s version-conflict retry-once path (Task 6) could never actually
trigger against a real server: `parseVersionConflict` never saw the text it needed. Confirmed
live 2026-07-20 by spawning `altool` directly and capturing both streams separately. None of the
existing unit tests caught this because they construct the fake backend's error string already
containing the right text, never exercising the real stdout/stderr split. Fixed by including
both streams in the thrown error; regression test added
(`packages/runner/tests/artifact.test.ts`).

## `launch.local.json` convention

`fixtures/sandbox-app/.vscode/launch.json` is committed with placeholder server details —
it documents the shape without leaking a real environment. To actually launch/debug against
a real dev server:

1. Copy `launch.json` to a sibling `launch.local.json` in the same `.vscode/` folder.
2. Fill in the real `server`, `serverInstance`, `tenant`, `environmentType`, etc.
3. `launch.local.json` is gitignored — it never gets committed.

## `lethal.config.json` / `lethal.config.local.json`

The `lethal` CLI (`packages/runner/src/cli.ts`) reads a JSON config file (`--config`,
default `<project>/lethal.config.json`) for backend connection details that don't fit as
CLI flags:

```jsonc
{
  "bcdev": {
    "mcpCommand": ["bun", "x", "bc-dev-mcp"],
    "server": "http://REPLACE_ME",
    "serverInstance": "REPLACE_ME",
    "tenant": "default",
    "company": "CRONUS",
    "username": "REPLACE_ME",
    "password": "REPLACE_ME",
    "packageCachePath": "C:/path/to/.alpackages",
    // Optional: extra env vars for the spawned bc-dev-mcp server process. bc-dev-mcp reads
    // credentials from BC_DEV_USER/BC_DEV_PASSWORD env vars, not tool params — and the MCP
    // SDK's StdioClientTransport only inherits a fixed OS-level allowlist by default (PATH,
    // USERPROFILE, ...), silently dropping anything else. Without this, bc-dev-mcp fails
    // preflight with "Missing connection settings: username (BC_DEV_USER env var or tool param)".
    "env": {
      "BC_DEV_USER": "REPLACE_ME",
      "BC_DEV_PASSWORD": "REPLACE_ME"
    }
  },
  "alRunner": {
    "alRunnerPath": "al-runner",
    "packagesDir": "C:/path/to/.alpackages"
  }
}
```

`alcPath` (R43) and `altoolPath` (R64) are optional `bcdev` fields, not required ones — with
neither set, the CLI locates the newest `ms-dynamics-smb.al-*` VS Code extension under
`~/.vscode/extensions` automatically and takes the `bin/` build matching the host platform
(`defaultAlToolPaths()`). Set one when the discovered tool is the wrong BUILD for your server
(`alcPath`) or cannot publish non-interactively (`altoolPath`); set both when there is no
extension to discover. The bc-dev OData base URL is derived from `server` + `serverInstance`
rather than being its own field, with port **7048** injected regardless of what (if any) port
`server` carries (`odataBaseUrl()`, `packages/runner/src/cli.ts`) — verified against a real BC
server 2026-07-18: `server`/`serverInstance` are also used unqualified for bc-dev-mcp's own
dev-service protocol (port 7049 by default), but the OData/web-service endpoint
`MutationControlClient` talks to lives on 7048, not 7049 or 80. `tenant`, when present, is also
forwarded to every OData call as `?tenant=...` — without it, Basic auth fails outright (401)
even with a correct username/password, on this container's single "default" tenant included.

For real credentials, create a gitignored `lethal.config.local.json` next to `app.json` with
the same shape and point `--config` at it. `packages/runner/itest/bcdev.itest.ts` reads this
file (plus `launch.local.json` for `environmentType`/`environmentName`) directly — it is not
routed through the CLI.

## Running the fixture manually

```bash
# Dry run — no deploy/run, just prints the batch/mutant table
bun packages/runner/src/cli.ts run --project fixtures/sandbox-app --dry-run

# Against al-runner (needs al-runner installed — see CI note below)
bun packages/runner/src/cli.ts run \
  --project fixtures/sandbox-app --tests fixtures/sandbox-tests \
  --backend al-runner --config fixtures/sandbox-app/lethal.config.local.json

# Against a live bc-dev dev server
bun packages/runner/src/cli.ts run \
  --project fixtures/sandbox-app --tests fixtures/sandbox-tests \
  --backend bcdev --config fixtures/sandbox-app/lethal.config.local.json
```

## Parallel execution

`lethal run` accepts `--workers <n>` (default 1) and `--compile-concurrency <n>` (default
`min(workers, 4)`), wired straight through to `SessionConfig.workers`/`compileConcurrency` —
see `packages/runner/src/cli.ts`'s `parseCliConfig`/`buildBackend`/`runFromCli`. Each al-runner
worker gets its own scratch directory (`<scratchRoot>/worker-<i>`), so its private copy of the
batch's instrumented sources (`AlRunnerBackend.deploy`) never collides with another worker's.

**`--backend bcdev --workers > 1` is rejected outright**, not given per-worker isolation: mutant
activation against a real BC server is a single server-side record (`MutationControl_SetActive`),
shared by every worker's `BcDevMcpBackend` instance — concurrent workers would call `setActive()`
against that same record, so worker B's activation can clobber worker A's while A's test is still
in flight, silently attributing a result to the wrong mutant. The echo check `setActive()` does on
its own response can't catch this, since it only validates against what THAT call wrote, not a
later overwrite by another worker. Real parallelism against the authoritative backend needs
per-container isolation (deferred to the container-pool layer); `parseCliConfig` throws before
`runFromCli` ever starts a session:

> `--workers > 1 is not supported with --backend bcdev: mutant activation is a single server-side
> record shared by all workers, so concurrent workers would overwrite each other's active mutant.
> Parallel execution on a real BC server needs per-container isolation (deferred to the
> container-pool layer).`

```bash
bun packages/runner/src/cli.ts run \
  --project fixtures/sandbox-app --tests fixtures/sandbox-tests \
  --backend al-runner --config fixtures/sandbox-app/lethal.config.local.json \
  --workers 4 --compile-concurrency 2
```

Verified live against the real al-runner binary (2026-07-19), running the full fixture at
`--workers 1`, `2`, and `4` in turn **with `"serverMode": true` in `lethal.config.local.json`**
(the warm-process transport, `ServerTransport` — see `al-runner-transport.ts`). **Verdicts were
identical at every worker count** — the exact known-good table (killed 3, survived 13,
no-coverage 0, score 18.8%) — confirming the per-worker sharding (`shardEvenly`) and isolation
are correct, not just plausible:

| Workers | Wall clock | killed | survived | no-coverage | score |
|---|---|---|---|---|---|
| 1 | 1m10.2s | 3 | 13 | 0 | 18.8% |
| 2 | 1m13.6s | 3 | 13 | 0 | 18.8% |
| 4 | 0m59.0s | 3 | 13 | 0 | 18.8% |

**A reader reproducing these numbers with `serverMode` absent (or `false`) — the CLI's own
default transport — will see roughly 3x slower wall clocks; that is expected, not a
discrepancy.** `serverMode: true` keeps one al-runner process warm across every test in the
session; the default one-shot transport (`OneShotTransport`) pays a fresh process spawn plus a
full recompile on every single test invocation. Verified live (2026-07-19) at the same three
worker counts, one-shot transport, `serverMode` explicitly `false`:

| Workers | Wall clock | killed | survived | no-coverage | score |
|---|---|---|---|---|---|
| 1 | 3m37.4s | 3 | 13 | 0 | 18.8% |
| 2 | 2m44.0s | 3 | 13 | 0 | 18.8% |
| 4 | 2m01.0s | 3 | 13 | 0 | 18.8% |

(The `--workers 1` one-shot figure is the Step 6 live gate's baseline run, `real 3m37.381s` — see
`.superpowers/sdd/task-4-report.md` — not re-measured here; `--workers 2` and `4` were run for
this hardening pass specifically to close the gap the original table left, since it verified
only the server-mode transport at every worker count and only the sequential, `--workers 1`
one-shot transport.) Verdicts were identical to the server-mode table at every worker count here
too. One-shot parallelism's payoff is much clearer than server mode's on this fixture — each
worker pays its own process-spawn-plus-recompile cost per test regardless of transport, so
splitting that fixed cost across workers actually shrinks wall clock materially (3m37.4s down to
2m01.0s at `--workers 4`, a ~44% reduction) instead of being swamped by a single shared warm
process's one-time startup cost the way server mode is.

Honest reading of the **server-mode** timings: on this 16-mutant-site fixture, parallelism's
payoff is modest and noisy, not a clean win. `--workers 2` was not measurably faster than
`--workers 1` in this run (73.6s vs 70.2s — within the noise of a live external process);
`--workers 4` was the only count that showed a real improvement, about 16% faster than
`--workers 1`. A one-time baseline (both fixture tests, run once per batch before fan-out) plus
per-worker al-runner server startup/handshake cost is fixed overhead that doesn't shrink with
more workers, and only ~13 mutants' worth of test invocations are actually left to shard across
them — too small a workload, and too much fixed overhead relative to it, to show the kind of
scaling a larger target app would. One `--workers 1` run during this verification produced a
genuinely wrong verdict (score 20.0% instead of 18.8%, one mutant misreported as
`error`/`deadline-exceeded` instead of `survived`) — **not real-infra timing noise**: it was a
real bug in an earlier build of `AlRunnerBackend.deploy()`, which copied a batch's compiled
source directly into `cfg.instrumentedDir` instead of a private `active` subdirectory. That
collided when `cfg.instrumentedDir` was itself an ancestor of the batch directory being copied
from (the exact construction `al-runner.itest.ts` uses), corrupting the copy. Fixed by copying
into `<cfg.instrumentedDir>/active` instead (see the comment on `AlRunnerBackend.deploy`), with a
dedicated regression test (`tests/al-runner-backend.test.ts`) driving the real `deploy()`/
`activate()` code. After the fix, `--workers 1` was re-run twice more and reproduced the correct
table both times; it did not recur at any worker count, and the fix does not change the
determinism conclusion above.

## Integration scripts (`packages/runner/itest/`)

`al-runner.itest.ts` and `bcdev.itest.ts` are standalone Bun scripts (not `bun:test` files —
`bun test` never picks them up), run via the root `package.json` scripts:

```bash
bun run itest:alrunner   # needs LETHAL_ITEST_ALRUNNER=1 and LETHAL_ALRUNNER_PATH=<path to al-runner>
bun run itest:bcdev      # needs LETHAL_ITEST_BCDEV=1, and the local files above populated
bun run itest:tables     # needs LETHAL_ITEST_TABLES=1 and fixtures/sandbox-data/lethal.config.local.json
```

`tables.itest.ts` is the same shape as `bcdev.itest.ts` but pointed at the TABLE fixture
(`sandbox-data` + `sandbox-data-tests`) — the trigger half of Tier-2 Phase 0, whose result was
previously recorded only by hand in this file. It reads sandbox-data's own
`lethal.config.local.json` (a different container from sandbox-app's) and has no committed
baseline until a live run records one; see §Tier-2 Phase 0 above.

All three skip cleanly (print "skipped", exit 0) when their gate env var is unset, so they never
affect a plain `bun test` or CI run that hasn't opted in.

### Per-mutant healthy-path regression guard (Task 15, design spec §14)

Both itests already ran the session twice per invocation and asserted `shape(first) ===
shape(second)` — that only proves same-*process* determinism (two runs in this one invocation
agree with each other); it says nothing about a real regression introduced since the itest last
ran, because two runs of a silently-broken build can still agree with each other.

`packages/runner/itest/baseline-guard.ts` closes that gap: after `assertVerdictTable(first)`
(the aggregate killed/survived/no-coverage smoke test), each itest also calls
`assertMatchesBaseline(first, BASELINE_PATH, label)`, which normalizes the report via
`mutant-equality.ts`'s `normalizeForComparison` (semantic-identity-keyed —
astHash/codeunitName/operatorName/operatorMajor, immune to mutant renumbering) and diffs it
against a **committed baseline file**
(`packages/runner/itest/bcdev.baseline.json` / `al-runner.baseline.json`) via `diffMutants`. A
per-mutant difference — e.g. two mutants' verdicts silently swapped while the aggregate counts
stay identical — fails the itest even though `assertVerdictTable`'s counts alone would not
catch it. The first run ever recorded a baseline file writes it to disk (and logs that it needs
to be committed); every run after that compares against it. If the fixture or an operator
legitimately changes and the diff is expected, delete the baseline file, re-run, review the new
diff, and commit it.

This mechanism is wired into both live itests but, being inside an env-gated script, is only
actually exercised when `LETHAL_ITEST_BCDEV=1 bun run itest:bcdev` /
`LETHAL_ITEST_ALRUNNER=1 bun run itest:alrunner` runs against real infrastructure — see
`packages/runner/tests/baseline-guard.test.ts` for the offline unit coverage of
`assertMatchesBaseline` itself (records-on-first-run, matches-on-agreement, throws-on-diff,
and the "aggregate counts identical, per-mutant swap" case that is this guard's whole reason to
exist).

Per spec §14, this guard proves nothing about the **failure** path — it only exercises the
healthy path, where nothing here ever quarantines or latches. Each failure seam needs its own
fault-injection oracle instead; see `packages/runner/tests/fault-injection.test.ts` and the
"Wedged-tier reproduction" section below for the live-infra counterpart of the one seam that
cannot be safely exercised offline.

`bcdev.itest.ts` is also where the assumptions pinned during implementation without a live
server to check against get verified against real infra, and fixed in one commit each if
wrong:

- `bcdev_test_run` MCP payload shape (Task 7, `bcdev-backend.ts`) — **wrong**, fixed. The real
  payload nests `status` (`"passed"|"failed"|"skipped"`) and `output` per result, not `outcome`
  (`"pass"|"fail"|"skip"`)/`failureMessage`; coverage is a separate top-level array keyed by
  `testObjectId`/`testMethodId`, listing `{objectType, objectId, methodId, file?}` per covered
  procedure — numeric `methodId` only, never a name. Those ids turned out to be exactly the
  `Id` the AL compiler assigns each method in the compiled app's own `SymbolReference.json`
  (see `packages/runner/src/app-package.ts`) — resolvable locally, no extra server round-trip,
  *except* for `local`/private procedures, which are never listed there; unresolvable ids fall
  back to crediting every local procedure declared in that object (safe over-approximation:
  it can only turn a coverage-skip into an actual run, never hide a real kill).
- `altool` flag spellings (Task 8, `publisher.ts`) — **wrong**, fixed. Flags are all-lowercase
  (`--serverinstance`, `--schemaupdatemode`, not the camelCase originally guessed), and
  `--authentication` defaults to AAD — on-prem `UserPassword` auth must be selected explicitly.
  altool has no `--username`/`--password` flags at all: on-prem Basic-auth credentials go
  through `BC_SERVER_USERNAME`/`BC_SERVER_PASSWORD` env vars on the altool process (verified
  against the `Microsoft.Dynamics.Nav.Deployment.dll` strings shipped with the AL extension).
- OData `MutationControl_*` action parameter/return shape (Task 9, `activation.ts`) — **wrong
  in more ways than the parameter shape**: (1) every OData call needs `?tenant=...` or Basic
  auth fails outright with a generic 401, even with correct credentials; (2) the OData
  endpoint lives on port **7048**, not whatever port `server` carries (`odataBaseUrl()` now
  injects it); (3) `emitWebServicesXml` (`packages/schemata/src/selector.ts`) emitted
  `<ObjectType>Codeunit</ObjectType>` — the compiler's own embedded schema
  (`TenantWebServicesV1.xsd` in `Microsoft.Dynamics.Nav.CodeAnalysis.dll`) and the AL
  extension's own snippet both require exactly `CodeUnit` (capital U); the lowercase version
  silently fails validation and `alc` drops the file from the package entirely (confirmed:
  absent from a real compiled `.app`'s file listing). Fixed, and confirmed working after the
  fix: the file is now bundled (`serv/file0_webservices.xml` inside the `.app`) and the action
  becomes reachable (`BadRequest_NotFound` → a real parameter-validation error). See the
  bcdev-integration-fixes report for the exact request/response shape once fully re-verified.

### CI status: both itests are manual (not wired into CI)

`itest:bcdev` needs a live, reachable Business Central dev server plus credentials — it can
only ever run manually or against a self-hosted runner with network access to that server;
it is intentionally never a candidate for hosted CI.

`itest:alrunner` genuinely is CI-friendly (no server, no Docker — checked via a quick WebFetch
of the [BusinessCentral.AL.Runner README](https://github.com/StefanMaron/BusinessCentral.AL.Runner)
during Task 12): install is a one-liner,

```bash
dotnet tool install --global MSDyn365BC.AL.Runner
```

requiring only .NET SDK 8/9/10 (the AL compiler and BC Service Tier DLLs download and cache
automatically on first run). Despite that, it is **not** wired into CI in this task: this repo
has no GitHub Actions workflow at all yet (no `.github/workflows/`), and standing up the
monorepo's first CI pipeline (checkout, Bun setup, `bun test` + `typecheck` + `biome check`,
*and* a .NET SDK + al-runner install step) is a materially bigger task than "add one step to
an existing pipeline" — out of scope for "do not spend long on this." Whoever sets up CI next
can wire in `itest:alrunner` cheaply using the command above plus
`LETHAL_ITEST_ALRUNNER=1` / `LETHAL_ALRUNNER_PATH=al-runner` (the tool is on `PATH` after a
global `dotnet tool install`).

## Wedged-tier reproduction & operator clear (Task 15, design spec §8/§9/§10/§12)

This is the operator runbook for the one failure mode that genuinely needs live infrastructure
to reproduce end to end: a BC service tier left running a test LethAL can no longer confirm
finished (an **in-flight-unknown** operation, spec §7) — LethAL is designed to notice this,
refuse to guess, and lock the tier out of further use until a human proves it is safe again.
Everything below is accurate to what is actually built: quarantine is a **machine-local**,
durable, per-tier record (`QuarantineStore`, `packages/runner/src/quarantine-store.ts`, one JSON
file per tier under `~/.lethal/quarantine` by default, keyed by normalized `server` +
`serverInstance` — tenant is deliberately excluded, see `quarantineResourceKey`); clearing it is
`lethal clear-quarantine`, not a self-service unblock; and the process-level signal is exit code
**3** (`QUARANTINED_EXIT_CODE`, `packages/runner/src/cli.ts`).

Everything in this section requires `LETHAL_ITEST_BCDEV=1`-class live access — a real BC
container reachable via `bccontainerhelper` on the host running the dev server. There is no
offline equivalent of *actually* stranding a container; for a fast, safe, CI-runnable proof of
the same containment invariant (latch + durable quarantine + refuse the next session before
`status()`), see `packages/runner/tests/fault-injection.test.ts` instead — it drives the exact
same orchestrator code path (`runSession`) against a stateful fake backend that never resolves,
with no server involved.

### 1. Deliberately wedge a tier

`BcDevMcpBackend.run()` has no way to cancel a dispatched `bcdev_test_run` call — once dispatched,
LethAL's own client timer racing the MCP call is the only signal it ever gets (see the comment at
`packages/runner/src/bcdev-backend.ts`'s `run()`, phase 2). So the cheapest deliberate strand is a
test method that runs past LethAL's timeout budget while the server keeps executing it — no
container manipulation needed to produce a *real* in-flight-unknown, only a test that never
returns in time:

```al
[Test]
procedure NeverReturns()
begin
    // Deliberately exceeds the baseline timeout (default 120000ms; pass a lower
    // --baseline-timeout-ms-equivalent via SessionConfig.baselineTimeoutMs when embedding, or
    // just let a genuinely long-running/looping test exceed the default) so LethAL's client
    // timer fires while bc-dev-mcp is still executing it server-side.
    while true do;
end;
```

Point `lethal run` at a throwaway copy of `fixtures/sandbox-tests` with this method added, and
run it against a live dev server:

```bash
bun packages/runner/src/cli.ts run \
  --project fixtures/sandbox-app --tests <copy-with-NeverReturns> \
  --backend bcdev --config fixtures/sandbox-app/lethal.config.local.json
```

A harder, container-level strand (for proving the tier-restart step below against something more
realistic than a hung AL loop) is to freeze the whole container mid-test instead of hanging the
test itself — `docker pause <containerName>` (BC containers are plain Docker containers under
`bccontainerhelper`) while a `lethal run` is in flight. The dispatched `bcdev_test_run` call
never returns because the whole container is frozen, not just the one AL procedure — LethAL
observes exactly the same ambiguity either way.

### 2. Observe LethAL quarantine it and exit `quarantined`

LethAL's own client timer fires at the configured budget; `BcDevMcpBackend.run()` returns
`{ outcome: "deadline-exceeded", operation: "in-flight-unknown" }` (the server may still be
running the test — the call was dispatched, so it cannot be retried). `runSession` (via the
shared `quarantineInFlight` helper, `packages/runner/src/orchestrator.ts`) then:

1. latches `SessionSafety` unsafe (in-memory, one-way, for the rest of this process) — no further
   deploy/activate/run/verify/status call may execute, not even the deactivating `ClearActive` the
   `finally` teardown would otherwise send;
2. durably records a quarantine (`QuarantineStore.record`) under
   `~/.lethal/quarantine/<sha256(server|serverInstance)>.json`, an atomic temp-file-then-rename
   write that survives a crash of the LethAL process itself;
3. stops scheduling further work and returns a `SessionReport` with `quarantined: { reason }`
   set instead of throwing — this is a **recognized**, reported outcome, not a crash.

`lethal run`'s `main()` renders the console report and exits **`3`** (`QUARANTINED_EXIT_CODE`,
distinct from exit 1's "ordinary config/uncaught error" so a calling script can branch on it
without parsing output):

```
$ lethal run --project ... --tests ... --backend bcdev --config ...
[report table ...]
$ echo $?
3
```

A second `lethal run` against the same tier — before it is recycled and cleared — is refused
**before it even calls `status()`** (the quarantine consult runs first, spec §8):

```
Error: tier http://cronus281|BC is quarantined (test-run: baseline test in-flight-unknown
running NeverReturns, recorded 2026-07-20T12:00:00.000Z, generation 1). Recycle the tier and
run 'lethal clear-quarantine' to clear it.
```

### 3. Restart the tier via `bccontainerhelper` on the host

Quarantine is a **client-side refusal to trust the tier again**, not a fix — the wedged test run
(or the frozen container) is still there until an operator actually recycles it. On the machine
hosting the BC container:

```powershell
# Either is sufficient to prove the strand is gone:
Restart-BcContainerServiceTier -containerName <name>   # just the NST process — aborts whatever
                                                          # it was mid-executing, container stays up
# ...or recycle the whole container:
Restart-BcContainer -containerName <name>
# older bccontainerhelper versions: Restart-NavContainer -containerName <name>

# If the container was paused rather than the test left hanging (the "harder" reproduction
# above), unpause it first:
# docker unpause <name>; Restart-BcContainerServiceTier -containerName <name>
```

Confirm the tier answers again before clearing quarantine — e.g. a plain `Get-BcContainerEventLog`
tail, or just watching the container come back healthy in `docker ps`/`Get-BcContainerServerConfiguration`.
LethAL has no way to verify this step happened; clearing quarantine is an **operator-proven**
action (spec §10), not something LethAL re-checks on the operator's behalf.

### 4. Clear the quarantine

```bash
bun packages/runner/src/cli.ts clear-quarantine --server http://cronus281 --instance BC
```

This opens the **same** `~/.lethal/quarantine` store `runSession` wrote to (there is deliberately
no `--quarantine-dir` override on this subcommand — an operator clearing a real tier must hit the
real store, never one a stray flag silently redirected), reads the record's current `generation`,
and clears it only if that generation is still current (`QuarantineStore.clear`, generation-checked
— a clear computed against a stale generation because a *newer* strand landed in between prints
`stale` and leaves the newer record intact, rather than erasing evidence of it). Prints exactly one
of:

- `cleared` — exit 0. The tier is usable again.
- `not-quarantined` — exit 0. Idempotent: nothing to do (already clear, or never quarantined).
- `stale` — exit 1. A newer quarantine was recorded since whatever the operator was looking at;
  re-run `clear-quarantine` again after investigating the newer record (do not assume it is safe
  to ignore — it means something quarantined this tier again after the first strand).

### 5. Confirm the next session runs

```bash
bun packages/runner/src/cli.ts run \
  --project fixtures/sandbox-app --tests fixtures/sandbox-tests \
  --backend bcdev --config fixtures/sandbox-app/lethal.config.local.json
```

`QuarantineStore.read` now returns `null` for this tier's key, so the consult at the top of
`runSession` passes straight through to `status()` and the session proceeds normally — no special
"post-quarantine" state persists once cleared; the guard is purely "does a record currently exist
for this key," and it doesn't.


## R36 — the fixture's own `asserterror` accepted the wrong error (2026-07-27)

`RequireCategoryAFails` asserted only that AN error occurred. Deleting `DataMain.Get(MainNo)`
(M0034, `DataOps.Codeunit.al:44`) leaves the record blank, and `TestField(Category, 'A')` then
still raises — because `''` is not `'A'` — so the bare `asserterror` was satisfied by a failure
with a completely different cause and the mutant was reported SURVIVED.

That verdict was *correct* (the fixture genuinely did not catch it) and simultaneously a defect,
because this fixture exists so that a broken operator FAILS. It was carrying the project's
signature "test passes for the wrong reason" inside the very thing built to catch that shape.

The test now asserts the error message names the record it loaded (`T-REQ`), which a blank record
cannot do. It discriminates on exactly what the deleted `Get` is responsible for — whether the
record was loaded at all. Asserting the expected Category would NOT discriminate: both the real
and the mutated path mention `'A'`.

Frozen result moved **63 / 10 / 2 → 64 / 9 / 2**, one net verdict, in the safe direction. The
re-recorded `tables.baseline.json` shows TWO changed lines rather than one: identical statements
share a semantic identity key (`Data Ops` has a six-deep group), and `diffMutants` sorts each
group canonically, so one member's verdict changing re-sorts the group. That is the design working
— see `mutant-equality.ts` on why a within-key ordinal is deliberately not added.

### The test app had not compiled since `76dfe48`

Found while doing the above. A **docs-only** commit rewriting a comment in
`InsertDoublesAmountWeak` deleted the procedure's body and its closing `end;` along with it. The
project stopped compiling, and `itest:tables` kept passing — because LethAL publishes the *target*
on every run and treats publishing the *test app* as the user's own workflow, so the gate ran
against a stale published build for days.

R31's stale-test-app detector cannot see this shape: it fires when the server has no result for a
discovered test, and here the server had an OLDER, WORKING build of every test. Nothing diverged
that R31 measures. See ROADMAP R56.
