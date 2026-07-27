# Measurements

Probe sources kept so a claim can be re-checked rather than re-argued. A measurement nobody can
re-run is barely better than a guess.

## `object-kind-selector-var-probe.al` — which AL object kinds can carry the selector var

Answers R40. `canCarryMutationSelectorVar` (`packages/schemata/src/compile.ts`) refuses every
object kind but codeunit and table, stating that no other kind can carry
`var MutationSelector: Codeunit "Mutation Selector";` and that a guard in one "cannot compile
(AL0118)". On Continia Document Output that refusal costs 41% of the app's mutation sites.

This probe declares that exact var inside a `page`, a `pageextension`, a `tableextension` and a
`report`, each with the var placed AFTER the kind's structural sections.

**Result (2026-07-27, `alc 17.0.29.44223`, platform/application 28.0.0.0, runtime 17.0):**
exit 0, zero errors, artifact produced. All four kinds accept the declaration.

So the stated reason is wrong. The real constraint is anchor POSITION within the object — the
same thing R38 turned out to be for codeunits, where the var had to follow the object's
properties. Recovering the 41% is anchor work plus operator coverage of those bodies, not a
language limitation.

Re-run:

```sh
alc /project:<this dir's parent copy> /packagecachepath:<symbols> /out:probe.app
```

Note the probe compiles only; it does not prove the guard EXECUTES correctly in those kinds, which
is a separate live question.

## `tableextension-coverage-probe.al` — where BC attributes an extension's coverage

Answers the blocker that keeps the extensions half of R40 open. `coverageFilter` keys on
`(objectType, objectId)`; if a `tableextension`'s code were reported under the BASE table's id,
keying its mutants on the extension id would find no coverage and report every one as
`no-coverage`, while keying them on the base id would merge two objects' coverage. Guessing wrong
is the R29 failure — the one that produced 10 false survivors out of 20.

The probe declares a base table with `BaseBump()`, a tableextension with `ExtBump()`, a driver
codeunit calling both, and one `[Test]` exercising them, then reads the coverage BC returns.

**Result (2026-07-27, hosted Continia BC 28, `coverage: "procedure"`):**

```
Table:79480      base table       seen
Codeunit:79482   driver           seen
15:79481         tableextension   seen, under its OWN object id
```

Two findings:

1. **Extension code IS attributed to the extension's own id**, not the base object's. Keying
   extension mutants on the extension id is therefore correct.
2. **`objectType` arrives as the raw numeric `15`** (BC's TableExtension object-type enum), not a
   name. LethAL's manifest writes `"tableextension"`, so the two keys would not match and every
   extension mutant would silently become `no-coverage`. That — not the attribution question — is
   the real work remaining: `buildCoverageMap`/`normalizeObjectType` must map BC's numeric
   extension types, and it must be a mapping that FAILS LOUDLY on an unknown type rather than
   defaulting, since a silent mismatch is indistinguishable from "nothing covered this".

`procedure` came back `undefined` for all three objects, i.e. object-level attribution only, so an
extension mutant would additionally depend on `coverageFilter`'s object-level fallback.

## `session-capability` — why two runners disagree (R57)

`fixtures/sandbox-probes/src/SessionCapabilityProbe.Codeunit.al` reports `GuiAllowed`,
`CurrentClientType`, `CompanyName` and `UserId` from inside a `[Test]` body, so whatever the runner
did to the session is what gets reported.

It exists because R55 measured that 12 of 56 Continia Document Output tests fail through the
bc-dev-mcp hub and pass through LethAL's fenced `RunMutant`, order-independently, and the most
informative failure is `Unhandled UI: Confirm ... has not been activated` raised in test codeunits
that declare no handler functions at all. BC raises `Unhandled UI` for a `Confirm` only in a session
it treats as INTERACTIVE; a non-GUI session returns the default silently and the caller takes the
other branch. Session capability is therefore the prime suspect — and unlike the alternatives it can
be measured directly instead of argued about.

Run it by pointing a session's `--tests` at `fixtures/sandbox-probes` and running the same target
twice, changing only `bcdev.coverageMode`:

- `"procedure"` routes the BASELINE through the hub
- `"none"` routes it through the fence

The probe raises its values as an `Error`, so the test shows as FAILED — that is the transport, not
a broken probe. Compare the two messages.

It lives in `sandbox-probes` deliberately: that fixture is published and driven separately and is
not part of any frozen mutation baseline, so adding a test to it cannot move `itest:bcdev` or
`itest:tables`. Adding it to `sandbox-tests` would have.
