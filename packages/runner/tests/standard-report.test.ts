import { describe, expect, test } from "bun:test";
import SCHEMA from "mutation-testing-report-schema/mutation-testing-report-schema.json";
import { statusOf } from "../src/standard-report";

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
