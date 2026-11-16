import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliConfig } from "../packages/runner/src/cli";

// PR-70: the CI templates under docs/ci are examples, but every `lethal` command in them must parse with the CLI's own
// argument table, so a renamed or removed flag fails here, not in a user's pipeline.
const DIR = process.env.LETHAL_CI_TEMPLATES_DIR ?? join(import.meta.dir, "../docs/ci");
const TEMPLATES = ["github-actions.yml", "azure-pipelines.yml"];

/**
 * Every `lethal ...` command of a template, from any line that is not a YAML comment (whatever the step form: `run:`,
 * `- run:`, `- bash:`, `script:` or a block scalar), with quotes dropped and CI expressions (`${{ ... }}`, `$(...)`) and shell
 * variables replaced by a branch name. A command continued with a trailing `\` is refused: it would be read in part.
 */
function lethalCommands(text: string): string[][] {
  const out: string[][] = [];
  for (const raw of text.split("\n")) {
    // a YAML comment, whole-line or after the value (the templates' commands hold no `#`)
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (line === "") continue;
    const m = /(?:^|[\s:;&|(])lethal\s+(\S.*)$/.exec(line);
    if (m?.[1] === undefined) continue;
    if (line.endsWith("\\")) throw new Error(`a continued lethal command is not checked: ${line}`);
    out.push(
      m[1]
        .replace(/\$\{\{[^}]*\}\}/g, "main")
        .replace(/\$\([^)]*\)/g, "main")
        .replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "main")
        .replace(/"/g, "")
        .split(/\s+/),
    );
  }
  return out;
}

/** The block scalar (`run: |` or `- bash: |`) that holds the `lethal run` command, dedented. */
function runBlock(text: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.includes("lethal run --project"));
  let head = at;
  while (head >= 0 && !/\|\s*$/.test(lines[head] ?? "")) head--;
  if (at < 0 || head < 0) throw new Error("no block holds the lethal run command");
  const indent = (s: string) => s.length - s.trimStart().length;
  const bodyIndent = indent(lines[head + 1] ?? "");
  const body: string[] = [];
  for (const l of lines.slice(head + 1)) {
    if (l.trim() !== "" && indent(l) < bodyIndent) break;
    body.push(l.slice(bodyIndent));
  }
  return body.join("\n");
}

/** Runs the template's run block with a stub `lethal` that exits `n`; returns the block's own exit code. */
function exitOfRunBlock(block: string, n: number): number {
  const dir = mkdtempSync(join(tmpdir(), "lethal-ci-stub-"));
  try {
    const stub = join(dir, "lethal");
    writeFileSync(stub, '#!/bin/sh\nexit "$LETHAL_STUB_EXIT"\n');
    chmodSync(stub, 0o755);
    const r = Bun.spawnSync(["bash", "-c", block], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        LETHAL_STUB_EXIT: String(n),
        TARGET: "main", // Azure
        BASE: "main", // GitHub
      },
    });
    return r.exitCode;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The labels of the `case "$rc"` block's branches, e.g. ["0", "3", "4", "7", "*"]. */
function caseLabels(text: string): string[] {
  const start = text.indexOf('case "$rc" in');
  const end = text.indexOf("esac", start);
  if (start < 0 || end < 0) return [];
  return [...text.slice(start, end).matchAll(/^\s*([0-9]+|\*)\)/gm)].map((m) => m[1] ?? "");
}

describe("PR-70: the CI templates' lethal commands", () => {
  for (const t of TEMPLATES) {
    const text = readFileSync(join(DIR, t), "utf8");
    const cmds = lethalCommands(text);

    test(`${t}: holds one run and two exports (the JSON and the HTML page)`, () => {
      expect(cmds.map((c) => c[0])).toEqual(["run", "export", "export"]);
      const formats = cmds.slice(1).map((c) => c[c.indexOf("--format") + 1]);
      expect(formats).toEqual(["mutation-elements", "mutation-elements-html"]);
    });

    test(`${t}: every lethal command parses with the CLI's own table`, () => {
      // The templates run al-runner-v3 on Linux; Windows refuses that backend at parse time (R586), so there the same flags
      // are parsed under bcdev, which keeps every flag checked by the strict table.
      const onWindows = process.platform === "win32";
      for (const argv of cmds) {
        const parsed = onWindows ? argv.map((a) => (a === "al-runner-v3" ? "bcdev" : a)) : argv;
        expect(() => parseCliConfig(parsed), parsed.join(" ")).not.toThrow();
      }
    });

    test(`${t}: the run is scoped to the changed lines and the export reads its report and project`, () => {
      const [run, ...exports] = cmds;
      if (run === undefined || exports.length === 0) throw new Error("no run or export");
      const arg = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
      expect(arg(run, "--changed-since")).toStartWith("origin/");
      for (const exp of exports) {
        expect(exp[1]).toBe(arg(run, "--out"));
        expect(arg(exp, "--project")).toBe(arg(run, "--project"));
        expect(arg(exp, "--format")).toStartWith("mutation-elements");
      }
    });

    // The stub needs `sh` and an executable named `lethal`: not on Windows.
    test.skipIf(process.platform === "win32")(
      `${t}: the run block passes for exit 0 and 8 only (stub lethal, exits 0..9)`,
      () => {
        const block = runBlock(text);
        for (let n = 0; n <= 9; n++) {
          expect(exitOfRunBlock(block, n) === 0, `lethal exit ${n}`).toBe(n === 0 || n === 8);
        }
      },
    );

    test(`${t}: maps exactly the exit codes LethAL documents (0, 3, 4, 7, 8, else); only 0 and 8 pass`, () => {
      expect(caseLabels(text)).toEqual(["0", "8", "3", "4", "7", "*"]);
      expect(text).toMatch(/8\) echo "[^"]*"; rc=0 ;;/);
      expect(text).toContain('exit "$rc"');
      expect(text.indexOf("set +e")).toBeGreaterThan(-1);
      expect(text.indexOf("set +e")).toBeLessThan(text.indexOf("lethal run --project"));
    });
  }

  test("lethalCommands: replaces CI expressions and skips non-lethal lines", () => {
    const text =
      "      - run: echo hi\n      run: lethal run --changed-since origin/${{ github.base_ref }} --dry-run\n";
    expect(lethalCommands(text)).toEqual([["run", "--changed-since", "origin/main", "--dry-run"]]);
  });

  test("lethalCommands: catches every step form, skips comments, drops quotes and shell variables", () => {
    const text = [
      "# lethal run --nope (a comment)",
      "      - run: lethal export r.json --format mutation-elements",
      '        script: lethal run --changed-since "origin/$TARGET"',
      "          rm -f lethal-report.json",
    ].join("\n");
    expect(lethalCommands(text)).toEqual([
      ["export", "r.json", "--format", "mutation-elements"],
      ["run", "--changed-since", "origin/main"],
    ]);
  });

  test("lethalCommands: a continued command is refused, not read in part", () => {
    expect(() => lethalCommands("      lethal run --project app \\\n        --tests test")).toThrow(
      /continued/,
    );
  });

  test("caseLabels: reads only the case block's branches", () => {
    expect(caseLabels('# 9) in a comment\ncase "$rc" in\n  0) a ;;\n  *) b ;;\nesac\n')).toEqual([
      "0",
      "*",
    ]);
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
