import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const r326Dirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("r326-w8-"));

test("r326-w8-memory on sandbox-app: three markers, heap capacity, temp dir removed", async () => {
  const before = r326Dirs();
  const out = join(mkdtempSync(join(tmpdir(), "r326test-")), "out.json");
  const p = Bun.spawn(["bun", "scripts/r326-w8-memory.ts", "fixtures/sandbox-app", out], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  expect(await p.exited).toBe(0);
  expect(err).toContain("MARK write-start ");
  const j = JSON.parse(readFileSync(out, "utf8"));
  expect(j.markers.map((m: { name: string }) => m.name)).toEqual(["start", "generated", "written"]);
  for (const m of j.markers) {
    for (const k of ["rss", "heapUsed", "external", "heapSize", "heapCapacity", "vmHwmKb"]) {
      expect(typeof m[k]).toBe("number");
      expect(m[k]).toBeGreaterThan(0);
    }
    expect(m.heapCapacity).toBeGreaterThanOrEqual(m.heapSize);
  }
  expect(j.counts.manifestRows).toBeGreaterThan(0);
  expect(r326Dirs().filter((n) => !before.includes(n))).toEqual([]);
}, 120_000);
