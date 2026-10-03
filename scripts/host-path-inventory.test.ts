import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PathClass, inventory, parseClasses } from "./host-path-inventory";

const classes = (rows: [string, PathClass][]) => new Map(rows);

describe("host-path-inventory", () => {
  test("a hit file with no row is reported, a classified one is not", () => {
    const r = inventory(
      [
        { path: "a.ts", text: "const x = 'H:/x'" },
        { path: "b.ts", text: "const y = 'H:/y'" },
      ],
      classes([["a.ts", "inert"]]),
    );
    expect(r.unclassified).toEqual(["b.ts"]);
    expect(r.hits.get("a.ts")).toBe(1);
  });

  test("a directory row classifies files below it, and not a sibling with the same prefix", () => {
    const c = classes([["docs/superpowers/plans/", "historical"]]);
    const r = inventory(
      [
        { path: "docs/superpowers/plans/p.md", text: "U:\\Git\\x" },
        { path: "docs/superpowers/plans-extra/p.md", text: "U:\\Git\\x" },
      ],
      c,
    );
    expect(r.unclassified).toEqual(["docs/superpowers/plans-extra/p.md"]);
  });

  test("Windows separators in a path still match a row", () => {
    const r = inventory(
      [{ path: "scripts\\a.ts", text: "C:/Users/me" }],
      classes([["scripts/a.ts", "inert"]]),
    );
    expect(r.unclassified).toEqual([]);
  });

  test("a file with no host path is not a hit", () => {
    const r = inventory(
      [{ path: "c.ts", text: "nothing here, H: alone is not a path" }],
      new Map(),
    );
    expect(r.hits.size).toBe(0);
    expect(r.unclassified).toEqual([]);
  });

  test("every spec pattern counts", () => {
    const text = "H:\\a H:/b U:\\Git U:/Git C:/Users ~/.vscode";
    expect(inventory([{ path: "p", text }], new Map()).hits.get("p")).toBe(6);
  });

  test("parseClasses reads table rows and skips header, separator and prose", () => {
    const md = [
      "# t",
      "| path | class | note |",
      "|---|---|---|",
      "| `a/b.ts` | inert | why |",
      "| d/ | historical | |",
      "| x | bogus | |",
    ].join("\n");
    expect([...parseClasses(md)]).toEqual([
      ["a/b.ts", "inert"],
      ["d/", "historical"],
    ]);
  });
});

describe("host-path-inventory CLI", () => {
  const script = join(import.meta.dir, "host-path-inventory.ts");
  const run = (...args: string[]) => Bun.spawnSync(["bun", script, ...args]);
  const tmp = mkdtempSync(join(tmpdir(), "hpi-"));

  test("passes on this repo: every hit is classified", () => {
    const p = run();
    expect(p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
  });

  test("fails when the inventory file is missing", () => {
    const p = run(join(tmp, "nope.md"));
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("missing");
  });

  test("fails when the inventory file has no rows", () => {
    const f = join(tmp, "empty.md");
    writeFileSync(f, "# nothing\n");
    const p = run(f);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("no classification rows");
  });

  test("fails and names the files when rows do not cover the hits", () => {
    const f = join(tmp, "one.md");
    writeFileSync(f, "| path | class | note |\n|---|---|---|\n| CLAUDE.md | operational | x |\n");
    const p = run(f);
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("not classified");
    expect(p.stderr.toString()).toContain("scripts/coord.sh");
  });
});
