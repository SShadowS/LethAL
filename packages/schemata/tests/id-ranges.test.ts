import { describe, expect, test } from "bun:test";
import type { AppIdRange, DeclaredObject } from "../src/id-ranges";
import { parseIdRanges, validateSelectorIds } from "../src/id-ranges";
import type { SelectorConfig } from "../src/selector";

const DEFAULT_IDS: SelectorConfig = { selectorId: 79199, controlId: 79198, tableId: 79197 };

describe("parseIdRanges", () => {
  test("parses a well-formed idRanges array", () => {
    const ranges = parseIdRanges({ idRanges: [{ from: 79000, to: 79199 }] });
    expect(ranges).toEqual([{ from: 79000, to: 79199 }]);
  });

  test("parses several ranges", () => {
    const ranges = parseIdRanges({
      idRanges: [
        { from: 79197, to: 79199 },
        { from: 79300, to: 79399 },
      ],
    });
    expect(ranges).toEqual([
      { from: 79197, to: 79199 },
      { from: 79300, to: 79399 },
    ]);
  });

  test("throws when idRanges is missing", () => {
    expect(() => parseIdRanges({})).toThrow(/no non-empty "idRanges" array/);
  });

  test("throws when idRanges is an empty array", () => {
    expect(() => parseIdRanges({ idRanges: [] })).toThrow(/no non-empty "idRanges" array/);
  });

  test("throws when idRanges is not an array", () => {
    expect(() => parseIdRanges({ idRanges: "nope" })).toThrow(/no non-empty "idRanges" array/);
  });

  test("throws when an entry is missing from/to", () => {
    expect(() => parseIdRanges({ idRanges: [{ from: 1 }] })).toThrow(/idRanges\[0\] is malformed/);
  });

  test("throws when an entry has from > to", () => {
    expect(() => parseIdRanges({ idRanges: [{ from: 100, to: 50 }] })).toThrow(
      /"from" \(100\) greater than "to" \(50\)/,
    );
  });
});

describe("validateSelectorIds — range check", () => {
  const IN_RANGE: readonly AppIdRange[] = [{ from: 79000, to: 79199 }];

  test("accepts ids that fall inside a declared range", () => {
    expect(() => validateSelectorIds(DEFAULT_IDS, IN_RANGE)).not.toThrow();
  });

  test("accepts ids spread across several declared ranges", () => {
    const ids: SelectorConfig = { selectorId: 79300, controlId: 79301, tableId: 79302 };
    const ranges: readonly AppIdRange[] = [
      { from: 79197, to: 79199 },
      { from: 79300, to: 79399 },
    ];
    expect(() => validateSelectorIds(ids, ranges)).not.toThrow();
  });

  test("rejects an out-of-range selectorId, naming the id and the declared ranges", () => {
    const ids: SelectorConfig = { ...DEFAULT_IDS, selectorId: 50000 };
    expect(() => validateSelectorIds(ids, IN_RANGE)).toThrow(
      /selectorId.*= 50000 falls outside every idRange.*\(79000-79199\)/s,
    );
  });

  test("rejects an out-of-range controlId", () => {
    const ids: SelectorConfig = { ...DEFAULT_IDS, controlId: 1 };
    expect(() => validateSelectorIds(ids, IN_RANGE)).toThrow(/controlId.*= 1 falls outside/s);
  });

  test("rejects an out-of-range tableId", () => {
    const ids: SelectorConfig = { ...DEFAULT_IDS, tableId: 999999 };
    expect(() => validateSelectorIds(ids, IN_RANGE)).toThrow(/tableId.*= 999999 falls outside/s);
  });

  test("with no declared ranges, every id is out of range", () => {
    expect(() => validateSelectorIds(DEFAULT_IDS, [])).toThrow(/\(none\)/);
  });
});

describe("validateSelectorIds — pairwise distinct", () => {
  const RANGE: readonly AppIdRange[] = [{ from: 1, to: 100 }];

  test("rejects selectorId === controlId", () => {
    const ids: SelectorConfig = { selectorId: 5, controlId: 5, tableId: 6 };
    expect(() => validateSelectorIds(ids, RANGE)).toThrow(/selector ids collide.*are both 5/s);
  });

  test("rejects all three ids being equal", () => {
    const ids: SelectorConfig = { selectorId: 5, controlId: 5, tableId: 5 };
    expect(() => validateSelectorIds(ids, RANGE)).toThrow(/selector ids collide/);
  });

  test("accepts three distinct ids", () => {
    const ids: SelectorConfig = { selectorId: 5, controlId: 6, tableId: 7 };
    expect(() => validateSelectorIds(ids, RANGE)).not.toThrow();
  });
});

describe("validateSelectorIds — collision with an existing object", () => {
  const RANGE: readonly AppIdRange[] = [{ from: 1, to: 100 }];

  test("rejects an id equal to an existing codeunit's id", () => {
    const ids: SelectorConfig = { selectorId: 5, controlId: 6, tableId: 7 };
    const existing = new Map<number, DeclaredObject>([
      [6, { type: "codeunit", id: 6, name: "Some Other Codeunit" }],
    ]);
    expect(() => validateSelectorIds(ids, RANGE, existing)).toThrow(
      /controlId.*= 6 is already declared as codeunit 6 "Some Other Codeunit"/s,
    );
  });

  test("an empty existing-objects map never collides", () => {
    const ids: SelectorConfig = { selectorId: 5, controlId: 6, tableId: 7 };
    expect(() => validateSelectorIds(ids, RANGE, new Map())).not.toThrow();
  });
});
