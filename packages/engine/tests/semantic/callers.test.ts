import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { initParser, parseAL } from "../../src/ast/parser";
import { wrapRoot } from "../../src/ast/syntax-node";
import { buildCallerIndex } from "../../src/semantic/callers";
import { buildSymbolTable, objectScopeKey } from "../../src/semantic/symbol-table";

describe("buildCallerIndex", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("indexes direct and indirect callers of Helper", async () => {
    const src = await readFile(resolve(__dirname, "../fixtures/al/caller-chain.al"), "utf8");
    const root = wrapRoot(parseAL(src));
    const symbols = buildSymbolTable([{ path: "c.al", root }]);
    const callers = buildCallerIndex([{ path: "c.al", root }], symbols);
    const helperCalls = callers.callersOf(objectScopeKey("codeunit", "Callers"), "Helper");
    const names = helperCalls.map((c) => c.fromProcedure).sort();
    expect(names).toEqual(["Direct", "Indirect"]);
  });

  it("keeps two same-named objects of different KINDS in separate buckets (R81)", async () => {
    // R81: with the index keyed on the bare owner name, `table 50000 "CDO Setup".Configure` and
    // `page 50000 "CDO Setup".Configure` shared one bucket and each was reported as a caller of
    // the other. Two objects, same name, different kind, each with its own caller — the merged
    // key gives every lookup BOTH sites, so the assertion is on the bucket's contents, not just
    // its size (a size-only check passes if the two happen to be swapped).
    const src = `
      table 50000 "Shared Name"
      {
          fields { field(1; "No."; Code[20]) { } }
          procedure Configure(): Integer begin exit(1); end;
          procedure FromTable(): Integer begin exit(Configure()); end;
      }
      page 50000 "Shared Name"
      {
          SourceTable = "Shared Name";
          procedure Configure(): Integer begin exit(2); end;
          procedure FromPage(): Integer begin exit(Configure()); end;
      }`;
    const root = wrapRoot(parseAL(src));
    const symbols = buildSymbolTable([{ path: "shared.al", root }]);
    const callers = buildCallerIndex([{ path: "shared.al", root }], symbols);

    const fromTable = callers.callersOf(objectScopeKey("table", "Shared Name"), "Configure");
    const fromPage = callers.callersOf(objectScopeKey("page", "Shared Name"), "Configure");
    expect(fromTable.map((c) => c.fromProcedure)).toEqual(["FromTable"]);
    expect(fromPage.map((c) => c.fromProcedure)).toEqual(["FromPage"]);
  });

  it("returns empty list for an uncalled procedure", async () => {
    const src = `codeunit 50109 "U" { procedure Unused(): Integer begin exit(0); end; }`;
    const root = wrapRoot(parseAL(src));
    const symbols = buildSymbolTable([{ path: "u.al", root }]);
    const callers = buildCallerIndex([{ path: "u.al", root }], symbols);
    expect(callers.callersOf(objectScopeKey("codeunit", "U"), "Unused")).toEqual([]);
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
    expect(callers.callersOf(objectScopeKey("codeunit", "QC"), "Target")).toEqual([]);
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
    expect(callers.callersOf(objectScopeKey("codeunit", "Callers"), "Helper")).toHaveLength(1);
  });
});
