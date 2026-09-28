import { describe, expect, test } from "bun:test";
// Imported WITH its extension, per R186 (scripts/importable-scripts.test.ts): a bare "./sidecar"
// import is matched by basename and would otherwise be read as importing an unrelated script.
// sidecar.ts's CLI body is guarded by import.meta.main, so importing it only exposes the pure
// scheduling function below; it opens no file, makes no request, starts no loop.
import { MAX_CONCURRENT, pickProbesToRun, refusalForUsername } from "./sidecar.ts";

describe("refusalForUsername (R289 review r1 I2: enforce a separate gate user)", () => {
  test("refuses when the gate config's username is missing", () => {
    expect(refusalForUsername(undefined, "LETHALPROBE")).toBeDefined();
  });

  test("refuses when the gate config's username is blank (whitespace only)", () => {
    expect(refusalForUsername("   ", "LETHALPROBE")).toBeDefined();
  });

  test("refuses when the sidecar user is the same as the gate's", () => {
    expect(refusalForUsername("gateuser", "gateuser")).toBeDefined();
  });

  test("refuses when the two usernames differ only by case", () => {
    expect(refusalForUsername("GateUser", "gateuser")).toBeDefined();
  });

  test("refuses when the two usernames differ only by surrounding whitespace", () => {
    expect(refusalForUsername("  gateuser  ", "gateuser")).toBeDefined();
  });

  test("allows a sidecar user that genuinely differs from the gate's", () => {
    expect(refusalForUsername("gateuser", "LETHALPROBE")).toBeUndefined();
  });
});

describe("pickProbesToRun (R289 P1 concurrency cap, ADDENDUM)", () => {
  test("fills up to the cap from idle probes, in order", () => {
    expect(pickProbesToRun(["a", "b", "c"], new Set(), 0, 2)).toEqual(["a", "b"]);
  });

  test("skips a probe whose previous call is still open", () => {
    expect(pickProbesToRun(["a", "b", "c"], new Set(["a"]), 0, 2)).toEqual(["b", "c"]);
  });

  test("counts already-open probes against the cap", () => {
    expect(pickProbesToRun(["a", "b", "c"], new Set(["a"]), 1, 2)).toEqual(["b"]);
  });

  test("starts nothing once the cap is already met", () => {
    expect(pickProbesToRun(["a", "b", "c"], new Set(), 2, 2)).toEqual([]);
  });

  test("round-robins with startAt so the cap does not starve the same probe every tick", () => {
    const names = ["company", "registeredArtifact", "renewLease"];
    expect(pickProbesToRun(names, new Set(), 0, 2, 0)).toEqual(["company", "registeredArtifact"]);
    expect(pickProbesToRun(names, new Set(), 0, 2, 1)).toEqual([
      "registeredArtifact",
      "renewLease",
    ]);
    expect(pickProbesToRun(names, new Set(), 0, 2, 2)).toEqual(["renewLease", "company"]);
  });

  test("the production cap holds: three idle probes never all start together", () => {
    const names = ["company", "registeredArtifact", "renewLease"];
    for (let startAt = 0; startAt < names.length; startAt++) {
      expect(
        pickProbesToRun(names, new Set(), 0, MAX_CONCURRENT, startAt).length,
      ).toBeLessThanOrEqual(MAX_CONCURRENT);
    }
  });
});
