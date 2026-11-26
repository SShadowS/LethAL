import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { assignMutantIds, buildComponents, dedupeSpecs } from "@lethal/schemata";
import { printDryRun } from "../src/cli";
import {
  MAX_GUARDS_PER_METHOD,
  MethodGuardsPlanError,
  MethodGuardsRefusedError,
  assertMethodGuards,
  largestMethodGuards,
  largestOfComponents,
  methodGuardsRefusal,
  methodsOverGuardLimit,
} from "../src/large-fold";
import {
  fileOf,
  session,
  statementsOverLimit,
  textGuards,
  tierOf,
  writeProject,
} from "./helpers/pr461";

/**
 * PR-461 (R826 step 3, spec 2026-11-26-pr460-r826-size-ladder.md amendment 4): on bcdev a file whose
 * largest method holds more than MAX_GUARDS_PER_METHOD guards is refused by name before any publish.
 * G comes from the generator's plan; these tests pin it to the emitted text and to the threshold both
 * ways. The --confirm case is in `pr461-method-guards-confirm.test.ts`, the fixtures' real shapes in
 * `pr461-method-guards-fixtures.test.ts`.
 */

async function dryRun(dir: string, backendKind?: "bcdev" | "al-runner-v3"): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.join(" "));
  });
  try {
    await printDryRun(dir, undefined, {
      dbPath: join(dir, "no-such.sqlite"),
      configPath: join(dir, "no-such.json"),
      ...(backendKind !== undefined ? { backendKind } : {}),
    });
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

/** Statements per method that put one method just over the real threshold. */
let overN = 0;

describe("PR-461: guards per method on bcdev", () => {
  beforeAll(async () => {
    await initParser();
    overN = await statementsOverLimit();
  }, 120_000);

  test("the constant is the ladder's last pass, and its text says it is BC 28.4's", () => {
    expect(MAX_GUARDS_PER_METHOD).toBe(4800);
    const text = methodGuardsRefusal([{ path: "a.al", method: "M", line: 3, guards: 4801 }]) ?? "";
    expect(text).toContain("measured on BC 28.4 W1 Linux (R826): not measured on BC 29 or Windows");
  });

  test("G from the plan equals the guards in the emitted text's largest method", async () => {
    const f = await fileOf([40, 120, 70]);
    const g = largestMethodGuards(f, tierOf, 0);
    expect(g?.guards).toBeGreaterThan(0);
    expect(g?.guards).toBe(textGuards(f));
    expect(g?.method).toBe("Work1");
    expect(g?.line).toBe(f.source.split("\n").findIndex((l) => l.includes("procedure Work1")) + 1);
  });

  test("the threshold both ways: G over it is named, G at it is not", async () => {
    // Two methods, so the file's count is over G and the plan is read at limit = G (no cheap skip).
    const f = await fileOf([60, 20]);
    const g = largestMethodGuards(f, tierOf, 0)?.guards ?? 0;
    expect(g).toBeGreaterThan(0);
    expect(largestMethodGuards(f, tierOf, g)?.guards).toBe(g);
    expect(methodsOverGuardLimit([f], tierOf, g)).toEqual([]);
    expect(methodsOverGuardLimit([f], tierOf, g - 1).map((m) => m.guards)).toEqual([g]);
    expect(() => assertMethodGuards([f], tierOf, g)).not.toThrow();
    expect(() => assertMethodGuards([f], tierOf, g - 1)).toThrow(MethodGuardsRefusedError);
  });

  test("many guards over small methods is not refused: the file's count is over, no method is", async () => {
    const f = await fileOf([50, 50, 50]);
    const file = dedupeSpecs(f.specs, tierOf).length;
    const g = largestMethodGuards(f, tierOf, 0)?.guards ?? 0;
    expect(g * 2).toBeLessThan(file);
    // The file's count is over the limit, so the plan IS read (not the cheap skip), and it says no.
    expect(largestMethodGuards(f, tierOf, g)).toBeDefined();
    expect(methodsOverGuardLimit([f], tierOf, g)).toEqual([]);
  });

  test("a file at or under the limit is not planned at all (G cannot pass it)", async () => {
    const f = await fileOf([30]);
    const file = dedupeSpecs(f.specs, tierOf).length;
    expect(largestMethodGuards(f, tierOf, file)).toBeUndefined();
    expect(largestMethodGuards(f, tierOf, file - 1)).toBeDefined();
  });

  test("the refusal names the file, the method, its line, G and the levers", async () => {
    const f = await fileOf([60]);
    let message = "";
    try {
      assertMethodGuards([f], tierOf, 10);
    } catch (e) {
      expect(e).toBeInstanceOf(MethodGuardsRefusedError);
      message = (e as Error).message;
    }
    expect(message).toContain("P.Codeunit.al: Work0 (line 3) holds");
    expect(message).toContain("over 10 guards");
    for (const lever of [
      "--lines",
      "--only",
      "--exclude-operator",
      "--operator",
      "--allow-large-run does not lift it",
      "R1231",
      "300 s request ceiling",
    ]) {
      expect(message).toContain(lever);
    }
  });

  test("the plan fails loudly when it does not add up, never as G = 0", async () => {
    const f = await fileOf([20]);
    const deduped = dedupeSpecs(f.specs, tierOf);
    const ided = assignMutantIds(new Map([[f.path, deduped]])).get(f.path) ?? [];
    const components = buildComponents(ided);
    // The real plan adds up, and gives the same G as the file-level reader.
    expect(largestOfComponents(f.path, components, ided.length)?.guards).toBe(
      largestMethodGuards(f, tierOf, 0)?.guards ?? -1,
    );
    // Sums that miss the deployed count.
    expect(() => largestOfComponents(f.path, components, ided.length + 1)).toThrow(
      MethodGuardsPlanError,
    );
    // A component whose root sits in no procedure or trigger: its object node, the file's top.
    const [c] = components;
    if (c === undefined) throw new Error("no component");
    let top = c.root;
    while (top.parent !== null && top.parent.parent !== null) top = top.parent;
    // `deployed` counts only the in-method component, so only the no-method check can fire.
    expect(() =>
      largestOfComponents(f.path, [c, { root: top, members: c.members }], c.members.length),
    ).toThrow(/sits in no procedure or trigger/);
  });

  test("a bcdev session over the limit refuses before any deploy; v3 runs it", async () => {
    const big = await session([overN], "bcdev");
    expect(big.thrown).toBeInstanceOf(MethodGuardsRefusedError);
    expect(big.deploys).toBe(0);
    const v3 = await session([overN], "al-runner-v3");
    expect(v3.thrown).not.toBeInstanceOf(MethodGuardsRefusedError);
    expect(v3.deploys).toBeGreaterThan(0);
  }, 60_000);

  test("a bcdev session at a method just under the limit is not refused", async () => {
    // overN is the first size over, so one statement fewer is at or under 4,800: the edge, both ways.
    expect(
      largestMethodGuards(await fileOf([overN - 1]), tierOf, 0)?.guards ?? Number.POSITIVE_INFINITY,
    ).toBeLessThanOrEqual(MAX_GUARDS_PER_METHOD);
    const under = await session([overN - 1], "bcdev");
    expect(under.thrown).not.toBeInstanceOf(MethodGuardsRefusedError);
    expect(under.deploys).toBeGreaterThan(0);
  }, 60_000);

  test("--dry-run says so for a BC tier and not for al-runner-v3", async () => {
    const dir = writeProject([overN]);
    expect(await dryRun(dir, "bcdev")).toContain("hold a method over 4,800 guards");
    expect(await dryRun(dir)).toContain("hold a method over 4,800 guards");
    expect(await dryRun(dir, "al-runner-v3")).not.toContain("hold a method over");
  }, 60_000);
});
