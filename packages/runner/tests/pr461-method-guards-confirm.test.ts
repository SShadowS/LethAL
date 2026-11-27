import { beforeAll, describe, expect, test } from "bun:test";
import { initParser } from "@lethal/engine";
import { sha256Hex } from "../src/confirm";
import { MethodGuardsRefusedError } from "../src/large-fold";
import { session, statementsOverLimit, writeProject, writeTests } from "./helpers/pr461";

/**
 * PR-461 (build review 1): the guards-per-method refusal reads the DEPLOYED set, after `--confirm`
 * narrows it, so a confirm run of a few mutants in a method over the limit is not refused.
 */
describe("PR-461: --confirm and the guards-per-method refusal", () => {
  let overN = 0;
  beforeAll(async () => {
    await initParser();
    overN = await statementsOverLimit();
  }, 120_000);

  test("a few confirmed mutants of a method over the limit are not refused; the full set is", async () => {
    // v3 runs the large method (no refusal there); a bcdev confirm run deploys a small sample of its
    // survivors, so the method then holds a few guards, not 4,800.
    const dirs = { projectDir: writeProject([overN]), testDir: writeTests() };
    const v3 = await session(dirs, "al-runner-v3", {}, true);
    if (v3.report === undefined) throw new Error(`v3 run failed: ${String(v3.thrown)}`);
    const text = JSON.stringify(v3.report);
    const confirm = await session(
      dirs,
      "bcdev",
      {
        confirm: {
          inputPath: "v3.json",
          input: JSON.parse(text),
          inputSha256: sha256Hex(text),
          sample: 3,
        },
      },
      true,
    );
    expect(confirm.thrown).toBeUndefined();
    expect(confirm.deploys).toBeGreaterThan(0);
    expect((await session(dirs, "bcdev", {}, true)).thrown).toBeInstanceOf(
      MethodGuardsRefusedError,
    );
  }, 150_000);
});
