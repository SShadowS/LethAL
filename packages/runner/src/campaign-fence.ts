/**
 * The DECISION half of the rung-3 agent fence. The hook itself is
 * `fixtures/do-campaign/fence-hook.ts` — a thin stdin/stdout shell over `evaluateFenceEvent`.
 *
 * Why the split (same reason as `compile-only-args.ts`): the fence's rules are the campaign's
 * safety argument, so they need a committed test that runs in the ordinary `bun test` suite and
 * gets typechecked by `tsc --build`. `fixtures/` is outside every package's project graph, and a
 * hook that reads stdin at module scope can only be probed by spawning it — which is slow, and
 * worse, cannot vary the process cwd cheaply (two of the rules resolve relative paths against it).
 * With the logic pure and `cwd` an argument, the whole probe matrix is a fast unit test:
 * `packages/runner/tests/campaign-fence.test.ts`, mirrored for humans in
 * `fixtures/do-campaign/fence-probe-matrix.md`.
 *
 * THREAT MODEL (decided by the campaign owner 2026-08-04, and it governs everything below):
 * **accident, not adversary.** Three hardening rounds produced three bypass classes of the same
 * kind — text-matching a Bash command string is not a parser — ending with `--allow-large-ru$()n`,
 * stock bash that defeats the one rule that matters most. Shell substitution (`$()`, `$VAR`) is
 * therefore an ACCEPTED RESIDUAL: tested, documented, deliberately not closed, because only
 * OS-level isolation (a container, a VM, a restricted account) would actually hold against
 * deliberate evasion and this campaign does not have that. See
 * `fixtures/do-campaign/fence-probe-matrix.md` §"Accepted residuals" and README.md's threat model.
 *
 * What is actually load-bearing, restated so this file cannot be read as claiming more:
 *   - No writes under `U:/Git/LethAL`: the agent's workspace does not CONTAIN the LethAL source
 *     tree, which removes the ACCIDENTAL-reference path. It does NOT make the tree unreachable —
 *     `U:/Git/LethAL` and the DO worktree are siblings on one drive, one account, no boundary.
 *   - No unnarrowed run: `assertRunSizeAcceptable` (`orchestrator.ts`,
 *     `LARGE_RUN_MUTANT_THRESHOLD = 1_000`) is a default-on pre-flight refusal in the product
 *     itself. That is the real guarantee; the rules here are defence in depth around it.
 */
import { resolve } from "node:path";

export const LETHAL_ROOT = "u:/git/lethal";

/**
 * `lethal ... run ...` — the invocation shape, matched loosely on purpose.
 *
 * `[\s\S]` (any char including newline) stands in for a dotAll flag so the match survives
 * "lethal" and "run" landing on different lines of a multi-line Bash script; `/i` so a
 * differently-cased invocation still hits.
 *
 * The leading `(?<![\w-])` is load-bearing and was a REAL BUG when it was a bare `\b`: `-` is a
 * word boundary, so `\blethal\b` matched inside `do-lethal` — the name of the agent's OWN
 * workspace (`U:/Git/do-lethal`). Every command that mentioned its own worktree and contained the
 * word "run" anywhere (`bun run`, `grep -rn "run"`, a path with `run` in it) was denied with
 * "`lethal run` requires BOTH --only and --tests-only". That is worse than friction on this
 * campaign: plan Task 8 step 4 files a roadmap row for every agent confusion, so a fence denying
 * the agent's own workspace would manufacture the very signal rung 3 exists to measure.
 *
 * The trailing side stays `\b`, NOT `(?![\w-])`, and that asymmetry is deliberate: the rung-3
 * agent invokes the standalone binary by its versioned filename,
 * `lethal-0.1.0-alpha.1-windows-x64.exe`. A trailing `(?![\w-])` would refuse to match a hyphen
 * after "lethal" and would therefore switch this rule OFF for the exact invocation form the
 * campaign uses — a silent fail-open on the campaign's own happy path. Probe cases 26–29 pin
 * both directions.
 */
const LETHAL_RUN_PATTERN = /(?<![\w-])lethal\b[\s\S]*\brun\b/i;
const HAS_ONLY_PATTERN = /--only\b/i;
const HAS_TESTS_ONLY_PATTERN = /--tests-only\b/i;

// R48/R53: the two flags that opt out of `lethal`'s own pre-flight refusals. No innocent idiom
// produces these by accident, so their mere presence anywhere is denied unconditionally.
const DANGEROUS_RUN_FLAGS: ReadonlyArray<{ readonly flag: string; readonly pattern: RegExp }> = [
  { flag: "--allow-large-run", pattern: /--allow-large-run\b/i },
  { flag: "--retry-stranded", pattern: /--retry-stranded\b/i },
];

/**
 * serena MCP tools whose effective write/execute/activation target is not reliably visible in
 * their own `tool_input` (fix round 1) — denied unconditionally.
 */
export const ALWAYS_DENY_TOOLS: ReadonlySet<string> = new Set([
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

export interface FenceEvent {
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
}

export type FenceDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: string };

function deny(reason: string): FenceDecision {
  return { decision: "deny", reason };
}

const ALLOW: FenceDecision = { decision: "allow" };

function normalize(s: string): string {
  return s.replace(/\\/g, "/").toLowerCase();
}

/**
 * Defeats `U:/Git/Leth""AL/PROBE.txt` / `leth""al ru""n` — the shell removes empty-quote pairs and
 * concatenates what's left into one token; stripping the quote characters here reconstructs
 * exactly that same text before any pattern runs.
 */
function stripQuotes(s: string): string {
  return s.replace(/["']/g, "");
}

function extractTokens(text: string): string[] {
  return text.split(/[\s|&;()<>]+/).filter((t) => t.length > 0);
}

/**
 * Only a token that is ALREADY absolute (drive-letter form) or the git-bash `/<drive>/` mount form
 * gets real path resolution — deliberately excludes bare relative tokens in Bash text; see
 * `pathHits`'s `resolveBareRelative` option for the split.
 */
function looksAbsoluteOrMounted(token: string): boolean {
  return /^[a-zA-Z]:/.test(token) || /^\/[a-zA-Z](\/|$)/.test(token);
}

function resolveMountForm(p: string): string {
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
  if (m === null) return p;
  const [, drive, rest] = m;
  return `${drive}:${rest ?? "/"}`;
}

function normalizePathLike(token: string, cwd: string): string {
  const mounted = resolveMountForm(token);
  let resolved: string;
  try {
    resolved = resolve(cwd, mounted);
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
 *      prefix against `cwd` — see the call site for why this is only ever passed `true` for
 *      Write/Edit/NotebookEdit's `file_path`, never for Bash's freeform command text;
 *   3. pairwise-adjacent concatenation across `texts` — closes a value deliberately split across
 *      two adjacent fields (e.g. `{"a":"u:/git/leth","b":"al/PROBE.txt"}`), which a per-string
 *      scan or a separator-joined scan both miss.
 */
function pathHits(
  texts: readonly string[],
  cwd: string,
  options?: { readonly resolveBareRelative?: boolean },
): boolean {
  const resolveBareRelative = options?.resolveBareRelative ?? false;
  const normalized = texts.map(normalize);
  if (normalized.join("\n").includes(LETHAL_ROOT)) return true;
  for (const t of texts) {
    for (const token of extractTokens(t)) {
      const shouldResolve = resolveBareRelative || looksAbsoluteOrMounted(token);
      if (shouldResolve && normalizePathLike(token, cwd).includes(LETHAL_ROOT)) {
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

/**
 * Three tiers, checked in order, unchanged in shape since round 1:
 *   (a) Precise rules for Write/Edit/NotebookEdit's `file_path` and Bash's command text.
 *   (b) A fixed name-block for serena MCP tools whose target isn't visible in their own tool_input.
 *   (c) A generic backstop for everything else (unknown/future MCP tools, Read/Grep/Glob/Task/...).
 *
 * `cwd` is the directory relative paths resolve against — the hook passes `process.cwd()`; the
 * probe matrix passes whatever topology a case is about (the real rung-3 agent's cwd is
 * `U:/Git/do-lethal`, a SIBLING of `U:/Git/LethAL`, never a descendant, and a probe run from
 * inside this repo would otherwise measure this repo's dev layout instead of the campaign's).
 */
export function evaluateFenceEvent(event: FenceEvent, cwd: string): FenceDecision {
  const tool = event.tool_name ?? "";
  const input = event.tool_input ?? {};

  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
    // (a) precise: the write target is this field, full stop. resolveBareRelative: true here
    // because these tools' file_path is session-scoped, not agent-`cd`-scoped — there is no
    // freeform shell for the agent to have moved the effective base directory out from under this
    // hook's own process.cwd() the way there is for Bash, so resolving a bare relative path here
    // doesn't carry Bash's false-denial risk on a legitimate relative glob.
    const p = stripQuotes(String(input.file_path ?? ""));
    if (pathHits([p], cwd, { resolveBareRelative: true })) {
      return deny(
        `campaign fence: writes under ${LETHAL_ROOT} are refused — work in the worktree.`,
      );
    }
    return ALLOW;
  }

  if (tool === "Bash") {
    // (a) precise: all three checks apply to the one command string.
    const cmd = stripQuotes(String(input.command ?? ""));
    if (pathHits([cmd], cwd)) {
      return deny(
        `campaign fence: Bash commands mentioning ${LETHAL_ROOT} are refused — work in the worktree (this also denies harmless reads of that path; the agent has no legitimate reason to touch it at all).`,
      );
    }
    const dangerousFlag = findDangerousRunFlag(cmd);
    if (dangerousFlag !== null) {
      return deny(
        `campaign fence: Bash commands passing ${dangerousFlag} are refused — that flag opts out of lethal's own pre-flight refusal (assertRunSizeAcceptable / LARGE_RUN_MUTANT_THRESHOLD, or the stranded-mutant skip), which is the actual guarantee behind this rule now. See fixtures/do-campaign/README.md.`,
      );
    }
    if (violatesLethalRun(cmd)) {
      return deny(
        "campaign fence: `lethal run` requires BOTH --only and --tests-only in this session " +
          "(an unnarrowed DO run schedules 19,832 sites and can wedge the environment).",
      );
    }
    return ALLOW;
  }

  if (ALWAYS_DENY_TOOLS.has(tool)) {
    // (b) name-block: this tool's own tool_input cannot be trusted to reveal its real target.
    return deny(
      `campaign fence: ${tool} is refused unconditionally — its effective file/shell target is not verifiable from its own tool_input (serena resolves relative paths and activation targets against session state this hook cannot see). Use Write/Edit/Bash instead.`,
    );
  }

  // (c) generic backstop.
  const rawStrings: string[] = [];
  collectStrings(input, rawStrings);
  const strings = rawStrings.map(stripQuotes);
  if (pathHits(strings, cwd)) {
    return deny(
      `campaign fence: ${tool || "(unnamed tool)"} references ${LETHAL_ROOT} — refused (generic backstop; the agent has no legitimate reason to touch that path).`,
    );
  }
  const haystack = strings.join("\n");
  if (violatesLethalRun(haystack)) {
    return deny(
      `campaign fence: ${tool || "(unnamed tool)"} appears to invoke \`lethal run\` without both --only and --tests-only — refused (generic backstop).`,
    );
  }
  const dangerousFlag = findDangerousRunFlag(haystack);
  if (dangerousFlag !== null) {
    return deny(
      `campaign fence: ${tool || "(unnamed tool)"} appears to pass ${dangerousFlag} — refused (generic backstop; opts out of lethal's own pre-flight refusal).`,
    );
  }
  return ALLOW;
}
