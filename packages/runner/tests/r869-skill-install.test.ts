/**
 * R869 (GitHub #26): the LethAL skill ships as an installable file, and nothing in it may drift from
 * the CLI. Every `lethal ...` command the skill shows is parsed by the real argv parser (subcommand,
 * flag ownership, values), every subcommand it names is in `--help`'s USAGE, and every doctor check
 * it names is one `lethal doctor` reports. The plugin manifests point at the one skill file.
 * `agent-contract.test.ts` keeps the older promises (flags in the shared table, exit codes, rules).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { helpText, parseCliConfig } from "../src/cli";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SKILL_DIR = join(ROOT, "skills", "lethal-mutation-testing");
const SKILL = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** The skill's placeholders, as a user would fill them in. */
const FILLED: ReadonlyArray<[string, string]> = [
  ["<app-dir>", "app"],
  ["<test-app-dir>", "tests"],
  ["<glob>", "src/**"],
];

/** Shell words of one command line: whitespace splits, double quotes group. */
function words(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

function fill(line: string): string {
  let s = line;
  for (const [from, to] of FILLED) s = s.split(from).join(to);
  return s;
}

/** Each `lethal ...` command in the skill's ```bash blocks, continuations joined. */
function blockCommands(text: string): string[] {
  const out: string[] = [];
  for (const block of text.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const joined = (block[1] ?? "").replace(/\\\n\s*/g, " ");
    for (const line of joined.split("\n"))
      if (line.trim().startsWith("lethal ")) out.push(line.trim());
  }
  return out;
}

/** Each inline `lethal ...` the prose names, whitespace collapsed. */
function inlineCommands(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, "");
  return [...prose.matchAll(/`(lethal [^`]+)`/g)].map((m) => (m[1] ?? "").replace(/\s+/g, " "));
}

/** The subcommands `--help`'s USAGE block lists (`lethal campaign freeze` gives `campaign`). */
function usageSubcommands(): Set<string> {
  const help = helpText("0.0.0");
  const usage = help.slice(help.indexOf("USAGE"), help.indexOf("\n\n", help.indexOf("USAGE")));
  return new Set([...usage.matchAll(/^\s+lethal ([a-z-]+)/gm)].map((m) => m[1] ?? ""));
}

describe("R869: the skill names only what the CLI accepts", () => {
  test("every command block parses with the real argv parser, as the subcommand it names", () => {
    const commands = blockCommands(SKILL);
    expect(commands.length).toBeGreaterThanOrEqual(5);
    for (const c of commands) {
      const argv = words(fill(c)).slice(1);
      const parsed = (() => {
        try {
          return parseCliConfig(argv);
        } catch (e) {
          throw new Error(`the skill's command does not parse: ${c}\n${String(e)}`);
        }
      })();
      // `run --dry-run` is the one subcommand whose mode is not its name.
      const want = argv[0] === "run" && argv.includes("--dry-run") ? "dry-run" : argv[0];
      expect(String(parsed.mode), c).toBe(String(want));
    }
  });

  test("every inline command with flags parses too, and every subcommand is in --help", () => {
    const known = usageSubcommands();
    expect(known.has("doctor") && known.has("run") && known.has("verify")).toBe(true);
    const inline = inlineCommands(SKILL);
    expect(inline.length).toBeGreaterThanOrEqual(5);
    for (const c of [...inline, ...blockCommands(SKILL)]) {
      const sub = words(c)[1] ?? "";
      expect(known.has(sub), `lethal ${sub} is not in --help's USAGE`).toBe(true);
    }
    for (const c of inline.filter((x) => x.includes(" --"))) {
      expect(() => parseCliConfig(words(fill(c)).slice(1)), c).not.toThrow();
    }
  });

  test("every doctor check the skill names is one lethal doctor reports", () => {
    const section = SKILL.slice(SKILL.indexOf("## 1. Check the setup"), SKILL.indexOf("## 2."));
    const named = [...section.matchAll(/^- (`[a-z-]+`(?:, `[a-z-]+`)*):/gm)].flatMap((m) =>
      [...(m[1] ?? "").matchAll(/`([a-z-]+)`/g)].map((x) => x[1] ?? ""),
    );
    expect(named.length).toBeGreaterThanOrEqual(5);
    const doctor = read("packages", "runner", "src", "doctor.ts");
    for (const n of named) expect(doctor, `doctor has no check "${n}"`).toContain(`"${n}"`);
  });

  test("the skill keeps the safe order: doctor, dry run, scoped run, read, restore", () => {
    const at = (s: string) => SKILL.indexOf(s);
    const order = [
      "## 1. Check the setup",
      "## 2. Size the job",
      "## 3. Run a slice",
      "## 4. Read the result",
      "## 5. Restore the user's app",
    ].map(at);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The restore step quotes the line the run prints, word for word.
    expect(read("packages", "runner", "src", "cli.ts")).toContain(
      "[lethal] the instrumented build is still published as version",
    );
    expect(SKILL.replace(/\s+/g, " ")).toContain(
      "[lethal] the instrumented build is still published as version ...",
    );
  });
});

describe("R869: the skill installs as one file, or as a plugin", () => {
  test("the frontmatter passes the toolbox's shared schema (bc-dev-mcp skill-frontmatter.ts)", () => {
    const front = /^---\n([\s\S]*?)\n---\n/.exec(SKILL)?.[1] ?? "";
    const field = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(front)?.[1] ?? "";
    // The same two rules, copied: that schema says sibling repos copy it until a shared package exists.
    expect(field("name")).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(field("description").length).toBeGreaterThan(0);
    expect(field("name")).toBe("lethal-mutation-testing"); // the folder a user copies it into
  });

  test("the plugin manifest names the skill folder, at the release's version", () => {
    const plugin = JSON.parse(read(".claude-plugin", "plugin.json")) as {
      name: string;
      version: string;
      skills: string[];
    };
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(plugin.name).toBe("lethal");
    expect(plugin.version).toBe(pkg.version);
    expect(plugin.skills).toEqual(["./skills/lethal-mutation-testing"]);
    for (const s of plugin.skills) expect(existsSync(join(ROOT, s, "SKILL.md"))).toBe(true);
  });

  test("the marketplace's one plugin is this repository's plugin", () => {
    const market = JSON.parse(read(".claude-plugin", "marketplace.json")) as {
      plugins: { name: string; source: string }[];
    };
    expect(market.plugins.map((p) => [p.name, p.source])).toEqual([["lethal", "./"]]);
  });

  test("the repository root holds nothing a plugin loads by default but the skill", () => {
    // The plugin's root is the repository's root, so a hooks file or an MCP config added here
    // later would reach every user who installed the skill.
    for (const p of ["hooks", "commands", "agents", "output-styles", ".mcp.json", ".lsp.json"]) {
      expect(
        existsSync(join(ROOT, p)),
        `${p} at the repository root would ship in the plugin`,
      ).toBe(false);
    }
  });

  test("the README tells a user both ways to install it", () => {
    const readme = read("README.md");
    expect(readme).toContain("/plugin marketplace add SShadowS/LethAL");
    expect(readme).toContain("/plugin install lethal@lethal");
    expect(readme).toContain(
      "https://raw.githubusercontent.com/SShadowS/LethAL/master/skills/lethal-mutation-testing/SKILL.md",
    );
  });
});
