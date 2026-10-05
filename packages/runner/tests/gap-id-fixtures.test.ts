import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { MutantManifest } from "@lethal/schemata";
import { writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";

// C02-09: the gap-id predictions over sandbox-app, through the real operator set and the real
// writer. They live here, not in schemata, because the runner owns spec generation.
const REPO = resolve(import.meta.dir, "../../..");

async function manifestOfFixture(name: string): Promise<MutantManifest> {
  const set = await generateMutationSet(join(REPO, "fixtures", name));
  const dir = await mkdtemp(join(tmpdir(), "lethal-gap-"));
  try {
    await writeInstrumentedProject({
      targetDir: dir,
      files: set.files,
      identityOrdinals: identityOrdinalsOf(set),
      selectorIds: { selectorId: 79997, controlId: 79998, tableId: 79999 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
      operatorTiers,
    });
    return JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as MutantManifest;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("gap ids over sandbox-app (C02-09)", () => {
  test("sandbox-app: LogAudit has two gaps, the body and the then-block, and every entry has one", async () => {
    const m = await manifestOfFixture("sandbox-app");
    for (const e of m.mutants) {
      expect(e.gapId).toMatch(/^G[0-9a-f]{12}$/);
      expect(e.blockStartLine).toBeLessThanOrEqual(e.startLine);
      expect(e.blockEndLine).toBeGreaterThanOrEqual(e.startLine);
    }
    const log = m.mutants.filter((e) => e.procedureName === "LogAudit");
    expect(new Set(log.map((e) => e.gapId)).size).toBe(2);
    const then = log.find((e) => e.operatorName === "lethal.remove-assignment");
    const cond = log.find((e) => e.operatorName === "lethal.negate-conditional");
    expect(then?.gapId).not.toBe(cond?.gapId);
    expect(
      log
        .filter((e) => e.gapId === then?.gapId)
        .map((e) => e.operatorName)
        .sort(),
    ).toEqual(["lethal.empty-block", "lethal.remove-assignment"]);
    expect(
      log
        .filter((e) => e.gapId === cond?.gapId)
        .map((e) => e.operatorName)
        .sort(),
    ).toEqual(["lethal.empty-block", "lethal.negate-conditional", "lethal.shift-integer"]);
  });

  test("sandbox-app: ClampPercent, ApplyAudit, IsOverBudget and DiscountedPrice each have ONE gap", async () => {
    const m = await manifestOfFixture("sandbox-app");
    for (const p of ["ClampPercent", "ApplyAudit", "IsOverBudget", "DiscountedPrice"]) {
      expect(new Set(m.mutants.filter((e) => e.procedureName === p).map((e) => e.gapId)).size).toBe(
        1,
      );
    }
  });
});
