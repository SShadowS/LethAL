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
    /**
     * R167 made EXISTENCE the selector, so a fixture that only creates the extension directory now
     * resolves to `undefined` — correctly. These fixtures therefore lay down the real per-RID
     * layout of `ms-dynamics-smb.al-18.0.2498801`, which is the multi-platform VSIX this describe
     * was written against.
     */
    async function pathsFor(platform: NodeJS.Platform) {
      const tmpDir = await mkdtemp(join(tmpdir(), "al-platform-"));
      try {
        const bin = join(tmpDir, "ms-dynamics-smb.al-18.0.2498801", "bin");
        for (const [dir, suffix] of [
          ["win32", ".exe"],
          ["linux", ""],
          ["darwin", ""],
        ] as const) {
          await mkdir(join(bin, dir), { recursive: true });
          await Bun.write(join(bin, dir, `alc${suffix}`), "");
          await Bun.write(join(bin, dir, `altool${suffix}`), "");
        }
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

  /**
   * R167 — the AL extension changed its own layout mid-session and every live gate died.
   *
   * 18.0.2498801 shipped ONE multi-platform VSIX: `bin/win32`, `bin/linux`, `bin/darwin`.
   * 18.0.2668733 shipped a PER-PLATFORM VSIX: the Windows binaries sit directly in `bin/` and there
   * is no `bin/win32` at all. Discovery took the newest extension and joined a fixed layout onto it
   * without checking, so it produced a path that did not exist, and the failure arrived as
   * `could not run alc (...): Executable not found` AFTER instrumenting and publishing — naming
   * nothing about the layout.
   */
  describe("AL extension layout changes (R167)", () => {
    const write = async (dir: string, name: string) => {
      await mkdir(dir, { recursive: true });
      await Bun.write(join(dir, name), "");
    };

    test("finds the tools when the VSIX puts them directly in bin/", async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), "al-r167-"));
      try {
        const ext = join(tmpDir, "ms-dynamics-smb.al-18.0.2668733");
        await write(join(ext, "bin"), "alc.exe");
        await write(join(ext, "bin"), "altool.exe");
        const result = await defaultAlToolPaths(tmpDir, "win32");
        expect(result?.alcPath).toEndWith(
          join("ms-dynamics-smb.al-18.0.2668733", "bin", "alc.exe"),
        );
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("prefers the per-RID directory when BOTH layouts are present", async () => {
      // On an older multi-platform VSIX the `bin/` root holds a DIFFERENT platform's binaries, so
      // the RID directory has to win or a Linux host gets a Windows PE — the exact regression R64
      // fixed and this must not reintroduce.
      const tmpDir = await mkdtemp(join(tmpdir(), "al-r167-"));
      try {
        const ext = join(tmpDir, "ms-dynamics-smb.al-18.0.2498801");
        await write(join(ext, "bin"), "alc.exe");
        await write(join(ext, "bin", "win32"), "alc.exe");
        const result = await defaultAlToolPaths(tmpDir, "win32");
        expect(result?.alcPath).toEndWith(join("bin", "win32", "alc.exe"));
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("SKIPS a newer extension that carries no tools and uses the older one", async () => {
      // The failure as it actually happened: both installed, newest chosen, path absent. Walking
      // newest-first and checking existence is what turns that into a working run.
      const tmpDir = await mkdtemp(join(tmpdir(), "al-r167-"));
      try {
        await mkdir(join(tmpDir, "ms-dynamics-smb.al-18.0.9999999", "bin"), { recursive: true });
        const older = join(tmpDir, "ms-dynamics-smb.al-18.0.2498801");
        await write(join(older, "bin", "win32"), "alc.exe");
        const result = await defaultAlToolPaths(tmpDir, "win32");
        expect(result?.alcPath).toContain("ms-dynamics-smb.al-18.0.2498801");
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    test("a WINDOWS-only VSIX is not offered to a Linux host", async () => {
      // The suffix is what keeps the `bin/` fallback honest across hosts: a Windows VSIX has
      // `bin/alc.exe` and no `bin/alc`, so the Linux probe must find nothing rather than hand back
      // a PE binary this host cannot execute.
      const tmpDir = await mkdtemp(join(tmpdir(), "al-r167-"));
      try {
        const ext = join(tmpDir, "ms-dynamics-smb.al-18.0.2668733");
        await write(join(ext, "bin"), "alc.exe");
        expect(await defaultAlToolPaths(tmpDir, "linux")).toBeUndefined();
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
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
      // R167: existence is now the selector, so each candidate must actually carry a tool or the
      // walk skips it. The ordering under test is unchanged.
      await Promise.all(dirs.map((d) => mkdir(join(d, "bin", "win32"), { recursive: true })));
      await Promise.all(dirs.map((d) => Bun.write(join(d, "bin", "win32", "alc.exe"), "")));

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
      // R167: see the note on the test above — existence is the selector now.
      await Promise.all(dirs.map((d) => mkdir(join(d, "bin", "win32"), { recursive: true })));
      await Promise.all(dirs.map((d) => Bun.write(join(d, "bin", "win32", "alc.exe"), "")));

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
