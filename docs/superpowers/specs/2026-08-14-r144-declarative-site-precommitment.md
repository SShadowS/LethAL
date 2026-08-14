# R144 pre-commitment: the declarative-site count reaches the report, and the fixture grows one

Written 2026-08-14, BEFORE the `itest:tables` run that judges it. Never edited afterwards: a
contradicted prediction is the finding, not a mistake to tidy away.

## 1. What changed

R135 closed by ruling that LethAL does not mutate declarative surfaces, Option C, which is "refuse
the class permanently **and say so in the report**". The refusal was already real. The report said
nothing: `generateMutationSet` counted the dropped sites in a local, emitted one `warn(...)` to
stderr, and threw the number away.

Three changes, all additive:

1. `MutationSetResult.declarativeSites` carries the drops PER FILE (path, object kinds, spec count),
   and the count is recorded before the `specs.length === 0` bail so a page whose only matched sites
   are declarative is still named.
2. `SessionReport.declarativeSites` (`siteCount` / `fileCount` / `files`), a required field with a
   measured zero rather than an absent one, plus the caveat `declarative-sites-dropped`, its
   `CAVEAT_INTERPRETATIONS` entry, and a console callout beside `NOT INSTRUMENTED`.
3. ONE fixture line: `page 79320 "Data Main List"` gains `Enabled = Rec."Modify Count" > 0`.

`REPORT_SCHEMA_VERSION` is deliberately NOT bumped: the field is additive, which that constant's own
doc comment excludes from a bump.

## 2. Why the fixture gained a line

Before this, both fixture projects measured ZERO declarative sites. A gate asserting `siteCount === 0`
would pass identically on a build where the count never reached the report at all, which is the exact
"checked, and there was nothing" misreading R144 was filed to prevent. One real site turns the
assertion into evidence.

The shape was MEASURED, not guessed (2026-08-14, grammar 4.0.x). Of the six declarative shapes
probed, only a page property whose value is a boolean EXPRESSION still produces a dropped spec:

| Shape | Specs dropped |
| --- | --- |
| `Enabled = Rec.Amount > 0` (page property) | 1, by `lethal.conditional-boundary` |
| `SubPageLink = "Header Code" = field("Code")` | 0 |
| `SourceTableView = where(Type = const(Item), ...)` | 0 |
| `TableRelation = Item."No." where(...)` | 0 |
| `DataItemTableFilter = "No." = filter(<> '')` | 0 |
| `RunPageLink = "No." = field("Code")` | 0 |

That matches R135 §6's note that grammar 4.0.x parses single-entry links as `link_value` with named
markers instead of as comparison expressions. The 154-spec figure R135 quotes for Continia Document
Output was measured under the OLD grammar and is not what a re-run would produce today.

## 3. The prediction

Judged against `LETHAL_ITEST_TABLES=1 bun run itest:tables`.

**Unchanged, every one of them.** The fixture line adds no mutant, so nothing may move:

- killed **191**, survived **31**, no-coverage **10**
- 232 deployed mutants, **252** raw specs (`EXPECTED.totalMutantSites`)
- `mutationScore` **191 / 222**
- `untargetedTriggerCount` **0**
- `assertionScreen.discrimination` **`partial`**
- `platformArtifactKills.killedCount` **3**, groups `run-trigger-skipped-insert` (2) and
  `write-txn-codeunit-run` (1)
- exactly ONE baseline failure, `Data Tests.PageActionComputesNonZero`, named in the report
- **`tables.baseline.json` needs no re-recording.** If it does, something moved that must not have,
  and that is the finding rather than a file to regenerate.

**New, and the reason for the run:**

- `report.declarativeSites.siteCount` **1**
- `report.declarativeSites.fileCount` **1**
- the single row is `src/DataMainList.Page.al`, kinds `page_declaration`, sites **1**
- `report.validity.caveats` includes **`declarative-sites-dropped`**

## 4. What was already measured offline, before the run

- `generateMutationSet` over `fixtures/sandbox-data` with the new property present: 23 instrumentable
  files, **252** raw specs, and exactly one declarative row (`src\DataMainList.Page.al`,
  `page_declaration`, 1). Same 23/252 as before the property existed.
- `bun run compile:fixtures`: all 8 fixture projects compile, `sandbox-data` included.
- `bun test`: 2334 pass, 0 fail.
- Red-check, twice, each reverting one specific piece and confirming the specific test goes red for
  the right reason: (a) disabling the per-file collection in `generateMutationSet` turns the
  per-file assertion red with `Expected length: 1 / Received length: 0`; (b) making the fold return
  an empty list turns the fold assertion AND the report/caveat assertion red. Both restored, green.

## 5. What would falsify this

Any verdict moving. The property is declarative, so if a single mutant appears, disappears or
changes verdict, the drop itself is not doing what R135 ruled it does, and that outranks the
reporting change this row is about.

A `siteCount` of 0 with everything else unchanged would mean the count still does not reach the
report on the live path, i.e. the wiring works in unit tests and not in a real session.
