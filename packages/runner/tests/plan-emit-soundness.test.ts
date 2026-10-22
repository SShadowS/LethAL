import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ALNodeKind,
  type ALSyntaxNode,
  FileRefusedError,
  type MutationSpec,
  findFirst,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import {
  type TierResolver,
  assignMutantIds,
  dedupeSpecs,
  emitOneFile,
  planOneFile,
} from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";

/**
 * R-307 O8 (plan amendment 2026-10-03, section 5): the fixture soundness sweep. For every file of
 * every fixture and example project, with its real spec set (the trial's inputs, exactly as O1
 * took them): when PLAN (`planOneFile`) returns, EMIT (`emitOneFile`) on that plan does not throw
 * and its output's sha256 equals the O1(b) record, which was taken BEFORE the PLAN/EMIT split
 * (`instrumented-output-golden.json`, commit cc4e6dde). It is never compared against today's
 * `instrumentOneFile`, which is PLAN then EMIT itself and would agree with any change to either.
 * When PLAN refuses, the record holds a refusal with the same `shape` and `file`.
 *
 * Refused files: the trial in `generateMutationSet` IS `planOneFile` (R-307 O6), and a refused file
 * leaves the set's `files` for its `refusedFiles`, so its refusal is read from there. The key set
 * of the sweep must equal the record's, so no file can drop out of the comparison.
 *
 * Plus the hand-built refusals no fixture reaches: the two T4b cases (`compile.test.ts`, "R307 T4b")
 * and the C8 xmlport case (`compile.test.ts`, "throws, naming the object kind and the file, for an
 * object kind it cannot instrument"), each through `planOneFile`.
 */

const REPO = resolve(import.meta.dir, "../../..");
const OUTPUT_FILE = join(import.meta.dir, "__fixtures__", "instrumented-output-golden.json");

/** Every fixture and example project (a directory holding `app.json`), as O1 walked them. */
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

interface Sweep {
  readonly outputs: Record<string, OutputRecord>;
  /** `<key>: <error>` for each file whose EMIT threw on a plan PLAN returned. */
  readonly emitThrew: string[];
  /** Files PLAN accepted. */
  readonly planned: number;
}

async function sweep(): Promise<Sweep> {
  const outputs: Record<string, OutputRecord> = {};
  const emitThrew: string[] = [];
  let planned = 0;
  for (const rel of allProjects()) {
    const setsPath = join(REPO, rel, "symbol-sets.json");
    const hasSets = existsSync(setsPath);
    const sets = hasSets ? (JSON.parse(await readFile(setsPath, "utf8")) as string[][]) : [[]];
    for (const symbols of sets) {
      const label = hasSets ? `${rel}[${symbols.join(",")}]` : rel;
      const set = await generateMutationSet(join(REPO, rel), {
        preprocessorSymbols: symbols,
        emit: () => {},
      });
      for (const f of set.files) {
        const key = `${label}/${f.path}`;
        const deduped = dedupeSpecs(f.specs, tierOf);
        const ided = assignMutantIds(new Map([[f.path, deduped]])).get(f.path) ?? [];
        let plan: ReturnType<typeof planOneFile>;
        try {
          plan = planOneFile(f, deduped, ided);
        } catch (e) {
          if (!(e instanceof FileRefusedError)) throw e;
          outputs[key] = { refused: { shape: e.shape, file: e.file } };
          continue;
        }
        planned++;
        let text: string;
        try {
          text = emitOneFile(plan);
        } catch (e) {
          emitThrew.push(`${key}: ${String(e)}`);
          continue;
        }
        outputs[key] = {
          sha256: createHash("sha256").update(text, "utf8").digest("hex"),
          mutants: ided.length,
        };
      }
      for (const r of set.refusedFiles) {
        outputs[`${label}/${r.file}`] = { refused: { shape: r.shape, file: r.file } };
      }
    }
  }
  return { outputs, emitThrew, planned };
}

let taken: Sweep = { outputs: {}, emitThrew: [], planned: 0 };

beforeAll(async () => {
  await initParser();
  taken = await sweep();
}, 300_000);

describe("R-307 O8: PLAN then EMIT reproduces the pre-split output on every fixture file", () => {
  test("EMIT never throws on a plan PLAN returned", () => {
    expect(taken.planned).toBeGreaterThan(50);
    expect(taken.emitThrew).toEqual([]);
  });

  test("each file's sha256 (or refusal shape and file) equals the O1(b) record", async () => {
    if (!existsSync(OUTPUT_FILE)) throw new Error(`${OUTPUT_FILE} is missing (O1 records it)`);
    const golden = JSON.parse(await readFile(OUTPUT_FILE, "utf8")) as {
      outputs: Record<string, OutputRecord>;
    };
    expect(Object.keys(golden.outputs).length).toBeGreaterThan(50);
    const sorted: Record<string, OutputRecord> = {};
    for (const k of Object.keys(taken.outputs).sort()) {
      const v = taken.outputs[k];
      if (v !== undefined) sorted[k] = v;
    }
    expect(sorted).toEqual(golden.outputs);
  });
});

/** A spec shaped as the hand-built ones in `compile.test.ts`. */
function spec(before: ALSyntaxNode, afterText: string, operatorName: string): MutationSpec {
  return {
    operatorName,
    operatorVersion: "1.0.0",
    astNodeId: `${before.startIndex}-${before.endIndex}`,
    before,
    after: { ...before, text: afterText } as never,
    parentContext: "statement-position",
  };
}

/** The refusal `fn` throws; anything else, or nothing, fails the test. */
function refusalOf(fn: () => unknown): FileRefusedError {
  try {
    fn();
  } catch (e) {
    if (e instanceof FileRefusedError) return e;
    throw e;
  }
  throw new Error("expected a FileRefusedError, got none: planOneFile returned");
}

describe("R-307 O8: the hand-built refusals, through PLAN alone", () => {
  /** `compile.test.ts` "R307 T4b"'s source, unchanged. */
  const SRC = [
    'codeunit 79390 "Probe"', // 1
    "{", // 2
    "    procedure P()", // 3
    "    var", // 4
    "        X: Integer;", // 5
    "    begin", // 6
    "        X := 1;", // 7
    "        X := 2;", // 8
    "    end;", // 9
    "}", // 10
    "",
  ].join("\n");

  test("T4b latch-owner: PLAN throws the site the old path did", () => {
    const root = wrapRoot(parseAL(SRC));
    const before = {
      kind: ALNodeKind.assignment_statement,
      rawKind: "assignment_statement",
      text: "L := 1",
      startIndex: 0,
      endIndex: 6,
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: 6 },
      parent: null,
      children: [],
      namedChildren: [],
      fieldName: null,
      isMissing: false,
      hasError: false,
      childForFieldName: () => null,
    } as unknown as ALSyntaxNode;
    const s = spec(before, "L := 2", "lethal.op");
    const ided = assignMutantIds(new Map([["src/P.al", [s]]])).get("src/P.al") ?? [];
    const err = refusalOf(() => planOneFile({ path: "src/P.al", source: SRC, root }, [s], ided));
    expect(err.site).toBe("compile.latch-owner");
    expect(err.shape).toBe("latch-owner");
    expect(err.file).toBe("src/P.al");
    expect(err.lines).toEqual([1, 1]);
  });

  test("T4b overlap: PLAN throws the site the old path did", () => {
    const root = wrapRoot(parseAL(SRC));
    const a = findFirst(root, ALNodeKind.assignment_statement);
    const body = a?.parent?.parent;
    if (a === null || a === undefined || body === null || body === undefined)
      throw new Error("fixture shape");
    const end2 = SRC.indexOf("\n", SRC.indexOf("X := 2")) + 1;
    const withSpan = (start: number, end: number): ALSyntaxNode =>
      Object.create(body, { startIndex: { value: start }, endIndex: { value: end } });
    const sa = spec(withSpan(body.startIndex, a.endIndex + 3), "begin end", "lethal.op");
    const sb = spec(withSpan(a.startIndex + 2, end2), "begin end", "lethal.op");
    const ided = assignMutantIds(new Map([["src/P.al", [sa, sb]]])).get("src/P.al") ?? [];
    const err = refusalOf(() =>
      planOneFile({ path: "src/P.al", source: SRC, root }, [sa, sb], ided),
    );
    expect(err.site).toBe("rewrite.overlap");
    expect(err.shape).toBe("overlap");
    expect(err.file).toBe("src/P.al");
    expect(err.lines).toEqual([6, 8]);
  });

  test("C8: compile.test.ts's inline xmlport refuses in PLAN", () => {
    const source = `xmlport 50100 "My Port"
{
    schema
    {
        textelement(Root)
        {
            tableelement(Cust; Customer)
            {
                trigger OnAfterGetRecord()
                begin
                    DoThing();
                end;
            }
        }
    }
}`;
    const root = wrapRoot(parseAL(source));
    const call = findFirst(root, ALNodeKind.procedure_call);
    if (call === null) throw new Error("no call in fixture");
    const s = spec(call, "", "lethal.void-method-call");
    const path = "MyPort.XmlPort.al";
    const ided = assignMutantIds(new Map([[path, [s]]])).get(path) ?? [];
    const err = refusalOf(() => planOneFile({ path, source, root }, [s], ided));
    expect(err.shape).toBe("unsupported-kind");
    expect(err.site).toBe("compile.unsupported-kind");
    expect(err.file).toBe(path);
    expect(err.lines).toEqual([11, 11]);
  });
});
