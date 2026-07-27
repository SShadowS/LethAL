import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot } from "../../src/ast/syntax-node";
import { buildCallerIndex } from "../../src/semantic/callers";
import { buildSymbolTable } from "../../src/semantic/symbol-table";

describe("buildCallerIndex", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("indexes direct and indirect callers of Helper", async () => {
    const src = await readFile(resolve(__dirname, "../fixtures/al/caller-chain.al"), "utf8");
    const root = wrapRoot(parseAL(src));
    const symbols = buildSymbolTable([{ path: "c.al", root }]);
    const callers = buildCallerIndex([{ path: "c.al", root }], symbols);
    const helperCalls = callers.callersOf("Callers", "Helper");
    const names = helperCalls.map((c) => c.fromProcedure).sort();
    expect(names).toEqual(["Direct", "Indirect"]);
  });

  it("returns empty list for an uncalled procedure", async () => {
    const src = `codeunit 50109 "U" { procedure Unused(): Integer begin exit(0); end; }`;
    const root = wrapRoot(parseAL(src));
    const symbols = buildSymbolTable([{ path: "u.al", root }]);
    const callers = buildCallerIndex([{ path: "u.al", root }], symbols);
    expect(callers.callersOf("U", "Unused")).toEqual([]);
  });

  it("does not misattribute argument identifiers as call targets", async () => {
    const src = `codeunit 50110 "QC" {
    procedure Target(): Integer begin exit(0); end;
    procedure Caller(): Integer
    var
        Rec: Record "Foo Table";
    begin
        Rec.Find(Target);
        exit(0);
    end;
  }`;
    const root = wrapRoot(parseAL(src));
    const symbols = buildSymbolTable([{ path: "qc.al", root }]);
    const callers = buildCallerIndex([{ path: "qc.al", root }], symbols);
    // Target should have no callers because Rec.Find(Target) is a qualified call
    // whose argument `Target` is not itself an invocation.
    expect(callers.callersOf("QC", "Target")).toEqual([]);
  });

  it("does not double-count callers when multiple files parse through", async () => {
    const src = `codeunit 50108 "Callers" {
    procedure Helper(): Integer begin exit(1); end;
    procedure Direct(): Integer begin exit(Helper()); end;
  }`;
    const root = wrapRoot(parseAL(src));
    const symbols = buildSymbolTable([{ path: "c.al", root }]);
    // Same root passed as two file entries — simulating a multi-file project
    // where the caller index must not duplicate per-file.
    const callers = buildCallerIndex(
      [
        { path: "c.al", root },
        { path: "c2.al", root },
      ],
      symbols,
    );
    expect(callers.callersOf("Callers", "Helper")).toHaveLength(1);
  });
});
