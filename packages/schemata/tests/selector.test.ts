import { describe, expect, test } from "bun:test";
import {
  emitMutationActiveTable,
  emitMutationControl,
  emitMutationSelector,
  emitStaticSelector,
  emitWebServicesXml,
} from "../src/selector";

const cfg = { selectorId: 50000, controlId: 50001, tableId: 50002 };

describe("emitMutationActiveTable", () => {
  test("emits single-row table, cross-company", () => {
    const src = emitMutationActiveTable(cfg);
    expect(src).toContain('table 50002 "Mutation Active"');
    expect(src).toContain("DataPerCompany = false;");
    expect(src).toContain('field(1; PrimaryKey; Code[10])');
    expect(src).toContain("field(2; ActiveId; Text[64])");
  });
});

describe("emitMutationSelector", () => {
  test("reads the table once per session, then caches", () => {
    const src = emitMutationSelector(cfg);
    expect(src).toContain('codeunit 50000 "Mutation Selector"');
    expect(src).toContain("SingleInstance = true;");
    expect(src).toContain("procedure Active(MutantId: Text): Boolean");
    expect(src).toContain("if not Loaded then begin");
    expect(src).toContain("if MutationActive.Get('') then");
    expect(src).toContain("CachedId := MutationActive.ActiveId;");
  });
});

describe("emitMutationControl", () => {
  test("writes the table, commits, echoes the id", () => {
    const src = emitMutationControl(cfg);
    expect(src).toContain('codeunit 50001 "Mutation Control"');
    expect(src).toContain("procedure SetActive(MutantId: Text): Text");
    expect(src).toContain("procedure ClearActive()");
    expect(src).toContain("Commit();");
    expect(src).toContain("exit(MutantId);");
  });
});

describe("emitStaticSelector", () => {
  test("hardcodes the active id for in-memory backends", () => {
    const src = emitStaticSelector({ objectId: 50000, activeId: "M0007" });
    expect(src).toContain('codeunit 50000 "Mutation Selector"');
    expect(src).toContain("exit(MutantId = 'M0007');");
  });
  test("empty id means always inactive", () => {
    const src = emitStaticSelector({ objectId: 50000, activeId: "" });
    expect(src).toContain("exit(false);");
  });
});

describe("emitWebServicesXml", () => {
  test("exposes Mutation Control as a web service", () => {
    const xml = emitWebServicesXml(cfg);
    expect(xml).toContain("<ObjectType>Codeunit</ObjectType>");
    expect(xml).toContain("<ObjectID>50001</ObjectID>");
    expect(xml).toContain("<ServiceName>MutationControl</ServiceName>");
    expect(xml).toContain("<Published>true</Published>");
  });
});
