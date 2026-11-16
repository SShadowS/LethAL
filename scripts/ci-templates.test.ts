import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCliConfig } from "../packages/runner/src/cli";

// PR-70: the CI templates under docs/ci are examples, but every `lethal` command in them must parse with the CLI's own
// argument table, so a renamed or removed flag fails here, not in a user's pipeline.
const DIR = join(import.meta.dir, "../docs/ci");
const TEMPLATES = ["github-actions.yml", "azure-pipelines.yml"];

/** The `lethal ...` command lines of a template, with CI expressions (`${{ ... }}`, `$(...)`) replaced by a branch name. */
function lethalCommands(text: string): string[][] {
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^(run|- bash):\s*/, ""))
    .filter((l) => l.startsWith("lethal "))
    .map((l) =>
      l
        .replace(/\$\{\{[^}]*\}\}/g, "main")
        .replace(/\$\([^)]*\)/g, "main")
        .split(/\s+/)
        .slice(1),
    );
}

describe("PR-70: the CI templates' lethal commands", () => {
  for (const t of TEMPLATES) {
    const text = readFileSync(join(DIR, t), "utf8");
    const cmds = lethalCommands(text);

    test(`${t}: holds one run and one export`, () => {
      expect(cmds.map((c) => c[0])).toEqual(["run", "export"]);
    });

    test(`${t}: every lethal command parses with the CLI's own table`, () => {
      for (const argv of cmds) expect(() => parseCliConfig(argv), argv.join(" ")).not.toThrow();
    });

    test(`${t}: the run is scoped to the changed lines and writes its report where the export reads it`, () => {
      const [run, exp] = cmds;
      expect(run).toContain("--changed-since");
      const out = run?.[run.indexOf("--out") + 1];
      expect(exp?.[1]).toBe(out);
      expect(exp).toContain("mutation-elements");
    });

    test(`${t}: maps every exit code LethAL documents (0, 3, 4, 7) and fails on anything but 0`, () => {
      for (const code of ["0)", "3)", "4)", "7)", "*)"]) expect(text).toContain(code);
      expect(text).toContain('exit "$rc"');
    });
  }

  test("lethalCommands: replaces CI expressions and skips non-lethal lines", () => {
    const text =
      "      - run: echo hi\n      run: lethal run --changed-since origin/${{ github.base_ref }} --dry-run\n";
    expect(lethalCommands(text)).toEqual([["run", "--changed-since", "origin/main", "--dry-run"]]);
  });

  test("a renamed flag is refused, so the parse check can fail", () => {
    expect(() =>
      parseCliConfig([
        "run",
        "--project",
        "app",
        "--tests",
        "test",
        "--backend",
        "al-runner-v3",
        "--changed-sinse",
        "x",
      ]),
    ).toThrow();
  });
});
