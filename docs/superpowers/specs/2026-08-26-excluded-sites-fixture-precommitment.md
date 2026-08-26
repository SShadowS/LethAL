# Excluded-sites spine, Task 4: a `notInstrumented` fixture that can actually fail

Written before any live run. Nothing below is edited afterwards; the outcome is appended by
whoever runs Step 5 (this agent's scope stops at Step 4; see the header note).

## 0. Why this exists

Tasks 1-3 replaced two duplicated report records (`notInstrumented`, `declarativeSites`) with one
`excludedSites` record, keeping the two as derived views (`notInstrumentedView`,
`declarativeSitesView` in `packages/runner/src/excluded-sites.ts`). The obvious landing proof for
that refactor ("it is verdict-neutral, so all four live gates stay frozen") cannot fail for the
`notInstrumented` half: no itest references `notInstrumented`, and every existing fixture file is a
CARRIER kind (`CARRIER_KINDS` in `packages/schemata/src/compile.ts`), so that population is empty
on every gate run today. `notInstrumentedView` could be replaced with `{ ...view, files: [] }` and
every gate would still pass. `declarativeSites` is already pinned against this failure mode in
`tables.itest.ts`; this task gives `notInstrumented` the same treatment.

The alternative of comparing against committed campaign data does not work either: all nine reports
under `docs/campaign/` have `notInstrumented.fileCount === 0`.

## 1. The fixture, chosen by measuring

`fixtures/sandbox-data/src/DataScopeQuery.Query.al`, `query 79332 "Data Scope Query"`. `query` is
one of the two object kinds (with `xmlport`) that hold executable code (a trigger) but are NOT in
`CARRIER_KINDS`, per that constant's own doc comment ("`xmlport` and `query` are the kinds that
still hold code and still cannot carry it"). It declares one dataitem over `Data Main`, a global
`Threshold: Integer`, and:

```al
trigger OnBeforeOpen()
begin
    if Threshold = 0 then
        Threshold := 10;
end;
```

`Threshold = 0` is a site `lethal.negate-conditional` claims (an `=` comparison), which is the
"reliable choice" the task brief names.

### Step 1 measurement: census script

```
bun scripts/census-operator-sites.ts fixtures/sandbox-data /tmp/sites.json
grep -c "DataScopeQuery" /tmp/sites.json
```

Result: **5** (>= 1 required). The claimed sites, all inside the one trigger:

| operator | span |
| --- | --- |
| `lethal.empty-block` | the whole trigger body |
| `lethal.negate-conditional` | `Threshold = 0` |
| `lethal.shift-integer` | the literal `0` |
| `lethal.remove-assignment` | `Threshold := 10` |
| `lethal.shift-integer` | the literal `10` |

### Step 1 cross-check: the actual code path `tables.itest.ts` runs

The census script has its own site-collection walk, separate from `generateMutationSet`'s (dedup,
the declarative-site filter, the carrier check). To pin the exact value that will land in
`report.notInstrumented`, `generateMutationSet("fixtures/sandbox-data")` was run directly and
offline (no live BC involved; this only parses AL and builds the mutation set, and is the same call
`tables.itest.ts` makes at `const { files } = await generateMutationSet(PROJECT_DIR);`). Output:

```
[lethal] skipped 1 file(s) holding 5 mutation site(s): ... src\DataScopeQuery.Query.al (query_declaration, 5 site(s)).
totalFiles: 29
totalMutantSites (deployed-file specs): 365
skipped (notInstrumented input): [
  {
    "file": "src\\DataScopeQuery.Query.al",
    "kinds": "query_declaration",
    "sites": 5
  }
]
declarativeSites: [
  {
    "file": "src\\DataMainList.Page.al",
    "kinds": "page_declaration",
    "sites": 1
  }
]
```

All 5 raw specs land in `skipped` (the `notInstrumented` input), NOT in `files` (the deployed set).
`totalMutantSites` reads 365, unchanged. `declarativeSites` is unaffected (still 1 file, 1 site):
the query's sites are ordinary executable AL, not declarative page/report properties, so none of
them are dropped by that filter.

### Step 2: offline compile

`bun run compile:fixtures`: **exit 0**, all 12 fixture projects OK, `fixtures/sandbox-data`
included. The query object is syntactically and semantically valid standalone AL.

## 2. Current `EXPECTED` in `tables.itest.ts`, read directly from the file (not restated from any
other document)

| field | value | source line |
| --- | --- | --- |
| `totalMutantSites` | 365 | `tables.itest.ts:235` |
| `counts.killed` | 267 | `tables.itest.ts:335` |
| `counts.survived` | 63 | `tables.itest.ts:418` |
| `counts.noCoverage` | 15 | `tables.itest.ts:457` |
| `untargetedTriggerCount` | 0 | `tables.itest.ts:541` |
| `declarativeSites.siteCount` | 1 | `tables.itest.ts:565` |
| `declarativeSites.fileCount` | 1 | `tables.itest.ts:566` |
| `declarativeSites.file` | `"src/DataMainList.Page.al"` | `tables.itest.ts:567` |
| `declarativeSites.kinds` | `"page_declaration"` | `tables.itest.ts:568` |

(Line numbers are pre-edit, i.e. before this task's own addition to `EXPECTED`, so a future reader
comparing against the file after this commit lands should expect them to have shifted down.)

## 3. Prediction, pre-committed

**All values in section 2 stay UNCHANGED.** This fixture is a non-carrier file, contributes no
deployable mutant (section 1's cross-check already measured this offline), and touches no other
file.

**New**, added to `EXPECTED.notInstrumented`:

```ts
notInstrumented: {
  fileCount: 1,
  siteCount: 5,
  files: ["src/DataScopeQuery.Query.al"],
},
```

matching one row: `{ file: "src/DataScopeQuery.Query.al", kinds: "query_declaration", sites: 5 }`
(path forward-slash-normalized the same way the existing `declarativeSites` assertion already does,
since `generateMutationSet` reports it OS-native: backslash on Windows).

## 4. Reasoning

A non-carrier file's specs are pushed to `skipped` and the loop `continue`s before
`files.push(...)` (`orchestrator.ts`'s `generateMutationSet`). They never reach the instrumented
project, so they cannot be deployed, killed, survived, or counted as no-coverage. A moved
`totalMutantSites` or `counts.*` value after this fixture lands would mean one of two things, both
regressions this task is designed to catch:

- `query` (or the grammar's `query_declaration` node) became a carrier kind without
  `CARRIER_KINDS` being updated to match, i.e. `canCarryMutationSelectorVar` now disagrees with
  reality, or
- the 5 claimed sites were actually claimed in a DIFFERENT file that also carries mutants (a
  parse/scope bug bleeding sites across files, the same shape R70 found).

## 5. What would refuse this build

- `EXPECTED.totalMutantSites`, `.killed`, `.survived`, or `.noCoverage` moving off the section 2
  values.
- `report.notInstrumented.siteCount !== 5` or `.fileCount !== 1`: the operator census on this file
  changed, or the carrier check no longer refuses `query`.
- `report.notInstrumented.files` not containing exactly `src/DataScopeQuery.Query.al`: a
  permanently-empty (or wrongly-named) derived view is the exact failure Task 4 exists to catch,
  which is why Step 4's assertion checks the file list, not just the counts.
- `report.declarativeSites.*` moving off its section 2 values, which would mean the query's
  trigger body is being (mis)classified as declarative.

---

## OUTCOME

Not yet run. Steps 5-7 (the live `itest:tables` run, appending the outcome here, and the
mutation-red-check of the new assertion) are explicitly out of scope for the agent that wrote this
pre-commitment and Steps 1-4; the live gate is reserved for the user to trigger.
