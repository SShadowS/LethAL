import { describe, expect, test } from "bun:test";
import {
  type Exec,
  InventoryError,
  SCAN_PS,
  allReady,
  formatTable,
  hostScanRows,
  ignoredSuperpowers,
  laneRow,
  orphanBranchRows,
  parseHostScan,
  parseRemoteHeads,
  parseWorktrees,
  repoRows,
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
    const rows = orphanBranchRows(
      `master ${A}\nkeep ${A}\nlethal/x ${B}\nlost ${B}\n`,
      wts,
      remote,
    );
    expect(rows.map((r) => r.subject)).toEqual(["keep", "lost"]);
    expect(rows.every((r) => !r.ready)).toBe(true);
  });

  test("remote branch exists, local is ahead: not ready, names both tips", () => {
    const rows = orphanBranchRows(`lethal/x ${A}\n`, [], remote);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ready).toBe(false);
    expect(rows[0]?.detail).toContain("differs from origin (local aaaaaaaa, origin bbbbbbbb)");
  });

  test("a branch listing line without a tip is an inventory failure, not a pass", () => {
    expect(() => orphanBranchRows("lethal/x\n", [], remote)).toThrow(InventoryError);
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

  test("a complete scan with nothing watched is ready", () => {
    const quiet = JSON.stringify([
      { kind: "task", name: "\\Other", state: "Ready", text: "notepad" },
      { kind: "process", name: "pid 1 x", state: "running", text: "x.exe" },
    ]);
    expect(parseHostScan(quiet).map((r) => r.detail)).toEqual(["none found"]);
  });

  test("empty, non-JSON, non-array, malformed or one-sided output is an inventory failure", () => {
    const task = { kind: "task", name: "\\T", state: "Ready", text: "t" };
    const proc = { kind: "process", name: "pid 1 x", state: "running", text: "x" };
    for (const bad of [
      "",
      "[]",
      "not json",
      JSON.stringify(proc),
      JSON.stringify([task]),
      JSON.stringify([proc]),
      JSON.stringify([task, { ...proc, text: null }]),
      JSON.stringify([task, proc, { kind: "other", name: "n", state: "s", text: "t" }]),
    ])
      expect(() => parseHostScan(bad)).toThrow(InventoryError);
  });

  test("the scan's PowerShell stops on any error and the runner refuses its exit", async () => {
    expect(SCAN_PS).toContain("$ErrorActionPreference = 'Stop'");
    expect(SCAN_PS).toMatch(
      /catch \{ \[Console\]::Error\.WriteLine\(\$_\.ToString\(\)\); exit 1 \}/,
    );
    const failed: Exec = async () => ({ code: 1, out: "[]", err: "Access is denied." });
    await expect(hostScanRows(failed)).rejects.toThrow(
      /host scan \(PowerShell\) failed \(exit 1\): Access is denied\./,
    );
  });
});

describe("kraken-preflight inventory commands (injected failures)", () => {
  const REMOTE = `${A}\trefs/heads/master\n`;
  const WTS = `worktree /repo\nHEAD ${A}\nbranch refs/heads/master\n`;
  // Every command answers successfully unless its key (the git subcommand words) is `failing`.
  const fake =
    (failing: string | null): Exec =>
    async (cmd) => {
      const key = cmd.slice(3).join(" ");
      if (failing !== null && key.startsWith(failing))
        return { code: 128, out: "", err: `fatal: injected ${failing}` };
      if (key.startsWith("ls-remote")) return { code: 0, out: REMOTE, err: "" };
      if (key.startsWith("worktree list")) return { code: 0, out: WTS, err: "" };
      if (key.startsWith("for-each-ref")) return { code: 0, out: `master ${A}\n`, err: "" };
      if (key.startsWith("rev-parse")) return { code: 1, out: "", err: "" };
      return { code: 0, out: "", err: "" };
    };

  test("all listings succeeding gives rows (the control)", async () => {
    const rows = await repoRows(fake(null), "/repo", undefined, {});
    expect(rows.find((r) => r.area === "worktree")?.ready).toBe(true);
  });

  for (const failing of [
    "ls-remote",
    "worktree list",
    "for-each-ref",
    "stash list",
    "status --porcelain --ignored",
  ])
    test(`a failed ${failing} throws with its stderr, never an empty inventory`, async () => {
      await expect(repoRows(fake(failing), "/repo", undefined, {})).rejects.toThrow(
        new RegExp(`failed \\(exit 128\\): fatal: injected ${failing}`),
      );
    });

  test("a worktree whose plain status fails is a NOT READY row, not a throw", async () => {
    const rows = await repoRows(fake("status --porcelain"), "/repo", undefined, {});
    expect(rows.find((r) => r.area === "worktree")?.ready).toBe(false);
  });
});
