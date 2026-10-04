// RUST-03 S4.2a (AMENDMENT 1, lead E): the manifest-row loop in `writeInstrumentedProject` must do
// per-file or per-block work once, not once per mutant. On the whole Base Application the loop was
// 90% of W8's wall time and about 5 GB of transient memory at its peak. Each test below counts one
// of the per-mutant costs on one procedure holding N mutants, so a cost that grows with N times
// the file (or the block) goes red here long before it shows on a whole-BaseApp run.
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALNodeKind, findAll, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { ALSyntaxNode, MutationSpec } from "@lethal/engine";
import {
  type MutantManifest,
  type WriteInput,
  gapIdOf,
  lineOfIndex,
  lineStartsOf,
  runIdentityOrdinals,
  writeInstrumentedProject,
} from "../src/project";

/** The scan `lineOfIndex` replaced (before `167f540c`): one plus the newlines before `index`. */
function scanLine(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

describe("lineOfIndex over one line index equals the old scan", () => {
  const cases: readonly (readonly [name: string, source: string, index: number, line: number])[] = [
    ["CRLF, after the first line break", "ab\r\ncd\r\nef", 4, 2],
    ["CRLF, on the \\r", "ab\r\ncd", 2, 1],
    ["offset ON a newline", "ab\ncd", 2, 1],
    ["offset at a line start", "ab\ncd", 3, 2],
    ["final line with no newline", "ab\ncd\nef", 7, 3],
    ["end of a file with no final newline", "ab\ncd\nef", 8, 3],
    ["end of a file with a final newline", "ab\ncd\n", 6, 3],
    ["BOM at 0", "﻿ab\ncd", 0, 1],
    ["BOM, second line", "﻿ab\ncd", 4, 2],
    ["index past the end", "ab\ncd", 99, 2],
    ["negative index", "ab\ncd", -5, 1],
    ["empty source", "", 0, 1],
    ["only newlines", "\n\n\n", 2, 3],
  ];
  for (const [name, source, index, line] of cases) {
    it(name, () => {
      expect(scanLine(source, index)).toBe(line);
      expect(lineOfIndex(lineStartsOf(source), index)).toBe(line);
    });
  }

  it("agrees with the scan at every offset of every case, and one past each end", () => {
    for (const [, source] of cases) {
      const starts = lineStartsOf(source);
      for (let i = -2; i <= source.length + 2; i++)
        expect(lineOfIndex(starts, i)).toBe(scanLine(source, i));
    }
  });
});

const N = 400;
const SRC = [
  `codeunit 51990 "Cost"`,
  "{",
  "    [NonDebuggable]",
  "    local procedure P()",
  "    begin",
  ...Array.from({ length: N }, (_, i) => `        X := ${i};`),
  "    end;",
  "}",
  "",
].join("\n");

function specsOver(root: ALSyntaxNode): MutationSpec[] {
  const specs = findAll(root, ALNodeKind.assignment_statement).map((a) => ({
    operatorName: "op.flip",
    operatorVersion: "1.0.0",
    astNodeId: `${a.startIndex}`,
    before: a,
    after: { ...a, text: "X := -1;" } as never,
    parentContext: "statement-position" as const,
  }));
  if (specs.length !== N) throw new Error(`fixture shape: expected ${N} assignments`);
  return specs;
}

function inputFor(dir: string, source: string, root: ALSyntaxNode): WriteInput {
  const specs = specsOver(root);
  // R374: numbered over the plain SRC, so the counted source's reads stay the writer's alone.
  const identityOrdinals = runIdentityOrdinals(
    [{ path: "Cost.Codeunit.al", source: SRC, root, specs }],
    new Map(),
  );
  return {
    targetDir: dir,
    files: [{ path: "Cost.Codeunit.al", source, root, specs }],
    identityOrdinals,
    selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
    operatorTiers: new Map(),
  };
}

/** A stand-in for the source string. It counts character reads by index (`s[i]`), and, for every
 *  method call, the characters that call can have scanned: what `slice`/`substring`/`substr`
 *  returned, how far `indexOf` searched, one for `charAt`-like reads, and the whole string for
 *  anything else (`split`, `lastIndexOf`, `replace`, regex methods, ...). Every method runs on the
 *  real string. */
function countingSource(src: string): {
  source: string;
  reads: () => number;
  scanned: () => number;
} {
  let reads = 0;
  let scanned = 0;
  const costOf = (method: string, args: readonly unknown[], result: unknown): number => {
    if (method === "slice" || method === "substring" || method === "substr")
      return typeof result === "string" ? result.length : src.length;
    if (method === "indexOf") {
      const from = typeof args[1] === "number" ? Math.max(0, args[1]) : 0;
      const needle = typeof args[0] === "string" ? args[0].length : 1;
      return typeof result === "number" && result >= 0 ? result - from + needle : src.length - from;
    }
    if (method === "charAt" || method === "charCodeAt" || method === "codePointAt") return 1;
    if (method === "toString" || method === "valueOf") return 0;
    return src.length;
  };
  const proxy = new Proxy(new String(src), {
    get(_t, prop) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        reads++;
        return src[Number(prop)];
      }
      if (prop === "length") return src.length;
      const v: unknown = Reflect.get(String.prototype, prop);
      if (typeof v !== "function") return v;
      const f = v as (...a: unknown[]) => unknown;
      if (typeof prop !== "string") return f.bind(src);
      return (...a: unknown[]) => {
        const result = f.apply(src, a);
        scanned += costOf(prop, a, result);
        return result;
      };
    },
  });
  return { source: proxy as unknown as string, reads: () => reads, scanned: () => scanned };
}

/** Wraps a node so every `.text` read is summed by raw kind; parents and children stay wrapped. */
function trackText(node: ALSyntaxNode, readBy: Map<string, number>): ALSyntaxNode {
  const wrap = (n: ALSyntaxNode | null): ALSyntaxNode | null =>
    n === null ? null : trackText(n, readBy);
  return new Proxy(node, {
    get(t, prop) {
      if (prop === "text") {
        const text = t.text;
        readBy.set(t.rawKind, (readBy.get(t.rawKind) ?? 0) + text.length);
        return text;
      }
      if (prop === "parent") return wrap(t.parent);
      if (prop === "children") return t.children.map((c) => trackText(c, readBy));
      if (prop === "namedChildren") return t.namedChildren.map((c) => trackText(c, readBy));
      if (prop === "childForFieldName") return (name: string) => wrap(t.childForFieldName(name));
      return Reflect.get(t, prop, t);
    },
  });
}

describe("manifest-row loop cost (RUST-03 S4.2a)", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("reads the source by index a bounded number of times per file, not per mutant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-rowcost-"));
    try {
      const counted = countingSource(SRC);
      await writeInstrumentedProject(inputFor(dir, counted.source, wrapRoot(parseAL(SRC))));
      // A line-number scan from offset 0 per mutant reads about N times the file.
      expect(counted.reads()).toBeLessThanOrEqual(4 * SRC.length);
      // The same bound through method calls: per-mutant line work or block text taken through
      // slice, indexOf or split scans about N times the file.
      expect(counted.scanned()).toBeLessThanOrEqual(4 * SRC.length);
      const m = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      ) as MutantManifest;
      expect(m.mutants.map((r) => r.startLine)).toEqual(Array.from({ length: N }, (_, i) => i + 6));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never takes a whole procedure's text per mutant to find its scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-rowcost-"));
    try {
      const readBy = new Map<string, number>();
      const root = trackText(wrapRoot(parseAL(SRC)), readBy);
      await writeInstrumentedProject(inputFor(dir, SRC, root));
      expect(readBy.get("procedure") ?? 0).toBeLessThanOrEqual(SRC.length);
      const m = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      ) as MutantManifest;
      expect(new Set(m.mutants.map((r) => r.procedureScope))).toEqual(new Set(["local"]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("computes each gap block's id once per block, not once per mutant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-rowcost-"));
    try {
      let calls = 0;
      const counting: typeof gapIdOf = (...a) => {
        calls++;
        return gapIdOf(...a);
      };
      await writeInstrumentedProject({
        ...inputFor(dir, SRC, wrapRoot(parseAL(SRC))),
        gapIdOf: counting,
      });
      expect(calls).toBe(1);
      const m = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      ) as MutantManifest;
      expect(new Set(m.mutants.map((r) => r.gapId)).size).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
