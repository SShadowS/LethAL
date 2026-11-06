# R847 plan: let the clash check see an installed app that is not a dependent

Written 2026-11-06 by lethal-code, coord task R-847, Part 1, after one opus plan review. Part 1 is offline: AL and client on a held branch, an offline `alc`
compile, red tests. No control app and no probe is published anywhere. Part 2 needs the orchestrator's word.

## Read first: R433 and the run-time cost

**R433.** BC's automation `extensions` list, asked for all rows, hung BC 28.4 for about 166 s and took a server down. A filter on publisher did not help, and a
filter on one app id answered in about 40 ms. The rule: ask about one known thing, never list and filter.

**This plan never lists, and on an ordinary run it asks about almost nothing.** It does not read every installed app. It asks only about what is NEW in the target
since the installed target:

- Installed apps are disjoint: BC refuses a clashing pair at publish (L1, L3a-d, f1, f3a). So any clash must involve something new.
- `new = target's objects and fields, minus those in the installed target's package`.
- First run over a stock build: about the 3 injected codeunits. A re-run after a gate's mint: the installed build is already instrumented, so nothing is new, and **no
  control call is made at all**.
- Whole-set on a Base-sized target would be about 90,000 reads, which no 10 s budget can finish. New-only is what makes this viable.

**The read itself.** The control app reads two virtual tables by primary key: `AllObj` (Object Type, Object ID) and `Field` (TableNo, No.). It does not touch the automation
API, whose slow page reads a real table with a FlowField filter, so R433 does not speak to `AllObj` either way. **Whether a keyed read of a virtual table is cheap is not
measured.** The nearest evidence: `TestSuiteMgt.TestResultsToJSON` does this exact join per test method, in a loop body R198 measured at about 55 ms: an upper bound of tens of ms,
no more.

**Bounds.** At most 200 items a call, and one 10 s deadline in all, no retry. The action takes `MaxMs`, as `RunMutantMany` takes `RequestCeilingMs`, because a client abort does not
stop running AL: past it the loop stops and answers how many it read. The client's timeout is the time remaining. A partial read warns (`object-clash-unchecked`), and never refuses
and never fails the run. A row already read may still lead to a package read.

**Part 2 measures first, in a scratch PROBE app, ids 915xx, under a lease, not in a bumped control app.** A ladder of 1, 10, 100, 1000 items, moving up only if the last step passed:
`bc2` (Base only), then `bc3` (Continia). **Stop if** one read costs over 100 ms above a HarnessInfo round trip; if the per-read cost grows with server size and not with items; if
HarnessInfo latency doubles during a call; or on any 503. A 10-item call within 2 s is enough to go on: the design survives at 100 ms a read.

## The design

**1. Skip.** Is the target installed? Three answers, from the keyed `fetchInstalledVersions`, on the backend. No: a first publish cannot strip, so no call. Yes: go on. A throw: warn
`object-clash-unchecked`, never read it as a first publish; rethrow `UnfilteredExtensionsQueryError`. Two installed versions: no base set, go on with the whole set under the budget.

**2. Base set.** The installed target's package through `fetchPublishedAppPackage`, read with `declaredObjectsOfPackage(got, {id, version})`, naming the INSTALLED version:
`devPackagesUrl` sends an empty version, and a newer published-not-installed build must not become the base. Unreadable or mismatched: the whole set, under the budget, then warn.

**3. Items.** Objects: the target's source objects plus the injected three, minus the base. Fields: only fields of a tableextension on a table the target does not own, new by (table, id)
or (table, name). A target's own tables are skipped: a non-dependent cannot extend them, since AL requires a dependency, and Base has 29,441 own-table fields against 284 tableextension fields.
An empty set: no call.

**4. Third-app table id.** Source says `extends Customer`, a name. Resolve offline: `cfg.dependencyPackageDirs` holds `packageCachePath` at this point, and `packageFolderReader`
indexes by app id. Read `SymbolReference.json` of the target's `dependencies` plus the five Microsoft apps, only when a new field sits on a non-own table (Base: about 0.65 s and 390 MB
once). Zero matches or two ids: warn (Base and Business Foundation share 8 names).

**5. Read.** Two actions in `LC Control API`:

- `ObjectOwners(ItemsJson, MaxMs)`, `FieldOwners(ItemsJson, MaxMs)`: **one row per item asked**, in order, each `{outcome: owner | none | unresolved, appId?, name?}`, the target's own rows
  included, plus `read`, the count. Never only "other" rows: empty must not look clean.
- Kinds map through an explicit `case` in AL, erroring on an unknown one. `Table` must never become `TableData`. Client `XmlPort` is option `XMLport`. Loop with `FindSet`, not `FindFirst`,
  so a second row is not hidden. Cache the package-to-app join per call: `"Package ID"` is not a key of `"NAV App Installed App"`.
- A failed join, or a null `App Package ID`: `unresolved`, which only warns. Compare by App ID, never by package id: a mint changes the package id.
- `Field` answers `FieldName` and `TableName`, and the CLIENT compares names exactly (L5: case-only must never refuse), and checks `TableName` is the table asked about, so a wrong
  id cannot refuse. A name read scans one table's rows.

**6. A row is a lead, never a refusal.** For an owner that is not the target and not an app actually compared in the loop (a set by app id, since a dependent whose read failed or
fell past the bound must not be ignored): read that app with `fetchPublishedAppPackage` and `declaredObjectsOfPackage(got, {id, version})`, then the existing `findObjectClashes` and
`compareMembers`. That is what refuses. It carries the `Moved` exemption, needs no trust in `AllObj`, and keeps "read from the package the server holds" true. Unreadable: warn, do not refuse.

**7. Blind kinds.** `AllObj` may hold no rows for a kind (unknown for Enum, EnumExtension, ReportExtension, PermissionSet, PermissionSetExtension). So per kind asked, send one object known
to be installed from the base set as a control. If it does not come back owned by the target, that kind is `unseen`: warn, never clean, never refuse.

**8. Where.** In `checkObjectClashes`, BEFORE its early returns at `!Array.isArray(args.dependents)` and `dependents.length === 0`: a target with no dependents is U3's shape too.

**9. Text.** `ObjectClashError`'s "Republish the named app built against this target" is wrong for an unrelated app. Say the app is not known to be a dependent, and to remove the clash in the
target or that app. "Not known", because a truncated walk cannot say "not a dependent".

No progress event for the time spent: new-only makes it speculative, and a new event ripples.

## The standing rule

A comparison refuses only on a BC measurement. U3, L2 and L3h measured that a non-dependent clash loses the target. The refusal comes from the other app's package, with the same comparisons R843
and R845 measured, so `AllObj` only decides what to read. Remaining assumption: an X published uninstalled and installed later is not measured; if BC let such a pair install, new-only misses it,
and that lands where it lands today, at `UpgradeClashRefusedError`. Every miss does. No path is worse than now.

## Limits

Enum values: `Enum Metadata` is not in System's symbols, on 28 or 29. Kinds found blind in Part 2. A non-dependent's page, action and report-column names were accepted or are unmeasured
(R845). The env-tool items stay as R845 names them. `AllObjWithCaption` has `App ID` directly and may be better: Part 2 measures both.

## An older control app

`MIN_CONTROL_VERSION` rises in Part 2, so an older app is refused by version, by name, with no fallback. **The branch is held, not merged, until Part 2.** In Part 1 the AL is added, `app.json` stays
1.0.0.24 and `MIN_CONTROL_VERSION` is unchanged: CI stays green, and the backend methods are optional. Do not land that AL on master without a bump: two builds would both report 1.0.0.24, R28's defect.

Part 2 raises both, plus the literals in `harness.test.ts`, the guide `agent-contract.test.ts` pins, `CONTROL_APP` and `CONTROL_SHA256` in `bc-linux-setup.ts`,
`scripts/testdata/bc-demo-kraken-pin.json`, and `docs/gates/README.md`'s table. Re-check the next free version then: another lane may have taken 1.0.0.25. `bc-demo` shares the pin.

## A session and permissions

Read-only calls on the control endpoint, after `openLeaseScope`, in the block `InstalledDependents` already runs in: no fence, no op, no lease check, and `operation-busy` does not apply. A missing
verifier warns. All reads are wrapped and warn, rethrowing only `UnfilteredExtensionsQueryError`. `AllObj` and `Field` carry `InherentPermissions = rX`; declare them anyway, as `InstalledDependents` does. An offline
`alc` 18.1 compile accepted the fields and the `Permissions` line.

## Tests

Client, red per direction, with a fake backend and a fake clock: no call on a first publish; a read failure of "installed" warns; base set minus; empty set makes no call; the installed version is named, and a newer published
build is not the base; `dependents: []` and `{error}` still run the step; a row per item, malformed answers throw, a short answer warns; owner target passes; `unresolved` warns, so a failed join on the target's own row cannot
refuse; a dependent compared passes, and a dependent NOT compared goes to its package; a lead with a real clash refuses from the package, zero deploys by call counter; a lead with no real clash passes; `Moved` on the other side warns;
unreadable lead warns; a blind kind warns; a case-only field name passes; a wrong `TableName` passes; two table ids warn; same id in another kind passes; the budget warns and never refuses; `MaxMs` is sent; batches split at 200.

AL: `alc` offline, and a source test in `control-app-source.test.ts`. Whether the actions are right needs Part 2.

## Part 2, on the orchestrator's word

Needs the bc1 restart first, and no overlap with R-833's or R-836's BC gates. A probe on one scratch pair, on a leased server: T and unrelated X both extend Customer, and X holds one object of each of the 13 kinds; read each through
`AllObj` and `AllObjWithCaption`, and fields through `Field`, on the ladder above. That settles read cost, visible kinds, whether a tableextension field names X, the join on a dev-published app, `SetRange(FieldName)`'s case, and what a
published-not-installed app shows. Then bump, setup pin, publish to `bc1`-`bc3`, `bc4` when up, and `bc-demo`; the hang gate; the proof table redone per server. About 14 gates on each of 3 servers, under an hour a server when none is held up: a morning, if the slots are free.
