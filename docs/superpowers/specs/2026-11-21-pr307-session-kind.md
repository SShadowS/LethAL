# PR-307 pre-commitment: label session-kind-sensitive tests, and the `ciSessionKind` setting with no default (R1168)

Coord PR-307 (lethal-code, 2026-11-21).

**The ruling:** q-20261121T205341-a906f8b9. It was kraken applying the owner's mantra (principles 5, 6 and 9). The owner is
asked to confirm it (q-20261121T211549-6b0d2540), and the MERGE waits for that answer.

An Opus spec-adversary reviewed v1 (`/coord/handoff/PR-307/spec-review.md`). Its two blocking findings and four smaller
ones are folded into this v2.

## Why
- **bcdev runs headless; DO's CI runs a client session.** bcdev runs a test inside an ODataV4 call (`GuiAllowed` false).
  DO's CI runs a client session (`GuiAllowed` true).
- **DO's figures** (PR-299): al-runner with a client vs bcdev differ on 60 tests that its GuiAllowed scan predicted as
  session-kind differences. Those 60 already leave out the 100 tests v3 refused, so they are a v3-vs-bcdev measure, not a
  CI-vs-bcdev one.
- **The rule below flags 55 of those 60.** This is an approximate regex sizing, in `/coord/handoff/PR-307/sizing.txt`.
  - How many of DO's tests the rule flags in total, and so its precision, is NOT measured. The build reports the total
    flagged count on DO from the parser.
  - **The 5 it misses** fail with a client and pass headless (an unhandled Confirm in app code). They need a coverage
    join, filed as a new roadmap item.

## The rule: which tests are SESSION-KIND-SENSITIVE, per backend, read from the test app's source by the parser
- **H** (every backend): a discovered test whose `[Test]` attribute run binds `HandlerFunctions(...)`.
  - Only discovered tests are looked up, so a helper's handlers never count.
  - Across `#if` arms the attribute runs are a UNION, so a compiled-out arm's handlers count. That direction is safe (it
    labels more, never fewer), and a test pins it.
- **T** (al-runner-v3 only): `analyzeTestPageModel` (the non-throwing variant of the R-236c scan) refuses the test. The
  reason is `testpage`.
- **U** (al-runner-v3 only): the scan reports an error for the test. The reason is `unreadable`, with the scan's error
  text; an unreadable test counts as sensitive (principle 5).
  - To read errors per test, `analyzeTestPageModel` gains a per-test error map (`errorsByTest`) NEXT TO its existing
    outputs.
  - `errors`, `refused` and `scanTestPageModel`'s throw are unchanged. A test pins bcdev's scan output byte for byte
    before and after.
- **Not T on bcdev:** bcdev already refuses such tests before sending them, and labels them `tests-testpage-refused`. A
  refused test cannot change with the session kind, so the existing label stands.

## The setting
- **The field:** `ciSessionKind: "client" | "headless"`, top level in `lethal.config.json`, in the schema, with no default.
  - It is read and validated in ONE place: the shared config load result (`loadLethalConfigFile`'s result, or the one
    builder every path uses).
  - Every path to `runSession` reads it from there, including the nested recheck's config built from `base`.
  - An invalid value is refused by name.
- **The refusal:**
  - It counts sensitive tests in the run's FINAL test list, after `--tests-only`, the `#if` arm filter, `--exclude-test`
    and the company-write leave-out.
  - When that count is above 0 and the setting is unset, the session is refused before any backend call, by a typed
    `SessionKindUnsetError` (extending `Error` directly).
  - The message names the setting, the count, up to 5 examples with their reasons, and the one-line fix:
    `add "ciSessionKind": "client" (or "headless") to <config path>`.
- **Paths that refuse:** `run` (and `--resume` / `--resume-run`), `campaign`, and lends. Each gets one red test.
- **Paths that never refuse:** `lethal verify` (it does not go through `runSession`), `doctor` and `--dry-run`.

## The label (label, never hide; principle 6)
- **The backend's session kind:**
  - bcdev: `headless`;
  - al-runner-v3: `client`, or `headless` when `alRunnerV3.noClient` is true.
- **The report field:** a new OPTIONAL `sessionKindSensitiveTests: { test, reasons: ("handlers" | "testpage" | "unreadable")[], scanError?: string }[]`.
  It is present only when at least one test is sensitive, and is not root-required.
- **The caveat:** `session-kind-mismatch`, when sensitive tests exist AND the backend's kind differs from
  `ciSessionKind`.
- **Both reach the report through ONE new non-warning event** (the report is folded from events). There is no warning
  event, no mutant note, and no change to any verdict path.
- **The ripple** (as PR-36, 9a5061388, did for a caveat):
  - `events.ts` and the stream schema;
  - `report-fold.ts`;
  - `report.ts` (the type, builder and banner);
  - `bun scripts/generate-schemas.ts` (the report schema regenerated);
  - a new `explain-vN.schema.json` with `EXPLAIN_SCHEMA_VERSION` bumped (R233);
  - the explain required-set pin and the caveat enum list in `tests/schemas.test.ts`;
  - a `schemas/README.md` row;
  - `CAVEAT_INTERPRETATIONS` and its counts in `interpretation.test.ts` and `report.test.ts`;
  - the report-equality snapshot, only if it moves (`--update-snapshots` on purpose).
  - The committed sample reports stay valid, since the field is optional, and are not regenerated.

## Gates: none move
- **bcdev gates** (tables, chunked, verify-scale, bcdev, and the rest): no fixture binds `HandlerFunctions`, and T does not
  apply on bcdev, so no sensitive test, no setting needed and no caveat. The setup script and bc1-bc3 are unchanged.
- **The v3 gate:**
  - `fixtures/sandbox-data-tests`' `Data Tests.PageActionComputesNonZero` is T on v3.
  - The T leg (`legT`, which hand-builds its config) passes `ciSessionKind: "headless"`. That fixture's gates pin the
    headless behaviour.
  - So the leg gets the `session-kind-mismatch` caveat (client vs headless). That is an ADDITION, and caveats are checked
    with `includes()`.
- **The census test, a STOP condition:** over every `fixtures/*-tests` project, T and H give exactly that one test, and the
  scan has `errors.length === 0`.
  - The census runs with each v3 leg's own preprocessor symbols. Optin, order, symbols, multiobject, recheck and layout
    have never been through the scan.
  - If any other v3 leg's fixture has a sensitive or unreadable test, the build STOPS and reports before going on. That
    leg would need the field, and the spec would be amended.
- **The proof:** the full v3 gate on the final head shows identical figures. No BC gate is needed, since nothing changes on
  bcdev, though one may be run as a smoke.
- **DO's configs outside the repo** (`/coord/handoff/R-984/*.json` and the lanes' copies) need `"ciSessionKind": "client"`.
  With it, DO's v3 runs get no caveat (client matches) and bcdev runs get the caveat. This is announced to the lanes at
  the merge.

## Tests (red-going both ways; parser-based; call counters, no wall-clock)
- **H:**
  - a `[Test, HandlerFunctions('ConfirmHandler')]` method is sensitive;
  - a plain `[Test]` is not;
  - a helper with handlers is not;
  - a `#if` arm's handlers are counted (a pinned union).
- **T:**
  - on v3, a TestPage test is sensitive (`testpage`), and a scan-error test is sensitive (`unreadable`, with its text);
  - `analyzeTestPageModel`'s `errors` and `refused`, and `scanTestPageModel`'s throw, are byte-identical to before;
  - on bcdev, the same test is not sensitive (it stays refused, as before).
- **The refusal:**
  - sensitive and unset is refused by name with 0 backend calls, and the message holds the fix;
  - the only sensitive test excluded by `--exclude-test` means no refusal;
  - one test each for `run`, `--resume`, `campaign` and lend;
  - `verify` and `--dry-run` never refuse.
- **Sensitive and set:** the field is listed with its reasons. There is no caveat when the kinds match, and the caveat is
  present when they differ (bcdev with `client`; v3 with `headless`; v3 `noClient` with `client`).
- **None sensitive:** unset runs, with no field and no caveat.
- **An invalid value** is refused.
- **The fixture census**, as above.

## Gates for this change
- An Opus delta review.
- The build, red checks, and an Opus build review.
- VERIFY.
- The full v3 gate.
- CI green.
- R1168's status recorded on the branch, plus the new roadmap item for the coverage-joined rule.
- The MERGE waits for q-20261121T211549-6b0d2540.
