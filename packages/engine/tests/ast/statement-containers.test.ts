import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONDITIONAL_LISTS,
  NOT_A_SLOT,
  SINGLE_STATEMENT_SLOTS,
  STATEMENT_LISTS,
} from "../../src/ast/tree-walks";

// R217: reads only the committed list (no cargo, no grammar), so it runs everywhere.
const committed = JSON.parse(
  readFileSync(join(import.meta.dir, "../../src/ast/statement-containers.json"), "utf8"),
) as {
  grammarVersion: string;
  candidates: { container: string; field: string }[];
};
const keys = committed.candidates.map((c) => `${c.container}.${c.field}`);

const classesOf = (key: string): string[] =>
  [
    SINGLE_STATEMENT_SLOTS.has(key) ? "SLOT" : "",
    STATEMENT_LISTS.has(key) ? "STATEMENT_LIST" : "",
    CONDITIONAL_LISTS.has(key) ? "CONDITIONAL" : "",
    key in NOT_A_SLOT ? "NOT_A_SLOT" : "",
  ].filter((c) => c !== "");

describe("R217 statement-container pin", () => {
  test("every candidate is classified in exactly one class", () => {
    const bad = keys
      .map((k) => ({ k, classes: classesOf(k) }))
      .filter((x) => x.classes.length !== 1)
      .map((x) => `${x.k} -> [${x.classes.join(",")}]`);
    expect(bad).toEqual([]);
  });

  test("every classified entry is a candidate (no stale entries)", () => {
    const all = new Set(keys);
    const stale = [
      ...SINGLE_STATEMENT_SLOTS,
      ...STATEMENT_LISTS,
      ...CONDITIONAL_LISTS,
      ...Object.keys(NOT_A_SLOT),
    ].filter((k) => !all.has(k));
    expect(stale).toEqual([]);
  });

  test("an unsupported entry names its roadmap item", () => {
    for (const [k, v] of Object.entries(NOT_A_SLOT))
      expect([k, v.kind === "unsupported" ? /^R\d+$/.test(v.item ?? "") : v.item === null]).toEqual(
        [k, true],
      );
  });

  test("the committed grammarVersion is the Cargo.toml pin", () => {
    const cargo = readFileSync(join(import.meta.dir, "../../native/Cargo.toml"), "utf8");
    const pin = /^tree-sitter-al\s*=\s*"=([^"]+)"/m.exec(cargo)?.[1];
    expect(committed.grammarVersion).toBe(pin ?? "no pin found");
  });

  // R796 (tree-sitter-al 4.5.0): the seven new containers are candidates, each classified, and
  // `preproc_conditional_var` (declarations only now) is no longer one.
  test("the 4.5.0 containers are candidates and classified; preproc_conditional_var is gone", () => {
    const NEW = [
      "case_body.children",
      "preproc_conditional_case.children",
      "preproc_split_block_close_after_endif.children",
      "preproc_split_block_end_in_else.children",
      "preproc_split_case_extended.children",
      "preproc_split_open_statement.children",
      "preproc_split_var_section_tail.children",
    ];
    for (const k of NEW) {
      expect(keys, k).toContain(k);
      expect(classesOf(k), k).toHaveLength(1);
    }
    expect(keys.some((k) => k.startsWith("preproc_conditional_var."))).toBe(false);
    expect("preproc_conditional_var.children" in NOT_A_SLOT).toBe(false);
  });

  // A case arm's body stays a statement slot (the 4.4.1 slot), and a case body's own children are
  // not: arms are reached through `case_branch.body`, never as bare statements of the body.
  test("case_body: the arm body keeps its slot; case_body.children is not a slot", () => {
    expect(SINGLE_STATEMENT_SLOTS.has("case_branch.body")).toBe(true);
    expect(SINGLE_STATEMENT_SLOTS.has("case_body.children")).toBe(false);
    expect(NOT_A_SLOT["case_body.children"]?.item).toBe("R796");
  });
});
