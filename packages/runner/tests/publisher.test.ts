import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Publisher, defaultAlToolPaths } from "../src/publisher";

function recordingSpawn(result = { exitCode: 0, stdout: "", stderr: "" }) {
  const calls: string[][] = [];
  const spawn = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return result;
  };
  return { calls, spawn };
}

const cfg = {
  alcPath: "C:/ext/bin/alc.exe",
  altoolPath: "C:/ext/bin/altool.exe",
  packageCachePath: "C:/proj/.alpackages",
  outputDir: "C:/out",
  server: "http://bcserver",
  serverInstance: "BC",
};

describe("Publisher.compile", () => {
  test("invokes alc with project, packagecache, out", async () => {
    const { calls, spawn } = recordingSpawn();
    const appPath = await new Publisher(cfg, spawn).compile("C:/instr");
    expect(calls[0]?.[0]).toBe("C:/ext/bin/alc.exe");
    expect(calls[0]).toContain("/project:C:/instr");
    expect(calls[0]).toContain("/packagecachepath:C:/proj/.alpackages");
    expect(appPath.startsWith("C:/out")).toBe(true);
  });

  test("failure surfaces stderr verbatim", async () => {
    const { spawn } = recordingSpawn({ exitCode: 1, stdout: "", stderr: "AL0132: nope" });
    await expect(new Publisher(cfg, spawn).compile("C:/instr")).rejects.toThrow("AL0132: nope");
  });

  test("spawn rejection includes alcPath context", async () => {
    const spawn = async () => {
      throw new Error("ENOENT: no such file or directory");
    };
    await expect(new Publisher(cfg, spawn).compile("C:/instr")).rejects.toThrow(
      "alc compile failed: ENOENT: no such file or directory (alcPath: C:/ext/bin/alc.exe)",
    );
  });

  test("normalizes all paths to forward slashes", async () => {
    const { calls, spawn } = recordingSpawn();
    const cfgWithBackslashes = {
      ...cfg,
      packageCachePath: "C:\\proj\\.alpackages",
      outputDir: "C:\\out",
    };
    await new Publisher(cfgWithBackslashes, spawn).compile("C:\\instr");
    expect(calls[0]).toContain("/project:C:/instr");
    expect(calls[0]).toContain("/packagecachepath:C:/proj/.alpackages");
  });
});

describe("Publisher.publish", () => {
  test("invokes altool publishapp with server params and ForceSync", async () => {
    const { calls, spawn } = recordingSpawn();
    await new Publisher(cfg, spawn).publish("C:/out/x.app");
    expect(calls[0]?.slice(0, 2)).toEqual(["C:/ext/bin/altool.exe", "publishapp"]);
    expect(calls[0]).toContain("C:/out/x.app");
    expect(calls[0]?.join(" ")).toContain("ForceSync");
  });

  test("spawn rejection includes altoolPath context", async () => {
    const spawn = async () => {
      throw new Error("ENOENT: no such file or directory");
    };
    await expect(new Publisher(cfg, spawn).publish("C:/out/x.app")).rejects.toThrow(
      "altool publishapp failed: ENOENT: no such file or directory (altoolPath: C:/ext/bin/altool.exe)",
    );
  });
});

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
