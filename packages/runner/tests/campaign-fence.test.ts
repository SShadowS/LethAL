/**
 * The rung-3 fence's probe matrix — every case that has ever been run against this fence, closed
 * bypasses and accepted residuals alike, as a committed test rather than a scratchpad script.
 *
 * It used to be the latter: a `probe-matrix.ts` under a session scratch dir, with its results
 * written into `.superpowers/sdd/.../task-4-report.md`, which is gitignored (`.superpowers/sdd/
 * .gitignore` is `*`). The evidence for the campaign's threat-model decision therefore could not
 * be committed, and eight committed citations pointed at a file that would not survive. The human
 * -readable table now lives in `fixtures/do-campaign/fence-probe-matrix.md`; this file is the part
 * that actually runs, and `matrix doc and probe matrix do not drift` below keeps the two joined.
 *
 * `evaluateFenceEvent` is pure and takes `cwd` as an argument, so every case runs in microseconds
 * and — this is the part the subprocess harness kept getting wrong — the cwd is the CAMPAIGN's
 * topology, not this repo's. The rung-3 agent's cwd is `U:/Git/do-lethal`, a SIBLING of
 * `U:/Git/LethAL`. A probe run from inside this worktree (which is nested UNDER `U:/Git/LethAL`)
 * would make every relative-path case pass or fail for reasons unrelated to the fence's logic.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FenceEvent, evaluateFenceEvent } from "../src/campaign-fence";

/** The real rung-3 agent's working directory: a sibling of `U:/Git/LethAL`, never a descendant. */
const AGENT_CWD = "U:/Git/do-lethal";
/** Somewhere that is not under `U:/Git/LethAL` at all — stands in for the agent's scratch space. */
const SCRATCH = "C:/Users/SShadowS/AppData/Local/Temp/claude/scratch";

interface ProbeCase {
  /** Matches the row id in `fixtures/do-campaign/fence-probe-matrix.md`. */
  readonly id: string;
  readonly name: string;
  readonly expect: "allow" | "deny";
  readonly event: FenceEvent;
  /** Defaults to `AGENT_CWD`. */
  readonly cwd?: string;
}

function bash(command: string): FenceEvent {
  return { tool_name: "Bash", tool_input: { command } };
}
function write(file_path: string): FenceEvent {
  return { tool_name: "Write", tool_input: { file_path } };
}

const NARROWED_RUN =
  'lethal run --project U:/Git/do-lethal/Cloud --only "Al/Codeunit/Codeunit 6175297 CDO Send Cust. Statement Mgt.al" --tests-only "Src/AutomaticDocuments/**" --stop-hung-sessions';

const CASES: readonly ProbeCase[] = [
  // ── Round 1: the original rules ──────────────────────────────────────────────────────────────
  {
    id: "1",
    name: "Write to U:/Git/LethAL/PROBE.txt",
    expect: "deny",
    event: write("U:/Git/LethAL/PROBE.txt"),
  },
  {
    id: "2",
    name: "Bash unnarrowed `lethal run --dry-run`",
    expect: "deny",
    event: bash("lethal run --project . --dry-run"),
  },
  {
    id: "3",
    name: "Bash redirect write",
    expect: "deny",
    event: bash("echo x > U:/Git/LethAL/PROBE.txt"),
  },
  {
    id: "4",
    name: "Bash cp write",
    expect: "deny",
    event: bash("cp somefile.txt U:/Git/LethAL/PROBE.txt"),
  },
  {
    id: "5",
    name: "Bash mv write",
    expect: "deny",
    event: bash("mv src.txt U:/Git/LethAL/PROBE.txt"),
  },
  {
    id: "6",
    name: "Bash tee write",
    expect: "deny",
    event: bash("echo x | tee U:/Git/LethAL/PROBE.txt"),
  },
  {
    id: "7",
    name: "Bash powershell Set-Content",
    expect: "deny",
    event: bash('powershell -c "Set-Content U:/Git/LethAL/PROBE.txt x"'),
  },
  {
    id: "8",
    name: "Bash multi-line variable indirection (plain assignment, no substitution)",
    expect: "deny",
    event: bash("BINARY=lethal\nACTION=run\n$BINARY $ACTION --project ."),
  },
  {
    id: "9",
    name: "Bash case variant `Lethal Run`",
    expect: "deny",
    event: bash("Lethal Run --project . --dry-run"),
  },
  {
    id: "10",
    name: "serena execute_shell_command (harmless-looking content)",
    expect: "deny",
    event: {
      tool_name: "mcp__plugin_serena_serena__execute_shell_command",
      tool_input: { command: "echo hello" },
    },
  },
  {
    id: "11",
    name: "serena create_text_file — no LETHAL_ROOT string anywhere",
    expect: "deny",
    event: {
      tool_name: "mcp__plugin_serena_serena__create_text_file",
      tool_input: { relative_path: "PROBE.txt", content: "x" },
    },
  },
  {
    id: "12",
    name: "serena activate_project — short name, no path string",
    expect: "deny",
    event: {
      tool_name: "mcp__plugin_serena_serena__activate_project",
      tool_input: { project: "lethal" },
    },
  },
  {
    id: "13",
    name: "unknown MCP tool whose tool_input carries a LETHAL_ROOT write path",
    expect: "deny",
    event: {
      tool_name: "mcp__future__do_thing",
      tool_input: { target: { path: "U:/Git/LethAL/PROBE.txt" } },
    },
  },
  {
    id: "14",
    name: "unknown MCP tool whose argv is an unnarrowed lethal run",
    expect: "deny",
    event: {
      tool_name: "mcp__future__spawn",
      tool_input: { argv: ["lethal", "run", "--project", "."] },
    },
  },

  // ── Round 2: reviewer-demonstrated obfuscations, closed ───────────────────────────────────────
  {
    id: "15",
    name: "Bash git-bash mount form",
    expect: "deny",
    event: bash("echo x > /u/git/lethal/PROBE.txt"),
  },
  {
    id: "16",
    name: "Bash absolute `..` traversal",
    expect: "deny",
    event: bash("echo x > U:/Git/Other/../LethAL/PROBE.txt"),
  },
  {
    id: "17",
    name: "Bash quote-split path",
    expect: "deny",
    event: bash('echo x > U:/Git/Leth""AL/PROBE.txt'),
  },
  {
    id: "18",
    name: "Bash quote-split invocation",
    expect: "deny",
    event: bash('leth""al ru""n --project .'),
  },
  {
    id: "19",
    name: "generic backstop: LETHAL_ROOT split across two adjacent JSON fields",
    expect: "deny",
    event: { tool_name: "mcp__future__split", tool_input: { a: "u:/git/leth", b: "al/PROBE.txt" } },
  },
  {
    id: "20",
    name: "Write file_path with absolute `..` traversal",
    expect: "deny",
    event: write("U:/Git/Other/../LethAL/PROBE.txt"),
  },
  {
    id: "21",
    name: "Write file_path in git-bash mount form",
    expect: "deny",
    event: write("/u/git/lethal/PROBE.txt"),
  },
  {
    id: "22",
    name: "Bash --allow-large-run",
    expect: "deny",
    event: bash("lethal run --project . --only a --tests-only b --allow-large-run"),
  },
  {
    id: "23",
    name: "Bash --retry-stranded",
    expect: "deny",
    event: bash("lethal run --project . --only a --tests-only b --retry-stranded"),
  },
  {
    id: "24",
    name: "generic backstop: dangerous flag in an unknown MCP tool's argv",
    expect: "deny",
    event: {
      tool_name: "mcp__future__spawn",
      tool_input: {
        argv: ["lethal", "run", "--only", "a", "--tests-only", "b", "--allow-large-run"],
      },
    },
  },

  // ── Round 3: bare-relative traversal, closed for the write tools only ─────────────────────────
  {
    id: "25",
    name: "Write file_path bare relative `../LethAL/PROBE.txt` from the agent's real cwd",
    expect: "deny",
    event: write("../LethAL/PROBE.txt"),
  },

  // ── Round 4 (finding C2): the fence must not deny the agent's OWN workspace ───────────────────
  // `do-lethal` contains `lethal`, and `-` is a word boundary, so the old `\blethal\b` matched
  // inside it. Any command naming the workspace and containing the word "run" was denied.
  {
    id: "26",
    name: "C2: Bash `bun run` inside the agent's own workspace",
    expect: "allow",
    event: bash("cd U:/Git/do-lethal && bun run scripts/x.ts"),
  },
  {
    id: "27",
    name: "C2: Bash grep for the word `run` inside the workspace",
    expect: "allow",
    event: bash('cd U:/Git/do-lethal/Cloud && grep -rn "run" .'),
  },
  {
    id: "28",
    name: "C2: tier-(c) backstop — Grep tool over the workspace with pattern `run`",
    expect: "allow",
    event: { tool_name: "Grep", tool_input: { path: "U:/Git/do-lethal/Cloud", pattern: "run" } },
  },
  {
    id: "29",
    name: "C2: Write inside the agent's own workspace",
    expect: "allow",
    event: write("U:/Git/do-lethal/notes.md"),
  },
  {
    id: "30",
    name: "C2: `lethal run` with --only but NOT --tests-only (the branch case C never reached)",
    expect: "deny",
    event: bash('lethal run --project U:/Git/do-lethal/Cloud --only "Al/Codeunit/**"'),
  },
  {
    id: "31",
    name: "C2: `lethal run` with --tests-only but NOT --only",
    expect: "deny",
    event: bash('lethal run --project U:/Git/do-lethal/Cloud --tests-only "Src/**"'),
  },
  {
    id: "32",
    name: "C2: unnarrowed run via the VERSIONED binary filename (`lethal-0.1.0-alpha.1-...exe`)",
    expect: "deny",
    event: bash(
      "./build/lethal-0.1.0-alpha.1-windows-x64.exe run --project U:/Git/do-lethal/Cloud",
    ),
  },
  {
    id: "33",
    name: "C2: the campaign's real invocation, via the versioned binary, narrowed",
    expect: "allow",
    event: bash(
      `./build/lethal-0.1.0-alpha.1-windows-x64.exe ${NARROWED_RUN.slice("lethal ".length)}`,
    ),
  },
  {
    id: "34",
    name: "C2: workspace mentioned AND a genuine unnarrowed run in the same command",
    expect: "deny",
    event: bash("cd U:/Git/do-lethal && lethal run --project Cloud"),
  },

  // ── Allow cases carried from round 1 ─────────────────────────────────────────────────────────
  {
    id: "A",
    name: "Write inside the scratch dir",
    expect: "allow",
    event: write(`${SCRATCH}/notes.md`),
  },
  { id: "B", name: "Bash `ls -la`", expect: "allow", event: bash("ls -la") },
  {
    id: "C",
    name: "Bash properly-narrowed `lethal run`",
    expect: "allow",
    event: bash(NARROWED_RUN),
  },
  {
    id: "D",
    name: "serena find_symbol (read-only, not name-blocked)",
    expect: "allow",
    event: {
      tool_name: "mcp__plugin_serena_serena__find_symbol",
      tool_input: { name_path: "Foo" },
    },
  },
  {
    id: "E",
    name: "Read of a file in the scratch dir",
    expect: "allow",
    event: { tool_name: "Read", tool_input: { file_path: `${SCRATCH}/notes.md` } },
  },

  // ── Known gap and accepted residuals — expected ALLOW, on purpose ─────────────────────────────
  {
    id: "F",
    name: "[KNOWN GAP] Bash bare relative `../LethAL/PROBE.txt` (freeform shell text is not cwd-resolved)",
    expect: "allow",
    event: bash("echo x > ../LethAL/PROBE.txt"),
  },
  {
    id: "G",
    name: "[ACCEPTED RESIDUAL] command substitution in a path: `Leth$()AL`",
    expect: "allow",
    event: bash("echo x > U:/Git/Leth$()AL/PROBE.txt"),
  },
  {
    id: "H",
    name: "[ACCEPTED RESIDUAL] variable indirection in a path: `$A$B`",
    expect: "allow",
    event: bash("A=/u/git/leth; B=al; echo x > $A$B/PROBE.txt"),
  },
  {
    id: "I",
    name: "[ACCEPTED RESIDUAL] command substitution in a flag: `--allow-large-ru$()n`",
    expect: "allow",
    event: bash("lethal run --only a --tests-only b --allow-large-ru$()n"),
  },
  {
    id: "J",
    name: "[ACCEPTED RESIDUAL] command substitution in the invocation: `leth$()al ru$()n`",
    expect: "allow",
    event: bash("leth$()al ru$()n --project ."),
  },
];

describe("fence probe matrix", () => {
  for (const c of CASES) {
    test(`${c.id}: ${c.name} → ${c.expect}`, () => {
      const decision = evaluateFenceEvent(c.event, c.cwd ?? AGENT_CWD);
      expect(decision.decision).toBe(c.expect);
    });
  }

  test("case ids are unique", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });
});

const MATRIX_DOC = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "fixtures",
  "do-campaign",
  "fence-probe-matrix.md",
);

/**
 * The probe rows of `fence-probe-matrix.md`, as `id -> expected decision`.
 *
 * Two things this deliberately does NOT do, both of which were real holes in the first version of
 * the drift guard (`doc.includes("| <id> |")`):
 *
 *   1. **It reads the expectation, not just the id.** A row left in place with `deny` flipped to
 *      `allow` satisfied a presence check completely — and a stale expectation is precisely the rot
 *      this guard exists to prevent, one step later. A guard that reports fine while checking
 *      nothing is this project's signature bug wearing a test's clothes.
 *   2. **It is scoped to the matrix section.** The document has other tables whose rows also start
 *      `| <n> |` — the bypass history numbers its ROUNDS 1–4 — so `| 4 |` was satisfied by
 *      `## Bypass history` even with the probe row for case 4 deleted. The slice runs from
 *      `## The matrix` to the next `##` heading, and a row only counts if its LAST cell is exactly
 *      `allow` or `deny` (bold or not), which is the probe tables' shape and nothing else's.
 *
 * Throws rather than returning something plausible when the section is missing or a row repeats:
 * a drift guard that cannot find its own input must fail loudly, not pass vacuously.
 */
function parseMatrixDoc(doc: string): Map<string, "allow" | "deny"> {
  const heading = "## The matrix";
  const start = doc.indexOf(heading);
  if (start < 0) {
    throw new Error(
      `fence-probe-matrix.md: no "${heading}" section. The drift guard cannot tell probe tables from the document's other tables without it.`,
    );
  }
  const after = doc.indexOf("\n## ", start + heading.length);
  const section = after < 0 ? doc.slice(start) : doc.slice(start, after);

  const rows = new Map<string, "allow" | "deny">();
  for (const line of section.split("\n")) {
    const m = /^\|\s*([A-Za-z0-9]+)\s*\|.*\|\s*\*{0,2}(allow|deny)\*{0,2}\s*\|\s*$/.exec(line);
    if (m === null) continue;
    const [, id, expect] = m;
    if (id === undefined || expect === undefined) continue;
    if (rows.has(id)) {
      throw new Error(
        `fence-probe-matrix.md: two probe rows carry id ${id}. One of them is describing a case that does not exist.`,
      );
    }
    rows.set(id, expect === "allow" ? "allow" : "deny");
  }
  return rows;
}

/**
 * The finding this whole file answers was "the evidence is gitignored". A committed markdown table
 * that silently falls behind the executable matrix is the same failure one step later, so the two
 * are joined in both directions: every case here has a row asserting the SAME decision, and the
 * document holds no row for a case this file no longer has.
 */
describe("matrix doc and probe matrix do not drift", () => {
  test("every probe case has a row stating the same expected decision", async () => {
    const documented = parseMatrixDoc(await readFile(MATRIX_DOC, "utf8"));
    const wrong = CASES.filter((c) => documented.get(c.id) !== c.expect).map(
      (c) => `${c.id}: doc says ${documented.get(c.id) ?? "(no row)"}, test asserts ${c.expect}`,
    );
    expect(wrong).toEqual([]);
  });

  test("the document holds no orphan row for a case this file no longer has", async () => {
    const documented = parseMatrixDoc(await readFile(MATRIX_DOC, "utf8"));
    const ids = new Set(CASES.map((c) => c.id));
    expect([...documented.keys()].filter((id) => !ids.has(id))).toEqual([]);
  });

  test("the parsed rows are exactly the probe cases, one each", async () => {
    // Redundant with the two above only while both hold; it is what makes a silent parser
    // regression (a scoping change that suddenly swallows the bypass-history table, say) visible
    // as a count rather than as an absence of failures.
    const documented = parseMatrixDoc(await readFile(MATRIX_DOC, "utf8"));
    expect(documented.size).toBe(CASES.length);
  });
});

/**
 * The matrix above proves the RULES. These two prove the WIRING — that the committed hook script
 * still reads a `PreToolUse` event on stdin and answers in the shape Claude Code understands. A
 * pure-function test cannot see a broken shell, and a hook whose shell is broken fails OPEN.
 */
describe("fence-hook.ts (the shell)", () => {
  const HOOK = join(import.meta.dir, "..", "..", "..", "fixtures", "do-campaign", "fence-hook.ts");
  // A real directory that exists and is NOT under `U:/Git/LethAL` — the child's cwd has to be
  // spawnable, and spawning it from inside this worktree (which IS under LethAL) is the
  // topology error the old scratchpad harness kept making.
  const OUTSIDE_LETHAL = tmpdir();

  async function runHook(event: FenceEvent, cwd: string): Promise<unknown> {
    const proc = Bun.spawn(["bun", HOOK], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(JSON.stringify(event));
    await proc.stdin.end();
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0)
      throw new Error(`fence-hook exited ${code}: ${await new Response(proc.stderr).text()}`);
    return JSON.parse(out);
  }

  test("emits a well-formed deny for a write under LETHAL_ROOT", async () => {
    const decision = (await runHook(write("U:/Git/LethAL/PROBE.txt"), OUTSIDE_LETHAL)) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
    expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain("campaign fence");
  });

  test("emits a bare {} for the agent's own workspace (finding C2, end to end)", async () => {
    expect(
      await runHook(bash("cd U:/Git/do-lethal && bun run scripts/x.ts"), OUTSIDE_LETHAL),
    ).toEqual({});
  });
});
