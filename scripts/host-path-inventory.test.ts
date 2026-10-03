import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const text = "H:\\a H:/b U:\\Git U:/Git C:/Users ~/.vscode /h/x /u/Git/y";
    expect(inventory([{ path: "p", text }], new Map()).hits.get("p")).toBe(8);
  });

  test("MSYS forms are anchored: /x/h/y, ./h/y, a URL /u/ and a/h/ are not hits", () => {
    const text = "/x/h/y ./h/y a/h/b reddit.com/u/me /u/other";
    expect(inventory([{ path: "p", text }], new Map()).hits.size).toBe(0);
    expect(inventory([{ path: "q", text: "cd /h/al-runner" }], new Map()).hits.get("q")).toBe(1);
    expect(inventory([{ path: "r", text: "/u/Git/LethAL" }], new Map()).hits.get("r")).toBe(1);
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

  // MERGE-TIME GATE: this fails when any tracked file names a host path and has no row in
  // docs/kraken-move-inventory.md. Stale rows only warn.
  test("merge-time gate: every host-path hit in this repo is classified", () => {
    const p = run();
    expect(p.stderr.toString()).not.toContain("not classified");
    expect(p.exitCode).toBe(0);
  });

  test("a stale row is a warning on stderr and the exit stays 0", () => {
    const f = join(tmp, "stale.md");
    const real = readFileSync(
      join(import.meta.dir, "..", "docs", "kraken-move-inventory.md"),
      "utf8",
    );
    writeFileSync(f, `${real}\n| gone/away.ts | inert | no hits |\n| gone-dir/ | historical | |\n`);
    const p = run(f);
    expect(p.exitCode).toBe(0);
    expect(p.stderr.toString()).toContain("WARNING");
    expect(p.stderr.toString()).toContain("gone/away.ts");
    expect(p.stderr.toString()).toContain("gone-dir/");
  });

  test("a tracked file deleted in the working tree is skipped, not a crash", () => {
    const repo = mkdtempSync(join(tmp, "repo-"));
    mkdirSync(join(repo, "scripts"));
    copyFileSync(script, join(repo, "scripts", "host-path-inventory.ts"));
    mkdirSync(join(repo, "docs"));
    writeFileSync(
      join(repo, "docs", "kraken-move-inventory.md"),
      "| path | class | note |\n|---|---|---|\n| kept.txt | inert | |\n| gone.txt | inert | |\n",
    );
    writeFileSync(join(repo, "kept.txt"), "H:/x\n");
    writeFileSync(join(repo, "gone.txt"), "H:/y\n");
    const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: repo });
    git("init", "-q");
    git("add", "kept.txt", "gone.txt");
    rmSync(join(repo, "gone.txt"));
    const p = Bun.spawnSync(["bun", join(repo, "scripts", "host-path-inventory.ts")]);
    expect(p.exitCode).toBe(0);
    expect(p.stderr.toString()).toContain("gone.txt"); // reported stale
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
