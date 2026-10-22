import { describe, expect, test } from "bun:test";
import { type ChunkedRow, foldChunkedRows, rerunMismatches } from "../itest/chunked-rows";

/** R582 (U7): itest:chunked's row fold, with the re-runs kept apart from the covering calls. */
const codeOf = new Map([[1, "M0015"]]);
const row = (code: string | null, method: string, session: number | null): ChunkedRow => ({
  mutant_row_id: 1,
  mutant_code: code,
  method,
  session_id: session,
});
// Chunk 2 of a warm kill (A1, A2 in session 10), its unmutated replay (session 11), then the
// re-run under the mutant (session 12).
const ROWS = [
  row("M0015", "A1", 10),
  row("M0015", "A2", 10),
  row(null, "A1", 11),
  row(null, "A2", 11),
  row("M0015", "A1", 12),
  row("M0015", "A2", 12),
];

describe("R582: the chunked gate's row fold", () => {
  test("a re-run after the replay is not a covering call: sizes [2], reruns [A1, A2]", () => {
    const fold = foldChunkedRows(ROWS, codeOf);
    expect(fold.callSizes.get("M0015")).toEqual([2]);
    expect(fold.replays.get("M0015")).toEqual(["A1", "A2"]);
    expect(fold.reruns.get("M0015")).toEqual(["A1", "A2"]);
  });

  test("covering calls before the replay are still split by session", () => {
    const fold = foldChunkedRows([row("M0015", "B1", 8), row("M0015", "B2", 8), ...ROWS], codeOf);
    expect(fold.callSizes.get("M0015")).toEqual([2, 2]);
    expect(fold.reruns.get("M0015")).toEqual(["A1", "A2"]);
  });

  test("a cold kill (no replay row) has no many re-run", () => {
    const fold = foldChunkedRows([row("M0015", "A1", 10)], codeOf);
    expect(fold.reruns.get("M0015")).toBeUndefined();
    expect(fold.callSizes.get("M0015")).toEqual([1]);
  });

  test("F2: a re-run equal to the replay list holds", () => {
    const fold = foldChunkedRows(ROWS, codeOf);
    expect(rerunMismatches([{ code: "M0015", replay: ["A1", "A2"] }], fold)).toEqual([]);
  });

  test("F2: a 4-method re-run against a 2-method replay fails, and so do a reordered and a missing one", () => {
    const four = new Map([["M0015", ["P1", "P2", "A1", "A2"]]]);
    expect(rerunMismatches([{ code: "M0015", replay: ["A1", "A2"] }], { reruns: four })).toEqual([
      'chunked: M0015\'s re-run under the mutant ran ["P1","P2","A1","A2"], expected exactly its replay list ["A1","A2"] (R582: the re-run replays the CHUNK\'s prefix)',
    ]);
    const swapped = new Map([["M0015", ["A2", "A1"]]]);
    expect(
      rerunMismatches([{ code: "M0015", replay: ["A1", "A2"] }], { reruns: swapped }),
    ).toHaveLength(1);
    expect(
      rerunMismatches([{ code: "M0015", replay: ["A1", "A2"] }], { reruns: new Map() }),
    ).toHaveLength(1);
  });
});
