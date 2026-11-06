# R843 pre-commitment: refuse a target that collides with an installed dependent, before anything is published

Written 2026-11-06 by lethal-code, coord task R-841, after one opus plan review. No figure moves: no fixture pair clashes (to be
confirmed by running the real function over every fixture), and a refusal moves no verdict.

## The bug

BC refuses a target whose object has the same type and id as an object in another installed app: "The application object of type
'CodeUnit' with the ID '79100' is defined in multiple apps". On an upgrade it cannot restore, so it leaves the target uninstalled and
removes every installed dependent (R709). Measured on `bc1`, 2026-11-06.

alc catches this when it compiles an app against a current build of the other: `AL0264`, for 13 kinds, by type and id, across apps
(alc 18.1, measured offline by the plan review). So the clash reaches BC when the INSTALLED tests app was compiled against an OLDER
target. That is what happened on `bc1`. Comparing sources alone would miss it: rename a test in source, do not republish, and the
resident app still holds the id.

## The rule

For `bcdev` only, before the first deploy, compare two sets and refuse by name on a shared (kind, id). Nothing is published.

**Set A, the target.** Every object declaration in the source snapshot (`sourceSnapshot` and `buildSymbols`, never a fresh disk read;
every `.al` key, not `generateMutationSet`'s list, which skips `Mutation*` files), plus the three injected ids. `selectorId`,
`controlId` and `tableId` are all CODEUNITS (`tableId` is `Mutation Upgrade`).

**Set B, each installed dependent** from `backend.installedDependents(targetId)`, read from `SymbolReference.json` in the package from
`fetchPublishedAppPackage`. That is exactly what BC holds, so it has no `#if` question. Direct dependents only: BC's list has no
transitive ones. Stated in the code and in the item.

**Fallback.** When the tests app's package cannot be read, its source through `readTestAppSources` with `testBuildSymbols` (not
`discoverTests`, which `--tests-only` narrows). A fallback refusal names the symbols it used. An unreadable package for any other
dependent warns by name.

**No refusal** when source clashes but the installed app does not: nothing is harmed, and the run carries on. No refusal on a first
publish: no dependent is installed.

**Kinds, exactly these 13:** Table, Codeunit, Page, Report, Query, XmlPort, Enum, EnumExtension, PermissionSet,
PermissionSetExtension, TableExtension, PageExtension, ReportExtension. Same id in another kind passes. Interfaces, profiles,
controladdins and dotnet have no real id and are not compared. `SymbolReference` keys are named one by one, and the read recurses into
`Namespaces`. No existing scanner is reused: `scanDeclaredObjects`, `objectIdentityOf` and `AppMethodIndex` each miss kinds, and the
first reads both `#if` arms.

**Parsing the source.** By tree, with `evaluateArms` per file, each app with its own symbols. An `undecided` arm warns by name and never
refuses. A split-header object (`preproc_split_declaration`) is counted, not dropped.

## Where it lives

A pure function over the two sets, and one call inside the `if (!dependentsChecked)` block in `runSessionBody`, beside `checkDependents`,
before `deployStep` is defined, sharing its dependent list. A failed read still warns, as now. `deployOnce` holds the only `.deploy(`
call and sits inside `deployStep`, so every route that publishes a target passes this block: fresh, `--resume`, `--resume-run`,
`--tests-only`, `--only`, chunked, snapshot reuse, lend, isolation redeploy, `campaign`. Exempt, as they never publish a target:
`verify`, `runNamedMutants`. Exempt, as they compile the resident source against the target: `bc-linux-setup.ts`, `bc-republish.ts`.
Not inside `BcDevMcpBackend.deploy`: an unknown error class there records a recycle and quarantines the tier.

The error is a typed class extending `Error` directly. Its text names the kind, id, the target's file and object, the other app's name
and version, and says to republish or remove that app first. No registration is needed in `failure-classes.ts`.

al-runner-v3 is exempt: no server, and it compiles the tests against each batch.

## Also in scope

- `UpgradeNotRestoredError` says an app "no longer compiles". When BC's text holds "defined in multiple apps", it says so instead. Red
  test.
- A plain 422 collision that DOES restore: check whether `classifyDeployFailure` records it as a size failure, which R90 reads as a
  publish ceiling. If so, fix it here.

## Not covered, filed as R845

Clashes a list cannot see: a tests `tableextension` field id against a new target field, an enum value ordinal, an installed app that is
not a dependent, a transitive dependent, and test apps the env-tool hook publishes before the deploy. Whether BC's check matches alc on
kinds other than Codeunit, and on same id across kinds, is measured only for codeunits (R629); a false refusal needs a stale tests build
that cannot be rebuilt against this target anyway.

## Tests

Red per direction, with call counters on a stateful fake backend proving nothing is published: a resident clash with clean source; a
dependent other than the tests app; `tableId` against a test codeunit refuses and a test TABLE with that id passes; Enum and PermissionSet
kinds; same id in another kind passes; interface not compared; unreadable package falls back to source; undecided arm warns; a source
clash with a clean installed app passes; a split-header object; no dependents installed passes; v3 unaffected.

Run the function over all `fixtures/*` first: 0 clashes, or stop.

## Gates

One opus build review, full v3 gate on the final head, `itest:bcdev` on a bc server, CI read before the submit.
