import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CoordRunner,
  CoordStatusError,
  DEFAULT_ROOT,
  formatView,
  gather,
  latestCheckpoint,
  leasedContainers,
  resolveRoot,
} from "./coord-status.ts";
import { envWithFakeBin } from "./fake-path-env.ts";

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

describe("root and containers follow KRAKEN_PROJECT", () => {
  test("LETHAL_COORD_ROOT wins on the host; KRAKEN_PROJECT reads CG_COORD_ROOT; the host ignores it", () => {
    expect(resolveRoot({ LETHAL_COORD_ROOT: "/a", CG_COORD_ROOT: "/b" })).toBe("/a");
    expect(
      resolveRoot({ LETHAL_COORD_ROOT: "/b", KRAKEN_PROJECT: "lethal", CG_COORD_ROOT: "/b" }),
    ).toBe("/b");
    expect(resolveRoot({ KRAKEN_PROJECT: "lethal", CG_COORD_ROOT: "/tmp/x" })).toBe("/tmp/x");
    expect(resolveRoot({ CG_COORD_ROOT: "/centralgauge" })).toBe(DEFAULT_ROOT);
    expect(resolveRoot({})).toBe(DEFAULT_ROOT);
  });
  test("kraken: a LETHAL_COORD_ROOT that differs from CG_COORD_ROOT is refused, naming both", () => {
    for (const env of [
      { LETHAL_COORD_ROOT: "/a", KRAKEN_PROJECT: "lethal", CG_COORD_ROOT: "/b" },
      { LETHAL_COORD_ROOT: "/a", KRAKEN_PROJECT: "lethal" },
    ]) {
      expect(() => resolveRoot(env)).toThrow(CoordStatusError);
      expect(() => resolveRoot(env)).toThrow(/LETHAL_COORD_ROOT=\/a differs from CG_COORD_ROOT=/);
    }
  });
  test("host: the fixed pair. kraken: this campaign's list in <root>/machine/allocation.json", () => {
    expect(leasedContainers("/x", {})).toEqual(["Cronus28", "Cronus284"]);
    const base = mkdtempSync(join(tmpdir(), "coord-status-k-"));
    const r = join(base, "coord");
    mkdirSync(r);
    mkdirSync(join(r, "machine"));
    writeFileSync(join(r, "coord.json"), JSON.stringify({ campaign: "lethal" }));
    writeFileSync(
      join(r, "machine", "allocation.json"),
      JSON.stringify({ lethal: ["Cronus28"], other: ["Cronus281"] }),
    );
    expect(leasedContainers(r, { KRAKEN_PROJECT: "lethal" })).toEqual(["Cronus28"]);
  });
  test("kraken with no allocation file is an error, not an empty list", () => {
    const base = mkdtempSync(join(tmpdir(), "coord-status-k-"));
    mkdirSync(join(base, "coord"));
    expect(() => leasedContainers(join(base, "coord"), { KRAKEN_PROJECT: "lethal" })).toThrow(
      CoordStatusError,
    );
  });
  test.each([["allocation.json"], ["coord.json"]])(
    "a corrupt %s raises CoordStatusError naming the file, never its content",
    (name) => {
      const r = join(mkdtempSync(join(tmpdir(), "coord-status-bad-")), "coord");
      mkdirSync(join(r, "machine"), { recursive: true });
      writeFileSync(join(r, "coord.json"), JSON.stringify({ campaign: "lethal" }));
      writeFileSync(join(r, "machine", "allocation.json"), JSON.stringify({ lethal: ["C"] }));
      const bad = name === "coord.json" ? join(r, name) : join(r, "machine", name);
      writeFileSync(bad, "{ hunter2 not json");
      let err: unknown;
      try {
        leasedContainers(r, { KRAKEN_PROJECT: "lethal" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CoordStatusError);
      const msg = (err as Error).message;
      expect(msg).toContain(name);
      expect(msg).not.toContain("hunter2");
    },
  );
  // A populated root: one doing task with a checkpoint, and one leased container.
  const populatedRoot = (task: string, container: string): string => {
    const r = join(mkdtempSync(join(tmpdir(), "coord-status-e2e-")), "coord");
    mkdirSync(join(r, "tasks", task, "runs", "001"), { recursive: true });
    writeFileSync(join(r, "tasks", task, "runs", "001", "checkpoint.json"), '{"phase":"green"}');
    mkdirSync(join(r, "machine"));
    writeFileSync(join(r, "machine", "allocation.json"), JSON.stringify({ lethal: [container] }));
    return r;
  };
  // Runs coord-status.ts against a fake `kraken` that reports T-1 doing; `called` records argv.
  const runStatus = async (env: Record<string, string>) => {
    const bin = mkdtempSync(join(tmpdir(), "coord-status-bin-"));
    const called = join(bin, "called");
    writeFileSync(
      join(bin, "kraken"),
      `#!/usr/bin/env bash
echo "$*" >> "${called.replace(/\\/g, "/")}"
case "$2" in
  pause-state) echo '{"paused":false,"doing":[{"id":"T-1","lane":"code"}]}';;
  questions) echo '[]';;
  stale) echo '(nothing stale)';;
  holder) echo null;;
esac
`,
    );
    chmodSync(join(bin, "kraken"), 0o755);
    const p = Bun.spawn(["bun", join(import.meta.dir, "coord-status.ts")], {
      env: { ...envWithFakeBin(bin, ["LETHAL_COORD_ROOT"]), KRAKEN_PROJECT: "lethal", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { out, err, code, krakenCalled: existsSync(called) };
  };

  test("end to end: KRAKEN_PROJECT + CG_COORD_ROOT=<tmp> reads <tmp>, never H:", async () => {
    const r = populatedRoot("T-1", "CronusZ");
    for (const env of [{ CG_COORD_ROOT: r }, { CG_COORD_ROOT: r, LETHAL_COORD_ROOT: r }]) {
      const { out, err, code } = await runStatus(env);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(out).toContain("  T-1 (code) run 001 green");
      expect(out).toContain("lease CronusZ: free");
      expect(out).not.toContain("Cronus28");
    }
  });

  test("end to end: distinct populated roots are refused, naming both, before any coord call", async () => {
    const a = populatedRoot("T-1", "CronusA");
    const b = populatedRoot("T-1", "CronusB");
    const { out, err, code, krakenCalled } = await runStatus({
      LETHAL_COORD_ROOT: a,
      CG_COORD_ROOT: b,
    });
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain(`LETHAL_COORD_ROOT=${a} differs from CG_COORD_ROOT=${b}`);
    expect(krakenCalled).toBe(false);
  });
});
