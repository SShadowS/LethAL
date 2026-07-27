import { beforeAll, describe, expect, test } from "bun:test";
import { ALNodeKind, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { ALSyntaxNode } from "@lethal/engine";
import { LineMap, fileLineMapEntries } from "../src/line-map";

/**
 * R58's crux. BC's fenced coverage reports a LINE, and this maps it to the procedure that owns it.
 * A line attributed to the wrong procedure yields a confident, non-empty, WRONG covering set — the
 * R29 failure that made 10 of 20 fixture survivors false — so these tests are about the boundaries,
 * not the happy path.
 */

/** Mirrors the real caller: identify an object node and its `(type, id)`. */
function identify(node: ALSyntaxNode): { objectType: string; objectId: number } | null {
  if (node.kind !== ALNodeKind.codeunit && node.kind !== ALNodeKind.table) return null;
  const idNode = node.childForFieldName("object_id");
  if (idNode === null) return null;
  const objectId = Number.parseInt(idNode.text, 10);
  if (Number.isNaN(objectId)) return null;
  return { objectType: node.kind === ALNodeKind.table ? "Table" : "Codeunit", objectId };
}

function mapFor(src: string, declared?: readonly string[]): LineMap {
  const root = wrapRoot(parseAL(src));
  const entries = fileLineMapEntries(root, identify);
  const keys = declared ?? entries.map((e) => `${e.objectType.toLowerCase()}:${e.objectId}`);
  return new LineMap(entries, new Set(keys));
}

// Line numbers are load-bearing here, so the fixtures are written with them counted out.
//  1 codeunit 50000 "One"
//  2 {
//  3     procedure Alpha()
//  4     begin
//  5         Beta();
//  6     end;
//  7
//  8     procedure Beta()
//  9     begin
// 10     end;
// 11 }
const SINGLE = `codeunit 50000 "One"
{
    procedure Alpha()
    begin
        Beta();
    end;

    procedure Beta()
    begin
    end;
}`;

describe("LineMap — single object", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("maps a line inside a procedure to that procedure", () => {
    expect(mapFor(SINGLE).lookup("Codeunit", 50000, 5)).toBe("Alpha");
  });

  test("includes the declaration line and the closing end; — measured, BC spans both", () => {
    const m = mapFor(SINGLE);
    expect(m.lookup("Codeunit", 50000, 3)).toBe("Alpha");
    expect(m.lookup("Codeunit", 50000, 6)).toBe("Alpha");
    expect(m.lookup("Codeunit", 50000, 8)).toBe("Beta");
    expect(m.lookup("Codeunit", 50000, 10)).toBe("Beta");
  });

  test("a line BETWEEN procedures belongs to neither", () => {
    // The dangerous direction is claiming it for the nearest procedure.
    expect(mapFor(SINGLE).lookup("Codeunit", 50000, 7)).toBeUndefined();
  });

  test("line 0 is object-level, never a procedure", () => {
    expect(mapFor(SINGLE).lookup("Codeunit", 50000, 0)).toBeUndefined();
  });

  test("a line past the object is object-level rather than the last procedure", () => {
    expect(mapFor(SINGLE).lookup("Codeunit", 50000, 999)).toBeUndefined();
  });
});

describe("LineMap — object-relative base line (the measured rule)", () => {
  beforeAll(async () => {
    await initParser();
  });

  // Two objects, ONE blank line between them — the exact shape probed on Cronus281, where object
  // 79322's procedure at FILE lines 33-40 was reported as object lines 6-13 (offset 27, i.e. base
  // = file line 28, the BLANK line, not the `codeunit` keyword at 29).
  //
  //  1 codeunit 50000 "One"
  //  2 {
  //  3     procedure Alpha()
  //  4     begin
  //  5     end;
  //  6 }
  //  7
  //  8 codeunit 50001 "Two"
  //  9 {
  // 10     procedure Second()
  // 11     begin
  // 12     end;
  // 13 }
  const TWO = `codeunit 50000 "One"
{
    procedure Alpha()
    begin
    end;
}

codeunit 50001 "Two"
{
    procedure Second()
    begin
    end;
}`;

  test("the second object is numbered from ONE PAST the first object's end, not its keyword", () => {
    // First object ends at file line 6, so object two bases at file line 7 and `Second`
    // (file line 10) is object line 4. Basing on the keyword line (8) would give 3 — off by one,
    // which on adjacent procedures lands the row on the WRONG one.
    const m = mapFor(TWO);
    expect(m.lookup("Codeunit", 50001, 4)).toBe("Second");
    expect(m.lookup("Codeunit", 50001, 6)).toBe("Second");
  });

  test("the first object still bases at line 1", () => {
    const m = mapFor(TWO);
    expect(m.lookup("Codeunit", 50000, 3)).toBe("Alpha");
    expect(m.lookup("Codeunit", 50000, 5)).toBe("Alpha");
  });

  test("the two objects do not bleed into each other", () => {
    // Object one's own line 10 does not exist; it must not resolve to object two's `Second`.
    expect(mapFor(TWO).lookup("Codeunit", 50000, 10)).toBeUndefined();
  });
});

describe("LineMap — scope and rules", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("an object the artifact does NOT declare is skipped, not an error", () => {
    // CoverageArray serializes the whole Code Coverage table — Base App, System App, Test Runner,
    // Continia Core. Treating those as errors would abort every real run; the hub path skips them
    // for the same reason.
    const m = mapFor(SINGLE);
    expect(m.lookup("Codeunit", 9999999, 12)).toBeUndefined();
    expect(m.declares("Codeunit", 9999999)).toBe(false);
  });

  test("an object the artifact DECLARES but the map lacks throws", () => {
    // The artifact's source is written by LethAL, so this is a LethAL bug and must say so rather
    // than degrade to a plausible empty answer.
    const m = mapFor(SINGLE, ["codeunit:50000", "codeunit:50002"]);
    expect(() => m.lookup("Codeunit", 50002, 3)).toThrow(/declares codeunit:50002 but no line map/);
  });

  test("a trigger body is NOT attributed to a procedure name", () => {
    // Rule 4, chosen explicitly: a trigger name would land in byMember under a key no mutant
    // queries, which is harmless AND invisible to the differential gate.
    const src = `table 50100 "T"
{
    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                Error('x');
            end;
        }
    }
}`;
    expect(mapFor(src).lookup("Table", 50100, 9)).toBeUndefined();
  });

  test("(objectType, objectId) is the key — a table and a codeunit may share an id", () => {
    // Keying on the bare id merged them and sent a trigger mutant at the wrong object's tests.
    const src = `codeunit 50000 "C"
{
    procedure InCodeunit()
    begin
    end;
}`;
    const m = mapFor(src, ["codeunit:50000"]);
    expect(m.lookup("Codeunit", 50000, 3)).toBe("InCodeunit");
    expect(m.lookup("Table", 50000, 3)).toBeUndefined();
  });
});
