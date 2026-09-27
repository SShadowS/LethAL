# R-236c: TestPage scan census over the GH-06 corpora

Task: `.superpowers/sdd/2026-09-27-R-236c-testpage-pre-refusal/task-2-brief.md`. Harness:
`scripts/r236c-testpage-census.ts`. Run before the R-236c wiring lands, offline, no container.

This page carries corpus names, file paths, counts and offsets only. No source text is quoted:
every `loudErrors` list below is empty, so there is nothing to redact.

## 1. Result in one paragraph

Nine corpora discovered tests and ran the scan clean: zero loud errors on every one. Two are the
main "Cloud" app trees, not their Test siblings, so they legitimately discover zero tests (recorded
as "no tests", not a pass, per the brief). The tenth corpus, `BC.History/BaseApp` (9,620 `.al`
files), **threw** before it could be scored: the underlying WASM parser printed `Aborted()` and the
script's per-corpus `try`/`catch` turned that into a `threw` result rather than crashing the whole
run. That is a real, non-fixture corpus with a hard failure, so per the brief's Step 3 decision rule
this session stops here: Task 4 (wiring the scan into the run path) does not start until the
orchestrator rules. The scanner itself was not touched.

## 2. Instrument

| item | value |
| --- | --- |
| harness | `scripts/r236c-testpage-census.ts`, consuming `discoverTests` (`packages/runner/src/discovery.ts`) and `readTestAppSources`/`analyzeTestPageSources` (`packages/runner/src/testpage-scan.ts`) |
| command | `bun scripts/r236c-testpage-census.ts fixtures/sandbox-data-tests fixtures/sandbox-tests fixtures/sandbox-hang-tests fixtures/sandbox-harden-tests "U:/Git/do-rel2/Cloud" "U:/Git/DC/Cloud" "U:/Git/BusinessCentral.Sentinel" "U:/Git/BC.History/BusinessFoundation" "U:/Git/BC.History/System Application" "U:/Git/BC.History/BaseApp"` |
| run mode | foreground, one process, corpora processed in argv order |
| repo state | `e7d397a` (HEAD at the time of this run) |
| raw output | saved to the session scratchpad (`r236c-census.txt`), reproduced verbatim in §4 below |

## 3. Census table

One line per corpus, in run order. "threw" means the script's `catch` fired instead of the normal
per-corpus report; "-" means the field was never reached for that corpus.

| corpus | files | tests | refused | loud errors | threw | ms |
| --- | --- | --- | --- | --- | --- | --- |
| `fixtures/sandbox-data-tests` | 1 | 68 | 1 | 0 | no | 44 |
| `fixtures/sandbox-tests` | 1 | 2 | 0 | 0 | no | 6 |
| `fixtures/sandbox-hang-tests` | 1 | 5 | 0 | 0 | no | 3 |
| `fixtures/sandbox-harden-tests` | 1 | 6 | 0 | 0 | no | 3 |
| `U:/Git/do-rel2/Cloud` | 554 | 0 (no tests) | 0 | 0 | no | 906 |
| `U:/Git/DC/Cloud` | 1135 | 0 (no tests) | 0 | 0 | no | 2477 |
| `U:/Git/BusinessCentral.Sentinel` | 67 | 54 | 0 | 0 | no | 78 |
| `U:/Git/BC.History/BusinessFoundation` | 104 | 89 | 19 | 0 | no | 278 |
| `U:/Git/BC.History/System Application` | 1718 | 1889 | 209 | 0 | no | 10530 |
| `U:/Git/BC.History/BaseApp` | - | - | - | - | **yes** | - |

`BaseApp`'s thrown message (no source, just the runtime's own text):
`Aborted(). Build with -sASSERTIONS for more info.`

The first four rows are fixtures, listed for completeness per the brief; the decision rule in §5
below is about the six real corpora only (`do-rel2/Cloud`, `DC/Cloud`, `BusinessCentral.Sentinel`,
and the three `BC.History` trees).

## 4. Raw output (verbatim)

```
{"corpus":"fixtures/sandbox-data-tests","files":1,"tests":68,"refused":1,"loudErrors":0,"firstErrors":[],"ms":44}
{"corpus":"fixtures/sandbox-tests","files":1,"tests":2,"refused":0,"loudErrors":0,"firstErrors":[],"ms":6}
{"corpus":"fixtures/sandbox-hang-tests","files":1,"tests":5,"refused":0,"loudErrors":0,"firstErrors":[],"ms":3}
{"corpus":"fixtures/sandbox-harden-tests","files":1,"tests":6,"refused":0,"loudErrors":0,"firstErrors":[],"ms":3}
{"corpus":"U:/Git/do-rel2/Cloud","files":554,"tests":0,"refused":0,"loudErrors":0,"firstErrors":[],"ms":906}
{"corpus":"U:/Git/DC/Cloud","files":1135,"tests":0,"refused":0,"loudErrors":0,"firstErrors":[],"ms":2477}
{"corpus":"U:/Git/BusinessCentral.Sentinel","files":67,"tests":54,"refused":0,"loudErrors":0,"firstErrors":[],"ms":78}
{"corpus":"U:/Git/BC.History/BusinessFoundation","files":104,"tests":89,"refused":19,"loudErrors":0,"firstErrors":[],"ms":278}
{"corpus":"U:/Git/BC.History/System Application","files":1718,"tests":1889,"refused":209,"loudErrors":0,"firstErrors":[],"ms":10530}
Aborted()
{"corpus":"U:/Git/BC.History/BaseApp","threw":"Aborted(). Build with -sASSERTIONS for more info."}
```

## 5. Decision (Step 3 of the brief)

The brief's rule: if ANY real corpus (not a fixture) has `loudErrors > 0` or `threw`, stop, write
and commit the doc and script, return `NEEDS_CONTEXT` with the table, and do not start Task 4.

`BC.History/BaseApp` threw. That satisfies the stop condition. Per the brief, the scanner
(`packages/runner/src/testpage-scan.ts`) was not touched, and Task 4 (wiring the scan into the run
path) was not started.

## 6. Notes

- **Reach sanity check.** On the two corpora that did discover tests and did find refusals,
  `refused`/`tests` is 19/89 (21.3%) for `BusinessFoundation` and 209/1889 (11.1%) for
  `System Application`. Both are the same order of magnitude as the brief's cited reference point
  (Continia Document Output: 9 of 104 test *files* declare a TestPage; not a directly comparable
  ratio, since this census counts refused *tests*, not files declaring a TestPage, and Continia is
  not one of the corpora this run covers). Nothing here suggests the policy is refusing everything
  or refusing nothing.
- **`do-rel2/Cloud` and `DC/Cloud` show `tests: 0`.** Both paths are the corpora's main app tree
  (`Cloud`), not their `Test` sibling directory; the brief's corpus list names `Cloud` specifically,
  so zero discovered tests is the expected shape for that path, not a scan failure. Recorded as "no
  tests" per the brief's instruction, not scored as a pass.
- **The `BaseApp` failure is in the parser, not in the census script's own logic.** `Aborted()` is
  an Emscripten/WASM runtime abort message, printed to the process's output ahead of the script's
  own `catch` handling it as a thrown `Error`. The script's per-corpus `try`/`catch` worked as
  designed: one corpus's failure did not stop the other nine from being scored, and did not crash
  the `bun` process. `BaseApp` is confirmed at 9,620 `.al` files (`find ... -iname '*.al' | wc -l`),
  matching the brief's "~9,600 files" estimate for the largest corpus in the set.
- No attempt was made to diagnose or fix the abort. Per the brief, that decision belongs to the
  orchestrator's ruling, not this task.
