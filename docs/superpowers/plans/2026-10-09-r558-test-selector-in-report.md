# R-558 plan r2: record al-runner's test selector in the SessionReport (lethal-preproc, 2026-10-09)

**r2 changes** (opus plan review r1, `review-opus-plan-r1.md`; this section overrides the r1 text below where they
differ):
- **itest legs.** cli-default runs `--server` plus resource, so it is on the ABSENT side. Present on: main, layout,
  multiobject, wrapped and the symbols one-shot legs. Absent on: every `--server` leg (server, resource, cli-default).
  The check is done once, in `runOnce`, next to `testSelectorLineFailures(selectorLines, !serverMode)`, with an
  absence check in cli-default's own block.
- **Doc caveat.** The field describes THIS session's al-runner runs. On `--resume`, a batch that logged
  `resume-baseline-reused` took its baseline (coverage and no-coverage verdicts) from the earlier run that warning
  names, which may have used another selector. This is the same caveat as `platformAppsDir`.
- **Wording.** The field is "absent on `--server`". A one-shot run with `selectorMode: "resource"` probes and records
  it.
- **Stream schema.** `schemas/stream-v1.schema.json` is regenerated, `STREAM_SCHEMA_VERSION` stays 1 (consumers ignore
  unknown event types), and the "union of N event shapes" prose is updated.
- **Tests.** The full verify suite runs. Any test comparing whole `executionContexts` entries is updated deliberately
  and listed in the submit note.
- **Extra red-checks:**
  - `exact` mapped to substring;
  - emitting on `not-applicable`;
  - dropping `reason`;
  - attaching the field to the zero-outcome fallback (pinned: probed but scored nothing means no field).
- **Still for the orchestrator:** a ruling on step 7 (not regenerating the committed sample reports).

---


Branch `lethal/r558` from master 302f3824. Step 1 is done: R535 is closed by the orchestrator's ruling (6e3826c0,
roadmap only).

## What exists (measured)
- `runSession` (orchestrator.ts, the R551 block after provisioning) calls `probeExactTestSelector()` once per
  session on the session backend. The probe answers:
  - `exact` (with elapsed ms);
  - `substring` (with elapsed ms and a `reason`);
  - `not-applicable`, which the al-runner backend returns on `--server` (`this.server !== undefined`).
- bcdev has no such probe.
- For `exact` and `substring`, it emits only a `warning` with code `al-runner-test-selector`. Warnings are not folded
  into the report.
- Every worker backend is forced onto the same selector (`useExactTestSelector`), or the session fails. So one value
  describes every directly-measured al-runner verdict of the session.
- The precedent is R147's `platformAppsDir`:
  - `events.ts`: a structured event `al-runner-platform-apps`;
  - `report-fold.ts`: the `alRunnerPlatformAppsDir` accumulator;
  - `report.ts`: `buildExecutionContexts` puts it in `bcFields`, only on non-carried entries and only when
    `!caps.authoritative`.

## Design
New optional fields on `ExecutionContext`, flat like the `bcBuild` / `bcBuildAnnouncement` pair:
- `testSelector?: "exact" | "substring-with-excludes"`: the selector the session's one-shot al-runner runs used.
- `testSelectorReason?: string`: the probe's reason, verbatim. Present exactly when `testSelector` is
  `"substring-with-excludes"`. An `exact` acceptance has no reason to give.

Gating is identical to `platformAppsDir`:
- set only on directly-measured entries, with `!caps.authoritative`;
- never on a carried entry, whose selector belongs to the run it came from;
- absent on bcdev (no probe);
- absent on `--server` and on the resource leg (the probe is `not-applicable` there, so no event is emitted and
  nothing is folded).

The absence is the statement, as with R242.

## Ripple, in CLAUDE.md's order
1. **`events.ts`:** a new event `{ type: "al-runner-test-selector"; selector: "exact" | "substring-with-excludes";
   reason?: string }`, documented like `al-runner-platform-apps`. `orchestrator.ts` emits it next to the existing
   warning. The warning stays unchanged, because the console line and R551's tests read it.
2. **`report-fold.ts`:** an accumulator `alRunnerTestSelector?: { selector; reason? }`, set on the event and passed
   out like `alRunnerPlatformAppsDir`.
3. **`report.ts`:** the `ExecutionContext` fields and their doc, plus a `buildExecutionContexts` parameter added to
   `bcFields` under the same two gates. No banner line: the selector is already printed as a warning during the run.
4. **Schemas:** `bun scripts/generate-schemas.ts` regenerates the published schema. `REPORT_SCHEMA_VERSION` stays 3:
   by R157's rule (report.ts), an added OPTIONAL field is free, and the field is nested, so the pinned root
   `required` set does not change.
5. **`tests/schemas.test.ts`:** the root-required pin is unchanged. I add a pin that `ExecutionContext.testSelector`
   is optional with exactly these two values, and that `testSelectorReason` is an optional string. The
   older-reports expectation is unchanged; the test proves the committed reports still validate.
6. **`report-equality`:** `bun test <file> --update-snapshots` only if the snapshot moves. It should not, because
   none of the fixtures there emits the event; I report either way.
7. **Committed sample reports: NOT regenerated, which needs a ruling.** CLAUDE.md's ripple step exists because a
   REQUIRED field breaks validation of committed reports.
   - This field is optional and creates no new report version, so every committed report stays valid as it is.
   - The samples `schemas.test.ts` reads (gift-card, DO rung2, r85 rung2) are bcdev reports, where the field can
     never appear, so a live regeneration would produce the same shape.
   - It would also re-freeze the gift-card stage, which the orchestrator deferred to the BC stage batch.
   - The only al-runner reports committed (`docs/measurements/r546/ar-*.report.json`) are records of a past
     measurement. Rewriting them would change history.
   - I propose skipping this step. If the orchestrator wants it anyway, the gift-card and credit-limit regeneration
     goes with the BC stage batch.

## Tests (red-checked per direction)
- **Fold:** the event sets the accumulator; with no event there is no accumulator.
- **`buildExecutionContexts`:**
  - an al-runner direct entry gets `exact`;
  - with a substring event, it gets `substring-with-excludes` plus the reason;
  - a carried entry in the same report gets neither;
  - an authoritative (bcdev) backend gets neither, even if fed the event.
- **Orchestrator, with fake backends:**
  - `exact`, then `substring`: one structured event each, with the right value and reason;
  - `not-applicable`: no event and no field;
  - no probe at all (bcdev): no field.
- **End to end** (an existing al-runner fake-backend session test): the report's direct context carries the field.
- **Red-checks, each reverted, gone red, and restored:**
  - drop the emit;
  - drop the fold case;
  - drop the `!caps.authoritative` gate;
  - drop the carried exclusion;
  - map `substring` to `exact`.

## Live: `itest:alrunner`
- One-shot legs (main, cli-default, layout, multiobject, wrapped, symbols one-shot): `testSelector` is present and
  is one of the two values. On the container's c5bbaf89 that is `exact`. The gate asserts presence and validity, not
  the value: the host's pinned c39ad5de may answer differently, and both selectors are correct.
- `--server` and resource legs: absent, asserted the way R242 asserts `platformAppsDir`.
- When the value is `substring-with-excludes`, `testSelectorReason` is present.
- Verdicts unchanged: every frozen baseline must PASS as is. This adds only report fields; no identity or verdict
  moves.

## Out of scope
A `--server` daemon's selector. The daemon has its own test-filter path, and the probe says `not-applicable` there.
That is R558's "absent on `--server`".
