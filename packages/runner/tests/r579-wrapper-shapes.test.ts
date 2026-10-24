// R-579 (tests first; plan /coord/handoff/R-579/plan.md, "After the plan review"): the wrapper
// shapes v3 coverage must tell apart. R579: a pragma-only `#if` holds no object, so it is no
// wrapper. R580: a wrapper holding only code-free objects is admitted. Each "stays" case guards the
// opposite direction: a wrong fix that widens the rule too far loses a real refusal.
// Each test names its plan letter and the wrong fix it guards against.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ALSyntaxNode,
  type ArmEvaluation,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { alRunnerCoverageSupport, buildAlRunnerCoverageIndex } from "../src/al-runner-coverage";
import {
  alRunnerAdmitsWrappedFile,
  bcWrappedShapeRefusal,
  coverageRefusedObjects,
  fileHoldsWrappedObject,
  fileLineMapEntries,
  objectIdentityOf,
  wrapperHoldsObject,
} from "../src/line-map";
import { removeScratchDir } from "./helpers/scratch";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) removeScratchDir(d);
});
beforeAll(async () => {
  await initParser();
});

async function bundle(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-r579-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(dir, rel);
    await mkdir(join(dest, ".."), { recursive: true });
    await writeFile(dest, body, "utf8");
  }
  return dir;
}

const rootOf = (text: string): ALSyntaxNode => wrapRoot(parseAL(text));
const FILE = "src/F.Codeunit.al";
const decided: ArmEvaluation = { kind: "decided", inactive: [] };

const codeunit = (id: number, name: string) => `codeunit ${id} "${name}"
{
    procedure Hit(): Integer
    begin
        exit(1);
    end;
}
`;
const PRAGMAS =
  "#pragma warning disable AL0432\n#pragma warning disable AL0603\n#pragma warning disable AL0604\n";
/** A pragma-only `#if` of three pragma lines (R579's shape). */
const PRAGMA_IF = `#if CLEAN20\n${PRAGMAS}#endif\n`;
const AFTER = `${PRAGMA_IF}${codeunit(57901, "R579 After")}`;
const BETWEEN = `${codeunit(57902, "R579 A")}${PRAGMA_IF}${codeunit(57903, "R579 B")}`;

/** One invented object per code-free kind (no procedure, no trigger). */
const CODE_FREE: Record<string, string> = {
  permissionset: `permissionset 57911 "R579 PS"\n{\n    Assignable = true;\n}\n`,
  permissionsetextension: `permissionsetextension 57912 "R579 PSE" extends "R579 PS"\n{\n}\n`,
  enum: `enum 57913 "R579 Enum"\n{\n    value(0; First) { }\n}\n`,
  interface: `interface "R579 Iface"\n{\n    procedure Run();\n}\n`,
  entitlement: `entitlement "R579 Ent"\n{\n    Type = Implicit;\n    ObjectEntitlements = "R579 PS";\n}\n`,
};
const B1_KINDS: Record<string, string> = {
  enumextension: `enumextension 57914 "R579 EnumExt" extends "R579 Enum"\n{\n    value(1; Second) { }\n}\n`,
  controladdin: `controladdin "R579 Addin"\n{\n    Scripts = 'main.js';\n    RequestedHeight = 100;\n}\n`,
  dotnet: `dotnet\n{\n    assembly("mscorlib")\n    {\n        type("System.String"; MyString) { }\n    }\n}\n`,
};
const wrap = (obj: string) => `#if not R579SYM\n${obj}#endif\n`;

const has = (list: readonly string[], rel: string) =>
  list.some((k) => k.toLowerCase().endsWith(rel.toLowerCase()));

async function indexOf(files: Record<string, string>) {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const dir = await bundle(files);
    return { dir, index: await buildAlRunnerCoverageIndex(dir, { symbols: [] }) };
  } finally {
    warn.mockRestore();
  }
}

describe("R579 A: a pragma-only #if is no wrapper", () => {
  // A. Guards: fixing only `fileHoldsWrappedObject`, leaving the line map or the index refusing.
  test("A: every reader agrees the file is plain, base 1", async () => {
    const root = rootOf(AFTER);
    expect(fileHoldsWrappedObject(root)).toBe(false);
    const dir = await bundle({ [FILE]: AFTER });
    expect((await alRunnerCoverageSupport(dir)).wrappedObjectFiles).toEqual([]);
    const entries = fileLineMapEntries(root, objectIdentityOf, FILE);
    expect(entries.map((e) => [e.objectId, e.baseLine, e.refused])).toEqual([
      [57901, 1, undefined],
    ]);
    expect(coverageRefusedObjects([{ path: FILE, root }], "al-runner-index").size).toBe(0);
    const { index } = await indexOf({ [FILE]: AFTER });
    expect(has([...index.byFile.keys()], "f.codeunit.al")).toBe(true);
    expect(index.skippedFiles).toEqual([]);
    expect(index.refusedFiles).toEqual([]);
    expect([...index.refusals.keys()]).toEqual([]);
  });

  // A2. Guards: a fix that stops refusing but numbers B from the pragma `#endif` (shifts kills).
  test("A2: a pragma-only #if between two codeunits moves no base: B starts at A's end + 1", () => {
    const root = rootOf(BETWEEN);
    expect(fileHoldsWrappedObject(root)).toBe(false);
    const entries = fileLineMapEntries(root, objectIdentityOf, FILE);
    const [a, b] = entries;
    expect(entries.map((e) => e.refused)).toEqual([undefined, undefined]);
    expect(a?.baseLine).toBe(1);
    const aEnd = a?.root.endPosition.row;
    expect(aEnd).toBeDefined();
    expect(b?.baseLine).toBe((aEnd ?? -1) + 2);
  });
});

describe("R580 B: a wrapper holding only a code-free object is admitted", () => {
  const admittedCase = (kind: string, obj: string) =>
    // B. Guards: admitting by identity (`objectIdentityOf` is null for these) or by a shorter kind list.
    test(`B: #if not X around a ${kind}`, async () => {
      const text = wrap(obj);
      expect(alRunnerAdmitsWrappedFile(rootOf(text))).toBe(true);
      const dir = await bundle({ "src/W.al": text });
      expect((await alRunnerCoverageSupport(dir)).wrappedObjectFiles).toEqual([]);
      const { index } = await indexOf({ "src/W.al": text });
      expect(has(index.skippedFiles, "w.al")).toBe(true);
      expect(index.refusedFiles).toEqual([]);
    });
  for (const [kind, obj] of Object.entries(CODE_FREE)) admittedCase(kind, obj);

  // B. Guards: admitting only a file with ONE wrapper (several have no code and no identity to lose).
  test("B: several code-free wrappers in one file are admitted", async () => {
    const text =
      wrap(CODE_FREE.enum ?? "") +
      wrap(CODE_FREE.interface ?? "") +
      wrap(CODE_FREE.permissionset ?? "");
    expect(alRunnerAdmitsWrappedFile(rootOf(text))).toBe(true);
    const dir = await bundle({ "src/W.al": text });
    expect((await alRunnerCoverageSupport(dir)).wrappedObjectFiles).toEqual([]);
    const { index } = await indexOf({ "src/W.al": text });
    expect(has(index.skippedFiles, "w.al")).toBe(true);
  });
});

describe("R580 kinds added by the B1 ruling (enumextension, controladdin, dotnet)", () => {
  for (const [kind, obj] of Object.entries(B1_KINDS)) {
    // B (B1). Guards: leaving the kind off the allow-list, which turns coverage off for those projects.
    test(`B: #if not X around a ${kind}`, async () => {
      const text = wrap(obj);
      expect(alRunnerAdmitsWrappedFile(rootOf(text))).toBe(true);
      const dir = await bundle({ "src/W.al": text });
      expect((await alRunnerCoverageSupport(dir)).wrappedObjectFiles).toEqual([]);
      const { index } = await indexOf({ "src/W.al": text });
      expect(has(index.skippedFiles, "w.al")).toBe(true);
    });
  }
});

describe("directions that must stay refused", () => {
  const listed = async (text: string) =>
    (await alRunnerCoverageSupport(await bundle({ "src/W.al": text }))).wrappedObjectFiles;
  const CODE_NODES = ["procedure", "trigger_declaration", "code_block"];
  const anyNode = (n: ALSyntaxNode, kinds: readonly string[]): boolean =>
    kinds.includes(n.rawKind) || n.namedChildren.some((c) => anyNode(c, kinds));
  const hasCode = (root: ALSyntaxNode) => anyNode(root, CODE_NODES);
  const hasError = (root: ALSyntaxNode) => anyNode(root, ["ERROR"]);

  // C. Guards: treating any wrapper as admitted once code-free objects are (R-602's rule must hold).
  test("C: a wrapped code-bearing codeunit alone keeps R-602's answer: admitted", async () => {
    const text = wrap(codeunit(57921, "R579 W"));
    expect(alRunnerAdmitsWrappedFile(rootOf(text))).toBe(true);
    expect(await listed(text)).toEqual([]);
  });

  // C. Guards: admitting a wrapper because SOME object in it is code-free.
  test("C: a wrapper holding a code-free object AND a codeunit stays refused", async () => {
    const text = wrap((CODE_FREE.enum ?? "") + codeunit(57922, "R579 Mix"));
    expect(alRunnerAdmitsWrappedFile(rootOf(text))).toBe(false);
    expect(await listed(text)).toEqual(["src/W.al"]);
  });

  // C. Guards: admitting a code-free wrapper without checking the bare object beside it.
  test("C: a code-free wrapped object with a bare codeunit beside it stays refused", async () => {
    const text = wrap(CODE_FREE.enum ?? "") + codeunit(57923, "R579 Bare");
    expect(alRunnerAdmitsWrappedFile(rootOf(text))).toBe(false);
    expect(await listed(text)).toEqual(["src/W.al"]);
  });

  // G. Guards: admitting by KIND alone, without `holdsCode` on the node (all five-plus-three kinds
  // that can hold a procedure). Each source must parse WITH a code node and WITHOUT an ERROR, or
  // the refusal would come from the ERROR and prove nothing.
  const proc = "    procedure Hit(): Integer\n    begin\n        exit(1);\n    end;\n";
  const WITH_CODE: Record<string, string> = {
    enum: `enum 57931 "R579 CodeEnum"\n{\n    value(0; A) { }\n${proc}}\n`,
    interface: `interface "R579 CodeIface"\n{\n${proc}}\n`,
    enumextension: `enumextension 57932 "R579 CodeExt" extends "R579 Enum"\n{\n    value(1; B) { }\n${proc}}\n`,
    controladdin: `controladdin "R579 CodeAddin"\n{\n    Scripts = 'main.js';\n${proc}}\n`,
  };
  for (const [kind, obj] of Object.entries(WITH_CODE)) {
    test(`G: a wrapped ${kind} that holds a procedure body stays refused`, async () => {
      const text = wrap(obj);
      const root = rootOf(text);
      expect(hasError(root)).toBe(false);
      expect(hasCode(root)).toBe(true);
      expect(alRunnerAdmitsWrappedFile(root)).toBe(false);
      expect(await listed(text)).toEqual(["src/W.al"]);
    });
  }

  // G (dotnet). Guards: admitting a dotnet block because the kind is allow-listed. The grammar's
  // `dotnet_body` holds only `assembly_declaration`, so a dotnet cannot hold a code node; a
  // procedure in it should parse to an ERROR (refused for that reason, which is fail-closed too).
  test("G: a wrapped dotnet block holding a procedure stays refused (it parses to an ERROR)", async () => {
    const text = wrap(`dotnet\n{\n    assembly("mscorlib") { }\n${proc}}\n`);
    const root = rootOf(text);
    // Probed: a procedure or trigger in a dotnet block becomes an ERROR node, never a code node.
    expect(hasError(root)).toBe(true);
    expect(hasCode(root)).toBe(false);
    expect(alRunnerAdmitsWrappedFile(root)).toBe(false);
    expect(await listed(text)).toEqual(["src/W.al"]);
  });

  // H. Guards: looking only at the `#if` arm and ignoring what the `#else` arm holds.
  test("H: code-free in the #if arm and a codeunit in the #else arm stays refused", async () => {
    const text = `#if R579SYM\n${CODE_FREE.enum}#else\n${codeunit(57941, "R579 Else")}#endif\n`;
    expect(alRunnerAdmitsWrappedFile(rootOf(text))).toBe(false);
    expect(await listed(text)).toEqual(["src/W.al"]);
  });

  // I. Guards: an allow-list that lets a split declaration (code behind a shared body) through.
  test("I: a wrapped code-free object beside a split declaration stays refused", async () => {
    const split = `#if FEATURE\ncodeunit 57951 "R579 Split"\n#else\ncodeunit 57951 "R579 Split"\n#endif\n{\n    procedure Q()\n    begin\n    end;\n}\n`;
    const text = wrap(CODE_FREE.enum ?? "") + split;
    expect(alRunnerAdmitsWrappedFile(rootOf(text))).toBe(false);
    expect(await listed(text)).toEqual(["src/W.al"]);
  });

  // I. Guards: an allow-list that lets an ERROR node through (fail-closed).
  test("I: a wrapped file with an ERROR node stays refused", async () => {
    const text = `${wrap(CODE_FREE.enum ?? "")}codeunit 57952 "R579 Broken"\n{\n    procedure (((\n`;
    const root = rootOf(text);
    expect(hasError(root)).toBe(true);
    expect(alRunnerAdmitsWrappedFile(root)).toBe(false);
    expect(await listed(text)).toEqual(["src/W.al"]);
  });
});

describe("D: pragma and object in the SAME wrapper stays a wrapper", () => {
  const wrapperOf = (text: string): ALSyntaxNode => {
    const w = rootOf(text).namedChildren.find((c) => c.rawKind === "preproc_conditional_object");
    if (w === undefined) throw new Error("no wrapper parsed");
    return w;
  };
  const cu = codeunit(57961, "R579 D");

  // D(a). Guards: deciding "pragma present" means "no object".
  test("D(a): one arm", () => {
    expect(wrapperHoldsObject(wrapperOf(`#if X\n${PRAGMAS}${cu}#endif\n`))).toBe(true);
  });
  // D(b). Guards: reading only the #if arm.
  test("D(b): pragma in #if, codeunit in #else", () => {
    expect(wrapperHoldsObject(wrapperOf(`#if X\n${PRAGMAS}#else\n${cu}#endif\n`))).toBe(true);
  });
  // D(c). Guards: not descending into a nested #if.
  test("D(c): pragma in the outer #if, codeunit in a nested #if", () => {
    expect(wrapperHoldsObject(wrapperOf(`#if X\n${PRAGMAS}#if Y\n${cu}#endif\n#endif\n`))).toBe(
      true,
    );
  });
});

describe("E: the BC path", () => {
  // E. Guards: fixing the coverage index but leaving the BC shape check treating the pragma #if as a wrapper.
  test("E: a pragma-only #if with an object after it gives no refusal", () => {
    expect(bcWrappedShapeRefusal(rootOf(AFTER), decided)).toBeUndefined();
  });
});
