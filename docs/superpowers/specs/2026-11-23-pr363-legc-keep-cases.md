# PR-363 pre-commitment v2 (R1152): leg C's serve-keep-reasons gets a case for every keep entry its daemon can produce

Written 2026-11-23, before the build. v2 folds in an Opus spec review of v1 (`/coord/handoff/PR-363/spec-review.md`: 5
SERIOUS, no BLOCK). v2.1 folds in its delta review: the generator runs as a subprocess, and a missing app is `unmeasurable`.
The orchestrator ruled to keep the 9 platform entries in. Measured first on current main-bf3a3e863 (`/coord/handoff/PR-363/`: `families/`, `map.ts`,
`serve-raw.sh`, `serve-raw/`, `map-serve.ts`, `map-serve.json`). Names and numbers only; every cell is invented AL from
`scripts/refusal-family.ts`.

## Why
PERF-10: a reworded Company-table refusal passed every gate, because `SERVE_CASES` judges only some keep entries. The
first full DO run then restarted its daemon 32 times.
- **What has force on the gate:** only `unkept` (R1000) fails the update gate, because it is a refused row no entry keeps.
  `diverged` is a warn line (`classifyLegC`).
- A reworded refusal is an unkept row unless another entry also matches the new text (one cell can match two entries, as
  FieldRef.Class does). So a case per producible entry turns a PERF-10 rewording into a gate-fail.
  A case that merely changes behaviour (a plain pass) shows as `diverged`, a warning.

## What was measured (v1's evidence; it chooses the cells, it does not set the predictions)
1. **Every refusal family, one-shot** (no package cache, no sidecar): 22 families ran, and their refused cells produce 56 of
   the 131 entries.
2. **The same family apps, each FULL app in its own fresh serve daemon** (`serve --test-timeout 3`, no package cache, no
   `ALRUNNER_CACHE`, one request): 48 entries produced, including `company-table-read-named` from `TCompany.FindFirst`, and
   28 refused rows no entry keeps.
- **This differs from the gate in four ways** (review S1): the gate sets `ALRUNNER_CACHE`, runs after the existing request,
  runs a SUBSET of cells, and `emitApp` renumbers a subset.
  - So v1's explanation of R-989's "outside the workspace" (the app layout) is unproven, since the cache also differed.
  - **Hence the predictions are set by step 3 of the build, not by this measurement.**

## The change
- **The same fact `serve-keep-reasons`; the existing request is unchanged.**
- **One more request per family, each on its OWN fresh daemon** (review S2), started exactly as the existing one: the same
  spawn, env (`ALRUNNER_CACHE` included), cwd, flags and `--environment`. A kept daemon carries `GlobalLanguage` (the
  existing request's Danish case), SingleInstance and XML state, and the locale-dependent cells must not inherit it.
- **Each request is judged on its OWN rows** (review S3). Every family app names its tests `Codeunit5100x.Cell`, so rows of
  different requests are never merged. Per request:
  - each chosen case is judged as a `SERVE_CASES` refusal: `notRun`, status `error`, its own entry's regex, with no
    plain-fail or plain-pass allowance;
  - every refused row of the request, judged or not, must be kept, or the fact is `unkept`;
  - a request with no row is `unmeasurable`, and the detail names the family and its `compilationErrors`.
- **The apps (v2.1, after the delta review):** built at gate time by a generator SCRIPT, `scripts/pr363-legc-keep-apps.ts
  --out <dir>`. The itest runs it as a subprocess, the way it runs `scripts/corpus-fingerprint.ts`, since packages and
  itests never import `scripts/`. The itest then passes the folders to the contract (`V3ProbeEnv`).
  - The generator's selector throws by name when a chosen cell (type, method, state) is missing from `FAMILIES`.
  - **A missing app fails loudly:** when `serveKeepReasons` runs with the app folders absent, or with fewer than the
    pre-committed families, the fact reads `unmeasurable` with the reason named. It never runs the old request alone, which
    would read exactly as today. This has a red check.
  - Each app holds only the chosen cells, keeps each cell's MEASURED codeunit id (no renumbering), carries the family's
    support objects at their own ids, and has an app id of its own per family. `emitApp` gets an option for this, and the
    full-app output is unchanged.
- **The chosen cases:** v1's 38, plus the 9 platform-table entries produced in serve (review S5): `license-permission`,
  `api-webhook-entity`, `page-action-promoted-area`, `power-bi-blob`, `power-bi-default-selection`, `media-read`,
  `application-object-metadata`, `permission-set-whole-object-type` and `platform-no-provider`.
  - **That makes 47 new cases.** R1152 had left platform tables out on the belief that they cannot be produced, but they
    are produced. A reworded `platform-no-provider` (239 cells in DO's shape) is PERF-10 again. This departure is flagged
    to the orchestrator.
  - v1's 38, by family:
    - **platform-table-read:** `company-table-read-named`;
    - **untouched-handle:** `fieldref-method-never-assigned` (a non-Class method), `stream-never-created`;
    - **get-url:** `geturl-unpinned-object-type`, `geturl-phone-tablet-desktop`;
    - **table-connection:** `register-table-connection-other-string`, `crm-insert-through-table-connection`;
    - **t9:** `setfilter-value-expected`, `evaluate-decimal-comparison`, `report-parameters-no-xml-declaration`,
      `boolean-false-to-biginteger`, `recordref-method-not-open`;
    - **t10:** `keyref-method-never-assigned`, `setfilter-unexpected-gt-date-range`, `setfilter-date-text-no-form`,
      `setfilter-not-a-biginteger`, `setfilter-empty-term`, `page-run-recordref`, `page-run-unassigned-variant`,
      `recordref-gettable-text-not-a-record`, `report-saveas-id-zero`, `xmldocument-readfrom-not-instream`,
      `outstream-untouched-handle`, `code-gl-to-biginteger`, `calcdate-outside-range`;
    - **t12:** `evaluate-decimal-nul-run`, `conversion-text-to-blob`, `conversion-text-to-integer`,
      `report-saveas2-untouched-handle`, `fieldref-calcfield-not-flowfield`, `action-left-another-row`;
    - **x2:** `recordref-gettable-integer-123`;
    - **y2-xml:** `xml-unassigned-node`, `xml-unassigned-element`, `xml-node-as-content`, `xml-attribute-collection-other`,
      `xml-name-measured-chars`;
    - **y2-collation:** `collation-no-weight-measured`.

## Every other entry, pinned by name with its reason (a test; a new entry in neither list goes red)
- **already judged** by an existing `SERVE_CASES` case (`fieldref-never-assigned` among them);
- **needs the .NET sidecar** (leg C runs without it): every `dotnet-*` entry, `copystream-untouched-to-dotnet`, `zip-*`;
- **needs `--no-client`:** `no-client-*`;
- **needs a dependency app or BaseApp:** the `denial-*` entries (Permissions Mock), `saveas-layout-*`,
  `company-open-subscriber-writes`;
- **produced one-shot only; in serve the cell refuses with a text no entry keeps** (review S4):
  `geturl-company-characters`, `geturl-object-type-or-arguments`;
- **not kept today (R1153's 12, the two above among them):** they stay with R1153 (a);
- **the old wording no cell produces:** `company-table-read`, `company-findset`;
- **no family cell yet:** the rest, each named (a later item may add cells);
- **every one of these stays with PR-244's run-time near-miss warning.**

## The predictions: measured on the built apps BEFORE the gate, then pinned (the hard claims)
- **Step 3 of the build:** after the code and tests are built, a probe script (`/coord/handoff/PR-363/probe-gate-path.ts`)
  calls the new code path with the gate's own env against current main-bf3a3e863. That means the itest's `cacheDir`, its
  spawn and its flags, the existing request first and then each family on its own daemon.
- **Its per-case readings are committed as amendment 1** before any v3 gate runs. Each of the 47 is predicted `refusal` on
  its own entry. A case that reads otherwise is moved to the pinned list by name in amendment 1, never silently dropped.
  - **A cell that gives an unkept row on current comes OUT of its app** in amendment 1, with its reason, since a cell left
    in would fail current's gate.
- **The fact's predicted reading on current:** `diverged`, for the same one reason as today
  (`setfilter-boolean-language-words: MOVED pass`), with NO new unkept row. `warnFacts` is unchanged. bugs' re-gate is
  pinned to 5b3f27102 anyway (no PR-363).
- **No other leg C fact moves.**
- **Older manifest rows** (review LOW): a `--refresh-rows` re-gate of an older build is not run by this task. A row that
  reads `matches` today would read `diverged` (the old Company wording does not match `-named`), and may read `unkept`
  (older XML or GetUrl texts). Amendment 1 says so for each of the 18 `matches` rows, and any refresh is its own
  pre-commitment.

## Red checks
- **A reworded entry:** add a character to `company-table-read-named`'s literal. Its case gives a refused row no entry
  keeps, and the fact reads `unkept` (the force that matters).
- **A non-kept cell added to one app:** `unkept`.
- **Two requests' rows merged** (the S3 bug): a fake that answers by `sourcePaths` with a colliding name makes the test red.
- **A shared daemon** instead of one per family: a fake daemon that counts requests per process makes the test red.
- **A name dropped from the pinned list:** the coverage test goes red.

## Checks
VERIFY (one at a time beside the timed run), Opus build review, CI. Then the full v3 gate on quiet cores, after PR-360's,
with leg C's reading checked per case against amendment 1.
- **Leg C's added wall time** (10 more daemon starts and requests) is measured and reported in the result, since every
  update gate pays it.

## Amendment 1 (2026-11-23, the probe, before any v3 gate): the per-case predictions
- **The probe:** leg C alone, through the real itest (`LETHAL_ITEST_ALRUNNER_V3=1 LETHAL_ITEST_V3_LEGS=C`), at the build's
  WIP head 501b74e2b. That is the gate's exact path: `ALRUNNER_CACHE`, the existing request first, then each family on its
  own fresh daemon with its subset app.
  - It ran on current main-bf3a3e863, on CPUs 12-21 at nice 19, from 03:18:21Z to 03:19:05Z.
  - Log: `/coord/handoff/PR-363/legc-probe.log`. Leg C: PASS (40 s).
- **The reading:** `serve-keep-reasons = diverged | setfilter-boolean-language-words: MOVED pass`, the same one reason as
  current's own gate.
  - The fact's detail lists every new case that is not a refusal (MOVED, UNKEPT or unmeasurable), and it lists none.
  - **So each of the 47 new cases read `refusal` under its own entry, and no family request gave an unkept or missing
    row.** No cell comes out, and no case moves to the pinned list.
- **The predictions pinned for the gate (the hard claims):**
  - `serve-keep-reasons` reads `diverged` with exactly that one MOVED reason and no other detail;
  - each of the 47 cases is a refusal;
  - no unkept row; no family unmeasurable.
- **The other leg C facts:** every one reads as in current's gate log
  (`/work/tools/al-runner-v3/main-bf3a3e863/gate.log`). The only additions are `batch-sequential-carry` and `stop-groups`,
  both `matches`, which come from PR-340 and PR-342 (current was gated before them), not from this change.
- **The cost:** leg C took 40 s here, against 31 s in current's gate. That is one run each under different load, so about
  +9 s is the size, not a measurement. The full gate run reports it again.
- **Older manifest rows:** not re-gated by this task. A `--refresh-rows` would read `diverged` where a row reads `matches`
  today (the old Company wording does not match `-named`), and may read `unkept` (older XML or GetUrl texts). Any refresh is
  its own pre-commitment.
