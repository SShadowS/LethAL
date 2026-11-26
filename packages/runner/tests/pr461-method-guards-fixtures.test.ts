import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { initParser } from "@lethal/engine";
import { largestMethodGuards, methodsOverGuardLimit } from "../src/large-fold";
import { generateMutationSet } from "../src/orchestrator";
import { textGuards, tierOf } from "./helpers/pr461";

/**
 * PR-461 (build review 1): the plan-based G on REAL shapes, not only the flat statements of the main
 * test: split `if`/`case` roots, loops, `#if`-holding roots, multi-object files, table and field
 * triggers. Read with the limit at 0, so every file is planned (no cheap skip).
 */
describe("PR-461: guards per method on the fixtures", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("on every target fixture the plan adds up and equals the emitted text; none is over (moves: 0)", async () => {
    const fixtures = resolve(import.meta.dir, "..", "..", "..", "fixtures");
    let planned = 0;
    for (const name of readdirSync(fixtures).sort()) {
      if (name.endsWith("-tests") || !existsSync(join(fixtures, name, "app.json"))) continue;
      const set = await generateMutationSet(join(fixtures, name), { emit: () => {} } as never);
      for (const f of set.files) {
        expect({ path: f.path, g: largestMethodGuards(f, tierOf, 0)?.guards ?? 0 }).toEqual({
          path: f.path,
          g: textGuards(f),
        });
        planned += 1;
      }
      expect(methodsOverGuardLimit(set.files, tierOf)).toEqual([]);
    }
    expect(planned).toBeGreaterThan(50);
  }, 150_000);
});
