import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceFiles, sourceHash } from "./source-hash.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lethal-srchash-"));
  await writeFile(join(dir, "app.json"), '{"version":"1.0.0.1"}');
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "A.Codeunit.al"), "codeunit 1 A { }");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("what goes in", () => {
  test("app.json and every .al file, by relative forward-slash path", async () => {
    expect(sourceFiles(dir)).toEqual(["app.json", "src/A.Codeunit.al"]);
  });

  test(".alpackages is excluded, so re-downloading symbols does not move the hash", async () => {
    const before = sourceHash(dir);
    await mkdir(join(dir, ".alpackages"), { recursive: true });
    await writeFile(join(dir, ".alpackages", "Microsoft_System.app"), "symbols");
    expect(sourceHash(dir)).toBe(before);
  });

  test(".vscode is excluded, because launch settings are not compiled", async () => {
    const before = sourceHash(dir);
    await mkdir(join(dir, ".vscode"), { recursive: true });
    await writeFile(join(dir, ".vscode", "launch.json"), "{}");
    expect(sourceHash(dir)).toBe(before);
  });

  test("an unrelated file is excluded", async () => {
    const before = sourceHash(dir);
    await writeFile(join(dir, "README.md"), "notes");
    expect(sourceHash(dir)).toBe(before);
  });
});

describe("what moves the hash", () => {
  test("THE R56 SHAPE: source changes with no version bump", async () => {
    // The whole reason this exists. app.json is untouched, so a version comparison sees nothing,
    // and the server would keep reporting the version the source claims while running a build
    // nobody can reproduce.
    const before = sourceHash(dir);
    await writeFile(join(dir, "src", "A.Codeunit.al"), "codeunit 1 A { procedure P() begin end; }");
    expect(sourceHash(dir)).not.toBe(before);
  });

  test("a version bump alone moves it too", async () => {
    const before = sourceHash(dir);
    await writeFile(join(dir, "app.json"), '{"version":"1.0.0.2"}');
    expect(sourceHash(dir)).not.toBe(before);
  });

  test("adding a file moves it", async () => {
    const before = sourceHash(dir);
    await writeFile(join(dir, "src", "B.Codeunit.al"), "codeunit 2 B { }");
    expect(sourceHash(dir)).not.toBe(before);
  });

  test("deleting a file moves it", async () => {
    const before = sourceHash(dir);
    await rm(join(dir, "src", "A.Codeunit.al"));
    expect(sourceHash(dir)).not.toBe(before);
  });

  test("MOVING a file moves it, even though the bytes are identical", async () => {
    // Paths are hashed, not only contents. Deleting one file and adding an identical one elsewhere
    // changes what compiles, and a hash of contents alone would call the two trees the same.
    const before = sourceHash(dir);
    await rm(join(dir, "src", "A.Codeunit.al"));
    await writeFile(join(dir, "A.Codeunit.al"), "codeunit 1 A { }");
    expect(sourceHash(dir)).not.toBe(before);
  });

  test("SWAPPING two files' contents moves it", async () => {
    // The pairing is what is hashed, so two files exchanging bodies is a real change even though
    // the multiset of contents and the set of paths are both unchanged.
    await writeFile(join(dir, "src", "B.Codeunit.al"), "codeunit 2 B { }");
    const before = sourceHash(dir);
    await writeFile(join(dir, "src", "A.Codeunit.al"), "codeunit 2 B { }");
    await writeFile(join(dir, "src", "B.Codeunit.al"), "codeunit 1 A { }");
    expect(sourceHash(dir)).not.toBe(before);
  });
});

describe("stability", () => {
  test("it is a property of the project, not of the walk", () => {
    expect(sourceHash(dir)).toBe(sourceHash(dir));
  });

  test("it is prefixed so nobody mistakes it for a bare hex digest", () => {
    expect(sourceHash(dir)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("paths are hashed, isolated from ordering", () => {
  test("two trees with the SAME content sequence but different paths do not collide", async () => {
    // The earlier "moving a file" and "swapping contents" tests both pass even when paths are
    // ignored, because relocating a file also changes the sorted ORDER, and the order alone moves
    // a contents-only hash. Found by mutation: dropping the path from the hash left all twelve
    // green.
    //
    // This isolates it. Both trees hold app.json plus two identical bodies, so the sequence of
    // content digests is byte-for-byte the same in sorted-path order. Only the paths differ.
    const a = await mkdtemp(join(tmpdir(), "lethal-srchash-a-"));
    const b = await mkdtemp(join(tmpdir(), "lethal-srchash-b-"));
    try {
      for (const d of [a, b]) {
        await writeFile(join(d, "app.json"), '{"version":"1.0.0.1"}');
        await mkdir(join(d, "src"), { recursive: true });
      }
      await writeFile(join(a, "src", "A.Codeunit.al"), "codeunit 1 Z { }");
      await writeFile(join(a, "src", "B.Codeunit.al"), "codeunit 1 Z { }");

      await mkdir(join(b, "other"), { recursive: true });
      await writeFile(join(b, "src", "A.Codeunit.al"), "codeunit 1 Z { }");
      await writeFile(join(b, "other", "A.Codeunit.al"), "codeunit 1 Z { }");

      // Same number of files, same bodies, same order of bodies. Different layout.
      expect(sourceFiles(a)).toEqual(["app.json", "src/A.Codeunit.al", "src/B.Codeunit.al"]);
      expect(sourceFiles(b)).toEqual(["app.json", "other/A.Codeunit.al", "src/A.Codeunit.al"]);
      expect(sourceHash(a)).not.toBe(sourceHash(b));
    } finally {
      await rm(a, { recursive: true, force: true });
      await rm(b, { recursive: true, force: true });
    }
  });
});
