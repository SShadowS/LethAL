// R670: the by-hand reset of a worktree's fixture `.alpackages` after a re-pin. Temp dirs only:
// never a real worktree, never /coord.
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_SYMBOLS_TAR_SHA256,
  GATE_ALPACKAGES,
  SYMBOLS_MARKER,
} from "../packages/runner/itest/fixture-symbols.ts";
import { ResetRefusedError, allowedWorktree, main, resetPlan } from "./fixture-symbols-reset.ts";

const OLD = "bdf460e292f005f1c02cc7b45e83ede1d5c5df280070dc97231f9b314d4f175e";
let root = "";
afterEach(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
  root = "";
});

/** A fake LethAL checkout under a temp root, with the two folders and, optionally, a marker. */
function worktree(marker: string | undefined, folders = true): string {
  root = realpathSync(mkdtempSync(join(tmpdir(), "lethal-r670-reset-")));
  const wt = join(root, "wt");
  mkdirSync(join(wt, ".git"), { recursive: true });
  mkdirSync(join(wt, "packages", "runner"), { recursive: true });
  writeFileSync(join(wt, "packages", "runner", "package.json"), "{}");
  if (folders)
    for (const f of GATE_ALPACKAGES) {
      mkdirSync(join(wt, f), { recursive: true });
      writeFileSync(join(wt, f, "x.app"), "x");
    }
  if (marker !== undefined) writeFileSync(join(wt, SYMBOLS_MARKER), `${marker}\n`);
  return wt;
}
const refused = (f: () => unknown, text: string) => {
  expect(f).toThrow(ResetRefusedError);
  expect(f).toThrow(text);
};

// Also R670's swap window: the marker names master's old pin while kraken-setup has already put
// the new tar's files in the folders. To r670's code that marker is simply not the current pin.
test("a marker naming the old pin: both folders and the marker are planned for removal", () => {
  const wt = worktree(OLD);
  expect(resetPlan({ worktree: wt, roots: [root] })).toEqual([
    ...GATE_ALPACKAGES.map((f) => join(wt, f)),
    join(wt, SYMBOLS_MARKER),
  ]);
});

test("the CLI removes them and prints each path; --dry-run only lists them", () => {
  const wt = worktree(OLD);
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    expect(main(["--dry-run", wt], [root])).toBe(0);
    expect(existsSync(join(wt, SYMBOLS_MARKER))).toBe(true);
    expect(log.mock.calls.map((c) => c[0])).toContain(`would remove ${join(wt, SYMBOLS_MARKER)}`);
    expect(main([wt], [root])).toBe(0);
    for (const f of GATE_ALPACKAGES) expect(existsSync(join(wt, f))).toBe(false);
    expect(existsSync(join(wt, SYMBOLS_MARKER))).toBe(false);
    expect(log.mock.calls.map((c) => c[0])).toContain(`removed ${join(wt, SYMBOLS_MARKER)}`);
  } finally {
    log.mockRestore();
  }
});

test("refused: the marker already names the current pin", () => {
  const wt = worktree(FIXTURE_SYMBOLS_TAR_SHA256);
  refused(() => resetPlan({ worktree: wt, roots: [root] }), "nothing to do");
});

test("refused: no marker but the folders exist (the R614 fix is named), and nothing is removed", () => {
  const wt = worktree(undefined);
  refused(() => resetPlan({ worktree: wt, roots: [root] }), "The R614 fix");
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(main([wt], [root])).toBe(1);
  } finally {
    err.mockRestore();
  }
  for (const f of GATE_ALPACKAGES) expect(existsSync(join(wt, f))).toBe(true);
});

test("refused: one folder only, with no marker or with the pin's marker; the gate's by-hand fix", () => {
  for (const marker of [undefined, FIXTURE_SYMBOLS_TAR_SHA256]) {
    const wt = worktree(marker);
    const [, second] = GATE_ALPACKAGES;
    rmSync(join(wt, second ?? ""), { recursive: true });
    refused(() => resetPlan({ worktree: wt, roots: [root] }), "the one-time fix, by hand: remove");
    expect(() => resetPlan({ worktree: wt, roots: [root] })).not.toThrow("run itest");
    rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

test("refused: a symlinked fixtures/ aims outside the worktree, and nothing there is touched", () => {
  const wt = worktree(OLD, false);
  const elsewhere = join(root, "elsewhere");
  for (const f of GATE_ALPACKAGES) {
    const rel = f.replace(/^fixtures\//, "");
    mkdirSync(join(elsewhere, rel), { recursive: true });
    writeFileSync(join(elsewhere, rel, "x.app"), "x");
  }
  symlinkSync(elsewhere, join(wt, "fixtures"), "dir");
  refused(() => resetPlan({ worktree: wt, roots: [root] }), "outside the worktree");
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(main([wt], [root])).toBe(1);
  } finally {
    err.mockRestore();
  }
  for (const f of GATE_ALPACKAGES)
    expect(existsSync(join(elsewhere, f.replace(/^fixtures\//, ""), "x.app"))).toBe(true);
});

test("refused: no marker and no folders", () => {
  const wt = worktree(undefined, false);
  refused(() => resetPlan({ worktree: wt, roots: [root] }), "nothing to reset");
});

test("refused: not a LethAL checkout", () => {
  const wt = worktree(OLD);
  rmSync(join(wt, "packages"), { recursive: true });
  refused(() => resetPlan({ worktree: wt, roots: [root] }), "not a LethAL checkout");
});

test("refused: outside the allowed roots, and the real default roots refuse /coord and /tmp", () => {
  const wt = worktree(OLD);
  refused(() => resetPlan({ worktree: wt }), "not under /work/lethal*");
  expect(existsSync(join(wt, SYMBOLS_MARKER))).toBe(true);
  expect(allowedWorktree("/coord/handoff/x")).toBe(false);
  expect(allowedWorktree("/coord", ["/"])).toBe(false);
  expect(allowedWorktree("/tmp/x")).toBe(false);
  expect(allowedWorktree("/work/lethal")).toBe(true);
  expect(allowedWorktree("/work/lethal-wt/r670")).toBe(true);
  expect(allowedWorktree("/work/other")).toBe(false);
});

test("usage: no worktree, or two", () => {
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(main([])).toBe(2);
    expect(main(["a", "b"])).toBe(2);
  } finally {
    err.mockRestore();
  }
});
