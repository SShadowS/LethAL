# Standard Mutation-Testing Report Schema (E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a report in the shared `mutation-testing-report-schema` format, so a LethAL run renders in the standard off-the-shelf HTML viewer that StrykerJS, Stryker.NET and Stryker4s reports already use.

**Architecture:** A pure mapper turns a `SessionReport` into the schema's shape, and a new CLI flag writes it. `--out` is untouched. Because the schema requires each file's full source, the output is a local-only artifact that the repo's redactor refuses outright rather than pretends to clean.

**Tech Stack:** Bun, TypeScript, `bun:test`, biome. No new runtime dependencies; the schema itself is vendored as a pinned JSON file for validation only.

**Spec:** `docs/superpowers/specs/2026-08-26-excluded-sites-and-report-schema-design.md` (§2)

**Depends on:** A, landed. `SessionReport.excludedSites` exists and is the source of this format's `Ignored` entries.

## Global Constraints

- **The schema's `required` sets are fixed and non-negotiable.** Root: `["schemaVersion", "thresholds", "files"]`. Each file: `["language", "source", "mutants"]`. Each mutant: `["id", "mutatorName", "location", "status"]`. `MutantStatus` is exactly `Killed | Survived | NoCoverage | CompileError | RuntimeError | Timeout | Ignored | Pending`.
- **`source` is REQUIRED per file.** A schema-valid report structurally cannot exist without the target's AL source embedded. This is the constraint that shapes the whole task, not a footnote.
- **This repo is PUBLIC.** The 2026-08-09 ruling: filenames, paths, procedure names and test names are publishable; source is not. A schema-format report is therefore never committed, and `scripts/redact-campaign-report.ts` must REFUSE it rather than appear to clean it (a blanked `source` is still schema-valid but renders nothing, so "redacted" would be a lie in both directions).
- **`--out` must not change.** It keeps writing `SessionReport` via `writeJsonReport`. The new format gets its own flag.
- Adding a flag means adding it to `RUN_FLAGS` in `cli.ts` AND to the help text; `packages/runner/tests/agent-contract.test.ts` derives its known-flag set from `RUN_FLAGS` and reddens on drift.
- No `!` non-null assertions. `exactOptionalPropertyTypes` is ON; build optional props with `...(v !== undefined ? { k: v } : {})`.
- Comments cite greppable NAMES, never `file.ts:123`. `scripts/line-citations.test.ts` enforces it.
- **ASCII only** in code and comments you add. A raw Windows-1252 byte for an em dash once made biome refuse an entire file.
- Build loop order: `bun run typecheck`, THEN `rm -rf packages/*/dist`, THEN `bun test`. Baseline is 2558 pass / 1 skip / 0 fail.
- Lint what you touched: `bunx biome check <paths>`.
- **Never run anything that contacts a Business Central container.** Every task here is offline.

---

### Task 1: Vendor the schema, pinned

**Files:**
- Create: `schemas/vendor/mutation-testing-report-schema-2.0.0.json`
- Create: `schemas/vendor/README.md`
- Test: `packages/runner/tests/standard-report.test.ts` (created here, extended by later tasks)

**Interfaces:**
- Produces: a committed, version-pinned copy of the published schema that Task 4 validates against.

> **Why vendor rather than fetch.** Validating against a URL makes the test suite depend on the network and on a third party not changing a file under us. The repo already vendors `tree-sitter-al` for the same reason. A pinned copy also makes a schema bump a reviewable diff instead of a silent behaviour change.

- [ ] **Step 1: Fetch and commit the schema**

Download `https://raw.githubusercontent.com/stryker-mutator/mutation-testing-elements/master/packages/report-schema/src/mutation-testing-report-schema.json` and save it verbatim to `schemas/vendor/mutation-testing-report-schema-2.0.0.json`. Do not reformat it.

Write `schemas/vendor/README.md` recording: the source URL, the date fetched, the version, and the rule that this file is never hand-edited. State that a bump is a deliberate, reviewed change because it can alter what validates.

- [ ] **Step 2: Assert the pinned facts, so a silent swap reddens**

Create `packages/runner/tests/standard-report.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

const SCHEMA = await Bun.file(
  "schemas/vendor/mutation-testing-report-schema-2.0.0.json",
).json();

// The vendored schema is a third-party contract. These are the parts this repo's mapper depends
// on, pinned so that replacing the file with a different version reddens here and names what
// moved, instead of silently changing which reports validate.
describe("the vendored mutation-testing report schema", () => {
  test("root requires schemaVersion, thresholds and files", () => {
    expect(SCHEMA.required.sort()).toEqual(["files", "schemaVersion", "thresholds"]);
  });

  test("every file requires language, source and mutants", () => {
    expect(SCHEMA.definitions.fileResult.required.sort()).toEqual([
      "language",
      "mutants",
      "source",
    ]);
  });

  test("source is required, which is why this format is never committed", () => {
    expect(SCHEMA.definitions.fileResult.required).toContain("source");
  });

  test("every mutant requires id, mutatorName, location and status", () => {
    expect(SCHEMA.definitions.mutantResult.required.sort()).toEqual([
      "id",
      "location",
      "mutatorName",
      "status",
    ]);
  });

  test("the status enum is exactly the eight we map onto", () => {
    expect(SCHEMA.definitions.mutantStatus.enum.sort()).toEqual([
      "CompileError",
      "Ignored",
      "Killed",
      "NoCoverage",
      "Pending",
      "RuntimeError",
      "Survived",
      "Timeout",
    ]);
  });
});
```

If any of these paths do not exist in the fetched file (the schema may nest definitions differently), adjust the accessor to the real shape and say so in your report. **Do not weaken an assertion to make it pass** — the point is that these five facts are pinned.

- [ ] **Step 3: Verify and commit**

```bash
bun test packages/runner/tests/standard-report.test.ts
git add schemas/vendor/ packages/runner/tests/standard-report.test.ts
git commit -m "chore(schema): vendor the mutation-testing report schema, with its contract pinned"
```

---

### Task 2: The verdict-to-status mapper

**Files:**
- Create: `packages/runner/src/standard-report.ts`
- Test: `packages/runner/tests/standard-report.test.ts` (extend)

**Interfaces:**
- Consumes: `MutantVerdict` and `MutantErrorCause` from `./store` and `./report`.
- Produces: `export function statusOf(outcome): MutantStatus` and the `MutantStatus` type. Task 3 uses it.

> **Why this is its own task.** The mapping is where a wrong decision becomes invisible: a verdict silently mapped to the wrong status produces a plausible report that misleads. It is also the only part with a real judgement call in it (`known-survivor`), and it deserves its own review.

- [ ] **Step 1: Write the failing test**

Append to `packages/runner/tests/standard-report.test.ts`:

```ts
import { statusOf } from "../src/standard-report";

describe("verdict to MutantStatus", () => {
  test("the four straightforward verdicts", () => {
    expect(statusOf({ verdict: "killed" })).toBe("Killed");
    expect(statusOf({ verdict: "survived" })).toBe("Survived");
    expect(statusOf({ verdict: "no-coverage" })).toBe("NoCoverage");
    expect(statusOf({ verdict: "timeout-killed" })).toBe("Timeout");
  });

  test("a carried survivor is Survived, not Pending", () => {
    // `known-survivor` means a prior run recorded it surviving and this run did not re-execute it.
    // It is reported Survived because that is what was measured; the fact that it was carried
    // rather than re-run belongs in statusReason, not in a different status. Pending would claim
    // the mutant is still queued, which is false.
    expect(statusOf({ verdict: "known-survivor" })).toBe("Survived");
  });

  test("an error maps by cause, and a compile culprit is CompileError", () => {
    expect(statusOf({ verdict: "error", cause: "unstable" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", cause: "stranded" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", cause: "deadline-exceeded" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", cause: "result-lost" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", compileCulprit: true })).toBe("CompileError");
  });

  test("an unknown verdict throws rather than defaulting", () => {
    // Fail loudly on a caller-contract violation: a new MutantVerdict must force a decision here,
    // not silently become whatever the default was. Empty-vs-empty agreement is this project's
    // signature bug.
    expect(() => statusOf({ verdict: "invented" as never })).toThrow(/unmapped verdict/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/runner/tests/standard-report.test.ts`
Expected: FAIL, cannot resolve `../src/standard-report`.

- [ ] **Step 3: Implement**

Create `packages/runner/src/standard-report.ts` with the `MutantStatus` union and `statusOf`. The `error` branch reads `cause`; the compile-culprit branch is driven by an explicit flag rather than by sniffing a message. **The default branch throws**, naming the verdict:

```ts
throw new Error(
  `unmapped verdict ${JSON.stringify(verdict)}: the standard report schema needs an explicit ` +
    "MutantStatus for every MutantVerdict. Add one here rather than letting it default.",
);
```

- [ ] **Step 4: Verify**

```bash
bun test packages/runner/tests/standard-report.test.ts
bun run typecheck
rm -rf packages/*/dist
bunx biome check packages/runner/src/standard-report.ts packages/runner/tests/standard-report.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/standard-report.ts packages/runner/tests/standard-report.test.ts
git commit -m "feat(report): map every MutantVerdict onto a standard-schema MutantStatus"
```

---

### Task 3: The mapper, including Ignored and locations

**Files:**
- Modify: `packages/runner/src/standard-report.ts`
- Test: `packages/runner/tests/standard-report.test.ts` (extend)

**Interfaces:**
- Consumes: `statusOf` from Task 2; `SessionReport` including `excludedSites` from A.
- Produces: `export function toStandardReport(report: SessionReport, sources: ReadonlyMap<string, string>): StandardReport`. Task 4 writes its output.

> **Sources are passed in, not read.** The mapper stays pure and testable; the caller does the I/O. That also makes the "this embeds source" decision visible at the call site rather than buried.

- [ ] **Step 1: Write the failing tests**

Cover, with concrete expected values:

```ts
describe("toStandardReport", () => {
  test("groups mutants by file and emits the required root fields", () => {
    // schemaVersion, thresholds, files all present; language "al" on each file.
  });

  test("location is 1-based with an exclusive end, derived from byte offsets", () => {
    // A mutant at a known startIndex/endIndex against a known source string maps to the
    // line/column pair a human would count. Include a multi-line source so the row arithmetic
    // is actually exercised.
  });

  test("coveredBy, killedBy and statusReason carry the report's own fields", () => {
    // coveringTests -> coveredBy; killingTest -> killedBy; killingTestFailure -> statusReason.
  });

  test("testsCompleted is present and may be less than coveredBy on a kill", () => {
    // The covering-test loop breaks on the first confirmed kill, which is exactly why this field
    // exists in the schema.
  });

  test("every excludedSites row becomes an Ignored entry with its reason", () => {
    // An excluded FILE with no mutants still appears, so the refusal is visible in the viewer
    // rather than being an absence a reader must notice.
  });

  test("a file with no source supplied throws rather than emitting an invalid report", () => {
    expect(() => toStandardReport(report, new Map())).toThrow(/no source for/);
  });
});
```

The last one matters: `source` is required by the schema, so a missing entry must fail loudly rather than emit `""` and produce a report that validates but renders nothing.

- [ ] **Step 2: Run, watch fail, implement, run again**

Standard TDD cycle. Run `bun test packages/runner/tests/standard-report.test.ts` between each.

- [ ] **Step 3: Commit**

```bash
git add packages/runner/src/standard-report.ts packages/runner/tests/standard-report.test.ts
git commit -m "feat(report): map a SessionReport onto the standard schema, refusals included"
```

---

### Task 4: Validate real output against the vendored schema

**Files:**
- Test: `packages/runner/tests/standard-report.test.ts` (extend)

> **This is the task that makes the other three trustworthy.** Unit tests on a mapper prove it does what its author expected. Validating its output against the third-party schema proves it does what the ecosystem expects, which is the whole point of adopting the format.

- [ ] **Step 1: Validate a report written by THIS build**

Follow the pattern in `packages/runner/tests/schemas.test.ts` ("a report written by THIS build validates against the report schema") — read it first and reuse its validator rather than adding a second one.

Build a `SessionReport` through the existing fold harness (`packages/runner/tests/report-equality.test.ts` and `operator-filter.test.ts` both have one), map it, and assert the result validates against the vendored schema.

- [ ] **Step 2: Prove the validator can fail**

```ts
test("the validator FAILS a document it should fail, or every test above is vacuous", () => {
  const invalid = { ...valid, files: { "a.al": { language: "al", mutants: [] } } }; // no source
  expect(validate(invalid)).toBe(false);
});
```

`schemas.test.ts` already carries a test with this exact name and reasoning. **Do not skip it.** A validator that accepts everything makes Step 1 meaningless, and that failure mode has been hit in this repo before.

- [ ] **Step 3: Commit**

```bash
git add packages/runner/tests/standard-report.test.ts
git commit -m "test(report): standard-schema output validates, and the validator can fail"
```

---

### Task 5: The flag, and the guards that keep the format out of the repo

**Files:**
- Modify: `packages/runner/src/cli.ts` (`RUN_FLAGS`, the help text, the write call)
- Modify: `scripts/redact-campaign-report.ts`
- Modify: `.gitignore`
- Test: `scripts/redact-campaign-report.test.ts`, `packages/runner/tests/standard-report.test.ts`

**Interfaces:**
- Consumes: `toStandardReport` from Task 3.

- [ ] **Step 1: Add the flag**

Add `"standard-report": { type: "string" }` to `RUN_FLAGS`, and a matching help line. Both are required: `packages/runner/tests/agent-contract.test.ts` derives its known-flag set from `RUN_FLAGS` and reddens if help and flags drift.

Write it beside the existing `--out` call:

```ts
if (parsed.outPath !== undefined) await writeJsonReport(report, parsed.outPath);
if (parsed.standardReportPath !== undefined) {
  await writeStandardReport(report, parsed.standardReportPath, cfg.projectDir);
}
```

`writeStandardReport` reads each file's source from disk and calls `toStandardReport`. The help text must say the output embeds the project's source and is not for committing.

- [ ] **Step 2: Gitignore the conventional filename**

Add `mutation-report.json` (and any default you choose) to `.gitignore`. State the reason in a comment: the format embeds target source, and this repo is public.

- [ ] **Step 3: Teach the redactor to REFUSE the format**

`scripts/redact-campaign-report.ts` currently throws on a file with no `mutants` array ("a report shape this script cannot read is a report it cannot certify"). A standard-schema report has no top-level `mutants`, so it already throws — but with a misleading message that says it is not a SessionReport.

Detect it explicitly (root `schemaVersion` plus `files`) and refuse with a message that says what it actually is and why it must not be committed at all, rather than implying it could be cleaned.

- [ ] **Step 4: Assert no such report is committed**

Extend `scripts/redact-campaign-report.test.ts`, mirroring how it already asserts the two committed campaign reports stay clean: walk the repo and assert no tracked file is a standard-schema report. Assert BY SHAPE (root `schemaVersion` + `files` + a file entry carrying `source`), not by filename, because a filename check passes against a file someone renamed.

- [ ] **Step 5: Full verification and commit**

```bash
bun run typecheck
rm -rf packages/*/dist
bun test
bunx biome check packages/runner/src/cli.ts scripts/redact-campaign-report.ts
```
Expected: 2558+ pass, 0 fail.

```bash
git add packages/runner/src/cli.ts scripts/redact-campaign-report.ts scripts/redact-campaign-report.test.ts .gitignore packages/runner/tests/standard-report.test.ts
git commit -m "feat(cli): --standard-report, with the guards that keep source out of this repo"
```

- [ ] **Step 6: Red-check the guard**

The commit-blocking guard from Step 4 is the one that protects a public repo, so prove it fires. Write a standard-schema report into the working tree, `git add` it, run the test, confirm it goes RED naming the file, then remove it and confirm green. **Report both outputs.** A guard never seen firing is not a guard.

---

## Self-Review

**Spec coverage.** §2.1 the format → Task 1. §2.2 the `source` constraint and all four of its consequences → Task 5 steps 2, 3, 4 and the local-only flag in step 1. §2.3 the mapping table → Tasks 2 and 3, with `known-survivor` (the spec's open question 1) decided in Task 2 step 1 and the reasoning written into the test. §2.4 JSON only, no bundled viewer → no task builds one, deliberately. §2.5 gates → Task 1 step 2, Task 4, Task 5 steps 4 and 6.

**Open question resolved by this plan.** The spec left `known-survivor` as `Survived` or `Pending`. This plan decides `Survived`, and puts the reasoning in the test rather than in a comment that can drift: `Pending` would claim the mutant is still queued, which is false.

**Placeholders.** Task 3 step 1 gives test names and the assertion each must make rather than full bodies, because the expected values depend on the fold harness's fixture, which the implementer reads in that step. Every other code step carries its code.

**Type consistency.** `statusOf` and `MutantStatus` are spelled identically in Tasks 2, 3 and 4. `toStandardReport(report, sources)` is spelled identically in Tasks 3, 4 and 5. `writeStandardReport` appears only in Task 5, which is also where it is defined.
