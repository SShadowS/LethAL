import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { UnknownMaxRssUnitError, maxRssToMb } from "./measure-peak";

describe("maxRssToMb", () => {
  test("linux reads bytes", () => {
    expect(maxRssToMb(1024 * 1024 * 1024, "linux")).toBe(1024);
    expect(maxRssToMb(BigInt(2 * 1024 * 1024), "linux")).toBe(2);
  });
  test("win32 reads kilobytes", () => {
    expect(maxRssToMb(1024 * 1024, "win32")).toBe(1024);
  });
  test("an unmeasured platform throws, naming it", () => {
    expect(() => maxRssToMb(1, "darwin")).toThrow(UnknownMaxRssUnitError);
    expect(() => maxRssToMb(1, "darwin")).toThrow(/darwin/);
  });
});

describe("1 GB probe", () => {
  test("a child that fills 1 GB reports a peak between 1024 and 2048 MB", async () => {
    const script = join(import.meta.dir, "measure-peak.ts");
    const child =
      "const b = new Uint8Array(1024 * 1024 * 1024); b.fill(1); let s = 0; for (let i = 0; i < b.length; i += 4096) s += b[i] ?? 0; if (s < 0) console.log(s);";
    const proc = Bun.spawn([process.execPath, script, process.execPath, "-e", child], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    const m = /peak_mb (\d+)/.exec(stderr);
    expect(m).not.toBeNull();
    const peak = Number(m?.[1]);
    expect(peak).toBeGreaterThanOrEqual(1024);
    expect(peak).toBeLessThanOrEqual(2048);
  }, 120_000);
});
