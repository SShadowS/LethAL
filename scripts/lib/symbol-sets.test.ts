import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSymbolSets } from "./symbol-sets.ts";

const made: string[] = [];
function project(json?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lethal-symbol-sets-"));
  made.push(dir);
  if (json !== undefined) writeFileSync(join(dir, "symbol-sets.json"), json, "utf8");
  return dir;
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readSymbolSets (R321)", () => {
  test("no file means the project declares no sets", () => {
    expect(readSymbolSets(project())).toBeUndefined();
  });
  test("returns the sets in file order, the empty set included", () => {
    expect(readSymbolSets(project('[[], ["LETHALA"], ["LETHALB"]]'))).toEqual([
      [],
      ["LETHALA"],
      ["LETHALB"],
    ]);
  });
  test("tolerates a UTF-8 BOM, as appVersion does", () => {
    expect(readSymbolSets(project('﻿[["A"]]'))).toEqual([["A"]]);
  });
  test("refuses a file that is not an array of arrays", () => {
    expect(() => readSymbolSets(project('{"sets": []}'))).toThrow(/non-empty array/);
    expect(() => readSymbolSets(project("[]"))).toThrow(/non-empty array/);
    expect(() => readSymbolSets(project('["A"]'))).toThrow(/array of symbols/);
  });
  test("refuses a symbol alc's /define list form would split or mangle", () => {
    expect(() => readSymbolSets(project('[["A,B"]]'))).toThrow(/array of symbols/);
    expect(() => readSymbolSets(project('[["A B"]]'))).toThrow(/array of symbols/);
    expect(() => readSymbolSets(project('[[""]]'))).toThrow(/array of symbols/);
  });
  test("refuses the same set listed twice, in any order", () => {
    expect(() => readSymbolSets(project('[["A","B"],["B","A"]]'))).toThrow(/listed twice/);
  });
});
