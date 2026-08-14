import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AlRunnerCacheReport,
  describeAlRunnerCache,
  formatBytes,
  readAlRunnerCache,
} from "../src/al-runner-cache";
import { runDoctor } from "../src/doctor";

/**
 * R131. al-runner resolves a BC version by PREFIX, so every upstream Microsoft publish adds an
 * artifact directory rather than reusing one, and nothing anywhere cleans them up. Measured on this
 * machine: three 28.0 directories on 2026-08-09, SEVEN plus one 28.1 on 2026-08-14 — 1.3 GB, from a
 * handful of gate runs over five days.
 *
 * R131 weighed three options and ruled for the one that cannot be wrong: REPORT the size, name the
 * superseded builds, delete nothing. These tests pin that ruling as much as the arithmetic — the
 * check exists to hand an operator a number, and a future edit that turned it into a reaper would
 * be deleting from a cache another tool owns.
 */

async function withCache(
  layout: Readonly<Record<string, number>>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lethal-alrunner-cache-"));
  for (const [rel, size] of Object.entries(layout)) {
    await Bun.write(join(root, rel), "x".repeat(size));
  }
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("readAlRunnerCache", () => {
  test("an absent directory is a MEASURED absence, not a throw and not a zero-sized cache", async () => {
    const report = await readAlRunnerCache(join(tmpdir(), "lethal-no-such-cache-dir-1234"));
    expect(report.present).toBe(false);
    expect(report.builds).toEqual([]);
    expect(report.totalBytes).toBe(0);
    expect(describeAlRunnerCache(report)).toContain("no al-runner artifact cache");
  });

  test("sums every file under each build directory, recursively", async () => {
    await withCache(
      {
        "28.0.46665.53508/platform-apps/a.app": 100,
        "28.0.46665.53508/test-apps/b.app": 50,
        "28.1.49838.50794/engine/c.dll": 25,
      },
      async (dir) => {
        const report = await readAlRunnerCache(dir);
        expect(report.present).toBe(true);
        expect(report.totalBytes).toBe(175);
        expect(report.builds.map((b) => [b.version, b.bytes])).toEqual([
          ["28.1.49838.50794", 25],
          ["28.0.46665.53508", 150],
        ]);
      },
    );
  });

  /**
   * The superseded rule is the whole finding: al-runner resolves `28.0` FORWARD, so only the newest
   * build under a prefix is ever selected again. A different prefix is never superseded by it, which
   * is why 28.1 stays live below even though it is newer than every 28.0.
   */
  test("marks every build a NEWER build of the same MAJOR.MINOR prefix supersedes", async () => {
    await withCache(
      {
        "28.0.46665.53459/a": 10,
        "28.0.46665.53492/a": 10,
        "28.0.46665.53508/a": 10,
        "28.1.49838.50794/a": 10,
      },
      async (dir) => {
        const report = await readAlRunnerCache(dir);
        expect(report.builds.filter((b) => b.superseded).map((b) => b.version)).toEqual([
          "28.0.46665.53492",
          "28.0.46665.53459",
        ]);
        expect(
          report.builds
            .filter((b) => !b.superseded)
            .map((b) => b.version)
            .sort(),
        ).toEqual(["28.0.46665.53508", "28.1.49838.50794"]);
      },
    );
  });

  /** A string comparison gets `53508` vs `53492` right by accident and gets `9` vs `10` wrong. */
  test("compares version components numerically, not as strings", async () => {
    await withCache({ "28.0.9.1/a": 10, "28.0.10.1/a": 10 }, async (dir) => {
      const report = await readAlRunnerCache(dir);
      expect(report.builds.map((b) => b.version)).toEqual(["28.0.10.1", "28.0.9.1"]);
      expect(report.builds.filter((b) => b.superseded).map((b) => b.version)).toEqual(["28.0.9.1"]);
    });
  });
});

describe("describeAlRunnerCache", () => {
  test("names the total, the superseded builds, and WHOSE cache it is", async () => {
    await withCache({ "28.0.1.1/a": 2048, "28.0.1.2/a": 4096 }, async (dir) => {
      const detail = describeAlRunnerCache(await readAlRunnerCache(dir));
      expect(detail).toContain("6.0 KB across 2 BC build(s)");
      expect(detail).toContain("1 superseded (2.0 KB): 28.0.1.1");
      // The ruling, in the text a user actually reads. A number with no owner is a chore nobody
      // agreed to; R131 decided LethAL is not the owner.
      expect(detail).toContain("LethAL will not delete from it");
    });
  });

  test("says so plainly when nothing is superseded", async () => {
    await withCache({ "28.0.1.2/a": 4096 }, async (dir) => {
      expect(describeAlRunnerCache(await readAlRunnerCache(dir))).toContain("none superseded");
    });
  });
});

describe("formatBytes", () => {
  test("keeps one decimal, so a doubling cannot hide inside a rounded GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536 * 1024 * 1024)).toBe("1.5 GB");
  });
});

describe("lethal doctor — the al-runner cache check", () => {
  const EMPTY: AlRunnerCacheReport = {
    dir: "/nonexistent",
    present: false,
    totalBytes: 0,
    builds: [],
  };

  test("is reported as its own named check", async () => {
    const r = await runDoctor(
      { envReady: "Running" },
      {
        toolPaths: async () => ({ alc: "ok", altool: "ok" }),
        alRunnerCache: async () => EMPTY,
      },
    );
    const check = r.checks.find((c) => c.name === "al-runner-cache");
    expect(check).toBeDefined();
    expect(check?.detail).toContain("no al-runner artifact cache");
  });

  /**
   * The check is informational by construction and can never be `ok: false` — R131 ruled there is
   * no threshold here that is a FAULT, because the cache is not LethAL's to clean. Pinned so that
   * a future edit adding a size threshold has to change this test and say why, rather than
   * silently turning a report into a gate.
   */
  test("never fails the report, however large the cache is", async () => {
    const huge: AlRunnerCacheReport = {
      dir: "/cache",
      present: true,
      totalBytes: 500 * 1024 * 1024 * 1024,
      builds: [{ version: "28.0.1.1", bytes: 500 * 1024 * 1024 * 1024, superseded: true }],
    };
    const r = await runDoctor(
      { envReady: "Running" },
      {
        toolPaths: async () => ({ alc: "ok", altool: "ok" }),
        alRunnerCache: async () => huge,
      },
    );
    expect(r.checks.find((c) => c.name === "al-runner-cache")?.ok).toBe(true);
    expect(r.ok).toBe(true);
  });

  /** A THROWN dep still reaches the report as a failed check rather than aborting the run — the
   *  boundary `runCheck` exists for, asserted for this dep too. */
  test("a cache read that throws becomes a failed check, not a dead report", async () => {
    const r = await runDoctor(
      { envReady: "Running" },
      {
        toolPaths: async () => ({ alc: "ok", altool: "ok" }),
        alRunnerCache: async () => {
          throw new Error("EACCES: permission denied");
        },
      },
    );
    const check = r.checks.find((c) => c.name === "al-runner-cache");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("EACCES");
    expect(r.checks.find((c) => c.name === "tool-paths")?.ok).toBe(true);
  });
});
