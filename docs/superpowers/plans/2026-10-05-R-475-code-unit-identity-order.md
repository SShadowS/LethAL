# R-475 plan — base fc9ff10a (master with R-464, scheme 22), IDENTITY_SCHEME 24

Status: r2 (sol r1 REVISE folded in: resume-test order, test-order.ts verdict risk, tie-break red check), ready for review. No product commit; worktree = fc9ff10a clean. Tools and raw output:
/coord/handoff/R-475/scratch-copy/ (measure.ts, oppairs.ts, testnames.ts, run-baseapp.sh, *.txt).

## Problem
`numberIdentityOrdinals` (the run-wide numbering a real run uses) and the dead-in-production
`assignIdentityOrdinals` sort FILES with `localeCompare` (host default collation). The generation
hash (`hashSourceSnapshot`) and file discovery (`discoveredRelPaths`) sort by code unit. Ordinals
only matter between twins that share one identity tuple (`hash|object name|scope|op|major`), so the
hazard is a CROSS-FILE twin (same object name in two files, e.g. a table and a codeunit both named
X) whose two file paths order differently under two collations. Then resume on another host gives
twin 0's key to the other twin with the source hash unchanged, R391 rule 1 matches, and a recorded
`killed` lands on an unmeasured mutant: a false kill. Measured in kraken: Bun 1.4.2 default is
en-US (sensitivity variant, numeric false, caseFirst "false", ignorePunctuation false); under "da"
`Z` < `Aa`, under en `Aa` < `Z`. The owner's Windows default is not measured and no longer needs to
be once no identity path calls `localeCompare`.

## Call sites (packages/*/src)
| site | what it orders | class |
|---|---|---|
| schemata project.ts `numberIdentityOrdinals` (file, then operatorName) | run-wide ordinals -> identity KEY | IDENTITY. Only the file compare can move a key; the operator tie-break only orders entries with one file AND one start, which have different tuples (op is in the tuple), so it never moves an ordinal. |
| schemata project.ts `identityOrdinalsOf` (behind `assignIdentityOrdinals`; file, mutantId) | same, test-only today | IDENTITY (dead in prod; fix so it cannot drift) |
| schemata ids.ts `assignMutantIds` (operatorName, same file + same start) | mutant CODE M#### | IDENTITY-adjacent (codes are pinned by gates). Paths already `.sort()` = code unit. |
| schemata components.ts `orderOutermostFirst` (operatorName, same span) | guard nesting order in emitted AL | artifact bytes only, not identity |
| runner test-order.ts:109 (qualified test name tie-break) | covering-test order -> `killingTest`, warm-kill positions | NOT identity, and NOT display-only (sol r1): a warm prefix can hide a cold kill (report.ts session-warm contract), so host collation can change a VERDICT. Out of R-475's scope; filed at build time as its own roadmap item, see open questions |
| runner report-fold.ts:604, :690; report.ts:212, :2493, :2611, :2624; cli.ts:3387; publish-ceiling.ts:331; stale-test-app.ts:251 | report / console / warning order | DISPLAY. Deterministic per host; cross-host report order may differ, verdicts and keys do not. Leave. |
| runner al-runner-cache.ts:89 | al-runner cache version fallback for a non-numeric component | tool selection, not identity. Leave. |
No `Intl.Collator`, `toLocaleLowerCase/UpperCase` in engine/schemata/runner src. Batches: split
by `planArtifacts` over discovery order, already code unit -> batches never move.

## The fix (candidate A, chosen by the decision rule — A moves no gate code)
One exported helper in schemata ids.ts, `compareCodeUnits(a, b) = a < b ? -1 : a > b ? 1 : 0`, used
at the 6 comparators: project.ts x4 (both sorts), ids.ts x1, components.ts x1. Update the
`numberIdentityOrdinals` doc ("source order ... code unit, the order the generation hash uses").
IDENTITY_SCHEME 24 with the doc line: "24: R-475, twins are numbered in code-unit file order (was
the host's default collation), so a cross-file twin pair whose paths differ only in case or
punctuation order can swap ordinals (fixtures, CDO, BaseApp: 0 keys)".
Candidate B (fixed `Intl.Collator("en", {usage:"sort", sensitivity:"variant",
ignorePunctuation:false, numeric:false, caseFirst:"false"})`) equals today on every corpus measured
(0 keys, 0 codes) but keeps ICU-version drift; A has none and also moves 0. A it is.

## Counts (keys = sites whose ordinal differs from today's real `numberIdentityOrdinals`; codes = per-file M#### positions)
| corpus | sites | cross-file twin tuples | A keys/codes | B keys/codes | da | sv | en upper-first |
|---|---|---|---|---|---|---|---|
| every fixtures/* and examples/* project (21 with app.json) | 1,730 | 0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| CDO Cloud | 36,882 | 7 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| CDO Test | 17,826 | 0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| BaseApp Source/Base Application (5,668 files, 59 refused) | 755,964 | 124 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| BaseApp Test (all, 1,515 files) | 947,669 | 0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 |
| synthetic twinproj (scratch-copy/twinproj: table "Twin" in `src/Aa_Twin.Table.al`, codeunit "Twin" in `src/Z_Twin.Codeunit.al`, byte-identical source) | 8 | 4 | 0/0 | 0/0 | **8**/0 | 0/0 | 0/0 |
The synthetic row is the false-kill evidence: a Danish-collation host renumbers every twin of
unchanged source (all 8 keys swap), the generation hash is equal, so R391 rule 1 carries.
`today` was also checked against the real `numberIdentityOrdinals` on every corpus (the script
throws on any difference).
Batches: 0 everywhere (by construction). Operator names: 26 registered, 0 pairs order differently
under localeCompare vs code unit (oppairs.ts), so ids.ts/components.ts change nothing for built-ins
(only a custom operator name differing in case/punctuation could move a code).

## Gate impact
None: no gate fixture has a cross-file twin tuple and no built-in operator pair orders differently,
so no mutant code, batch, key, killPosition, layout `<batch>/<code>`, `*.baseline.json` or
pre-commitment moves. Only literal scheme pins move (below). No live gate needed for identity;
`bun scripts/verify.ts` + typecheck. lethal-preproc (R-443) digests the numbering OUTPUT for marks:
unaffected, but tell them the ordering change lands (scheme 24 -> their marks need `identityScheme` 24).

## Tests + red-checks
1. schemata `numberIdentityOrdinals`: two entries, one tuple, files `src/B.al` and `src/a.al`:
   ordinal 0 is `src/B.al` (code unit). Red on current code (en gives `a.al` 0). Same shape for
   `assignIdentityOrdinals`, and `assignMutantIds` with two synthetic operators `Zop`/`aop` at one
   start (code M0001 = `Zop`).
2. No-collation proof: patch `String.prototype.localeCompare` to return the NEGATED result (try/
   finally restore) and assert ordinals, ids and component order are identical to the unpatched run.
   Red-check: revert the helper at each site in turn; the test goes red per site, EXCEPT the
   `numberIdentityOrdinals` operator tie-break, which cannot change an ordinal (same file and
   start means different tuples). For that one the test asserts the ORDER of the returned Map's
   iteration (operators `Zop`/`aop` at one file and start: `Zop`'s key first), which does go red.
3. Runner cross-collation resume (r2, per sol r1; in r391-cross-file-twin.test.ts, reusing its
   TABLE_AL / CODEUNIT_AL / SiteBackend). Discovery and batching are code-unit ordered, so
   `Aa_Twin.Table.al` EXECUTES before `Z_Twin.Codeunit.al`. Setup: the twin statement in both
   files plus one UNRELATED sentinel site with its own tuple, ordered between them (e.g.
   `M_Sentinel.Codeunit.al`). Run 1 (default collation): Aa's twin answers `fail` -> killed; the
   sentinel answers `abort`, so the run is interrupted BEFORE Z's twin runs. Do NOT strand Z's
   twin itself: stranded-key skipping would mask the bug. Run 2: `--resume`, no edit, with
   `String.prototype.localeCompare` wrapped to pass locale "da" (restore in finally); Z's twin
   answers `pass`. Assert: (a) both runs record the same generation source hash; (b) Aa's kill
   carries (rule 1); (c) Z's twin is actually EXECUTED in run 2 (the backend saw it active) and is
   `survived`, never `killed`. Red on the old code: Danish numbering gives Z ordinal 0, so Z takes
   Aa's key and rule 1 carries `killed` onto it (the false-kill reproduction). Green when fixed.
Red-check each by reverting the specific comparator with the Edit tool; report red and green.

## Scheme 24 literal list (as R-464 moved 21->22)
- packages/schemata/src/project.ts: `IDENTITY_SCHEME = 24` + doc line (23 held by R-446).
- CHANGELOG.md entry.
- docs/using-lethal-from-an-agent.md `"identityScheme": 24` example.
- fixtures/sandbox-harden/lethal.equivalent.json `identityScheme`.
- packages/runner/tests/__snapshots__/report-equality.test.ts.snap (`--update-snapshots` on that file).
- packages/runner/tests/resume.test.ts: the pinned scheme AND the pinned fingerprint hash (+ comment).
- per-test pins: r196-identity, r254-identity, r295-multi-name, r405a-identity,
  r455-record-scope-calls, r459-run-trigger-seam (+ R-464's own, if it pins 22) — `grep -rn
  "IDENTITY_SCHEME).toBe" packages` and `grep -rn '"identityScheme": 22' .` before editing.
- docs/roadmap/R475.md status, ROADMAP.md regenerate.
If R-446 (23) lands first, rebase the text; if it does not, 23 stays "held by R-446".

## Open questions
1. test-order.ts:109 (covering-test tie-break) uses host collation, so the order covering tests
   run in depends on the host. A warm prefix can hide a cold kill (report.ts session-warm
   contract), so this can change VERDICTS, not only `killingTest` and warm-kill positions. 2 name
   pairs in sandbox-data-tests order differently under code unit, so its fix could move
   tables/chunked killPositions or killingTest and needs its own pre-commitment. At build time,
   file it as a new roadmap item on execution-context determinism across hosts (re-check the next
   free id with `ls docs/roadmap/` immediately before writing). Not fixed in R-475.
2. Display sorts: leave (no verdict or key depends on them). Owner may want code-unit reports for
   byte-identical cross-host reports; that would move report-equality snapshot only.
