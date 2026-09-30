import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import { buildAlRunnerCoverageIndex, normalizeFileKey } from "../src/al-runner-coverage";
import {
  generateMutationSet,
  operatorTiers,
  planArtifacts,
  prepareBatchProject,
} from "../src/orchestrator";

/**
 * R353, offline guard for `fixtures/sandbox-layout`'s PURPOSE. The live leg in `itest:alrunner`
 * goes red when R349's per-deploy reset is removed only because batch 1's instrumented `Grow`
 * runs over lines that batch 0's verbatim layout gives to `Twice`, and batch 1's instrumented
 * `Twice` sits past the end of the verbatim file. `Layout Beta`'s header comment sets those
 * spans. This test re-derives them from the code, so shortening the comment or an emitter change
 * that moves lines fails here in seconds, not after a three-minute live run.
 *
 * Pre-committed in docs/superpowers/specs/2026-09-30-r353-stale-layout-precommitment.md.
 */

const PROJECT = resolve(import.meta.dir, "../../../fixtures/sandbox-layout");
const BETA = "LayoutBeta.Codeunit.al";

/** `<batch>/<code>` with the dry run's line, operator and procedure, the spec's ten rows. */
const EXPECTED_MUTANTS = [
  "0/M0001 src\\LayoutAlpha.Codeunit.al 4 lethal.empty-block IsBig",
  "0/M0002 src\\LayoutAlpha.Codeunit.al 5 lethal.return-value IsBig",
  "0/M0003 src\\LayoutAlpha.Codeunit.al 5 lethal.conditional-boundary IsBig",
  "1/M0001 src\\LayoutBeta.Codeunit.al 4 lethal.empty-block Grow",
  "1/M0002 src\\LayoutBeta.Codeunit.al 5 lethal.conditional-boundary Grow",
  "1/M0003 src\\LayoutBeta.Codeunit.al 6 lethal.return-value Grow",
  "1/M0004 src\\LayoutBeta.Codeunit.al 6 lethal.swap-additive Grow",
  "1/M0005 src\\LayoutBeta.Codeunit.al 7 lethal.return-value Grow",
  "1/M0006 src\\LayoutBeta.Codeunit.al 37 lethal.empty-block Twice",
  "1/M0007 src\\LayoutBeta.Codeunit.al 38 lethal.return-value Twice",
];

/**
 * Batch 1's emitted Beta: the statement lines each baseline test hits, what the line holds, and
 * its owner under batch 1's own index and under batch 0's (the stale one R349 kept).
 */
const WITNESS_LINES: readonly {
  line: number;
  text: string;
  own: string;
  stale: string | undefined;
}[] = [
  { line: 8, text: "MutationSelector.Active('M0001')", own: "Grow", stale: "Grow" },
  { line: 36, text: "if X > 10 then", own: "Grow", stale: "Twice" },
  { line: 37, text: "exit(X + 1);", own: "Grow", stale: "Twice" },
  { line: 71, text: "MutationSelector.Active('M0006')", own: "Twice", stale: undefined },
  { line: 73, text: "MutationSelector.Active('M0007')", own: "Twice", stale: undefined },
  { line: 79, text: "exit(X * 2);", own: "Twice", stale: undefined },
];

interface Built {
  readonly batchPaths: readonly (readonly string[])[];
  readonly rows: readonly string[];
  readonly dirs: readonly string[];
}

/** Instruments both batches once, as `runSession` does, into a scratch directory. */
async function build(root: string): Promise<Built> {
  const { files, identityOrdinals } = await generateMutationSet(PROJECT);
  const batches = planArtifacts(files, { maxGuardsPerBatch: 7 });
  const manifest = JSON.parse(await readFile(join(PROJECT, "app.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const dirs: string[] = [];
  const rows: string[] = [];
  for (const [i, batch] of batches.entries()) {
    const dir = join(root, `batch-${i}`);
    await writeInstrumentedProject({
      targetDir: dir,
      files: batch,
      identityOrdinals,
      selectorIds: { selectorId: 79749, controlId: 79748, tableId: 79747 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: String(manifest.id),
      operatorTiers,
    });
    await prepareBatchProject(PROJECT, dir, manifest, "1.0.1.1");
    dirs.push(dir);
    const written = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as {
      mutants: {
        mutantId: string;
        file: string;
        startLine: number;
        operatorName: string;
        procedureName: string;
      }[];
    };
    for (const m of written.mutants) {
      rows.push(`${i}/${m.mutantId} ${m.file} ${m.startLine} ${m.operatorName} ${m.procedureName}`);
    }
  }
  return { batchPaths: batches.map((b) => b.map((f) => f.path)), rows, dirs };
}

describe("R353: sandbox-layout splits at maxGuardsPerBatch 7 across a member boundary", () => {
  let root = "";
  let built: Built | undefined;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lethal-r353-"));
    built = await build(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const get = (): Built => {
    if (built === undefined) throw new Error("beforeAll did not build the batches");
    return built;
  };

  it("gives the pre-committed ten mutants in two batches", () => {
    expect(get().batchPaths).toEqual([
      ["src\\LayoutAlpha.Codeunit.al"],
      ["src\\LayoutBeta.Codeunit.al"],
    ]);
    expect(get().rows).toEqual(EXPECTED_MUTANTS);
  });

  it("batch 0's layout misplaces batch 1's covered lines, and batch 1's own does not", async () => {
    const [dir0, dir1] = get().dirs;
    if (dir0 === undefined || dir1 === undefined) throw new Error("expected two batch dirs");
    const stale = await buildAlRunnerCoverageIndex(dir0);
    const own = await buildAlRunnerCoverageIndex(dir1);
    const beta = own.byFile.get(normalizeFileKey(BETA));
    if (beta === undefined) throw new Error(`batch 1's index does not declare ${BETA}`);
    expect(stale.byFile.get(normalizeFileKey(BETA))).toEqual(beta);

    const verbatim = (await readFile(join(dir0, BETA), "utf8")).split(/\r?\n/);
    const emitted = (await readFile(join(dir1, BETA), "utf8")).split(/\r?\n/);

    const actual = WITNESS_LINES.map(({ line }) => ({
      line,
      holds: emitted[line - 1]?.trim() ?? "",
      own: own.lineMap.lookup(beta.objectType, beta.objectId, line),
      stale: stale.lineMap.lookup(beta.objectType, beta.objectId, line),
    }));
    expect(actual).toEqual(
      WITNESS_LINES.map(({ line, text, own: o, stale: s }) => ({
        line,
        holds: expect.stringContaining(text),
        own: o,
        stale: s,
      })),
    );
    // The verbatim Beta is 40 lines (plus the final newline), so nothing past 40 has an owner.
    expect(verbatim.length).toBe(41);
  });
});
