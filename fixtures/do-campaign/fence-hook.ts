/**
 * Rung-3 fence for the DO campaign's `claude -p` agent.
 *
 * Two rules, both from the spec's §Fences:
 *   1. No writes under U:/Git/LethAL — the agent works in the worktree, never in the tool.
 *   2. No `lethal run` without BOTH --only and --tests-only — an unnarrowed run costs days
 *      (R48: 19,832 sites) and can wedge the tier for everyone.
 *
 * Note the tension rule 2 creates, recorded in the spec: --tests-only selects TESTS and CAN
 * change a verdict (R45), so a kill claimed under narrowing may be an artifact. The red-check
 * at rung 3 is what catches that; this hook only bounds cost.
 *
 * FIX ROUND 1 (task-4-report.md documents the gaps this closes and how each was probed). The
 * settings.json matcher is now "*" — every tool call reaches this script, not just
 * Write/Edit/NotebookEdit/Bash, because a name-restricted matcher let confirmed MCP tools
 * (serena's execute_shell_command, create_text_file) bypass the fence entirely. Three tiers,
 * checked in order:
 *
 *   (a) Precise rules for the four tools whose write target is unambiguous from their own
 *       tool_input: Write/Edit/NotebookEdit's file_path, Bash's command text.
 *   (b) A fixed name-block for MCP tools whose write target is NOT reliably visible in their
 *       own tool_input, so no content scan can catch them: serena's file/symbol mutators
 *       resolve `relative_path` against whichever project `activate_project` last activated in
 *       THIS session, so e.g. create_text_file({relative_path: "PROBE.txt"}) carries no
 *       LETHAL_ROOT-looking string anywhere for tier (c) to find. `activate_project` itself is
 *       blocked too, because it can target a registered project by short NAME rather than by
 *       path, which a path substring scan also can't see. serena's memory tools
 *       (write/edit/delete/rename_memory) get the same treatment for the same reason.
 *   (c) A generic backstop for everything else (unknown/future MCP tools, Read/Grep/Glob/Task/
 *       etc.): walk every string value in tool_input and deny if the LETHAL_ROOT path appears
 *       anywhere, or if a `lethal run` invocation lacking both flags appears anywhere.
 *
 * Bias throughout, per instruction: prefer a false denial over a false allow. A wrongly-denied
 * agent asks for guidance and moves on; a wrongly-allowed one corrupts the tool it is being
 * measured with, or burns days of live BC time. Concretely this means:
 *   - the write check is `.includes(LETHAL_ROOT)`, not `.startsWith`, so an embedded or
 *     non-absolute reference still gets caught;
 *   - the Bash rule denies on ANY mention of LETHAL_ROOT, not just an obvious write construct —
 *     this also denies harmless reads of that path, which is the intended trade: the rung-3
 *     agent has no legitimate reason to touch U:/Git/LethAL for any purpose, so nothing is lost;
 *   - the `lethal`+`run` match now spans newlines ([\s\S] instead of ".") and is case-insensitive,
 *     so a multi-line script that puts the two words on separate lines, or a differently-cased
 *     invocation, is still caught.
 *
 * Verified NOT to false-positive on a legitimate campaign invocation: the real worktree is
 * `U:/Git/do-lethal` (a sibling checkout, per the spec), and the literal substring
 * "u:/git/lethal" does not occur inside "u:/git/do-lethal" — there is a "do-" between "git/" and
 * "lethal" — so `--project U:/Git/do-lethal/Cloud ...` is not caught by the LETHAL_ROOT scan.
 */
const LETHAL_ROOT = "u:/git/lethal";

// `lethal ... run ...` without both flags. [\s\S] (any char including newline) stands in for a
// dotAll flag so the match survives "lethal" and "run" landing on different lines of a
// multi-line Bash script; /i so a differently-cased invocation still hits.
const LETHAL_RUN_PATTERN = /\blethal\b[\s\S]*\brun\b/i;
const HAS_ONLY_PATTERN = /--only\b/i;
const HAS_TESTS_ONLY_PATTERN = /--tests-only\b/i;

// serena MCP tools whose effective write/execute/activation target is not reliably visible in
// their own tool_input (see the file header) — denied unconditionally, regardless of content.
const ALWAYS_DENY_TOOLS = new Set([
  "mcp__plugin_serena_serena__execute_shell_command",
  "mcp__plugin_serena_serena__create_text_file",
  "mcp__plugin_serena_serena__replace_content",
  "mcp__plugin_serena_serena__replace_in_files",
  "mcp__plugin_serena_serena__insert_after_symbol",
  "mcp__plugin_serena_serena__insert_before_symbol",
  "mcp__plugin_serena_serena__rename_symbol",
  "mcp__plugin_serena_serena__safe_delete_symbol",
  "mcp__plugin_serena_serena__activate_project",
  "mcp__plugin_serena_serena__write_memory",
  "mcp__plugin_serena_serena__edit_memory",
  "mcp__plugin_serena_serena__delete_memory",
  "mcp__plugin_serena_serena__rename_memory",
]);

interface HookEvent {
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
}

function deny(reason: string): never {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function normalize(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}

/** Collects every string leaf value out of an arbitrarily-nested tool_input, for the tier-(c) backstop. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

function violatesLethalRun(haystack: string): boolean {
  if (!LETHAL_RUN_PATTERN.test(haystack)) return false;
  return !(HAS_ONLY_PATTERN.test(haystack) && HAS_TESTS_ONLY_PATTERN.test(haystack));
}

const raw = await Bun.stdin.text();
const event = JSON.parse(raw) as HookEvent;
const tool = event.tool_name ?? "";
const input = event.tool_input ?? {};

if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
  // (a) precise: the write target is this field, full stop.
  const p = normalize(String(input.file_path ?? ""));
  if (p.includes(LETHAL_ROOT)) {
    deny(`campaign fence: writes under ${LETHAL_ROOT} are refused — work in the worktree.`);
  }
} else if (tool === "Bash") {
  // (a) precise: both rules apply to the one command string.
  const cmd = String(input.command ?? "");
  if (normalize(cmd).includes(LETHAL_ROOT)) {
    deny(
      `campaign fence: Bash commands mentioning ${LETHAL_ROOT} are refused — work in the worktree (this also denies harmless reads of that path; the agent has no legitimate reason to touch it at all).`,
    );
  }
  if (violatesLethalRun(cmd)) {
    deny(
      "campaign fence: `lethal run` requires BOTH --only and --tests-only in this session " +
        "(an unnarrowed DO run schedules 19,832 sites and can wedge the environment).",
    );
  }
} else if (ALWAYS_DENY_TOOLS.has(tool)) {
  // (b) name-block: this tool's own tool_input cannot be trusted to reveal its real target.
  deny(
    `campaign fence: ${tool} is refused unconditionally — its effective file/shell target is not verifiable from its own tool_input (serena resolves relative paths and activation targets against session state this hook cannot see). Use Write/Edit/Bash instead.`,
  );
} else {
  // (c) generic backstop: unknown/future MCP tools, Read/Grep/Glob/Task/etc.
  const strings: string[] = [];
  collectStrings(input, strings);
  const normalizedHaystack = strings.map(normalize).join("\n");
  if (normalizedHaystack.includes(LETHAL_ROOT)) {
    deny(
      `campaign fence: ${tool || "(unnamed tool)"} references ${LETHAL_ROOT} — refused (generic backstop; the agent has no legitimate reason to touch that path).`,
    );
  }
  const rawHaystack = strings.join("\n");
  if (violatesLethalRun(rawHaystack)) {
    deny(
      `campaign fence: ${tool || "(unnamed tool)"} appears to invoke \`lethal run\` without both --only and --tests-only — refused (generic backstop).`,
    );
  }
}

console.log(JSON.stringify({}));
