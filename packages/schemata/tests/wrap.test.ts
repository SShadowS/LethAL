import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import { wrapStatement } from "../src/wrap";

describe("wrapStatement", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("emits deletion wrap for a removed statement", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/schemata-single-statement.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    const output = wrapStatement({
      mutantId: "M0001",
      original: assign,
      replacement: null,
    });
    expect(output).toContain("if not MutationSelector.Active('M0001') then");
    expect(output).toContain("Amount := Amount + 1");
  });

  it("emits substitution wrap for a replaced statement", async () => {
    const src = `codeunit 51001 "W" { procedure P() begin X := 1; end; }`;
    const root = wrapRoot(parseAL(src));
    const assign = findFirst(root, ALNodeKind.assignment_statement);
    if (assign === null) throw new Error("no assignment");
    const output = wrapStatement({
      mutantId: "M0002",
      original: assign,
      replacement: "X := 2;",
    });
    expect(output).toContain("if MutationSelector.Active('M0002') then");
    expect(output).toContain("X := 2;");
    expect(output).toContain("else");
    expect(output).toContain("X := 1");
  });
});
