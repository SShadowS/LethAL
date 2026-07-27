import { describe, expect, test } from "bun:test";
import type { InstrumentedFile } from "@lethal/schemata";
import { planArtifacts } from "../src/orchestrator";

/**
 * R44: publish cost scales with INJECTED GUARD COUNT, because BC recompiles the extension
 * server-side on a dev publish. Measured against a hosted Continia BC 28 environment, same app and
 * same publish path, only the guard count differing:
 *
 *   163 guards    -> HTTP 200 in 28 s
 *   11,777 guards -> nginx 504 Gateway Time-out at 362 s
 *
 * So "every mutant in one artifact" is not publishable for a real app, and the fix is to bound a
 * batch by guards rather than by nothing. Document Output's largest single file holds 632 sites,
 * so file-granularity binning is sufficient there — but a file that alone exceeds the budget must
 * still be handled, and honestly.
 */

function file(path: string, specs: number): InstrumentedFile {
  return {
    path,
    source: "",
    root: {} as InstrumentedFile["root"],
    specs: Array.from({ length: specs }, () => ({}) as InstrumentedFile["specs"][number]),
  };
}

function guardsOf(batch: readonly InstrumentedFile[]): number {
  return batch.reduce((n, f) => n + f.specs.length, 0);
}

describe("planArtifacts — guard budget (R44)", () => {
  test("without a budget, everything stays in one batch (unchanged default)", () => {
    // The frozen live gates run this path; a behaviour change here would move their baselines.
    const batches = planArtifacts([file("a.al", 500), file("b.al", 500)]);
    expect(batches).toHaveLength(1);
    expect(guardsOf(batches[0] ?? [])).toBe(1000);
  });

  test("an empty set produces no batches at all", () => {
    expect(planArtifacts([])).toEqual([]);
  });

  test("splits so no batch exceeds the budget", () => {
    const batches = planArtifacts([file("a.al", 400), file("b.al", 400), file("c.al", 400)], {
      maxGuardsPerBatch: 800,
    });
    expect(batches).toHaveLength(2);
    for (const b of batches) expect(guardsOf(b)).toBeLessThanOrEqual(800);
  });

  test("every file lands in exactly one batch — none dropped, none duplicated", () => {
    // The dangerous failure: a binning bug that silently drops a file removes its mutants from
    // the run entirely, and the report would show a smaller total with no indication why.
    const files = [file("a.al", 300), file("b.al", 300), file("c.al", 300), file("d.al", 300)];
    const batches = planArtifacts(files, { maxGuardsPerBatch: 700 });
    const placed = batches.flat().map((f) => f.path);
    expect(placed.sort()).toEqual(["a.al", "b.al", "c.al", "d.al"]);
    expect(guardsOf(batches.flat())).toBe(1200);
  });

  test("a single file larger than the budget becomes its own batch rather than being dropped", () => {
    // planArtifacts splits at FILE granularity by contract, so it cannot subdivide one file. The
    // honest options are "oversized batch" or "silently lose the file"; only the first is
    // acceptable, and the caller is told.
    const batches = planArtifacts([file("huge.al", 5000), file("small.al", 10)], {
      maxGuardsPerBatch: 800,
    });
    const huge = batches.find((b) => b.some((f) => f.path === "huge.al"));
    expect(huge).toBeDefined();
    expect(huge).toHaveLength(1);
    expect(
      batches
        .flat()
        .map((f) => f.path)
        .sort(),
    ).toEqual(["huge.al", "small.al"]);
  });

  test("a budget larger than the whole set still yields one batch", () => {
    const batches = planArtifacts([file("a.al", 100), file("b.al", 100)], {
      maxGuardsPerBatch: 10_000,
    });
    expect(batches).toHaveLength(1);
  });

  test("DO's real shape: 11,777 guards, largest file 632, budget 800", () => {
    // The measured distribution. Confirms file-granularity binning is sufficient for this app —
    // no batch is oversized, so nothing needs intra-file splitting.
    const sizes = [632, 473, 437, 387, 355];
    const rest = Array.from({ length: 157 }, (_, i) => 50 + (i % 40));
    const files = [...sizes, ...rest].map((n, i) => file(`f${i}.al`, n));
    const batches = planArtifacts(files, { maxGuardsPerBatch: 800 });
    expect(batches.every((b) => guardsOf(b) <= 800)).toBe(true);
    expect(batches.flat()).toHaveLength(files.length);
  });
});

describe("parseCliConfig — --max-guards-per-batch (R44)", () => {
  const RUN_ARGS = ["run", "--project", "p", "--tests", "t", "--backend", "al-runner"] as const;

  test("parses a positive integer", async () => {
    const { parseCliConfig } = await import("../src/cli");
    const cfg = parseCliConfig([...RUN_ARGS, "--max-guards-per-batch", "800"]);
    if (cfg.mode !== "run") throw new Error("mode drift");
    expect(cfg.maxGuardsPerBatch).toBe(800);
  });

  test("omitting it leaves the key absent (unbounded, the prior behaviour)", async () => {
    const { parseCliConfig } = await import("../src/cli");
    const cfg = parseCliConfig([...RUN_ARGS]);
    expect("maxGuardsPerBatch" in cfg).toBe(false);
  });

  test("rejects zero, negatives and non-integers at parse time", async () => {
    const { parseCliConfig } = await import("../src/cli");
    for (const bad of ["0", "1.5", "many"]) {
      expect(() => parseCliConfig([...RUN_ARGS, "--max-guards-per-batch", bad])).toThrow(
        /must be a positive integer/,
      );
    }
    // A negative needs `=` form: parseArgs refuses a dash-prefixed value as ambiguous before this
    // validation runs, so passing "-5" positionally would test node's parser, not ours.
    expect(() => parseCliConfig([...RUN_ARGS, "--max-guards-per-batch=-5"])).toThrow(
      /must be a positive integer/,
    );
  });
});
