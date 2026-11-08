import { beforeAll, describe, expect, test } from "bun:test";
import { initParser } from "@lethal/engine";
import { buildTestAppModel } from "../src/testpage-scan";

/**
 * R-876 (R861, tree-sitter-al 4.6.0): a dotted name in `implements` is ONE `qualified_name` node and
 * its `.text` is the whole dotted name. testpage-scan keeps that FULL text in `Unit.implements`:
 * `lastSegment` takes the last segment where only the name is compared (`implementers`), and
 * `ownsInterface` needs the leading segments, because it checks the namespace. Taking the last
 * segment at the reader would make every qualified interface look like an unqualified one in the
 * file's own namespace, and wrongly count a dependency's interface as the test app's.
 */

beforeAll(async () => {
  await initParser();
});

const implementsOf = (src: string): readonly string[] => {
  const model = buildTestAppModel([{ path: "A.al", text: src }]);
  expect(model.damaged).toEqual([]);
  const unit = [...model.units, ...model.objects].find((u) => u.name === "a");
  if (unit === undefined) throw new Error("unit A not found");
  return unit.implements;
};

describe("R-876: the implements list keeps the whole name", () => {
  // Red: take the last segment of the node in the `implements` mapping of testpage-scan.
  test("a dotted name", () => {
    expect(implementsOf("codeunit 50100 A implements Microsoft.Sales.IFoo\n{\n}\n")).toEqual([
      "Microsoft.Sales.IFoo",
    ]);
  });
  test("a dotted name with a quoted segment holding a dot", () => {
    expect(implementsOf(`codeunit 50100 A implements "My.Ns"."IFoo"\n{\n}\n`)).toEqual([
      '"My.Ns"."IFoo"',
    ]);
  });
  test("a plain name, and a list mixing both", () => {
    expect(implementsOf("codeunit 50100 A implements IFoo\n{\n}\n")).toEqual(["IFoo"]);
    expect(implementsOf("codeunit 50100 A implements IFoo, Ns.IBar\n{\n}\n")).toEqual([
      "IFoo",
      "Ns.IBar",
    ]);
  });
  // tree-sitter-al 4.6.0 still parses a dotted INTERFACE `extends` as an ERROR plus the last
  // segment (probed), so only the plain form is pinned there.
  test("an interface extending a plain interface", () => {
    expect(implementsOf("interface A extends IFoo\n{\n}\n")).toEqual(["IFoo"]);
  });
});
