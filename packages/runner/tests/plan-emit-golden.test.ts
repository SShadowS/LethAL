import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ALNodeKind,
  type ALSyntaxNode,
  type MutationSpec,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import {
  type TierResolver,
  assignMutantIds,
  dedupeSpecs,
  instrumentOneFile,
} from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";

/**
 * R-307 O1 (plan amendment 2026-10-03, section 5). Two golden records, taken from the code BEFORE
 * the PLAN/EMIT split, so the split can be compared against what the writer did, not against
 * itself:
 *
 * (a) `reach-grain-golden.json`: the reach grain of every mutant in every project the GH-24 test
 *     (`reach-grain-fixtures.test.ts`) walks, keyed `<project>/<file>/<mutantId>`, plus three hand
 *     cases whose `before` starts where its resolved statement (a nested block) starts. There the
 *     grain rule reads the replacement text and the empty-slot filler, not the source. O3 checks
 *     the shared splice function against this table.
 * (b) `instrumented-output-golden.json`: for every file the per-file trial reaches in every
 *     fixture and example project, the sha256 of `instrumentOneFile`'s output, keyed
 *     `<project>/<file>`. A file refused today records its refusal `shape` and `file` instead.
 *     O8 compares the split's output against this table.
 *
 * Inputs are exactly the trial's (`generateMutationSet`): the file's specs after the operator and
 * line filters, deduped, with file-local ids. A project with a `symbol-sets.json` is recorded once
 * per set, as `<project>[<symbols>]`.
 *
 * The records never write themselves. A missing file fails with the command that records it;
 * `LETHAL_RECORD_PLAN_EMIT_GOLDEN=1` records, refuses to overwrite, and still fails the run, so a
 * record run is never a pass. A re-record needs the orchestrator's ruling, as any frozen baseline.
 */

const REPO = resolve(import.meta.dir, "../../..");
const GRAIN_FILE = join(import.meta.dir, "__fixtures__", "reach-grain-golden.json");
const OUTPUT_FILE = join(import.meta.dir, "__fixtures__", "instrumented-output-golden.json");
const RECORD = process.env.LETHAL_RECORD_PLAN_EMIT_GOLDEN === "1";

/** The GH-24 test's own list, unchanged: record (a) covers exactly what that test walks. */
const GRAIN_PROJECTS = [
  "fixtures/sandbox-app",
  "fixtures/sandbox-data",
  "fixtures/sandbox-hang",
  "fixtures/sandbox-symbols",
  "examples/gift-card",
  "examples/credit-limit",
];

/** Every fixture and example project (a directory holding `app.json`). */
function allProjects(): string[] {
  const out: string[] = [];
  for (const parent of ["fixtures", "examples"]) {
    for (const name of readdirSync(join(REPO, parent)).sort()) {
      if (existsSync(join(REPO, parent, name, "app.json"))) out.push(`${parent}/${name}`);
    }
  }
  return out;
}

const tierOf: TierResolver = (name) => operatorTiers.get(name);

interface OutputRecord {
  readonly sha256?: string;
  readonly mutants?: number;
  readonly refused?: { readonly shape: string; readonly file: string };
}

interface Taken {
  readonly grains: Record<string, string>;
  readonly outputs: Record<string, OutputRecord>;
}

async function symbolSetsOf(rel: string): Promise<readonly (readonly string[])[]> {
  const setsPath = join(REPO, rel, "symbol-sets.json");
  return existsSync(setsPath) ? (JSON.parse(await readFile(setsPath, "utf8")) as string[][]) : [[]];
}

/** Today's grains and output hashes for one project build, through the trial's own inputs. */
async function takeProject(
  rel: string,
  symbols: readonly string[],
  label: string,
  out: { grains?: Record<string, string>; outputs: Record<string, OutputRecord> },
): Promise<void> {
  const set = await generateMutationSet(join(REPO, rel), {
    preprocessorSymbols: symbols,
    emit: () => {},
  });
  for (const f of set.files) {
    const deduped = dedupeSpecs(f.specs, tierOf);
    const ided = assignMutantIds(new Map([[f.path, deduped]])).get(f.path) ?? [];
    const { compiled, grainOf } = instrumentOneFile(f, deduped, ided);
    if (grainOf.size !== ided.length) {
      throw new Error(`${label}/${f.path}: ${grainOf.size} grains for ${ided.length} mutants`);
    }
    out.outputs[`${label}/${f.path}`] = {
      sha256: createHash("sha256").update(compiled, "utf8").digest("hex"),
      mutants: ided.length,
    };
    if (out.grains !== undefined) {
      for (const { mutantId } of ided) {
        const grain = grainOf.get(mutantId);
        if (grain === undefined) throw new Error(`${label}/${f.path}/${mutantId}: no grain`);
        out.grains[`${label}/${f.path}/${mutantId}`] = grain;
      }
    }
  }
  for (const r of set.refusedFiles) {
    out.outputs[`${label}/${r.file}`] = { refused: { shape: r.shape, file: r.file } };
  }
}

/** A spec shaped as the hand-built ones in `compile.test.ts`. */
function handSpec(before: ALSyntaxNode, afterText: string, operatorName: string): MutationSpec {
  return {
    operatorName,
    operatorVersion: "1.0.0",
    astNodeId: `${before.startIndex}-${before.endIndex}`,
    before,
    after: { ...before, text: afterText } as never,
    parentContext: "statement-position",
  };
}

/**
 * The three hand cases. Each `if` is made the component root by a mutant on its condition, so the
 * then-block is a NESTED member whose `before` is its own resolved statement: `before` starts at
 * `S.start`, and the leading-`begin` test reads only the replacement text and the filler.
 * - `replaced`: the block replaced by `begin end`.
 * - `deleted-no-else`: the block deleted, no `else`, so the filler is `;`.
 * - `deleted-before-else`: the block deleted ahead of an `else`, so the filler is `begin end`.
 */
const HAND: ReadonlyArray<{ name: string; src: string; afterText: string }> = [
  {
    name: "replaced",
    src: `codeunit 51990 "Hand A" { procedure P(C: Boolean) var X: Integer; begin if C then begin X := 1; end; end; }`,
    afterText: "begin end",
  },
  {
    name: "deleted-no-else",
    src: `codeunit 51991 "Hand B" { procedure P(C: Boolean) var X: Integer; begin if C then begin X := 1; end; end; }`,
    afterText: "",
  },
  {
    name: "deleted-before-else",
    src: `codeunit 51992 "Hand C" { procedure P(C: Boolean) var X: Integer; begin if C then begin X := 1; end else X := 2; end; }`,
    afterText: "",
  },
];

function takeHand(grains: Record<string, string>): void {
  for (const h of HAND) {
    const root = wrapRoot(parseAL(h.src));
    const ifs = findAll(root, ALNodeKind.if_statement);
    const [stmt] = ifs;
    if (stmt === undefined || ifs.length !== 1) throw new Error(`hand ${h.name}: one if`);
    const cond = stmt.childForFieldName("condition");
    const block = findAll(stmt, ALNodeKind.block)[0];
    if (cond === null || block === undefined) throw new Error(`hand ${h.name}: drift`);
    const specs = [
      handSpec(cond, "not C", "lethal.negate-conditional"),
      handSpec(block, h.afterText, "lethal.empty-block"),
    ];
    const path = `Hand${h.name}.Codeunit.al`;
    const ided = assignMutantIds(new Map([[path, specs]])).get(path) ?? [];
    const { grainOf } = instrumentOneFile({ path, source: h.src, root }, specs, ided);
    for (const { mutantId, spec } of ided) {
      const grain = grainOf.get(mutantId);
      if (grain === undefined) throw new Error(`hand ${h.name}/${mutantId}: no grain`);
      grains[`hand/${h.name}/${mutantId}:${spec.operatorName}`] = grain;
    }
  }
}

async function takeAll(): Promise<Taken> {
  const grains: Record<string, string> = {};
  const outputs: Record<string, OutputRecord> = {};
  for (const rel of allProjects()) {
    const sets = await symbolSetsOf(rel);
    const hasSets = existsSync(join(REPO, rel, "symbol-sets.json"));
    for (const symbols of sets) {
      const label = hasSets ? `${rel}[${symbols.join(",")}]` : rel;
      await takeProject(rel, symbols, label, {
        ...(GRAIN_PROJECTS.includes(rel) ? { grains } : {}),
        outputs,
      });
    }
  }
  takeHand(grains);
  return { grains: sorted(grains), outputs: sorted(outputs) };
}

function sorted<T>(o: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(o).sort()) {
    const v = o[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function readGolden<T>(file: string): Promise<T> {
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing. It is recorded once, deliberately: LETHAL_RECORD_PLAN_EMIT_GOLDEN=1 CI=true bun test packages/runner/tests/plan-emit-golden.test.ts`,
    );
  }
  return JSON.parse(await readFile(file, "utf8")) as T;
}

let taken: Taken = { grains: {}, outputs: {} };

beforeAll(async () => {
  await initParser();
  taken = await takeAll();
}, 300_000);

describe("R-307 O1: golden records taken before the PLAN/EMIT split", () => {
  test("record mode writes both records once and never passes", async () => {
    if (!RECORD) return;
    for (const file of [GRAIN_FILE, OUTPUT_FILE]) {
      if (existsSync(file)) throw new Error(`${file} exists; delete it first to re-record`);
    }
    await writeFile(GRAIN_FILE, `${JSON.stringify({ grains: taken.grains }, null, 2)}\n`);
    await writeFile(OUTPUT_FILE, `${JSON.stringify({ outputs: taken.outputs }, null, 2)}\n`);
    throw new Error("recorded both golden files; a record run is never a pass");
  });

  test("(a) reach grain equals the golden table, every member and the three hand cases", async () => {
    const golden = await readGolden<{ grains: Record<string, string> }>(GRAIN_FILE);
    const keys = Object.keys(golden.grains);
    expect(keys.filter((k) => k.startsWith("hand/"))).toHaveLength(6);
    expect(keys.length).toBeGreaterThan(100);
    expect(taken.grains).toEqual(golden.grains);
  });

  test("(a) the hand cases read the replacement and the filler", async () => {
    // Pinned by name so a re-record cannot quietly move them: `begin end` as replacement or as
    // filler starts with `begin` (statement); a bare `;` filler does not (unplaced).
    const hand = Object.entries(taken.grains).filter(([k]) => k.includes(":lethal.empty-block"));
    expect(hand).toEqual([
      ["hand/deleted-before-else/M0002:lethal.empty-block", "statement"],
      ["hand/deleted-no-else/M0002:lethal.empty-block", "unplaced"],
      ["hand/replaced/M0002:lethal.empty-block", "statement"],
    ]);
  });

  test("(b) instrumented output equals the golden sha256 per file, refusals by shape", async () => {
    const golden = await readGolden<{ outputs: Record<string, OutputRecord> }>(OUTPUT_FILE);
    expect(Object.keys(golden.outputs).length).toBeGreaterThan(50);
    expect(taken.outputs).toEqual(golden.outputs);
  });

  test("(b) a refused file is recorded by shape and file, with no hash", () => {
    for (const [key, r] of Object.entries(taken.outputs)) {
      if (r.refused === undefined) continue;
      expect(r.sha256).toBeUndefined();
      expect(key.endsWith(`/${r.refused.file}`)).toBe(true);
    }
  });
});
