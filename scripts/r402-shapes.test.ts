// R754: the unit half of the R402 shape sweep. scripts/r402-shape-sweep.ts compiles every shape
// (source and instrumented artifact) with alc; that compile half stays manual because it needs alc
// and symbols. This file runs the generate-and-judge half (r402-shapes.ts) for every shape and
// build with no .alpackages: generateMutationSet reads no symbols, measured equal (0 of 188 cases
// differ with and without them). Only spec COUNTS and refusal reasons are pinned, not which specs,
// operators or hang tags (the sweep prints those).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "../packages/engine/src/ast/parser";
import { generateMutationSet } from "../packages/runner/src/orchestrator";
import {
  R402_BUILDS,
  R402_SHAPES_DIR,
  judgeShape,
  r402Expected,
  r402ShapeNames,
  runShape,
  writeShapeProject,
} from "./r402-shapes.ts";

// A shape whose current count differs from expected.json on master, filed as a roadmap item.
// Do not edit expected.json to hide it. (w6 was held here at 28 until R752 restored 29.)
const KNOWN_DRIFT: Record<string, { item: string; specs: readonly number[] }> = {};

const names = r402ShapeNames();
const expected = r402Expected();
const appJson = readFileSync(
  join(import.meta.dir, "..", "fixtures/sandbox-symbols/app.json"),
  "utf8",
);
let scratch = "";
let casesRun = 0;

beforeAll(async () => {
  await initParser();
  scratch = mkdtempSync(join(tmpdir(), "r402-shapes-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe("R402 shape coverage", () => {
  test("pins: 47 shapes, 4 builds, one spec count per build", () => {
    expect(names.length).toBe(47);
    expect(R402_BUILDS.length).toBe(4);
    for (const [name, e] of Object.entries(expected))
      if (e.specs !== undefined) expect([name, e.specs.length]).toEqual([name, R402_BUILDS.length]);
  });

  test("every shape has an expected entry and every entry has a shape", () => {
    expect(names.filter((n) => expected[n] === undefined)).toEqual([]);
    expect(Object.keys(expected).filter((k) => !names.includes(k))).toEqual([]);
  });
});

describe("R402 shapes", () => {
  for (const name of names) {
    for (const [bi, build] of R402_BUILDS.entries()) {
      const label = `${name} [${build.join(",")}]`;
      test(`${name} [${build.join(",") || "none"}]`, async () => {
        casesRun++;
        const want = expected[name];
        expect(want).toBeDefined();
        if (want === undefined) return;
        const dir = join(scratch, "src");
        writeShapeProject(dir, appJson, readFileSync(join(R402_SHAPES_DIR, `${name}.al`), "utf8"));
        const { specs, undecided } = await runShape(generateMutationSet, dir, build);
        const drift = KNOWN_DRIFT[name];
        if (drift === undefined) {
          expect(judgeShape(label, want, bi, specs.length, undecided)).toEqual([]);
          return;
        }
        // Today's exact figures, no refusal...
        expect(judgeShape(label, { specs: drift.specs }, bi, specs.length, undecided)).toEqual([]);
        // ...and expected.json still disagrees on exactly builds 0 and 2.
        const differs = judgeShape(label, want, bi, specs.length, undecided).length > 0;
        expect(differs).toBe(bi === 0 || bi === 2);
      });
    }
  }
});

describe("R402 totals", () => {
  test("188 cases ran (47 shapes x 4 builds)", () => {
    expect(casesRun).toBe(188);
  });
});
