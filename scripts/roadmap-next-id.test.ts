import { describe, expect, test } from "bun:test";
import { RoadmapFormatError } from "./roadmap-index.ts";
import { idsFromNames, nextId, worktreePaths } from "./roadmap-next-id.ts";

describe("idsFromNames", () => {
  test("reads R<nnn>.md names and paths, ignoring the template and anything else", () => {
    expect(
      idsFromNames(["R001.md", "docs/roadmap/R388.md", "_template.md", "R12.md", "README.md", ""]),
    ).toEqual([1, 388]);
  });
});

describe("nextId", () => {
  test("is the max over EVERY source plus one, naming where the max was seen", () => {
    const sources = new Map([
      ["working tree", [1, 2, 388]],
      ["refs/heads/lane-a", [1, 390]],
      ["refs/remotes/origin/master", [389]],
      ["worktree U:/x", [390]],
    ]);
    expect(nextId(sources)).toEqual({
      next: 391,
      max: 390,
      maxSeenIn: ["refs/heads/lane-a", "worktree U:/x"],
    });
  });
  test("no id anywhere is refused, never 'R0'", () => {
    expect(() => nextId(new Map([["working tree", []]]))).toThrow(RoadmapFormatError);
    expect(() => nextId(new Map())).toThrow(RoadmapFormatError);
  });
});

test("worktreePaths reads porcelain output", () => {
  const porcelain =
    "worktree U:/Git/LethAL\nHEAD abc\nbranch refs/heads/master\n\nworktree U:/Git/LethAL/.claude/worktrees/a\nHEAD def\ndetached\n";
  expect(worktreePaths(porcelain)).toEqual(["U:/Git/LethAL", "U:/Git/LethAL/.claude/worktrees/a"]);
});
