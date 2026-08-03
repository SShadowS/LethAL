import { describe, expect, test } from "bun:test";
// Imports from packages/runner/src, not scripts/campaign/compile-only.ts directly: scripts/ is
// outside every package's tsconfig project graph, and this package's tsconfig is composite, so a
// cross-boundary import here fails `tsc --build` with TS6059/TS6307 even though `bun test` alone
// resolves it fine. The driver script re-exports the same symbol from the same module — see
// packages/runner/src/compile-only-args.ts.
import { parseCompileOnlyArgs } from "../src/compile-only-args";

describe("parseCompileOnlyArgs", () => {
  test("parses a full invocation", () => {
    const a = parseCompileOnlyArgs([
      "--project",
      "U:/Git/do-lethal/Cloud",
      "--selector-id",
      "6175466",
      "--control-id",
      "6175467",
      "--table-id",
      "6175468",
      "--alc",
      "C:/alc/alc.exe",
      "--package-cache",
      "U:/Git/do-lethal/Cloud/.alpackages",
    ]);
    expect(a.projectDir).toBe("U:/Git/do-lethal/Cloud");
    expect(a.selectorIds).toEqual({
      selectorId: 6175466,
      controlId: 6175467,
      tableId: 6175468,
    });
  });

  test("throws naming the missing flag rather than defaulting", () => {
    expect(() => parseCompileOnlyArgs(["--project", "x"])).toThrow(/--selector-id/);
  });
});
