import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, rmdir } from "node:fs/promises";
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

  // ————————————————————————————————————————————————————————————————————————
  // R64: the per-RID bin/ layout. `bin/win32/` was hardcoded, so every bcdev run on a Linux or
  // macOS host — including anyone using the released Linux/macOS binaries — spawned a Windows PE
  // that cannot execute. Layout verified 2026-07-31 against ms-dynamics-smb.al-18.0.2498801:
  // bin/win32/{alc,altool}.exe, bin/linux/{alc,altool}, bin/darwin/{alc,altool}, one VSIX.
  // `platform` is injected rather than read from process.platform precisely so these three cases
  // are checkable from any host — on Windows alone, the fix is untestable and free to regress.
  // ————————————————————————————————————————————————————————————————————————
  describe("per-platform bin/ layout (R64)", () => {
    async function pathsFor(platform: NodeJS.Platform) {
      const tmpDir = await mkdtemp(join(tmpdir(), "al-platform-"));
      try {
        await mkdir(join(tmpDir, "ms-dynamics-smb.al-18.0.2498801"), { recursive: true });
        return await defaultAlToolPaths(tmpDir, platform);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    }

    test("win32 keeps bin/win32 and the .exe suffix", async () => {
      const result = await pathsFor("win32");
      expect(result?.alcPath).toEndWith(
        join("ms-dynamics-smb.al-18.0.2498801", "bin", "win32", "alc.exe"),
      );
      expect(result?.altoolPath).toEndWith(
        join("ms-dynamics-smb.al-18.0.2498801", "bin", "win32", "altool.exe"),
      );
    });

    test("linux uses bin/linux and no .exe suffix", async () => {
      const result = await pathsFor("linux");
      expect(result?.alcPath).toEndWith(
        join("ms-dynamics-smb.al-18.0.2498801", "bin", "linux", "alc"),
      );
      expect(result?.altoolPath).toEndWith(
        join("ms-dynamics-smb.al-18.0.2498801", "bin", "linux", "altool"),
      );
    });

    test("darwin uses bin/darwin and no .exe suffix", async () => {
      const result = await pathsFor("darwin");
      expect(result?.alcPath).toEndWith(
        join("ms-dynamics-smb.al-18.0.2498801", "bin", "darwin", "alc"),
      );
      expect(result?.altoolPath).toEndWith(
        join("ms-dynamics-smb.al-18.0.2498801", "bin", "darwin", "altool"),
      );
    });

    test("a platform the extension ships no binaries for throws instead of guessing a RID", async () => {
      // Guessing `linux` on freebsd yields a path that does not exist, which `buildBackend` then
      // reports as "install the AL extension" — advice that cannot help. The whole point of the
      // per-RID fix is to stop producing that class of unactionable error.
      await expect(pathsFor("freebsd")).rejects.toThrow(/no alc\/altool build for platform/);
    });
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
