import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifest } from "./coord-manifest.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("coord-manifest", () => {
  test("lists both files sorted with correct size and hash, and no content", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-manifest-"));
    mkdirSync(join(root, "tasks", "GH-1"), { recursive: true });
    writeFileSync(join(root, "coord.json"), "SECRET-ONE");
    writeFileSync(join(root, "tasks", "GH-1", "task.md"), "SECRET-TWO!");
    const m = await manifest(root);
    expect(m).toEqual({
      files: [
        { path: "coord.json", size: 10, sha256: sha("SECRET-ONE") },
        { path: "tasks/GH-1/task.md", size: 11, sha256: sha("SECRET-TWO!") },
      ],
    });
    expect(JSON.stringify(m)).not.toContain("SECRET");
  });

  test("a non-regular entry (symlink) fails loudly naming the path", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-manifest-"));
    writeFileSync(join(root, "real.txt"), "x");
    try {
      symlinkSync(join(root, "real.txt"), join(root, "link.txt"));
    } catch {
      return; // ponytail: Windows without symlink rights cannot make one; CI Linux covers it
    }
    await expect(manifest(root)).rejects.toThrow("link.txt");
  });

  test("an empty root is an empty list; a missing root throws", async () => {
    expect(await manifest(mkdtempSync(join(tmpdir(), "coord-manifest-")))).toEqual({ files: [] });
    await expect(manifest(join(tmpdir(), "coord-manifest-does-not-exist"))).rejects.toThrow();
  });
});
