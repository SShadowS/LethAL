import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ProjectSymlinkRefusedError,
  type WalkFs,
  type WalkFsSync,
  isLinkExcused,
  onSkippedLinks,
  refuseProjectLinks,
  walkFiles,
  walkFilesSync,
} from "../src/walk";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

/**
 * R631. Bun's recursive `readdir` follows directory links (Node's does not), so a link cycle hangs
 * or throws ELOOP and a link out walks a foreign tree. The walker never descends a link.
 *
 * Directory links are made as junctions so the Windows CI job needs no privilege. File links need
 * one there; a file-link case SKIPS BY NAME on EPERM only.
 */
function put(root: string, rel: string, text = "x"): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const dirLink = (target: string, at: string) => symlinkSync(target, at, "junction");

/** `true` when the file link was made; `false` on Windows EPERM (no privilege). */
function fileLink(target: string, at: string): boolean {
  try {
    symlinkSync(target, at, "file");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  }
}

/** root/a/A.al, root/b/B.al, root/a/deep/x/y/D.al, a 2-link cycle, a link out, a file link, a dangling link. */
function hostileTree(): { base: string; root: string; fileLinks: boolean } {
  const base = scratch("lethal-walk-");
  const root = join(base, "root");
  put(root, "a/A.al");
  put(root, "b/B.al");
  put(root, "a/deep/x/y/D.al");
  put(base, "foreign/F.al");
  put(base, "outside.al", "outside");
  dirLink(join(root, "b"), join(root, "a", "to-b"));
  dirLink(join(root, "a"), join(root, "b", "to-a"));
  dirLink(join(base, "foreign"), join(root, "to-foreign"));
  const f1 = fileLink(join(base, "outside.al"), join(root, "linkfile.al"));
  const f2 = fileLink(join(base, "nothing"), join(root, "dangling"));
  return { base, root, fileLinks: f1 && f2 };
}

const REAL = [join("a", "A.al"), join("a", "deep", "x", "y", "D.al"), join("b", "B.al")];
const DIR_LINKS = [join("a", "to-b"), join("b", "to-a"), "to-foreign"];
const sorted = (xs: readonly string[]) => [...xs].sort();

function countingFs(): { fs: WalkFs; dirs: string[] } {
  const dirs: string[] = [];
  return {
    dirs,
    fs: {
      readdir: async (d) => {
        dirs.push(d);
        return readdir(d);
      },
      lstat: (p) => lstat(p),
      stat: (p) => stat(p),
      realpath: (p) => realpath(p),
    },
  };
}

function countingFsSync(): { fs: WalkFsSync; dirs: string[] } {
  const dirs: string[] = [];
  const nodeFs = require("node:fs") as typeof import("node:fs");
  return {
    dirs,
    fs: {
      readdir: (d) => {
        dirs.push(d);
        return readdirSync(d);
      },
      lstat: (p) => lstatSync(p),
      stat: (p) => nodeFs.statSync(p),
      realpath: (p) => nodeFs.realpathSync(p),
    },
  };
}

describe("R631 walker: never descends a link", () => {
  test("a junction (Windows) or directory symlink reads as a link to lstat (the assumption the walker rests on)", () => {
    const { root } = hostileTree();
    expect(lstatSync(join(root, "to-foreign")).isSymbolicLink()).toBe(true);
  });

  test("skip: real nested files are yielded; no path through a link is; every link is listed (async)", async () => {
    const { root, fileLinks } = hostileTree();
    const r = await walkFiles(root, { links: "skip" });
    expect(r.files).toEqual(REAL);
    const links = fileLinks ? [...DIR_LINKS, "dangling", "linkfile.al"] : DIR_LINKS;
    expect(r.skippedLinks).toEqual(sorted(links));
  });

  test("skip: the same, sync", () => {
    const { root, fileLinks } = hostileTree();
    const r = walkFilesSync(root, { links: "skip" });
    expect(r.files).toEqual(REAL);
    const links = fileLinks ? [...DIR_LINKS, "dangling", "linkfile.al"] : DIR_LINKS;
    expect(r.skippedLinks).toEqual(sorted(links));
  });

  test("readdir runs exactly once per REAL directory (termination proof), async and sync", async () => {
    const { root } = hostileTree();
    const want = sorted(
      ["", "a", "b", join("a", "deep"), join("a", "deep", "x"), join("a", "deep", "x", "y")].map(
        (d) => join(root, d),
      ),
    );
    const a = countingFs();
    await walkFiles(root, { links: "skip" }, a.fs);
    expect(sorted(a.dirs)).toEqual(want);
    const s = countingFsSync();
    walkFilesSync(root, { links: "skip" }, s.fs);
    expect(sorted(s.dirs)).toEqual(want);
  });

  test("refuse: the first link throws ProjectSymlinkRefusedError naming the link and the root", async () => {
    const { root } = hostileTree();
    const err = await walkFiles(root, { links: "refuse" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectSymlinkRefusedError);
    const msg = (err as Error).message;
    expect(msg).toContain(root);
    expect(DIR_LINKS.some((l) => msg.includes(join(root, l)))).toBe(true);
    expect(() => walkFilesSync(root, { links: "refuse" })).toThrow(ProjectSymlinkRefusedError);
  });

  test("refuse: a linked .al FILE alone refuses too", async () => {
    const base = scratch("lethal-walk-");
    const root = join(base, "root");
    put(root, "src/A.al");
    put(base, "outside.al");
    if (!fileLink(join(base, "outside.al"), join(root, "src", "Linked.al"))) {
      console.log("SKIPPED (EPERM): refuse on a linked .al file");
      return;
    }
    const err = await walkFiles(root, { links: "refuse" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectSymlinkRefusedError);
    expect((err as Error).message).toContain(join(root, "src", "Linked.al"));
  });

  test("refuse: a link-free tree yields every real file", async () => {
    const base = scratch("lethal-walk-");
    put(base, "src/A.al");
    put(base, "src/sub/B.al");
    expect((await walkFiles(base, { links: "refuse" })).files).toEqual([
      join("src", "A.al"),
      join("src", "sub", "B.al"),
    ]);
  });

  test("yield-files: a linked FILE is yielded with its realpath; a dangling link is skipped", async () => {
    const base = scratch("lethal-walk-");
    const root = join(base, "cache");
    put(root, "Real.app");
    put(base, "elsewhere/Linked.app", "bytes");
    if (
      !fileLink(join(base, "elsewhere", "Linked.app"), join(root, "Linked.app")) ||
      !fileLink(join(base, "nothing"), join(root, "Dangling.app"))
    ) {
      console.log("SKIPPED (EPERM): yield-files on file links");
      return;
    }
    const r = await walkFiles(root, { links: "yield-files" });
    expect(r.files).toEqual(["Linked.app", "Real.app"]);
    expect(r.resolved.get("Linked.app")).toBe(await realpath(join(base, "elsewhere", "Linked.app")));
    expect(r.skippedLinks).toEqual(["Dangling.app"]);
    const s = walkFilesSync(root, { links: "yield-files" });
    expect(s.files).toEqual(r.files);
    expect(s.resolved.get("Linked.app")).toBe(r.resolved.get("Linked.app"));
  });

  test("yield-files: a linked FOLDER refuses by name", async () => {
    const base = scratch("lethal-walk-");
    const root = join(base, "cache");
    put(root, "Real.app");
    put(base, "more/X.app");
    dirLink(join(base, "more"), join(root, "more"));
    const err = await walkFiles(root, { links: "yield-files" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectSymlinkRefusedError);
    expect((err as Error).message).toContain(join(root, "more"));
    expect(() => walkFilesSync(root, { links: "yield-files" })).toThrow(ProjectSymlinkRefusedError);
  });
});

describe("R631 walker: entries that vanish mid-walk", () => {
  test("an entry gone between listing and lstat is left out; a missing ROOT still throws", async () => {
    const base = scratch("lethal-walk-");
    put(base, "keep.al");
    put(base, "gone.al");
    const fs: WalkFs = {
      readdir: (d) => readdir(d),
      lstat: async (p) => {
        if (p.endsWith("gone.al")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return lstat(p);
      },
      stat: (p) => stat(p),
      realpath: (p) => realpath(p),
    };
    expect((await walkFiles(base, { links: "skip" }, fs)).files).toEqual(["keep.al"]);
    await expect(walkFiles(join(base, "nope"), { links: "skip" })).rejects.toThrow();
    expect(() => walkFilesSync(join(base, "nope"), { links: "skip" })).toThrow();
  });
});

describe("R631 r3 A: node_modules and .git only EXCUSE links; they never drop real files", () => {
  function excusedTree(): string {
    const base = scratch("lethal-walk-");
    const root = join(base, "root");
    put(root, "src/A.al");
    put(root, "node_modules/pkg/X.al");
    put(root, "Node_Modules/other/Y.al");
    put(root, ".GIT/hooks/real-hook");
    put(base, "foreign/F.al");
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    dirLink(join(base, "foreign"), join(root, "node_modules", ".bin", "tool"));
    dirLink(join(base, "foreign"), join(root, ".GIT", "hooks", "linked"));
    dirLink(join(base, "foreign"), join(root, "Node_Modules", "other", "deep-link"));
    return root;
  }

  test("refuse: links inside node_modules / .GIT / Node_Modules are listed, not refused, never descended", async () => {
    const root = excusedTree();
    const r = await walkFiles(root, { links: "refuse" });
    expect(r.skippedLinks).toEqual(
      sorted([
        join(".GIT", "hooks", "linked"),
        join("Node_Modules", "other", "deep-link"),
        join("node_modules", ".bin", "tool"),
      ]),
    );
    expect(r.files.some((f) => f.includes("F.al"))).toBe(false);
    expect(() => walkFilesSync(root, { links: "refuse" })).not.toThrow();
  });

  test("refuse: real files under node_modules and Node_Modules are still yielded", async () => {
    const root = excusedTree();
    const r = await walkFiles(root, { links: "refuse" });
    expect(r.files).toContain(join("node_modules", "pkg", "X.al"));
    expect(r.files).toContain(join("Node_Modules", "other", "Y.al"));
    expect(r.files).toContain(join(".GIT", "hooks", "real-hook"));
  });

  test("isLinkExcused: case-insensitive, only INSIDE an excused folder", () => {
    expect(isLinkExcused(join("Node_Modules", ".bin", "x"))).toBe(true);
    expect(isLinkExcused(join("a", ".git", "x"))).toBe(true);
    expect(isLinkExcused(join("src", "linked"))).toBe(false);
    expect(isLinkExcused("node_modules")).toBe(false);
  });
});

describe("R631 onSkippedLinks: a skip walk announces its unexcused links (the caveat's tripwire)", () => {
  test("a skip walk calls listeners with the unexcused links only; refuse walks never call them", async () => {
    const base = scratch("lethal-walk-");
    const root = join(base, "root");
    put(root, "A.al");
    put(base, "elsewhere/x");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    dirLink(join(base, "elsewhere"), join(root, "linked"));
    dirLink(join(base, "elsewhere"), join(root, "node_modules", "tool"));
    const heard: Array<[string, readonly string[]]> = [];
    const off = onSkippedLinks((r, links) => heard.push([r, links]));
    try {
      await walkFiles(root, { links: "skip" });
      walkFilesSync(root, { links: "skip" });
      await walkFiles(join(base, "elsewhere"), { links: "skip" });
    } finally {
      off();
    }
    expect(heard).toEqual([
      [root, ["linked"]],
      [root, ["linked"]],
    ]);
  });
});

describe("R631 refuseProjectLinks: refuses an unexcused link whatever the walk policy (defence in depth)", () => {
  test("a linked helper folder in a test dir refuses", async () => {
    const base = scratch("lethal-walk-");
    put(base, "tests/T.al");
    put(base, "helpers/H.al");
    dirLink(join(base, "helpers"), join(base, "tests", "helpers"));
    await expect(refuseProjectLinks([join(base, "tests")])).rejects.toBeInstanceOf(
      ProjectSymlinkRefusedError,
    );
  });

  test("forced skip: a skipped unexcused link still refuses", async () => {
    const base = scratch("lethal-walk-");
    put(base, "tests/T.al");
    put(base, "helpers/H.al");
    dirLink(join(base, "helpers"), join(base, "tests", "helpers"));
    const err = await refuseProjectLinks([join(base, "tests")], "skip").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectSymlinkRefusedError);
    expect((err as Error).message).toContain(join(base, "tests", "helpers"));
  });

  test("an excused link alone does not refuse", async () => {
    const base = scratch("lethal-walk-");
    put(base, "tests/T.al");
    put(base, "elsewhere/x");
    mkdirSync(join(base, "tests", "node_modules", ".bin"), { recursive: true });
    dirLink(join(base, "elsewhere"), join(base, "tests", "node_modules", ".bin", "x"));
    await refuseProjectLinks([join(base, "tests")], "skip");
  });
});
