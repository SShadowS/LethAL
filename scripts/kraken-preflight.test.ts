import { describe, expect, test } from "bun:test";
import {
  allReady,
  formatTable,
  ignoredSuperpowers,
  laneRow,
  orphanBranchRows,
  parseHostScan,
  parseRemoteHeads,
  parseWorktrees,
  runRow,
  stashRows,
  worktreeRow,
} from "./kraken-preflight";

const A = "a".repeat(40);
const B = "b".repeat(40);

const PORCELAIN = `worktree /repo
HEAD ${A}
branch refs/heads/master

worktree /repo/wt/x
HEAD ${B}
detached
`;

describe("kraken-preflight worktrees", () => {
  const remote = parseRemoteHeads(`${A}\trefs/heads/master\n${B}\trefs/heads/lethal/x\n`);

  test("parses branch and detached worktrees from a porcelain transcript", () => {
    const w = parseWorktrees(PORCELAIN);
    expect(w).toEqual([
      { path: "/repo", head: A, branch: "master" },
      { path: "/repo/wt/x", head: B, branch: null },
    ]);
  });

  test("clean and on origin at the same tip is ready", () => {
    expect(worktreeRow({ path: "/r", head: A, branch: "master" }, false, remote).ready).toBe(true);
  });

  test("ignored .superpowers/ content is not ready and names the path", () => {
    const ig = ignoredSuperpowers(
      "?? x\n!! node_modules/\n!! .superpowers/\n!! .superpowers/sdd/notes.md\n!! other/.superpowers/y\n",
    );
    expect(ig).toEqual([".superpowers/", ".superpowers/sdd/notes.md"]);
    const r = worktreeRow({ path: "/r", head: A, branch: "master" }, false, remote, ig);
    expect(r.ready).toBe(false);
    expect(r.detail).toContain(".superpowers/sdd/notes.md");
    expect(r.detail).toContain("copy into the container worktree at cutover or acknowledge");
    expect(ignoredSuperpowers("!! node_modules/\n")).toEqual([]);
  });

  test("local branches without a worktree and not on origin are not ready", () => {
    const wts = [{ path: "/repo", head: A, branch: "master" }];
    const rows = orphanBranchRows("master\nkeep\nlethal/x\nlost\n", wts, remote);
    expect(rows.map((r) => r.subject)).toEqual(["keep", "lost"]);
    expect(rows.every((r) => !r.ready)).toBe(true);
  });

  test("each stash is a not-ready line, none is ready", () => {
    expect(stashRows("")).toEqual([]);
    const rows = stashRows("stash@{0}: WIP on master: abc msg\nstash@{1}: On x: y\n");
    expect(rows.map((r) => r.subject)).toEqual(["stash@{0}", "stash@{1}"]);
    expect(allReady(rows)).toBe(false);
  });

  test("dirty is not ready", () => {
    const r = worktreeRow({ path: "/r", head: A, branch: "master" }, true, remote);
    expect(r.ready).toBe(false);
    expect(r.detail).toContain("dirty");
  });

  test("branch missing on origin is not ready", () => {
    const r = worktreeRow({ path: "/r", head: A, branch: "lethal/gone" }, false, remote);
    expect(r.ready).toBe(false);
    expect(r.detail).toContain("not on origin");
  });

  test("ahead of origin (tips differ) is not ready", () => {
    const r = worktreeRow({ path: "/r", head: B, branch: "master" }, false, remote);
    expect(r.ready).toBe(false);
    expect(r.detail).toContain("differs from origin");
  });

  test("detached HEAD and unreadable status are not ready", () => {
    expect(worktreeRow({ path: "/r", head: B, branch: null }, false, remote).ready).toBe(false);
    expect(worktreeRow({ path: "/r", head: B, branch: "master" }, null, remote).ready).toBe(false);
  });
});

describe("kraken-preflight runs and lanes", () => {
  const remote = parseRemoteHeads(`${A}\trefs/heads/lethal/lane-code\n`);

  test("run: pushed is ready; unknown, unpushed and ahead are not", () => {
    expect(runRow("R-1", "lethal/lane-code", A, remote).ready).toBe(true);
    expect(runRow("R-1", null, null, remote).detail).toBe("branch unknown");
    expect(runRow("R-1", "lethal/nope", A, remote).ready).toBe(false);
    expect(runRow("R-1", "lethal/lane-code", B, remote).ready).toBe(false);
  });

  test("lane: contains the move commit is ready; missing commit, missing branch, no commit given are not", () => {
    expect(laneRow("lethal/lane-code", A, remote, 0).ready).toBe(true);
    expect(laneRow("lethal/lane-code", A, remote, 1).detail).toContain("does NOT contain");
    expect(laneRow("lethal/lane-code", A, remote, 128).ready).toBe(false);
    expect(laneRow("lethal/other", A, remote, 0).ready).toBe(false);
    expect(laneRow("lethal/lane-code", undefined, remote, null).ready).toBe(false);
  });

  test("exit is clean only when every line is ready", () => {
    const ok = laneRow("lethal/lane-code", A, remote, 0);
    const bad = laneRow("lethal/lane-code", A, remote, 1);
    expect(allReady([ok, ok])).toBe(true);
    expect(allReady([ok, bad])).toBe(false);
    expect(formatTable([ok, bad])).toContain("1 ready, 1 not ready");
  });
});

describe("kraken-preflight host scan", () => {
  const fake = JSON.stringify([
    { kind: "task", name: "\\lethal-coord-sync", state: "Ready", text: "bash coord.sh status" },
    { kind: "task", name: "\\agent-coord-old", state: "Disabled", text: "deno agent-coord" },
    { kind: "task", name: "\\CG", state: "Ready", text: "C:\\CentralGauge\\watchdog.ps1" },
    { kind: "task", name: "\\Other", state: "Ready", text: "notepad" },
    {
      kind: "process",
      name: "pid 9 msedgewebview2.exe",
      state: "running",
      text: "edge --gpu-watchdog-timeout-seconds=60",
    },
    { kind: "process", name: "pid 7 bun.exe", state: "running", text: "bun watchdog.ts" },
    {
      kind: "process",
      name: "pid 8 powershell.exe",
      state: "running",
      text: "Get-CimInstance ... lethal-coord",
    },
  ]);

  test("keeps LethAL entries, drops CentralGauge, the scan itself and unrelated ones", () => {
    const rows = parseHostScan(fake);
    expect(rows.map((r) => r.subject)).toEqual([
      "\\lethal-coord-sync",
      "\\agent-coord-old",
      "pid 7 bun.exe",
    ]);
    expect(rows.map((r) => r.ready)).toEqual([false, true, false]);
  });

  test("an empty scan is ready; a single object (PowerShell's one-item form) parses", () => {
    expect(allReady(parseHostScan("[]"))).toBe(true);
    expect(allReady(parseHostScan(""))).toBe(true);
    const one = JSON.stringify({
      kind: "process",
      name: "pid 1 x",
      state: "running",
      text: "agent-coord serve",
    });
    expect(allReady(parseHostScan(one))).toBe(false);
  });
});
