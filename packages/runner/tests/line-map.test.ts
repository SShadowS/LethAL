import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALNodeKind, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { ALSyntaxNode } from "@lethal/engine";
import { LineMap, buildLineMap, fileLineMapEntries } from "../src/line-map";

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

describe("LineMap — undeclared objects are never INDEXED (R39/R29)", () => {
  beforeAll(async () => {
    await initParser();
  });

  const TWO_OBJECTS = `codeunit 50000 "Ours"
{
    procedure Ours()
    begin
    end;
}

codeunit 50001 "Theirs"
{
    procedure Theirs()
    begin
    end;
}`;

  test("a parsed-but-undeclared object resolves to nothing, not to its own procedure name", () => {
    // The batch dir contains Document Output's 137 copied `.dependencies` sources, whose objects
    // are published by their OWN apps: the copied text need not be the bytes BC is running, so a
    // member name read out of it is plausible and wrong. Passing only `codeunit:50000` as declared
    // must make 50001 unmappable even though it parsed perfectly.
    const m = mapFor(TWO_OBJECTS, ["codeunit:50000"]);
    expect(m.lookup("Codeunit", 50000, 3)).toBe("Ours");
    expect(m.declares("Codeunit", 50001)).toBe(false);
    // Object line 4 is where `Theirs` WOULD resolve (50001 bases at file line 7, `Theirs` is at
    // file line 10). Asserting an out-of-range line instead would pass with or without the scope
    // filter — the "test passes for the wrong reason" shape this project treats as its own hazard.
    expect(m.lookup("Codeunit", 50001, 4)).toBeUndefined();
  });

  test("but an undeclared object still consumes the lines its neighbour is numbered against", () => {
    // Objects PARTITION the file, so the base line of a declared object depends on where the
    // PREVIOUS object ended — declared or not. Filtering before that arithmetic would shift every
    // later object's ranges onto its neighbour, which is the wrong-procedure failure exactly.
    const m = mapFor(TWO_OBJECTS, ["codeunit:50001"]);
    // Object 50000 ends at file line 6, so 50001 bases at 7 and `Theirs` (file line 10) is line 4.
    expect(m.lookup("Codeunit", 50001, 4)).toBe("Theirs");
  });
});

describe("buildLineMap — over a real batch dir", () => {
  beforeAll(async () => {
    await initParser();
  });

  async function dirWith(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "lethal-linemap-"));
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content, "utf8");
    }
    return dir;
  }

  test("maps every declared object across files, and skips the rest", async () => {
    const dir = await dirWith({
      "Ours.Codeunit.al": `codeunit 79100 "Ours"
{
    procedure Alpha()
    begin
    end;
}`,
      // Stands in for a copied `.dependencies` source: parses fine, is not in our SymbolReference.
      "Theirs.Codeunit.al": `codeunit 6175297 "Theirs"
{
    procedure Beta()
    begin
    end;
}`,
    });
    try {
      const m = await buildLineMap(dir, new Set(["codeunit:79100"]));
      expect(m.lookup("Codeunit", 79100, 3)).toBe("Alpha");
      expect(m.lookup("Codeunit", 6175297, 3)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("identifies every object kind coverage can report, extensions included", async () => {
    // The type NAMES must match `objectTypeName`'s exactly — a coverage row arrives as a BC integer
    // and is named by that function before it reaches this map, so `"Xmlport"` vs `"XmlPort"` would
    // resolve nothing while looking like "the test covered no member".
    const dir = await dirWith({
      "All.al": `table 79300 "T"
{
    procedure TProc()
    begin
    end;
}

tableextension 79301 "TE" extends "T"
{
    procedure TeProc()
    begin
    end;
}

query 79302 "Q"
{
    elements { dataitem(a; "T") { column(b; "TProc") { } } }

    procedure QProc()
    begin
    end;
}

xmlport 79303 "X"
{
    schema { textelement(root) { } }

    procedure XProc()
    begin
    end;
}`,
    });
    try {
      const declared = new Set([
        "table:79300",
        "tableextension:79301",
        "query:79302",
        "xmlport:79303",
      ]);
      const m = await buildLineMap(dir, declared);
      expect(m.lookup("Table", 79300, 3)).toBe("TProc");
      // Object 79300 ends at file line 6, so 79301 bases at 7 and `TeProc` (file line 10) is line 4.
      expect(m.lookup("TableExtension", 79301, 4)).toBe("TeProc");
      expect(m.lookup("Query", 79302, 6)).toBe("QProc");
      expect(m.lookup("XmlPort", 79303, 6)).toBe("XProc");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a DECLARED object with no source in the dir throws rather than resolving nothing", async () => {
    // Rule 2. Every declared object's source is source LethAL wrote and compiled, so this is a
    // LethAL bug and must say so — the alternative is a confident, quietly incomplete green set.
    const dir = await dirWith({
      "Ours.Codeunit.al": `codeunit 79100 "Ours"
{
    procedure Alpha()
    begin
    end;
}`,
    });
    try {
      const m = await buildLineMap(dir, new Set(["codeunit:79100", "codeunit:79199"]));
      expect(() => m.lookup("Codeunit", 79199, 3)).toThrow(/declares codeunit:79199/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * R175: `isNamingGap` is the discriminator that decides whether a `no-coverage` verdict is a
 * statement about the user's tests or about LethAL's own attribution, so it is worth testing
 * directly rather than only through its effect.
 *
 * These tests exist because MUTATION TESTING of this repository's own source said they were
 * missing: every mutant of `isNamingGap` survived, including one that emptied the whole method
 * body. `selection.test.ts` exercised the CONSEQUENCE with a hand-built `namingGaps` array and
 * proved nothing about whether this function computes one. That is the "test passes for the wrong
 * reason" shape CLAUDE.md names as this project's recurring hazard, found in code less than an hour
 * old. See docs/mutation-testing-ourselves.md.
 */
describe("R175: isNamingGap tells a declined name from a failed one", () => {
  //  1 table 50100 "T"
  //  2 {
  //  3     fields
  //  4     {
  //  5         field(1; "No."; Code[20])
  //  6         {
  //  7             trigger OnValidate()
  //  8             begin
  //  9                 Touch();
  // 10             end;
  // 11         }
  // 12     }
  // 13
  // 14     procedure Touch()
  // 15     begin
  // 16     end;
  // 17 }
  const WITH_TRIGGER = `table 50100 "T"
{
    fields
    {
        field(1; "No."; Code[20])
        {
            trigger OnValidate()
            begin
                Touch();
            end;
        }
    }

    procedure Touch()
    begin
    end;
}
`;

  test("a line inside a PROCEDURE is not a gap — it was named", () => {
    const map = mapFor(WITH_TRIGGER);
    expect(map.lookup("Table", 50100, 15)).toBe("Touch");
    expect(map.isNamingGap("Table", 50100, 15)).toBe(false);
  });

  test("a line inside a TRIGGER is not a gap — the name is DECLINED, not missing", () => {
    // This is the case the first version of R175's detector got wrong. `lookup` returns undefined
    // here exactly as it does for a real gap, and treating the two alike flagged every uncovered
    // procedure of every trigger-carrying table.
    const map = mapFor(WITH_TRIGGER);
    expect(map.lookup("Table", 50100, 9)).toBeUndefined();
    expect(map.isNamingGap("Table", 50100, 9)).toBe(false);
  });

  test("a line inside NOTHING known IS a gap — the resolver failed on our own emitted source", () => {
    const map = mapFor(WITH_TRIGGER);
    // Line 13 is the blank between the `fields` block and `Touch`: no procedure, no trigger.
    expect(map.lookup("Table", 50100, 13)).toBeUndefined();
    expect(map.isNamingGap("Table", 50100, 13)).toBe(true);
  });

  test("line 0 is BC's object-level row and is never a gap", () => {
    const map = mapFor(WITH_TRIGGER);
    expect(map.isNamingGap("Table", 50100, 0)).toBe(false);
  });

  test("an object this map never indexed is not a gap — it is not ours to place", () => {
    const map = mapFor(WITH_TRIGGER);
    expect(map.isNamingGap("Codeunit", 99999, 5)).toBe(false);
  });
});
