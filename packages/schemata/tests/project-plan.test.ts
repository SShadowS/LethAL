import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALNodeKind, findAll, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { MutationSpec } from "@lethal/engine";
import {
  type MutantManifest,
  withRunIdentityOrdinals,
  writeInstrumentedProject,
} from "../src/project";
import * as projectPlan from "../src/project-plan";

/**
 * R-307 O6 (plan amendment r3, section 3). The writer takes each mutant's header and grain from
 * `FilePlan.mutants`, walked in step with `ided` by position. A plan whose `mutants` is shorter
 * than `ided`, or out of order, is a caller-contract violation: the writer throws, naming the file
 * and the mutant, and never writes a wrong header.
 */

/** Two codeunits in one file, so a mutant attributed to the wrong one shows a wrong header. */
const SRC = [
  'codeunit 79392 "First"',
  "{",
  "    procedure P()",
  "    var",
  "        X: Integer;",
  "    begin",
  "        X := 1;",
  "    end;",
  "}",
  'codeunit 79393 "Second"',
  "{",
  "    procedure Q()",
  "    var",
  "        Y: Integer;",
  "    begin",
  "        Y := 1;",
  "    end;",
  "}",
  "",
].join("\n");

const PATH = "Two.Codeunit.al";

function inputFor(dir: string) {
  const root = wrapRoot(parseAL(SRC));
  const specs: MutationSpec[] = findAll(root, ALNodeKind.assignment_statement).map((a) => ({
    operatorName: "op.flip",
    operatorVersion: "1.0.0",
    astNodeId: `${a.startIndex}`,
    before: a,
    after: { ...a, text: `${a.text.slice(0, 1)} := 2` } as never,
    parentContext: "statement-position" as const,
  }));
  if (specs.length !== 2) throw new Error("fixture drift: two assignments");
  return withRunIdentityOrdinals({
    targetDir: dir,
    files: [{ path: PATH, source: SRC, root, specs }],
    selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
    operatorTiers: new Map(),
  });
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-o6-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("R-307 O6: the writer walks FilePlan.mutants by position", () => {
  beforeAll(async () => {
    await initParser();
  });

  const realPlanOneFile = projectPlan.planOneFile;
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  /** Spies on PLAN's `planOneFile`; the real one runs, then `edit` changes its `mutants`. */
  function planWith(
    edit: (m: readonly projectPlan.PlannedMutant[]) => projectPlan.PlannedMutant[],
  ): void {
    const spy = spyOn(projectPlan, "planOneFile").mockImplementation((f, deduped, ided) => {
      const plan = realPlanOneFile(f, deduped, ided);
      return { ...plan, mutants: edit(plan.mutants) };
    });
    restore = () => spy.mockRestore();
  }

  it("unchanged plan: each mutant gets its own object's header", async () => {
    await withDir(async (dir) => {
      await writeInstrumentedProject(inputFor(dir));
      const m = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      ) as MutantManifest;
      expect(m.mutants.map((r) => [r.mutantId, r.codeunitId, r.reachGrain])).toEqual([
        ["M0001", 79392, "statement"],
        ["M0002", 79393, "statement"],
      ]);
    });
  });

  it("a plan with fewer mutants than ided makes the writer throw, naming file and mutant", async () => {
    planWith((m) => m.slice(0, 1));
    await withDir(async (dir) => {
      await expect(writeInstrumentedProject(inputFor(dir))).rejects.toThrow(
        /Two\.Codeunit\.al.*M0002|M0002.*Two\.Codeunit\.al/,
      );
    });
  });

  it("a plan whose mutants are out of order makes the writer throw, naming file and mutant", async () => {
    planWith((m) => [...m].reverse());
    await withDir(async (dir) => {
      await expect(writeInstrumentedProject(inputFor(dir))).rejects.toThrow(
        /Two\.Codeunit\.al.*M0001|M0001.*Two\.Codeunit\.al/,
      );
    });
  });
});
