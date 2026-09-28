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
  writeInstrumentedProject,
} from "../src/project";

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
  return {
    targetDir: dir,
    files: [{ path: "Cost.Codeunit.al", source, root, specs: specsOver(root) }],
    selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
    operatorTiers: new Map(),
  };
}

/** A stand-in for the source string that counts character reads by index (`s[i]`). Every method
 *  runs on the real string, so only indexed reads are counted. */
function countingSource(src: string): { source: string; reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(new String(src), {
    get(_t, prop) {
      if (typeof prop === "string" && /^\d+$/.test(prop)) {
        reads++;
        return src[Number(prop)];
      }
      if (prop === "length") return src.length;
      const v: unknown = Reflect.get(String.prototype, prop);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(src) : v;
    },
  });
  return { source: proxy as unknown as string, reads: () => reads };
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
