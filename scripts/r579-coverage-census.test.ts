import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("census over the fixtures exits 0, sees the wrapped fixture, and totals equal the sums", async () => {
  const out = join(mkdtempSync(join(tmpdir(), "r579-")), "out.json");
  const p = Bun.spawn(
    ["bun", join(root, "scripts/r579-coverage-census.ts"), root, join(root, "fixtures"), out],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await p.exited).toBe(0);
  const r = JSON.parse(readFileSync(out, "utf8"));
  const rows = r.projects as {
    rel: string;
    coverage: string;
    multiObjectFiles: number;
    refusedWrapped: Record<string, number>;
    onIfFixed: boolean;
  }[];
  const off = rows.filter((x) => x.coverage === "off");
  expect(r.totals.projects).toBe(rows.length);
  expect(r.totals.coverageOff).toBe(off.length);
  expect(r.totals.onIfFixed).toBe(off.filter((x) => x.onIfFixed).length);
  for (const [key, cls] of [
    ["offBecausePragmaOnly", "pragma-only-wrapper"],
    ["offBecauseCodeFree", "code-free-wrapped"],
    ["offBecauseCodeBearing", "code-bearing-wrapped"],
  ] as const) {
    expect(r.totals[key]).toBe(off.filter((x) => (x.refusedWrapped[cls] ?? 0) > 0).length);
  }
  expect(r.totals.offBecauseMultiObject).toBe(off.filter((x) => x.multiObjectFiles > 0).length);
  // The wrapped fixture is a source app and is in the census; the multi-object fixture has a multi-object file.
  expect(rows.some((x) => x.rel === "sandbox-wrapped")).toBe(true);
  expect(rows.find((x) => x.rel === "sandbox-multiobject")?.multiObjectFiles).toBeGreaterThan(0);
}, 120_000);
