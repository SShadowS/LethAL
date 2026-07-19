import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAlToolPaths } from "../src/publisher";

// NOTE (Task 6): the old `Publisher` class (compile + publish bundled, fixed
// `lethal-instrumented.app` filename) is gone. Its compile half lives in
// `ArtifactCompiler` (artifact.ts, tested in artifact.test.ts) and its publish half in
// `ContainerDeployer` (publisher.ts, tested in artifact.test.ts's ContainerDeployer
// describes, including the verified altool flag spellings and the
// BC_SERVER_USERNAME/BC_SERVER_PASSWORD env handling).

describe("defaultAlToolPaths", () => {
  test("returns undefined when extensions dir does not exist", async () => {
    const result = await defaultAlToolPaths("/nonexistent/path/that/does/not/exist");
    expect(result).toBeUndefined();
  });

  test("returns undefined when no AL extensions found", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "al-test-"));
    try {
      const result = await defaultAlToolPaths(tmpDir);
      expect(result).toBeUndefined();
    } finally {
      await rmdir(tmpDir);
    }
  });

  test("sorts versions numerically across digit boundaries (9 vs 10)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "al-test-"));
    try {
      // Create fake AL extension dirs
      const dirs = [
        join(tmpDir, "ms-dynamics-smb.al-15.9"),
        join(tmpDir, "ms-dynamics-smb.al-15.10"),
        join(tmpDir, "ms-dynamics-smb.al-15.8"),
      ];
      await Promise.all(dirs.map((d) => mkdir(d, { recursive: true })));

      const result = await defaultAlToolPaths(tmpDir);
      // Should pick 15.10, not 15.9 (which would win lexicographically)
      expect(result?.alcPath).toContain("ms-dynamics-smb.al-15.10");
    } finally {
      // Clean up - remove all subdirs first
      try {
        const entries = await readdir(tmpDir);
        await Promise.all(entries.map((e) => rmdir(join(tmpDir, e))));
        await rmdir(tmpDir);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  test("picks newest version with complex multi-segment comparison", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "al-test-"));
    try {
      // Create fake AL extension dirs
      const dirs = [
        join(tmpDir, "ms-dynamics-smb.al-14.5.2"),
        join(tmpDir, "ms-dynamics-smb.al-15.1.0"),
        join(tmpDir, "ms-dynamics-smb.al-15.0.10"),
      ];
      await Promise.all(dirs.map((d) => mkdir(d, { recursive: true })));

      const result = await defaultAlToolPaths(tmpDir);
      // Should pick 15.1.0
      expect(result?.alcPath).toContain("ms-dynamics-smb.al-15.1.0");
    } finally {
      // Clean up - remove all subdirs first
      try {
        const entries = await readdir(tmpDir);
        await Promise.all(entries.map((e) => rmdir(join(tmpDir, e))));
        await rmdir(tmpDir);
      } catch {
        // ignore cleanup errors
      }
    }
  });
});
