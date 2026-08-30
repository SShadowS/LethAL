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
