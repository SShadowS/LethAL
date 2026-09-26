import { describe, expect, test } from "bun:test";
import type { GapRow, GapTally } from "../src/gaps";
import { GapGroupingError, tallyGaps } from "../src/gaps";
import type { MutantVerdict } from "../src/store";

function row(
  mutantCode: string,
  verdict: MutantVerdict,
  line: number,
  gapId = "Gaaaaaaaaaaaa",
  batchIndex = 0,
): GapRow {
  return { mutantCode, verdict, gapId, batchIndex, line };
}

function only(rows: readonly GapRow[]): GapTally {
  const tallies = tallyGaps(rows);
  expect(tallies.size).toBe(1);
  const [tally] = tallies.values();
  if (tally === undefined) throw new Error("no tally");
  return tally;
}

describe("tallyGaps", () => {
  test("a block where every row survived is unobservedBlock", () => {
    const t = only([
      row("M0003", "survived", 12),
      row("M0001", "survived", 10),
      row("M0002", "survived", 11),
    ]);
    expect(t).toMatchObject({
      survived: 3,
      killed: 0,
      noCoverage: 0,
      other: 0,
      unobservedBlock: true,
      batchIndex: 0,
    });
    expect(t.members).toEqual(["M0001", "M0002", "M0003"]);
    expect(t.noCoverageMembers).toEqual([]);
  });

  test("one killed row makes the block observed", () => {
    const t = only([
      row("M0001", "survived", 10),
      row("M0002", "killed", 11),
      row("M0003", "survived", 12),
    ]);
    expect(t).toMatchObject({ survived: 2, killed: 1, unobservedBlock: false });
    expect(t.members).toEqual(["M0001", "M0003"]);
  });

  test("a no-coverage row is counted and listed apart, never a member", () => {
    const t = only([row("M0001", "survived", 10), row("M0002", "no-coverage", 11)]);
    expect(t.members).toEqual(["M0001"]);
    expect(t.noCoverageMembers).toEqual(["M0002"]);
    expect(t).toMatchObject({
      survived: 1,
      killed: 0,
      noCoverage: 1,
      other: 0,
      unobservedBlock: false,
    });
  });

  test("timeout-killed counts as killed; error and known-survivor count as other", () => {
    const t = only([
      row("M0001", "survived", 10),
      row("M0002", "timeout-killed", 11),
      row("M0003", "error", 12),
      row("M0004", "known-survivor", 13),
    ]);
    expect(t).toMatchObject({
      survived: 1,
      killed: 1,
      noCoverage: 0,
      other: 2,
      unobservedBlock: false,
    });
    expect(t.members).toEqual(["M0001"]);
  });

  test("a block with no survivor is still tallied", () => {
    const t = only([row("M0001", "killed", 10), row("M0002", "killed", 11)]);
    expect(t).toMatchObject({ survived: 0, killed: 2, unobservedBlock: false });
    expect(t.members).toEqual([]);
  });

  test("members order by line, then mutantCode, whatever the input order", () => {
    const t = only([
      row("M0010", "survived", 20),
      row("M0009", "survived", 5),
      row("M0002", "survived", 20),
      row("M0007", "no-coverage", 30),
      row("M0006", "no-coverage", 3),
    ]);
    expect(t.members).toEqual(["M0009", "M0002", "M0010"]);
    expect(t.noCoverageMembers).toEqual(["M0006", "M0007"]);
  });

  test("rows of different gap ids get one tally each", () => {
    const tallies = tallyGaps([
      row("M0001", "survived", 1, "Gaaaaaaaaaaaa"),
      row("M0002", "killed", 2, "Gbbbbbbbbbbbb"),
    ]);
    expect([...tallies.keys()].sort()).toEqual(["Gaaaaaaaaaaaa", "Gbbbbbbbbbbbb"]);
    expect(tallies.get("Gbbbbbbbbbbbb")?.gapId).toBe("Gbbbbbbbbbbbb");
  });

  test("one gap id in two batches is refused", () => {
    const rows = [
      row("M0001", "survived", 1, "Gaaaaaaaaaaaa", 0),
      row("M0002", "survived", 2, "Gaaaaaaaaaaaa", 3),
    ];
    expect(() => tallyGaps(rows)).toThrow(GapGroupingError);
    expect(() => tallyGaps(rows)).toThrow(/Gaaaaaaaaaaaa.*0.*3/);
  });
});
