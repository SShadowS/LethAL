/**
 * Rung-3 fence for the DO campaign's `claude -p` agent.
 *
 * FIX ROUND 3 (task-4-report.md documents the full history, including rounds 1 and 2). Round 2's
 * hardening was itself defeated by a second adversarial review, using shell substitution this text
 * matcher cannot see: `Leth$()AL`, `A=/u/git/leth; B=al; echo x > $A$B/x`, `--allow-large-ru$()n`.
 * The campaign owner made a threat-model decision at that point, and it governs everything below:
 *
 *   **The threat model for rung 3 is ACCIDENT, not adversary.** The agent is a Claude agent doing
 *   a legitimate measurement task with no motive to evade a fence it isn't even told about. Three
 *   rounds produced three bypass classes of the same kind — text-matching a Bash command string is
 *   not a parser, and only OS-level isolation (a container, a VM, a restricted account) would
 *   actually hold against deliberate evasion, which this campaign does not have. So round 3 does
 *   NOT attempt to close the `$()`/`$VAR` class. It is the accepted residual, tested and left open
 *   on purpose (see the probe matrix in task-4-report.md, cases marked "accepted residual") —
 *   closing it would just produce a fourth bypass class next review, at real cost, for a threat
 *   this design was never trying to hold against in the first place.
 *
 * What guarantees what, restated plainly (see fixtures/do-campaign/README.md's "threat model" and
 * "which guarantee comes from where" sections for the full, honest version — this file's job is to
 * not contradict that document):
 *
 *   Rule 1 (no writes under U:/Git/LethAL): the rung-3 agent's workspace does not CONTAIN the
 *   LethAL source tree (it gets the DO worktree plus the standalone compiled binary,
 *   build/lethal-0.1.0-alpha.1-windows-x64.exe, instead) — this removes the ACCIDENTAL-reference
 *   path, which is the actual threat model. It does NOT make the tree unreachable: `U:/Git/LethAL`
 *   and the DO worktree are sibling directories on the same drive, same filesystem, same OS
 *   account, with no container/VM/ACL boundary anywhere in this design, so any absolute or
 *   resolvable path still reaches it. This hook is what stands in that gap, and it is demonstrably
 *   defeatable by deliberate shell obfuscation — it is not claimed to be more than that.
 *
 *   Rule 2 (no unnarrowed run): `assertRunSizeAcceptable` (packages/runner/src/orchestrator.ts,
 *   `LARGE_RUN_MUTANT_THRESHOLD = 1_000`) is a pre-flight REFUSAL in the product itself, on by
 *   default, before anything publishes — an unnarrowed DO run (19,832 sites) is refused by
 *   `lethal` regardless of this hook. `--allow-large-run` is precisely the flag that disables that
 *   refusal, and `--retry-stranded` (R53) opts out of skipping a mutant that stranded a prior run's
 *   tier; this hook denies both by literal-text match, which shell substitution can defeat (see
 *   above) — the product's own refusal is what actually holds when it does. The original
 *   --only/--tests-only requirement is kept too, unchanged.
 *
 * `preflight.ts` closes the fail-open half (a hook that can't run gives no fence, silently) and,
 * as of round 3, no longer hangs forever if the configured hook itself never answers.
 *
 * Three tiers, checked in order, unchanged in shape since round 1 (see task-4-report.md for the
 * round-1 MCP-tool-bypass rationale behind tier (b) and the generic backstop in tier (c)):
 *   (a) Precise rules for Write/Edit/NotebookEdit's file_path and Bash's command text.
 *   (b) A fixed name-block for serena MCP tools whose target isn't visible in their own tool_input.
 *   (c) A generic backstop for everything else.
 */
import { resolve } from "node:path";

const LETHAL_ROOT = "u:/git/lethal";

// `lethal ... run ...` without both flags. [\s\S] (any char including newline) stands in for a
// dotAll flag so the match survives "lethal" and "run" landing on different lines of a
// multi-line Bash script; /i so a differently-cased invocation still hits.
const LETHAL_RUN_PATTERN = /\blethal\b[\s\S]*\brun\b/i;
const HAS_ONLY_PATTERN = /--only\b/i;
const HAS_TESTS_ONLY_PATTERN = /--tests-only\b/i;

// R48/R53: the two flags that opt out of `lethal`'s own pre-flight refusals. No innocent idiom
// produces these by accident, so their mere presence anywhere is denied unconditionally.
const DANGEROUS_RUN_FLAGS: ReadonlyArray<{ readonly flag: string; readonly pattern: RegExp }> = [
  { flag: "--allow-large-run", pattern: /--allow-large-run\b/i },
  { flag: "--retry-stranded", pattern: /--retry-stranded\b/i },
];

// serena MCP tools whose effective write/execute/activation target is not reliably visible in
// their own tool_input (see task-4-report.md, fix round 1) — denied unconditionally.
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

// Defeats `U:/Git/Leth""AL/PROBE.txt` / `leth""al ru""n` — the shell removes empty-quote pairs
// and concatenates what's left into one token; stripping the quote characters here reconstructs
// exactly that same text before any pattern runs.
function stripQuotes(s: string): string {
  return s.replace(/["']/g, "");
}

function extractTokens(text: string): string[] {
  return text.split(/[\s|&;()<>]+/).filter((t) => t.length > 0);
}

// Only a token that is ALREADY absolute (drive-letter form) or the git-bash `/<drive>/` mount
// form gets real path resolution — deliberately excludes bare relative tokens; see the file
// header's honesty check for why.
function looksAbsoluteOrMounted(token: string): boolean {
  return /^[a-zA-Z]:/.test(token) || /^\/[a-zA-Z](\/|$)/.test(token);
}

function resolveMountForm(p: string): string {
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (m === null) return p;
  const [, drive, rest] = m;
  return `${drive}:${rest ?? "/"}`;
}

function normalizePathLike(token: string): string {
  const mounted = resolveMountForm(token);
  let resolved: string;
  try {
    resolved = resolve(mounted);
  } catch {
    resolved = mounted;
  }
  return normalize(resolved);
}

/**
 * Does any of `texts` reference LETHAL_ROOT? Three passes, cheapest first:
 *   1. plain substring, backslash/case normalized only;
 *   2. per-token real path resolution (collapses "..", rewrites the mount form) for tokens that
 *      are already absolute or mount-form — closes `U:/Git/Other/../LethAL/x` and `/u/git/lethal/x`.
 *      `resolveBareRelative` additionally resolves a token with NO drive letter and no mount
 *      prefix against the hook's own cwd — see the call site for why this is only ever passed
 *      `true` for Write/Edit/NotebookEdit's `file_path`, never for Bash's freeform command text;
 *   3. pairwise-adjacent concatenation across `texts` — closes a value deliberately split across
 *      two adjacent fields (e.g. {"a":"u:/git/leth","b":"al/PROBE.txt"}), which a per-string scan
 *      or a separator-joined scan both miss.
 */
function pathHits(
  texts: readonly string[],
  options?: { readonly resolveBareRelative?: boolean },
): boolean {
  const resolveBareRelative = options?.resolveBareRelative ?? false;
  const normalized = texts.map(normalize);
  if (normalized.join("\n").includes(LETHAL_ROOT)) return true;
  for (const t of texts) {
    for (const token of extractTokens(t)) {
      const shouldResolve = resolveBareRelative || looksAbsoluteOrMounted(token);
      if (shouldResolve && normalizePathLike(token).includes(LETHAL_ROOT)) {
        return true;
      }
    }
  }
  for (let i = 0; i + 1 < normalized.length; i++) {
    const a = normalized[i];
    const b = normalized[i + 1];
    if (a !== undefined && b !== undefined && `${a}${b}`.includes(LETHAL_ROOT)) return true;
  }
  return false;
}

function findDangerousRunFlag(text: string): string | null {
  for (const { flag, pattern } of DANGEROUS_RUN_FLAGS) {
    if (pattern.test(text)) return flag;
  }
  return null;
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
  // (a) precise: the write target is this field, full stop. resolveBareRelative: true here
  // because these tools' file_path is session-scoped, not agent-`cd`-scoped — there is no
  // freeform shell for the agent to have moved the effective base directory out from under this
  // hook's own process.cwd() the way there is for Bash, so resolving a bare relative path here
  // doesn't carry Bash's false-denial risk on a legitimate relative glob.
  const p = stripQuotes(String(input.file_path ?? ""));
  if (pathHits([p], { resolveBareRelative: true })) {
    deny(`campaign fence: writes under ${LETHAL_ROOT} are refused — work in the worktree.`);
  }
} else if (tool === "Bash") {
  // (a) precise: all three checks apply to the one command string.
  const cmd = stripQuotes(String(input.command ?? ""));
  if (pathHits([cmd])) {
    deny(
      `campaign fence: Bash commands mentioning ${LETHAL_ROOT} are refused — work in the worktree (this also denies harmless reads of that path; the agent has no legitimate reason to touch it at all).`,
    );
  }
  const dangerousFlag = findDangerousRunFlag(cmd);
  if (dangerousFlag !== null) {
    deny(
      `campaign fence: Bash commands passing ${dangerousFlag} are refused — that flag opts out of lethal's own pre-flight refusal (assertRunSizeAcceptable / LARGE_RUN_MUTANT_THRESHOLD, or the stranded-mutant skip), which is the actual guarantee behind this rule now. See fixtures/do-campaign/README.md.`,
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
  const rawStrings: string[] = [];
  collectStrings(input, rawStrings);
  const strings = rawStrings.map(stripQuotes);
  if (pathHits(strings)) {
    deny(
      `campaign fence: ${tool || "(unnamed tool)"} references ${LETHAL_ROOT} — refused (generic backstop; the agent has no legitimate reason to touch that path).`,
    );
  }
  const haystack = strings.join("\n");
  if (violatesLethalRun(haystack)) {
    deny(
      `campaign fence: ${tool || "(unnamed tool)"} appears to invoke \`lethal run\` without both --only and --tests-only — refused (generic backstop).`,
    );
  }
  const dangerousFlag = findDangerousRunFlag(haystack);
  if (dangerousFlag !== null) {
    deny(
      `campaign fence: ${tool || "(unnamed tool)"} appears to pass ${dangerousFlag} — refused (generic backstop; opts out of lethal's own pre-flight refusal).`,
    );
  }
}

console.log(JSON.stringify({}));
