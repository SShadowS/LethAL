# Standard Mutation-Testing Report Schema (E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit a report in the shared `mutation-testing-report-schema` format, so a LethAL run renders in the standard off-the-shelf HTML viewer that StrykerJS, Stryker.NET and Stryker4s reports already use.

**Architecture:** A pure mapper turns a `SessionReport` into the format's shape, typed against the schema package's own generated types so `tsc` enforces conformance at compile time. A new CLI flag writes it. `--out` is untouched. Because the schema requires each file's full source, the output is a local-only artifact that the repo's redactor refuses outright rather than pretends to clean.

**Tech Stack:** Bun, TypeScript, `bun:test`, biome. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-26-excluded-sites-and-report-schema-design.md` (§2)

**Depends on:** A, landed. `SessionReport.excludedSites` exists and is the source of this format's `Ignored` entries.

## What pre-flight established, so no task re-derives it

Every fact below was verified against the installed package and the live schema before this plan was written. Do not re-research them; do check them if something contradicts.

- **`mutation-testing-report-schema@^3.9.0` is ALREADY a devDependency** in `package.json`, installed at `node_modules/mutation-testing-report-schema`. Nothing needs vendoring or fetching.
- Its pinned schema JSON is **byte-identical** to the current upstream master copy (compared by parsed equality).
- It ships **generated TypeScript types** at `mutation-testing-report-schema/src-generated/schema.ts`: `MutationTestResult`, `FileResultDictionary`, `FileResult`, `MutantResult`, `MutantStatus`, `Location`, `Position`, `Thresholds`, `TestFile`, `TestDefinition`.
- `MutantStatus` is exactly `"Killed" | "Survived" | "NoCoverage" | "CompileError" | "RuntimeError" | "Timeout" | "Ignored" | "Pending"`.
- Root `required` is `["schemaVersion", "thresholds", "files"]`.
- `FileResult` is **inlined** at `properties.files.additionalProperties` (there is no `definitions.fileResult`), with `required` `["language", "source", "mutants"]`.
- `MutantResult` is at `...files.additionalProperties.properties.mutants.items`, with `required` `["id", "mutatorName", "location", "status"]`.
- `definitions` contains only `location`, `openEndLocation`, `position`.
- **`schemaVersion` is a STRING** matching `^([1-2])(\.(([1-9]\d*)|0)){0,2}$`, not a number.
- `thresholds` requires `["high", "low"]`.
- **`conformsTo` in `packages/runner/tests/schemas.test.ts` CANNOT validate this schema.** Its `deref` throws on any `$ref` that is not `#/$defs/<name>`, and this schema uses `#/definitions/`. It also uses `dependencies`, `format`, `pattern`, `minimum`, `maximum` and `uniqueItems`, none of which `conformsTo` supports. Its own doc comment says it "must not grow into one". **Task 3 therefore uses the package's TYPES as the conformance mechanism** rather than a runtime validator, and Task 4 hand-checks only the few constraints types cannot express. No JSON Schema dependency is added.

## Global Constraints

- **`source` is REQUIRED per file.** A schema-valid report structurally cannot exist without the target's AL source embedded. This constraint shapes the whole task, not a footnote.
- **This repo is PUBLIC.** The 2026-08-09 ruling: filenames, paths, procedure names and test names are publishable; source is not. A standard-format report is therefore never committed, and `scripts/redact-campaign-report.ts` must REFUSE it rather than appear to clean it (a blanked `source` is still schema-valid but renders nothing, so "redacted" would be a lie in both directions).
- **`--out` must not change.** It keeps writing `SessionReport` via `writeJsonReport`.
- Adding a flag means adding it to `RUN_FLAGS` in `cli.ts` AND to the help text; `packages/runner/tests/agent-contract.test.ts` derives its known-flag set from `RUN_FLAGS` and reddens on drift.
- No `!` non-null assertions. `exactOptionalPropertyTypes` is ON; build optional props with `...(v !== undefined ? { k: v } : {})`. **This matters more here than usual**: most `MutantResult` fields are optional, so every one you populate conditionally needs the spread idiom.
- Comments cite greppable NAMES, never `file.ts:123`. `scripts/line-citations.test.ts` enforces it.
- **ASCII only** in code and comments you add. A raw Windows-1252 byte for an em dash once made biome refuse an entire file in this repo.
- Build loop order: `bun run typecheck`, THEN `rm -rf packages/*/dist`, THEN `bun test`. Baseline is 2558 pass / 1 skip / 0 fail.
- Lint what you touched: `bunx biome check <paths>`.
- **Never run anything that contacts a Business Central container.** Every task here is offline.

---

### Task 1: Pin the dependency's contract

**Files:**
- Create: `packages/runner/tests/standard-report.test.ts`

**Interfaces:**
- Produces: nothing importable. This task's output is a set of assertions later tasks rely on staying true.

> **Why this exists at all, given the package is already pinned.** `^3.9.0` is a caret range, so a `bun install` can float it to 3.10 or 3.99. This task pins the five facts the mapper depends on, so a float that changes them reddens here and names what moved, rather than silently changing which reports validate. It is the same reasoning as the repo's existing `schemas.test.ts`, one dependency over.

- [ ] **Step 1: Write the test**

Create `packages/runner/tests/standard-report.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import SCHEMA from "mutation-testing-report-schema/mutation-testing-report-schema.json";

// The schema is a third-party contract reached through a CARET range (^3.9.0), so an install can
// float it. These are the parts the mapper depends on; a float that moves any of them reddens here
// and names it, instead of silently changing which reports validate. Same reasoning as
// schemas.test.ts's pins, one dependency over.
describe("the mutation-testing report schema contract", () => {
  test("root requires schemaVersion, thresholds and files", () => {
    expect([...SCHEMA.required].sort()).toEqual(["files", "schemaVersion", "thresholds"]);
  });

  test("schemaVersion is a STRING with a pattern, not a number", () => {
    // Emitting a number here would be a valid-looking report the ecosystem rejects.
    expect(SCHEMA.properties.schemaVersion.type).toBe("string");
    expect(SCHEMA.properties.schemaVersion.pattern).toBeDefined();
  });

  test("FileResult is inlined under files.additionalProperties and requires source", () => {
    // NOT `definitions.fileResult`, which does not exist. `definitions` holds only location,
    // openEndLocation and position.
    const fileResult = SCHEMA.properties.files.additionalProperties;
    expect([...fileResult.required].sort()).toEqual(["language", "mutants", "source"]);
  });

  test("MutantResult requires id, mutatorName, location and status", () => {
    const mutant = SCHEMA.properties.files.additionalProperties.properties.mutants.items;
    expect([...mutant.required].sort()).toEqual(["id", "location", "mutatorName", "status"]);
  });

  test("the status enum is exactly the eight we map onto", () => {
    const status =
      SCHEMA.properties.files.additionalProperties.properties.mutants.items.properties.status;
    expect([...status.enum].sort()).toEqual([
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

The import specifier above was VERIFIED to resolve during pre-flight, so it should work as written. **Do not weaken an assertion to make it pass.**

- [ ] **Step 2: Run it**

Run: `bun test packages/runner/tests/standard-report.test.ts`
Expected: PASS, 5 tests. These describe the installed package, so they should pass immediately. **A failure here means pre-flight's facts have gone stale and you should stop and report, not adjust the expectations.**

- [ ] **Step 3: Commit**

```bash
bun run typecheck
rm -rf packages/*/dist
bunx biome check packages/runner/tests/standard-report.test.ts
git add packages/runner/tests/standard-report.test.ts
git commit -m "test(report): pin the mutation-testing report schema contract the mapper depends on"
```

---

### Task 2: The verdict-to-status mapper

**Files:**
- Create: `packages/runner/src/standard-report.ts`
- Test: `packages/runner/tests/standard-report.test.ts` (extend)

**Interfaces:**
- Consumes: `MutantStatus` from `mutation-testing-report-schema/src-generated/schema`; `MutantVerdict` from `./store`; `MutantErrorCause` from `./report`.
- Produces: `export function statusOf(o: { verdict: MutantVerdict; cause?: MutantErrorCause; compileCulprit?: boolean }): MutantStatus`. Task 3 uses it.

> **Why this is its own task.** The mapping is where a wrong decision becomes invisible: a verdict silently mapped to the wrong status produces a plausible report that misleads nobody into noticing. It also holds the one real judgement call, `known-survivor`, and deserves its own review.

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
    // Survived is what was MEASURED; that it was carried rather than re-run belongs in
    // statusReason. Pending would claim the mutant is still queued, which is false.
    expect(statusOf({ verdict: "known-survivor" })).toBe("Survived");
  });

  test("an error maps by cause, and a compile culprit is CompileError", () => {
    expect(statusOf({ verdict: "error", cause: "unstable" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", cause: "stranded" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", cause: "deadline-exceeded" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", cause: "result-lost" })).toBe("RuntimeError");
    expect(statusOf({ verdict: "error", compileCulprit: true })).toBe("CompileError");
  });

  test("an unmapped verdict throws rather than defaulting", () => {
    // Fail loudly on a caller-contract violation: a new MutantVerdict must force a decision here,
    // not silently inherit whatever the default branch returned. Empty-vs-empty agreement is this
    // project's signature bug.
    expect(() => statusOf({ verdict: "invented" as never })).toThrow(/unmapped verdict/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/runner/tests/standard-report.test.ts`
Expected: FAIL, cannot resolve `../src/standard-report`.

- [ ] **Step 3: Implement**

Create `packages/runner/src/standard-report.ts`. Import the status type from the package rather than redeclaring it, so a schema float that adds a status is a compile error here:

```ts
import type { MutantStatus } from "mutation-testing-report-schema/src-generated/schema";
```

The `error` branch reads `cause`; the compile-culprit branch is driven by the explicit flag rather than by sniffing a message. **The default branch throws**, naming the verdict:

```ts
throw new Error(
  `unmapped verdict ${JSON.stringify(o.verdict)}: the standard report schema needs an explicit ` +
    "MutantStatus for every MutantVerdict. Add one here rather than letting it default.",
);
```

That specifier was VERIFIED to resolve during pre-flight. Bun strips types rather than checking them, so `bun run typecheck` is what actually proves the types line up; run it before committing. If `tsc` rejects the import, declare the union locally AND add a test asserting it equals the schema's enum so the two cannot drift, and say so in your report.

- [ ] **Step 4: Verify and commit**

```bash
bun test packages/runner/tests/standard-report.test.ts
bun run typecheck
rm -rf packages/*/dist
bunx biome check packages/runner/src/standard-report.ts packages/runner/tests/standard-report.test.ts
git add packages/runner/src/standard-report.ts packages/runner/tests/standard-report.test.ts
git commit -m "feat(report): map every MutantVerdict onto a standard-schema MutantStatus"
```

---

### Task 3: The mapper, typed against the schema

**Files:**
- Modify: `packages/runner/src/standard-report.ts`
- Test: `packages/runner/tests/standard-report.test.ts` (extend)

**Interfaces:**
- Consumes: `statusOf` from Task 2; `SessionReport` including `excludedSites` from A; `MutationTestResult` from the schema package.
- Produces: `export function toStandardReport(report: SessionReport, sources: ReadonlyMap<string, string>): MutationTestResult`. Tasks 4 and 5 use it.

> **The return type IS the conformance mechanism.** Annotating the return as `MutationTestResult` makes `tsc` enforce the schema's shape at compile time: a missing `source`, a wrong `status` string, a number where `schemaVersion` wants a string. That is stronger and cheaper than a runtime validator for structure, and it is why this plan adds no JSON Schema dependency. Task 4 covers only what types cannot express.

> **Sources are passed in, not read.** The mapper stays pure and testable, and the decision to embed source becomes visible at the call site rather than buried in the mapper.

- [ ] **Step 1: Write the failing tests**

Each of these asserts concrete values, not shapes:

```ts
describe("toStandardReport", () => {
  test("emits schemaVersion as the STRING \"2\" and the required root fields", () => {
    // A number here type-errors against MutationTestResult and is rejected by the schema's pattern.
  });

  test("groups mutants by file, with language \"al\" and the file's source", () => {});

  test("location is 1-based with an exclusive end, derived from byte offsets", () => {
    // Use a MULTI-LINE source so the row arithmetic is genuinely exercised, not just column 1.
  });

  test("coveredBy, killedBy, statusReason and testsCompleted carry the report's own fields", () => {
    // coveringTests -> coveredBy; killingTest -> killedBy; killingTestFailure -> statusReason.
    // testsCompleted may be LESS than coveredBy on a kill: the covering-test loop breaks on the
    // first confirmed kill, which is exactly why the schema has that field.
  });

  test("every excludedSites row becomes an Ignored entry carrying its reason", () => {
    // An excluded FILE with no mutants still appears, so the refusal is visible in the viewer
    // rather than being an absence a reader has to notice.
  });

  test("a file with no source supplied throws rather than emitting an invalid report", () => {
    expect(() => toStandardReport(report, new Map())).toThrow(/no source for/);
  });
});
```

That last one is load-bearing: `source` is required, so a missing entry must fail loudly rather than emit `""` and produce a report that validates but renders nothing.

- [ ] **Step 2: Run, watch fail, implement, run again**

Standard TDD cycle, running `bun test packages/runner/tests/standard-report.test.ts` between each. Remember `exactOptionalPropertyTypes`: most `MutantResult` fields are optional, so populate them with `...(v !== undefined ? { k: v } : {})`.

- [ ] **Step 3: Commit**

```bash
bun run typecheck
rm -rf packages/*/dist
bunx biome check packages/runner/src/standard-report.ts packages/runner/tests/standard-report.test.ts
git add packages/runner/src/standard-report.ts packages/runner/tests/standard-report.test.ts
git commit -m "feat(report): map a SessionReport onto the standard schema, refusals included"
```

---

### Task 4: Check what the types cannot

**Files:**
- Test: `packages/runner/tests/standard-report.test.ts` (extend)

> **Scope, stated precisely so this task is not busywork.** `tsc` already proves structure via Task 3's return type. What types cannot express, and what this task checks on a real emitted report, is: the `schemaVersion` string PATTERN, `thresholds` being present with `high` and `low`, every emitted `status` being a member of the schema's enum at runtime, and every file entry actually carrying a non-empty `source`. Four checks, against a report built through the real fold harness.

- [ ] **Step 1: Build a real report and check the four**

Use the existing fold harness (`packages/runner/tests/report-equality.test.ts` and `operator-filter.test.ts` both have one; read them and reuse, do not write a third). Map it, then assert the four constraints above, reading the expected pattern and enum FROM the schema JSON rather than restating them, so this test cannot drift from Task 1's pins.

- [ ] **Step 2: Prove the checks can fail**

```ts
test("the checks FAIL a document they should fail, or every check above is vacuous", () => {
  // A report with schemaVersion 2 as a NUMBER, and a file whose source is "", must be rejected by
  // the same assertions that passed above. schemas.test.ts carries a test with this exact name and
  // reasoning; a check that accepts everything makes Step 1 meaningless.
});
```

**Do not skip this.** The repo has been bitten by vacuous validation before, which is why `schemas.test.ts` carries the same guard by name.

- [ ] **Step 3: Commit**

```bash
git add packages/runner/tests/standard-report.test.ts
git commit -m "test(report): check the schema constraints types cannot express, and prove they fail"
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

Add `"standard-report": { type: "string" }` to `RUN_FLAGS`, and a matching help line saying the output embeds the project's source and must not be committed. Both are required: `agent-contract.test.ts` derives its known-flag set from `RUN_FLAGS` and reddens if help and flags drift.

Write it beside the existing `--out` call:

```ts
if (parsed.outPath !== undefined) await writeJsonReport(report, parsed.outPath);
if (parsed.standardReportPath !== undefined) {
  await writeStandardReport(report, parsed.standardReportPath, cfg.projectDir);
}
```

`writeStandardReport` reads each mutated file's source from disk relative to `projectDir`, builds the `sources` map, calls `toStandardReport`, and writes it.

- [ ] **Step 2: Gitignore the conventional output**

Add `mutation-report.json` to `.gitignore` with a comment giving the reason: the format embeds target source and this repo is public.

- [ ] **Step 3: Teach the redactor to REFUSE the format**

`scripts/redact-campaign-report.ts` already throws on a file with no top-level `mutants` array, saying "this is not a SessionReport". A standard-schema report hits that path with a misleading message. Detect it explicitly (root `schemaVersion` plus `files`) and refuse with a message that says what it is and that it must not be committed at all, rather than implying it could be cleaned.

- [ ] **Step 4: Assert no such report is committed**

Extend `scripts/redact-campaign-report.test.ts`, mirroring how it already asserts the two committed campaign reports stay clean: walk tracked files and assert none is a standard-schema report. Assert **BY SHAPE** (root `schemaVersion` + `files` + a file entry carrying `source`), never by filename, because a filename check passes against a renamed file.

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

The Step 4 guard is what protects a public repo, so prove it fires. Write a standard-schema report into the working tree, `git add` it, run the test, confirm it goes RED naming the file, then remove it and confirm green. **Report both outputs.** A guard never seen firing is not a guard.

---

## Self-Review

**Spec coverage.** §2.1 the format → Task 1. §2.2 the `source` constraint and its four consequences → Task 5 steps 1 to 4. §2.3 the mapping table → Tasks 2 and 3, with the spec's open question 1 decided in Task 2. §2.4 JSON only, no bundled viewer → no task builds one, deliberately. §2.5 gates → Tasks 1, 4, and Task 5 steps 4 and 6.

**Open question resolved.** The spec left `known-survivor` as `Survived` or `Pending`. Decided `Survived`, with the reasoning in the test rather than a comment that can drift: `Pending` would claim the mutant is still queued, which is false.

**What changed from the first draft of this plan, and why.** It vendored the schema from GitHub and validated with `conformsTo`. Pre-flight found the package is already a pinned devDependency shipping generated types, and that `conformsTo` cannot resolve this schema's `#/definitions/` refs at all. Vendoring is gone, the types became the conformance mechanism, and Task 4 shrank to the four constraints types cannot express. No dependency is added.

**Placeholders.** Tasks 3 and 4 give test names and the assertion each must make rather than full bodies, because the expected values depend on the fold harness's fixture, which the implementer reads in that step. Every other code step carries its code.

**Type consistency.** `statusOf` is spelled identically in Tasks 2 and 3. `toStandardReport(report, sources)` is spelled identically in Tasks 3, 4 and 5. `writeStandardReport` appears only in Task 5, where it is defined. `MutantStatus` and `MutationTestResult` come from the package in both Tasks 2 and 3.
