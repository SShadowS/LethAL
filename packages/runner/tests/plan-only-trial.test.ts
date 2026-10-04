import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { ALSyntaxNode } from "@lethal/engine";
import { initParser } from "@lethal/engine";
import * as schemata from "@lethal/schemata";
import { printDryRun } from "../src/cli";
import { generateMutationSet } from "../src/orchestrator";

/**
 * R-307 O6 (plan amendment, section 5). `generateMutationSet`'s per-file trial runs PLAN only
 * (`planOneFile`): it builds no instrumented text, and a plain `Error` raised inside PLAN still
 * aborts the run rather than becoming a refusal row.
 */

const REPO = join(import.meta.dir, "../../..");
/** A fixture with mutable sites in every file the trial reaches. */
const FIXTURE = join(REPO, "fixtures/sandbox-app");

describe("R-307 O6: the trial runs PLAN only", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("the trial never calls emitOneFile, and does call planOneFile", async () => {
    const plan = spyOn(schemata, "planOneFile");
    const emit = spyOn(schemata, "emitOneFile");
    try {
      const set = await generateMutationSet(FIXTURE, { emit: () => {} });
      expect(set.files.length).toBeGreaterThan(0);
      expect(plan).toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      plan.mockRestore();
      emit.mockRestore();
    }
  });

  test("E1 inside PLAN aborts a --dry-run; it is not turned into a refusal row", async () => {
    // The same plain Error E1 (`resolveStatement`, enclosing.ts) throws today.
    const spy = spyOn(schemata, "resolveStatement").mockImplementation((before: ALSyntaxNode) => {
      throw new Error(
        `resolveSite: no enclosing statement for node at ${before.startIndex}..${before.endIndex}`,
      );
    });
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(
        printDryRun(FIXTURE, undefined, {
          dbPath: join(REPO, "no-such-dir", "lethal.sqlite"),
          configPath: join(REPO, "no-such-dir", "lethal.config.json"),
        }),
      ).rejects.toThrow("resolveSite: no enclosing statement for node at");
      // A test that never reaches `resolveStatement` cannot pass.
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }
  });
});
