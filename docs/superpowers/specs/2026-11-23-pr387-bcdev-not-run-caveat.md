# PR-387 pre-commitment: the not-run-at-baseline survivor caveat (PR-381) for the bcdev backend

Written 2026-11-23, before the build. Rulings q-20261123T112833-7e045797 and q-20261123T113133-f6b3d303 ("the reason a
survivor is unknown does not depend on how it was found"). Builds on PR-381 (preproc,
`docs/superpowers/specs/2026-11-23-pr381-refused-test-survivors-caveat.md`, its amendments), with the interface agreed in
writing (`/coord/handoff/PR-386/interface.md`; PR-381 amendment 3: the backend-neutral field). Integration and the gate runs
follow once PR-381 lands.

## What PR-381 gives (agreed with preproc, 2026-11-23)
- A backend-neutral report field `notRunAtBaseline: string[]` (qualified test names). A report that measured its baseline
  ALWAYS writes it: `[]` means "measured, none". ABSENT means "not recorded" (an older report).
- `notRunSurvivors(report)` (one argument; the `reaches` hook removed, since PR-386 closed as "no gain") fires on ANY
  backend whose report fills the field non-empty and has at least one `survived` or `known-survivor` row.
- In PR-381 only al-runner-v3 writes the field, and only v3 prints "not recorded" for an absent field.

## What this PR adds
1. **bcdev fills `notRunAtBaseline`**, `[]` when none, from its baseline rows' existing classification
   (`baseline-batch-finished` `verdicts[].classification`, `BASELINE_CLASSIFICATIONS` in events.ts). Counted, the tests bcdev
   could not run at baseline:
   - `tests-testpage-refused` (R-236c: refused from source before sending, a synthetic `skip` row);
   - `tests-testpage-unsupported` (BC refused a TestPage in the fenced session);
   - `tests-permission-refused`;
   - `baseline-test-stopped` (R658: a baseline run our stop ended), and a baseline `outcome === "timeout"` row (no bcdev
     path to one without a stop state is known; kept for safety);
   - a baseline `skip` of any origin (the hub maps `skipped` to `skip`);
   - **a baseline row whose test body never ran (spec review SERIOUS 2):** a second `pre-dispatch-rejected` after
     `runOnce`'s retry, `completed-effect-unknown` (a malformed 2xx, a 500 after send), R139's line-count answers
     (`isRunMutantLineCountMessage`, already `bodyNeverRan`), and the hub's `isToolError` / `NO_RESULT_FOR_METHOD` rows. These
     reach the event as a plain `error`, so they get an explicit key: an optional **`notRun: true` on the
     `baseline-batch-finished` verdict**, set in `scoreBatch`'s classification block where the `TestVerdict` still exists
     (`b.verdict.operation !== undefined || bodyNeverRan`), and set by `runOnHub` on the two hub rows. Never inferred from
     message text. This ripples into the stream schema (`bun scripts/generate-schemas.ts`; an added optional property, so
     older streams validate).
   - A bcdev `deadline-exceeded` ends the baseline (`dispatchUnmutated` returns `stop`) and never reaches the event: no
     class needed.
   - **Not counted:** a test that ran and failed or errored with its own assertion or runtime error (red on BC too), and
     `stale-test-app` (a refusal of the whole session, which `StaleTestAppError` stops before any verdict).
2. **The "not recorded" text extends to bcdev:** a bcdev report with no `notRunAtBaseline` (written before this PR) says
   "tests not run at baseline: not recorded in this report" wherever PR-381's readers print it, never silence.
3. **`sharingACodeunit` is omitted on bcdev:** its source is v3's `[v3-refused-test-nearby]` tag, which bcdev has no
   counterpart for (the same shape as PR-381's coverage-off rule).
4. **The sentence names the backend that did not run the tests** (preproc, after PR-381 round 2, 4dde9eb5c): PR-381's
   "N tests v3 did not run at baseline (refused, timed out or stopped ...)" becomes, on bcdev, "N tests BC could not run at
   baseline in LethAL's session (TestPage or permission refusals, timed out or stopped ...)". v3's text is unchanged, so
   PR-381's exact-sentence tests stay green; every surface PR-381 lists prints the bcdev form for a bcdev report.
   - **The two interpretations too (spec review SERIOUS 1):** `CAVEAT_INTERPRETATIONS["survivors-beside-unrun-tests"]` and
     `NOT_RUN_NOT_RECORDED_INTERPRETATION` say "This is an al-runner-v3 run ... run on BC to narrow". Both are rewritten
     backend-neutral (a test a backend could not run kills nothing; to narrow, run the survivors where those tests run: BC's
     client session for TestPage tests, BC for v3 refusals). The explain schema's frozen text and `agent-contract.test.ts`
     move with them, listed in the build.
5. Nothing else: no verdict changes, no new report field, no new Caveat (PR-381's `survivors-beside-unrun-tests` is reused).
   The one new shape is the optional `notRun` on the stream event's baseline verdict (item 1).

## Predictions: every BC gate scanned (memory: operator-change-full-gate-scan)
- **No baseline file moves.** Every `packages/runner/itest/*.baseline.json` holds per-mutant rows only (key, verdict,
  killingTest, errorClass, coverageFiltered), and no verdict changes. So no R332 re-record.
- **No existing assertion breaks.** Every BC itest reads caveats with `.includes(...)`, never an exact list.
- **Which reports gain the caveat:**
  - **itest:tables gains it:** `notRunAtBaseline` = `["Data Tests.PageActionComputesNonZero"]` (the one static TestPage
    refusal; `/coord/handoff/PR-387/testpage-scan.ts` finds exactly that one in `sandbox-data-tests`), `survivors` 83 (its
    frozen 342 / 83 / 25), `notRunTests` 1, no `sharingACodeunit`. The gate gains these as assertions, and its page says so.
  - **itest:hang gains none:** its BASELINE leg stops `SleepsPastTheBaselineBudget` (so its `notRunAtBaseline` names it),
    but the gate asserts every mutant there besides the `DrainQueue` kill is `no-coverage`: 0 survivors, so no caveat.
    ON, SINGLE and OFF run at the 120 s default with a green baseline: `[]`.
  - **itest:chunked gains it too (spec review SERIOUS 3):** it runs `fixtures/sandbox-data` with `sandbox-data-tests`
    (`ONLY` narrows source files, not tests), so both legs get `["Data Tests.PageActionComputesNonZero"]` and the caveat,
    with each leg's own survivor count (11 per the review; confirmed from the legs' reports at the run). Both legs must
    carry the same list and count (chunking is a cost knob). It asserts no caveat today, so nothing breaks; the figures
    are added as assertions.
  - **itest:verify-scale** (sandbox-data too) gains it on every report it builds with survivors; it asserts no caveat.
  - **Every other BC gate gains none, with `notRunAtBaseline: []`:** bcdev, bcdev-names, bcdev-wrapped, lease,
    stale-publish, harden, testapp, verify, agreement, lend, envtool. Their fixtures' test apps have no TestPage refusal
    (offline scan: sandbox-tests, -hang-tests, -harden-tests, -names-tests, -wrapped-tests: 0; only sandbox-data-tests uses
    TestPage at all), and hang ON/SINGLE/OFF, harden, lend L0, envtool, verify-agreement, bcdev, names and wrapped already
    assert `baselineGreen` (every row `pass`).
  - A gate whose report differs from this (a caveat where none is predicted, or a different list) is a STOP: explained by
    name before anything is recorded.
- **Offline surfaces that move, deliberately:**
  - **`report-equality`'s snapshot moves more than one key (spec review SERIOUS 3):** its bcdev fixture feeds
    `baseline-test-stopped`, `tests-permission-refused` and `tests-testpage-unsupported` rows beside 4 survived and 1
    known-survivor. So the snapshot gains a 3-name `notRunAtBaseline`, `survivorsBesideUnrunTests`
    `{ survivors: 5, notRunTests: 3 }` (no `sharingACodeunit`), and `survivors-beside-unrun-tests` in `validity.caveats`.
    One `bun test --update-snapshots` of that file; the diff is reviewed against exactly these three changes.
  - The committed gift-card sample (bcdev) predates the field, so it is an older report: it still validates (the field is
    optional) and is not regenerated; its readers now print "not recorded". That line stays OFF the `score:` line, which
    `agent-contract`'s README test reads by regex (LOW).

## Tests (red-checked in each direction)
1. bcdev with a `tests-testpage-refused` row and a survivor: the caveat, `notRunTests` 1, the exact sentence; that row's
   class removed: `[]` and no caveat. (PR-381's test 4, "bcdev: no caveat", turned around.)
2. Each counted class alone (`tests-testpage-unsupported`, `tests-permission-refused`, `baseline-test-stopped`, a plain
   baseline `timeout`, a transport failure) gives the caveat.
3. A bcdev baseline whose only non-green test FAILED by assertion: `[]`, no caveat. `stale-test-app` alone: not counted.
4. A not-run test with only kills, errors and no-coverage rows: `notRunAtBaseline` filled, no caveat.
5. An older bcdev report (no field): "not recorded" on every surface PR-381 prints it; a bcdev report with `[]`: no text.
6. bcdev omits `sharingACodeunit`; v3 is unchanged (PR-381's tests stay green).
7. Each surface prints the bcdev sentence for a bcdev report and the v3 sentence for a v3 report (both directions).
8. **Against empty-vs-empty (LOW):** PR-381's `buildReport` writes the field only for `caps.kind === "al-runner-v3"`, so a
   fold-level or hand-built-event test could pass with that gate shut. One `runSession` test with a fake bcdev backend and a
   real refusal (a `testPageRefused` entry, and a permission message) asserts the exact list; one green-baseline
   `runSession` test asserts the key is PRESENT and equal to `[]` (`"notRunAtBaseline" in report`), since test 5's "no text"
   would also pass with the field absent.
9. Each body-never-ran kind (item 1) sets `notRun: true` on the event and counts; a red test's `error` does not.

## Spec review (spec-adversary, 2026-11-23, before commit)
No false-kill door (no verdict changes). 3 SERIOUS, folded in: the v3-only sentence and interpretations (item 4), no key
for body-never-ran rows (item 1's `notRun`), wrong gate predictions (chunked and verify-scale gain it; report-equality moves
three keys). LOWs folded: the `skip` of any origin, the gift-card `score:` line, the two `runSession` tests.

## Checks
VERIFY (one at a time), spec-adversary review, Opus build review, selectLegs' gates (each BC gate the diff selects, tables
and hang among them, with the figures above), CI. The gate runs wait for PR-381 to land.
