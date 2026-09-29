import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GRAMMAR_PIN,
  initNativeParser,
  parseALNative,
} from "../../packages/engine/src/ast/native-parser";
import {
  initWasmParser,
  parseALWasm,
  wasmLanguage,
  wrapWasmRoot,
} from "../../packages/engine/src/ast/parser-wasm";
import { wrapFlatRoot } from "../../packages/engine/src/ast/syntax-node";
import { compareStructure, flatLinksConsistent, wasmKindTableSha256 } from "./parser-equivalence";

const SNIPPETS: Record<string, string> = {
  simple:
    'codeunit 50100 "X"\n{\n    procedure P(A: Integer): Integer\n    begin\n        if A > 1 then exit(A + 1);\n        exit(0);\n    end;\n}\n',
  unicode:
    "\uFEFF// Ærø 😀\r\ncodeunit 50100 \"Blåbær\"\r\n{\r\n    procedure Kør()\r\n    var\r\n        T: Text;\r\n    begin\r\n        T := 'æøå 😀';\r\n    end;\r\n}\r\n",
  crlf: "codeunit 50100 X\r\n{\r\n    trigger OnRun()\r\n    begin\r\n        Message('a');\r\n    end;\r\n}\r\n",
  broken: "codeunit 50100 X { procedure P() begin if then end; }",
  empty: "",
};

describe("native vs wasm, lockstep through ALSyntaxNode", () => {
  beforeAll(async () => {
    await initWasmParser();
    await initNativeParser();
  });

  for (const [name, src] of Object.entries(SNIPPETS)) {
    it(`is identical on the ${name} snippet`, () => {
      const tree = parseALWasm(src);
      const parsed = parseALNative(src);
      const r = compareStructure(wrapWasmRoot(tree), wrapFlatRoot(parsed), 20);
      tree.delete();
      expect(r.diffs).toEqual([]);
      expect(r.nodes).toBeGreaterThan(0);
      expect(flatLinksConsistent(parsed.flat)).toBe(true);
    });
  }

  it("the WASM language's kind and field tables hash to the native pin", () => {
    expect(wasmKindTableSha256(wasmLanguage())).toBe(GRAMMAR_PIN.kindTableSha256);
  });

  it("reports a structural difference when one exists", () => {
    const tree = parseALWasm(SNIPPETS.simple ?? "");
    const r = compareStructure(
      wrapWasmRoot(tree),
      wrapFlatRoot(parseALNative(SNIPPETS.crlf ?? "")),
      5,
    );
    tree.delete();
    expect(r.diffs.length).toBeGreaterThan(0);
  });

  it("detects a sibling-link cycle and a child count that disagrees with the links", () => {
    const parsed = parseALNative(SNIPPETS.simple ?? "");
    const cyc = Int32Array.from(parsed.flat.nextSibling);
    cyc[1] = 1;
    expect(flatLinksConsistent({ ...parsed.flat, nextSibling: cyc })).toBe(false);
    const dup = Uint32Array.from(parsed.flat.childCount);
    dup[1] = (dup[1] ?? 0) + 1;
    expect(flatLinksConsistent({ ...parsed.flat, childCount: dup })).toBe(false);
  });

  it("compares text, not only offsets", () => {
    const src = SNIPPETS.simple ?? "";
    const tree = parseALWasm(src);
    const parsed = parseALNative(src);
    const r = compareStructure(
      wrapWasmRoot(tree),
      wrapFlatRoot({ ...parsed, source: src.replace("exit(0)", "exit(9)") }),
      5,
    );
    tree.delete();
    expect(r.diffs.some((d) => d.what === "text")).toBe(true);
  });

  it("detects a broken sibling link even when every row matches", () => {
    const parsed = parseALNative(SNIPPETS.simple ?? "");
    const bent = {
      ...parsed,
      flat: { ...parsed.flat, nextSibling: parsed.flat.nextSibling.map(() => -1) },
    };
    const tree = parseALWasm(SNIPPETS.simple ?? "");
    const r = compareStructure(wrapWasmRoot(tree), wrapFlatRoot(bent), 5);
    tree.delete();
    expect(r.diffs.length).toBeGreaterThan(0);
    expect(flatLinksConsistent(bent.flat)).toBe(false);
  });
});

describe("probe-parser-equivalence CLI", () => {
  // Spawns a real `bun` subprocess, which passes alone in well under a second but can push past
  // Bun's 5 s default test timeout when something else is loading the machine (a full `bun test`
  // run, or a live itest at the same time). See HOOK_TIMEOUT_MS in campaign-subcommands.test.ts
  // (R335) for the measured shape of this failure.
  const SPAWN_TEST_TIMEOUT_MS = 60_000;

  it(
    "refuses an empty corpus instead of reporting a clean Q1",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "q1-empty-"));
      try {
        const r = Bun.spawnSync([
          "bun",
          join(import.meta.dir, "..", "probe-parser-equivalence.ts"),
          dir,
        ]);
        expect(r.stderr.toString()).toContain("no .al files");
        expect(r.exitCode).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
