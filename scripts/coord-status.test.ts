import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CoordRunner,
  CoordStatusError,
  formatView,
  gather,
  latestCheckpoint,
} from "./coord-status.ts";

function root(): string {
  const r = mkdtempSync(join(tmpdir(), "coord-status-"));
  const run = (task: string, id: string, cp?: object) => {
    const dir = join(r, "tasks", task, "runs", id);
    mkdirSync(dir, { recursive: true });
    if (cp !== undefined) writeFileSync(join(dir, "checkpoint.json"), JSON.stringify(cp));
  };
  run("R-214", "001", { phase: "red", note: "old", at: 1 });
  run("R-214", "002", { phase: "green", note: `${"x".repeat(250)}`, at: 2 });
  run("R-307", "001");
  return r;
}

const fakeCoord =
  (pause: object): CoordRunner =>
  async (args) => {
    switch (args[0]) {
      case "pause-state":
        return JSON.stringify(pause);
      case "questions":
        return JSON.stringify([{ id: "q1" }, { id: "q2" }]);
      case "stale":
        return "GH-23 run 001 (infra): no checkpoint for 3237 min\n";
      case "holder":
        return args[1] === "Cronus28"
          ? JSON.stringify({ lane: "code", attempt: "004", at: 1 })
          : "null";
      default:
        throw new Error(`unexpected ${args.join(" ")}`);
    }
  };

describe("latestCheckpoint", () => {
  test("reads the HIGHEST run's checkpoint, and null when that run has none", () => {
    const r = root();
    expect(latestCheckpoint(r, "R-214")).toEqual({
      runId: "002",
      phase: "green",
      note: "x".repeat(250),
    });
    expect(latestCheckpoint(r, "R-307")).toBeNull();
  });
  test("a task with no runs dir is an error, not 'no checkpoint'", () => {
    expect(() => latestCheckpoint(root(), "R-999")).toThrow(CoordStatusError);
  });
});

describe("gather + formatView", () => {
  test("one view from coord output and checkpoint files", async () => {
    const r = root();
    const view = await gather(
      r,
      fakeCoord({
        paused: false,
        drained: false,
        leases: [],
        doing: [
          { id: "R-214", lane: "preproc" },
          { id: "R-307", lane: "code" },
        ],
      }),
    );
    expect(formatView(view)).toBe(
      [
        "pause: running",
        "open questions: 2",
        "stale: 1",
        "  GH-23 run 001 (infra): no checkpoint for 3237 min",
        "doing: 2",
        `  R-214 (preproc) run 002 green: ${"x".repeat(200)}`,
        "  R-307 (code) no checkpoint",
        "lease Cronus28: code",
        "lease Cronus284: free",
      ].join("\n"),
    );
  });
  test("a pause-state that is not the expected shape is refused", async () => {
    await expect(gather(root(), fakeCoord({ nope: true }))).rejects.toThrow(CoordStatusError);
  });
});
