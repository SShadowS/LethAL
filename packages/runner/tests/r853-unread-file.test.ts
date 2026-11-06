// R853: a file the parser gives up on holds no object, so a run stops at the manifest guard. Both
// backends' stops must name the file and how to leave it out. The AL is invented.
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
  test("two copies parse and three do not, so a new grammar that clears this fails here", () => {
    expect(isUnreadFile(wrapRoot(parseAL(unit(2))))).toBe(false);
    expect(isUnreadFile(wrapRoot(parseAL(unit(3))))).toBe(true);
  });

  // The object survives and an ERROR holds the procedures: the form with no root ERROR.
  const inner = (head: string): string =>
    `codeunit 50000 "X"\n{\n    ${head}\n    begin\n${armsOf(3)}end;\n    end;\n\n    procedure Q()\n    begin\n    end;\n}\n`;

  test("an ERROR that swallowed a procedure", () => {
    const root = wrapRoot(parseAL(inner("procedure P()")));
    expect(root.rawKind).toBe("source_file");
    expect(root.hasError).toBe(true);
    expect(isUnreadFile(root)).toBe(true);
  });

  test("an ERROR that swallowed a trigger", () => {
    const root = wrapRoot(parseAL(inner("trigger OnRun()")));
    expect(root.rawKind).toBe("source_file");
    expect(isUnreadFile(root)).toBe(true);
  });

  test("a body whose `end` the parser missed ran on over the next member", async () => {
    const text = `codeunit 50000 "X"\n{\n    procedure P()\n    begin\n        B();\n#if A\n    end;\n#else\n        C();\n    end;\n#endif\n\n    procedure Q()\n    begin\n        W();\n    end;\n}\n`;
    expect(isUnreadFile(wrapRoot(parseAL(text)))).toBe(true);
    const map = await lineMapFromSources([{ path: "X.al", text }], new Set([KEY]));
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
    const text = `codeunit 50000 "X"\n{\n    procedure P()\n    begin\n${armsOf(3)}end;\n    end;\n\n    procedure Q()\n    begin\n    end;\n}\n`;
    await expect(coverageRefusedFromSources([{ path: "X.al", text }])).rejects.toThrow(
      "limit of 6 parse paths",
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
    const text = `codeunit 50000 "X"\n{\n    procedure P()\n    begin\n${armsOf(3)}end;\n    end;\n\n    procedure Q()\n    begin\n    end;\n}\n`;
    const declared = new Set([KEY]);
    const map = await lineMapFromSources([{ path: "X.al", text }], declared);
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
      const text = `codeunit 50000 "X"\n{\n    procedure P()\n    begin\n${armsOf(3)}end;\n    end;\n\n    procedure Q()\n    begin\n    end;\n}\n`;
      await writeFile(join(dir, "X.Codeunit.al"), text, "utf8");
      const index = await buildAlRunnerCoverageIndex(dir, { symbols: [] });
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
    const map = await lineMapFromSources([{ path: "src\\X.Codeunit.al", text: unit(3) }], declared);
    expect(map.unreadFiles).toEqual(["src/X.Codeunit.al"]);
    const stop = stopOf(() =>
      assertManifestObjectsDeclared([KEY], declared, map.mappedKeys(), new Set(), map.unreadFiles),
    );
    expect(stop.message).toContain("no line map was built");
    expect(stop.message).toContain("src/X.Codeunit.al");
    expect(stop.message).toContain("limit of 6 parse paths");
    expect(stop.message).toContain("--exclude <glob>");
  });

  test("v3's index: not declared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r853-"));
    dirs.push(dir);
    await writeFile(join(dir, "X.Codeunit.al"), unit(3), "utf8");
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
    expect(stop.message).toContain("limit of 6 parse paths");
    expect(stop.message).toContain("--exclude <glob>");
  });

  test("a file the parser reads adds nothing to the message", async () => {
    const declared = new Set([KEY]);
    const map = await lineMapFromSources([{ path: "X.al", text: unit(2) }], declared);
    expect(map.unreadFiles).toEqual([]);
    const stop = stopOf(() =>
      assertManifestObjectsDeclared(["codeunit:50001"], declared, map.mappedKeys(), new Set(), []),
    );
    expect(stop.message).not.toContain("limit of 6");
  });
});
