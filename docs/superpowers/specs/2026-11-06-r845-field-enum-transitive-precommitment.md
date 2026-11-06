# R845 pre-commitment: extend the pre-publish check to fields, enum values and transitive dependents

Written 2026-11-06 by lethal-code, coord task R-845, after one opus plan review and three measurement batches on real BC 28.4. Basis: R843.
No figure moves: no fixture clashes (to be confirmed by the real function over every fixture pair), and a refusal moves no verdict.

**The standing rule of this design: a comparison refuses only if a BC measurement below backs it. A rule with only alc behind it warns.**
alc and BC differ: L5 below, where alc refuses and BC accepts.

## Measured

Logs: `/coord/handoff/R-845/steps.log`, `l-cases.log`, `recovery.log`. All with `SchemaUpdateMode=forcesync&DependencyPublishingOption=ignore`,
scratch apps, `bc1` for upgrades, `bc2` for fresh publishes.

**An upgrade of target A, dependents installed:**

| Case | Clash | Result |
|---|---|---|
| U5 | object kind + id, direct dependent | stripped: A and dependents not installed |
| U4 | object kind + id, transitive dependent | stripped: the whole chain |
| U1 | field id, A's own table, dependent's tableextension | stripped |
| U6 | field name, other id, A's own table | stripped |
| U2 | enum ordinal, A's own enum, dependent's enumextension | stripped |
| L4 | enum value NAME, other ordinal, A's own enum | stripped |
| L3e | field id, both extending a third app's table | stripped |
| L7b | field name, both extending a third app's table | stripped |
| L3f | enum ordinal, both extending a third app's enum | stripped |
| L3g | enum value name, both extending a third app's enum | stripped |
| U3, L2, L3h | any clash with an app that is NOT a dependent | no restore attempt: A's old row gone, new row not installed, A's dependents not installed, the other app fine |
| K01-K11 | object kind + id, each of Table, Page, Report, Query, XmlPort, TableExtension, PageExtension, ReportExtension, EnumExtension, PermissionSetExtension, in a dependent | stripped, all with "defined in multiple apps" |
| R4 | U3 with a dependent B | A v2 fails with no restore sentence, B not installed, X fine |

With Codeunit, PermissionSet and Enum (measured earlier), all 13 kinds the object rule compares are measured: its refusals stand.

**Accepted by BC, so these must never refuse:**

| Case | Pair |
|---|---|
| L5 | field names differing only in CASE (alc refuses these, AL0155) |
| L6a, L6b | page control and action names |
| L6d | same-kind object, same name, other id |
| f3c, f3d | one id across kinds (enum, codeunit), fresh publish |
| K2 | table against page, one id, upgrade |

**A clashing pair cannot be installed.** BC recompiles a dependent at publish: L1, L3a-d were refused cleanly, the originals restored. So
comparing all of the target's fields is as safe as comparing only new ones: no installed pair can trip it, and BC's text ("can only appear
once in the table") is a whole-table check. Exception: `Moved`, below.

**Every publish path LethAL owns uses ForceSync:** the target through `altool publishapp --schemaupdatemode ForceSync` (the URL read from a live
log), test apps through `publishBytes`, also `forcesync`. An env tool's own publish command is outside LethAL: its mode is unknown.

## The extension to `checkObjectClashes`

Set B grows from objects to objects plus members, read from each dependent's `SymbolReference.json`:

- `TableExtensions[].Fields[]`: `Id`, `Name`, by `TargetObject`.
- `EnumExtensionTypes[].Values[]`: `Ordinal` (omitted means 0), `Name`, by `TargetObject`.
- A bad entry (`Id`, `Ordinal` or `Name` of the wrong type, a missing `TargetObject`) makes the package unreadable, never empty.

**Refuse on the same target table or enum, when:** (1) field id equal; (2) field name equal, EXACTLY (L5: case differs is accepted; trailing
space is not measured, so compare exactly and say so); (3) enum ordinal equal; (4) enum value name equal, exactly (L4, L3g). The same id, name or
ordinal on a DIFFERENT table or enum does not refuse. Page, action, report-column and object-name clashes are not compared.

**`TargetObject` has two forms.** `#<appid no dashes>#Name`, or a bare `Name`, meaning the declaring app's own table. The namespace is not in the
string, and it holds the canonical case. Compare app ids with dashes removed and case folded. A bare name resolves to the declaring app; bare and
not in that app's own `Tables` or `EnumTypes` warns by name. `ReportExtensions` uses `Target`, not `TargetObject`: not read here.

**Source-side identity.** A target table or enum the target declares: (target id, name). A target tableextension or enumextension: `base_object` text
may be `Customer`, `"pub table"` or `Foo.Two."Other Name"`: take the last segment, unquote (`""` to `"`). The source does not say which app owns it.
A name is unique inside one app (AL0197), so (app, name) is sound on the package side. Match on name, and refuse only when the `TargetObject`'s app
is in the target's `app.json` `dependencies` or is a Microsoft app; otherwise warn by name, since it may be another app's table of that name. A
qualified name pointing away from the target's own namespace is not "own".

**`Moved`.** A pair `ObsoleteState = Moved; MovedTo` / `MovedFrom`, same id and name, compiled clean, for a field and for a table. It is limited to
Microsoft and select publishers. Either side `Moved`: warn, do not refuse. R843's (Table, id) gets the same exemption. Not measured on BC.

**Transitive dependents.** `installedDependents` takes any app id: its AL filters `Application Dependency` by the given id and joins to installed
rows. Walk breadth-first, tests app first. The visited set is seeded with the target's own id, lowercased, or a stray row would compare the target
with itself. A failed read of one level warns by name and stops that branch.

**The bound.** At most 40 apps and 120 s in all. On reaching it: warn with `object-clash-unchecked`, naming how many were not read and the first
few. Never refuse and never fail on it. A dependent as big as Base is 46 MB: its 15 s deadline warns, as an unreadable package does today.

**Source fallback.** When the tests package is unread, objects compare as R843 does, and a member clash from fallback WARNS, never refuses: both
sides are names only, and the tests app's own tables would pass for target tables, so resolve those first.

**`unquote`** in `object-clash.ts` leaves `""` where a package holds `"`. Fix it.

## Three texts, one helper

Each new BC refusal needs a change in three places, so name the texts in one helper: "defined in multiple apps", "can only appear once in the table",
"Metadata delta application failed".

- `UpgradeNotRestoredError`: for all three, say so in BC's words, not "no longer compiles": the installed app compiled fine.
- `classifyDeployFailure`: none of the three records a publish ceiling.
- `ObjectClashError`: "declare the same object" and "republish" do not fit a member. For a field or value, say to change or remove it, in the target or
  in the named app. Rebuilding that app alone fails, with AL0206.
- A U3 failure has no restore sentence, so `restoreFailed` does not match it and `UpgradeNotRestoredError` does not fire. Say which path it takes today, and
  have it name the recovery section.

`dependentsWarning` names transitive dependents too: U4 shows they are stripped.

## The limits, named

- **U3: an installed app that is not a dependent.** Objects, fields and enum values alike. Not visible to this check: finding it needs a by-object read no
  control-app action offers today. It loses the target and its dependents; the other app is untouched. Two unrelated apps adding one field to `Customer` is
  the likely real case. A control-app action reading `AllObj` and `Field` could close objects and fields, at a version bump: filed as its own item.
- **An env tool's publish command** may use another schema mode, and **the hook's own test-app publish** runs before this check.
- **Report columns, trailing spaces in names:** not measured.
- **A transitive member clash cannot exist:** alc refuses AL0247 when C extends A's table with only a transitive path, so C must depend
  on A directly and is then a direct dependent. The rule is kept; in effect it reaches only direct owners.
- A table reached through `propagateDependencies` is not in `dependencies`, so a clash there only warns. One name in two trusted apps can
  refuse wrongly, because the source side cannot check the owner's app (Base Application and Business Foundation share 8 table names).
- **Fixture targets:** recovery is measured on scratch apps.

## Recovery for a user's own server

A section in `docs/` (`docs/using-lethal-from-an-agent.md`, or the page users read: pick one, and link it), named by `ObjectClashError`,
`UpgradeNotRestoredError` and the U3 path. Measured on `bc1` with no restart:

1. BC's text names the clash and lists the apps that could not be reinstalled.
2. Fix the clash in the target. Give it a version above every version BC has seen: the failed one counts.
3. Publish it over the dev endpoint, with nothing uninstalled first. The stranded rows are replaced, and the app's data stays (one row, read back).
4. Publish each listed dependent at a version above its stranded row. The same build is refused: "A duplicate package ID is detected".
5. Do not fall back to the old build: with dependents involved, "a newer version ... was already installed". After a U3 failure the old build does publish.
6. If everything was unpublished first, a dependent's same build publishes again, and the target must still be the higher version.

## Tests

Red per direction, each a real mutation: field id, field name, enum ordinal and enum value name each refuse, on a target's own table or enum and on a third
app's; a case-only name difference passes (L5); same id, name or ordinal on a DIFFERENT table or enum passes; omitted ordinal reads 0; bare `TargetObject`
resolves to its own app, so a dependent's own `Setup` passes against a target `extends Setup`; a non-dependency app's same-named table warns; `Moved` warns;
transitive clash refuses; a cycle ends; target id seeded; the bound warns, both limits; a failed walk warns; fallback member clash warns; bad member entries
read unreadable; `undecided` warns; `""` unquotes; three texts through the helper; no publish on any refusal, by call counters. A real package, built by alc,
with a tableextension and enumextension, read through `declaredObjectsOfPackage`.

Run over all `fixtures/*`: 0 clashes, or stop.

## Gates

One opus build review, full v3 gate on the final head, `itest:bcdev` on a bc server, CI both jobs read before the submit. Release a server only after a
health check. Live: the clashes of U1 and L4 refused on a bc server with zero publishes, with scratch apps.
