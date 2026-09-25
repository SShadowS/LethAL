import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedLinesSince, parseUnifiedDiffAdded } from "../src/line-filter";
import { sessionFingerprint } from "../src/resume";
import { git, hermeticSpawn, makeGitRepo } from "./helpers/git-repo";

// GH-25: real git throughout. A fake spawn would only re-assert beliefs about git. Each git call
// can exceed the 5 s default on a loaded Windows runner (see HOOK_TIMEOUT_MS in the campaign test).
setDefaultTimeout(60_000);

const TEN = `${Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n")}\n`;

/** main = base; feat = base plus one committed change at app/src/A.al line 5. */
async function prFixture(localConfig: Record<string, string> = {}) {
  const root = await makeGitRepo(
    { "app/src/A.al": TEN, "app/.gitignore": "Ignored.al\n" },
    localConfig,
  );
  await git(root, ["checkout", "-qb", "feat"]);
  await writeFile(join(root, "app/src/A.al"), TEN.replace("l5\n", "L5\n"));
  await git(root, ["commit", "-qam", "committed change"]);
  return { root, app: join(root, "app") };
}
const rangesOf = async (app: string, ref = "main") =>
  (await changedLinesSince(app, ref, hermeticSpawn)).ranges;

test("an uncommitted insertion above a committed change carries the committed range with it", async () => {
  const { root, app } = await prFixture();
  try {
    await writeFile(
      join(app, "src/A.al"),
      TEN.replace("l5\n", "L5\n").replace("l1\n", "l1\nx\ny\nz\n"),
    );
    expect(await rangesOf(app)).toEqual([
      { file: "src/A.al", start: 2, end: 4 },
      { file: "src/A.al", start: 8, end: 8 },
    ]);
    // The #19 form on the same tree: HEAD's numbering, which is wrong for the file LethAL parses.
    const old = parseUnifiedDiffAdded(
      await git(app, ["diff", "-U0", "--relative", "main...HEAD", "--", "."]),
    );
    expect(old).toEqual([{ file: "src/A.al", start: 5, end: 5 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a brand-new untracked codeunit counts whole; ignored, non-.al and outside-project files do not", async () => {
  const { root, app } = await prFixture();
  try {
    await writeFile(join(app, "src/New.Codeunit.al"), "a\r\nb\r\nc"); // CRLF, no trailing newline
    await writeFile(join(app, "src/Empty.al"), "");
    await writeFile(join(app, "Ignored.al"), "q\n");
    await writeFile(join(app, "notes.txt"), "n\n");
    await writeFile(join(root, "Outside.al"), "o\n");
    const { ranges, source } = await changedLinesSince(app, "main", hermeticSpawn);
    expect(ranges).toContainEqual({ file: "src/New.Codeunit.al", start: 1, end: 3 });
    expect(ranges.map((r) => r.file).sort()).toEqual(["src/A.al", "src/New.Codeunit.al"]);
    expect(source.untrackedFiles).toEqual(["src/Empty.al", "src/New.Codeunit.al"]);
    expect(source.mergeBase).toBe((await git(root, ["merge-base", "main", "HEAD"])).trim());
    expect(source.ref).toBe("main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staged changes count, and the working tree wins over the index", async () => {
  const { root, app } = await prFixture();
  try {
    await writeFile(join(app, "src/Staged.al"), "s1\ns2\n");
    await git(app, ["add", "src/Staged.al"]);
    const edited = TEN.replace("l5\n", "L5\n");
    await writeFile(join(app, "src/A.al"), edited.replace("l9\n", "L9\n"));
    await git(app, ["add", "src/A.al"]);
    await writeFile(join(app, "src/A.al"), edited); // revert line 9 in the worktree only
    expect(await rangesOf(app)).toEqual([
      { file: "src/A.al", start: 5, end: 5 },
      { file: "src/Staged.al", start: 1, end: 2 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renames, spaces, non-ASCII names and hostile diff config all yield on-disk paths", async () => {
  const root = await makeGitRepo(
    { "app/src/Old.al": "r1\nr2\nr3\nr4\n", "app/src/Æble.al": "x\ny\n" },
    {
      "diff.renames": "false",
      "diff.mnemonicPrefix": "true",
      "diff.noprefix": "true",
      "core.quotePath": "true",
    },
  );
  const app = join(root, "app");
  try {
    await git(app, ["mv", "src/Old.al", "src/My New.al"]);
    await writeFile(join(app, "src/My New.al"), "r1\nr2\nr3\nR4\n");
    await writeFile(join(app, "src/Æble.al"), "x\nY\n");
    expect(await rangesOf(app, "HEAD")).toEqual([
      { file: "src/My New.al", start: 4, end: 4 },
      { file: "src/Æble.al", start: 2, end: 2 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a clean tree reproduces the three-dot ranges; an uncommitted edit changes the fingerprint", async () => {
  const { root, app } = await prFixture();
  try {
    const fp = (lines: readonly { file: string; start: number; end: number }[]) =>
      sessionFingerprint({
        projectDir: app,
        testDir: "t",
        backend: "bcdev",
        skipKnownSurvivors: false,
        selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
        lines,
      });
    // Exactly #19's argv (line-filter.ts before this change), as the oracle.
    const old = parseUnifiedDiffAdded(
      await git(app, [
        "diff",
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--relative",
        "main...HEAD",
        "--",
        ".",
      ]),
    );
    const clean = await rangesOf(app);
    expect(clean).toEqual(old);
    await writeFile(join(app, "src/A.al"), TEN.replace("l5\n", "L5\n").replace("l9\n", "L9\n"));
    const dirty = await rangesOf(app);
    expect(fp(dirty)).not.toBe(fp(clean));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe("fails loudly", () => {
  test("a ref that does not exist", async () => {
    const { root, app } = await prFixture();
    try {
      await expect(changedLinesSince(app, "nope", hermeticSpawn)).rejects.toThrow(
        /--changed-since nope.*merge-base.*Not a valid object name/s,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a directory that is not in a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-norepo-"));
    try {
      await expect(changedLinesSince(dir, "main", hermeticSpawn)).rejects.toThrow(
        /not a git repository/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a ref with no common ancestor", async () => {
    const { root, app } = await prFixture();
    try {
      await git(root, ["checkout", "-q", "--orphan", "lonely"]);
      await writeFile(join(app, "src/Lonely.al"), "z\n");
      await git(root, ["add", "-A"]);
      await git(root, ["commit", "-qm", "unrelated history"]);
      await expect(changedLinesSince(app, "main", hermeticSpawn)).rejects.toThrow(
        /share no commit/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a binary .al", async () => {
    const root = await makeGitRepo({ "app/src/A.al": TEN });
    const app = join(root, "app");
    try {
      await writeFile(join(app, "src/Bin.al"), "a\0b\n");
      await git(app, ["add", "src/Bin.al"]);
      await expect(changedLinesSince(app, "HEAD", hermeticSpawn)).rejects.toThrow(
        /binary \.al file \(src\/Bin\.al\)/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an untracked binary .al", async () => {
    const { root, app } = await prFixture();
    try {
      await writeFile(join(app, "src/Blob.al"), "a\0b\n");
      await expect(changedLinesSince(app, "main", hermeticSpawn)).rejects.toThrow(
        /binary \.al file \(src\/Blob\.al\)/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a submodule inside the project", async () => {
    const inner = await makeGitRepo({ "I.al": "i\n" });
    const { root, app } = await prFixture();
    try {
      await git(root, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "--quiet",
        "add",
        inner,
        "app/sub",
      ]);
      await git(root, ["commit", "-qm", "add submodule"]);
      await expect(changedLinesSince(app, "main", hermeticSpawn)).rejects.toThrow(
        /sub is a git submodule inside the project/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(inner, { recursive: true, force: true });
    }
  });

  test("an untracked nested repository inside the project", async () => {
    const { root, app } = await prFixture();
    try {
      await git(app, ["init", "-q", "nested"]);
      await writeFile(join(app, "nested/N.al"), "n\n");
      await expect(changedLinesSince(app, "main", hermeticSpawn)).rejects.toThrow(
        /nested\/ is a nested git repository inside the project/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a nested repository or submodule with no .al file is ignored", async () => {
    const inner = await makeGitRepo({ "x.txt": "x\n" });
    const { root, app } = await prFixture();
    try {
      await git(app, ["init", "-q", "tools"]);
      await writeFile(join(app, "tools/README.md"), "r\n");
      await git(root, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "--quiet",
        "add",
        inner,
        "app/sub",
      ]);
      await git(root, ["commit", "-qm", "add submodule"]);
      expect(await rangesOf(app)).toEqual([{ file: "src/A.al", start: 5, end: 5 }]);

      // Neither refusal suggests --exclude: line resolution runs before exclusions apply.
      await writeFile(join(app, "tools/T.al"), "t\n");
      const nestedErr = await changedLinesSince(app, "main", hermeticSpawn).catch((e) => e);
      expect(String(nestedErr)).toMatch(/tools\/ is a nested git repository/);
      expect(String(nestedErr)).not.toContain("--exclude");
      await rm(join(app, "tools"), { recursive: true, force: true });
      await writeFile(join(app, "sub/S.al"), "s\n");
      const subErr = await changedLinesSince(app, "main", hermeticSpawn).catch((e) => e);
      expect(String(subErr)).toMatch(/sub is a git submodule inside the project/);
      expect(String(subErr)).not.toContain("--exclude");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(inner, { recursive: true, force: true });
    }
  });
});

describe("edges", () => {
  test("a line-ending-only change adds no range", async () => {
    const { root, app } = await prFixture();
    try {
      await writeFile(join(app, "src/A.al"), TEN.replace("l5\n", "L5\n").replace(/\n/g, "\r\n"));
      expect(await rangesOf(app)).toEqual([{ file: "src/A.al", start: 5, end: 5 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a low-similarity rename counts the new file whole", async () => {
    const root = await makeGitRepo({ "app/src/Old.al": "r1\nr2\nr3\nr4\n" });
    const app = join(root, "app");
    try {
      await git(app, ["mv", "src/Old.al", "src/Ren.al"]);
      await writeFile(join(app, "src/Ren.al"), "a\nb\nc\nr4\n");
      const ranges = await rangesOf(app, "HEAD");
      expect(ranges).toEqual([{ file: "src/Ren.al", start: 1, end: 4 }]);
      expect(ranges.some((r) => r.file === "src/Old.al")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--changed-since HEAD: a clean tree selects only untracked files, a dirty one its edits", async () => {
    const { root, app } = await prFixture();
    try {
      expect(await rangesOf(app, "HEAD")).toEqual([]);
      await writeFile(join(app, "src/U.al"), "u\n");
      expect(await rangesOf(app, "HEAD")).toEqual([{ file: "src/U.al", start: 1, end: 1 }]);
      await writeFile(join(app, "src/A.al"), TEN.replace("l5\n", "L5\n").replace("l9\n", "L9\n"));
      const ranges = await rangesOf(app, "HEAD");
      expect(ranges).toContainEqual({ file: "src/A.al", start: 9, end: 9 });
      expect(ranges).toContainEqual({ file: "src/U.al", start: 1, end: 1 });
      expect(ranges.some((r) => r.file === "src/A.al" && r.start <= 5 && 5 <= r.end)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The Review Focus 4 fixture also sets diff.noprefix, which WINS over mnemonicPrefix and prints
  // bare paths the parser reads fine, so it cannot catch a dropped --dst-prefix. This one can:
  // mnemonicPrefix alone prints `+++ w/src/A.al` for a worktree diff.
  test("diff.mnemonicPrefix alone still yields on-disk paths", async () => {
    const { root, app } = await prFixture({ "diff.mnemonicPrefix": "true" });
    try {
      expect(await rangesOf(app)).toEqual([{ file: "src/A.al", start: 5, end: 5 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a tag works as the ref", async () => {
    const { root, app } = await prFixture();
    try {
      await git(root, ["tag", "v0", "main"]);
      const byTag = await changedLinesSince(app, "v0", hermeticSpawn);
      expect(byTag.ranges).toEqual(await rangesOf(app, "main"));
      expect(byTag.source.ref).toBe("v0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
