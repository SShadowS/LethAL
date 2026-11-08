// R853: a file the parser gives up on holds no object, so a run stops at the manifest guard. Both
// backends' stops must name the file and how to leave it out. The AL is invented.
// The unread shapes below are plainly invalid AL, so they stay unread whatever the grammar fixes
// next. Valid AL that a parser loses was used here once, and a grammar fix read it (R855 shape C).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser, parseAL, wrapRoot } from "@lethal/engine";
import { buildAlRunnerCoverageIndex } from "../src/al-runner-coverage";
import {
  ManifestDeclarationError,
  assertManifestObjectsDeclared,
  coverageRefusedFromSources,
  isUnreadFile,
  lineMapFromSources,
} from "../src/line-map";
import { removeScratchDir } from "./helpers/scratch";

const ARM = `        B();
#if not C
        if not A then begin
#endif
        end;
        exit(true);
`;
const armsOf = (n: number): string =>
  Array.from(
    { length: n },
    (_, i) =>
      `${i === 0 ? "if S then" : i < n - 1 ? `end else if T${i} then` : "end else"} begin\n${ARM}`,
  ).join("");
const unit = (n: number): string =>
  `codeunit 50000 "X"\n{\n    procedure P()\n    begin\n${armsOf(n)}end\n    end;\n}\n`;
const KEY = "codeunit:50000";
const ROOT_ERROR = `codeunit 50000 "X"\n{\n    procedure P()\n    begin\n        B();\n`;
const SWALLOW_PROCEDURE = `codeunit 50000 "X"\n{\n    procedure\n    begin\n    end;\n\n    procedure Q()\n    begin\n    end;\n}\n`;
const SWALLOW_TRIGGER = `codeunit 50000 "X"\n{\n    trigger OnRun(\n    begin\n    end;\n\n    trigger OnRun()\n    begin\n    end;\n}\n`;
const MISSING_END = `codeunit 50000 "X"\n{\n    procedure P()\n    begin\n        begin\n    end;\n\n    procedure Q()\n    begin\n    end;\n}\n`;

type Node = ReturnType<typeof wrapRoot>;
const find = (n: Node, pred: (n: Node) => boolean): Node | undefined => {
  if (pred(n)) return n;
  for (const c of n.children) {
    const hit = find(c, pred);
    if (hit !== undefined) return hit;
  }
  return undefined;
};
const errorWith = (root: Node, kind: string): Node | undefined =>
  find(root, (n) => n.rawKind === "ERROR" && n.children.some((c) => c.rawKind === kind));

function stopOf(run: () => void): ManifestDeclarationError {
  try {
    run();
  } catch (e) {
    if (e instanceof ManifestDeclarationError) return e;
    throw e;
  }
  throw new Error("the guard did not stop the run");
}

beforeAll(initParser);

describe("R853: the parser's limit", () => {
  // This test goes red on the stock grammar (4.5.0 and older) ON PURPOSE: the stock parser cannot
  // read three copies of the shape. It pins the csb fix. The bump to tree-sitter-al 4.6.0 (R861)
  // landed and flipped it to green.
  test("the csb grammar reads three and sixteen copies that the stock grammar cannot (flipped by the bump)", () => {
    expect(isUnreadFile(wrapRoot(parseAL(unit(2))))).toBe(false);
    expect(isUnreadFile(wrapRoot(parseAL(unit(3))))).toBe(false);
    expect(isUnreadFile(wrapRoot(parseAL(unit(16))))).toBe(false);
  });

  test("a root ERROR", () => {
    const root = wrapRoot(parseAL(ROOT_ERROR));
    expect(root.rawKind).toBe("ERROR");
    expect(isUnreadFile(root)).toBe(true);
  });

  // The object survives and an ERROR holds the members: the form with no root ERROR.
  test("an ERROR that swallowed a procedure", () => {
    const root = wrapRoot(parseAL(SWALLOW_PROCEDURE));
    expect(root.rawKind).toBe("source_file");
    expect(root.hasError).toBe(true);
    expect(errorWith(root, "procedure_keyword")).toBeDefined();
    expect(isUnreadFile(root)).toBe(true);
  });

  test("an ERROR that swallowed a trigger", () => {
    const root = wrapRoot(parseAL(SWALLOW_TRIGGER));
    expect(root.rawKind).toBe("source_file");
    expect(errorWith(root, "trigger_keyword")).toBeDefined();
    expect(isUnreadFile(root)).toBe(true);
  });

  test("a body whose `end` the parser missed ran on over the next member", async () => {
    const root = wrapRoot(parseAL(MISSING_END));
    const block = find(
      root,
      (n) =>
        n.rawKind === "code_block" &&
        n.children.some((c) => c.isMissing && c.rawKind === "end_keyword"),
    );
    expect(block).toBeDefined();
    expect(isUnreadFile(root)).toBe(true);
    const map = await lineMapFromSources([{ path: "X.al", text: MISSING_END }], new Set([KEY]));
    expect([...map.mappedKeys()]).toEqual([]);
  });

  test("an ERROR that lost no member is not a stop, in a body or in a header", () => {
    const body = `codeunit 50000 "X"\n{\n    procedure P()\n    begin\n        X := ;\n    end;\n}\n`;
    const header = `tableextension 50000 "X" extends My.Ns.Base\n{\n}\n`;
    for (const text of [body, header]) {
      const root = wrapRoot(parseAL(text));
      expect(root.hasError).toBe(true);
      expect(isUnreadFile(root)).toBe(false);
    }
  });
});

describe("R853: the hub stops on an unread file", () => {
  test("by name, and passes a file the parser reads", async () => {
    await expect(coverageRefusedFromSources([{ path: "X.al", text: MISSING_END }])).rejects.toThrow(
      "a gap in the parser",
    );
    await expect(
      coverageRefusedFromSources([{ path: "X.al", text: unit(2) }]),
    ).resolves.toBeInstanceOf(Map);
  });
});

describe("R853: a harmless ERROR still indexes the file", () => {
  test("the object stays mapped and nothing is named", async () => {
    const text = `codeunit 50000 "X"\n{\n    procedure P()\n    begin\n        X := ;\n    end;\n}\n`;
    const map = await lineMapFromSources([{ path: "X.al", text }], new Set([KEY]));
    expect(map.unreadFiles).toEqual([]);
    expect([...map.mappedKeys()]).toEqual([KEY]);
  });

  test("a procedure lost to an ERROR leaves the object unmapped, so its mutants stop the run", async () => {
    const declared = new Set([KEY]);
    const map = await lineMapFromSources([{ path: "X.al", text: MISSING_END }], declared);
    expect(map.unreadFiles).toEqual(["X.al"]);
    expect([...map.mappedKeys()]).toEqual([]);
    const stop = stopOf(() =>
      assertManifestObjectsDeclared([KEY], declared, map.mappedKeys(), new Set(), map.unreadFiles),
    );
    expect(stop.message).toContain("X.al");
  });

  test("v3 stops on the same file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r853-"));
    try {
      await writeFile(join(dir, "X.Codeunit.al"), MISSING_END, "utf8");
      const notes: string[] = [];
      const index = await buildAlRunnerCoverageIndex(dir, {
        symbols: [],
        notify: (code, message) => notes.push(`${code} ${message}`),
      });
      expect(notes.filter((n) => n.includes("X.Codeunit.al") && n.includes("R853"))).toHaveLength(
        1,
      );
      expect(index.lineMap.unreadFiles).toEqual(["X.Codeunit.al"]);
      expect(index.skippedFiles).toContain("x.codeunit.al");
      expect(index.declared.has(KEY)).toBe(false);
    } finally {
      removeScratchDir(dir);
    }
  });
});

describe("R853: the stop names the file and the way out", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) removeScratchDir(d);
  });

  test("bcdev's line map: declared, not mapped", async () => {
    const declared = new Set([KEY]);
    const map = await lineMapFromSources([{ path: "src\\X.Codeunit.al", text: MISSING_END }], declared);
    expect(map.unreadFiles).toEqual(["src/X.Codeunit.al"]);
    const stop = stopOf(() =>
      assertManifestObjectsDeclared([KEY], declared, map.mappedKeys(), new Set(), map.unreadFiles),
    );
    expect(stop.message).toContain("no line map was built");
    expect(stop.message).toContain("src/X.Codeunit.al");
    expect(stop.message).toContain("a gap in the parser");
    expect(stop.message).toContain("--exclude <glob>");
  });

  test("v3's index: not declared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r853-"));
    dirs.push(dir);
    await writeFile(join(dir, "X.Codeunit.al"), MISSING_END, "utf8");
    const index = await buildAlRunnerCoverageIndex(dir, { symbols: [] });
    expect(index.lineMap.unreadFiles).toEqual(["X.Codeunit.al"]);
    const stop = stopOf(() =>
      assertManifestObjectsDeclared(
        [KEY],
        index.declared,
        index.lineMap.mappedKeys(),
        index.exempt,
        index.lineMap.unreadFiles,
      ),
    );
    expect(stop.message).toContain("does not declare");
    expect(stop.message).toContain("X.Codeunit.al");
    expect(stop.message).toContain("a gap in the parser");
    expect(stop.message).toContain("--exclude <glob>");
  });

  test("a file the parser reads adds nothing to the message", async () => {
    const declared = new Set([KEY]);
    const map = await lineMapFromSources([{ path: "X.al", text: unit(2) }], declared);
    expect(map.unreadFiles).toEqual([]);
    const stop = stopOf(() =>
      assertManifestObjectsDeclared(["codeunit:50001"], declared, map.mappedKeys(), new Set(), []),
    );
    expect(stop.message).not.toContain("a gap in the parser");
  });
});
