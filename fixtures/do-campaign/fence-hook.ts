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
 */
const LETHAL_ROOT = "u:/git/lethal";

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

const raw = await Bun.stdin.text();
const event = JSON.parse(raw) as HookEvent;
const tool = event.tool_name ?? "";
const input = event.tool_input ?? {};

if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
  const p = String(input.file_path ?? "")
    .replace(/\\/g, "/")
    .toLowerCase();
  if (p.startsWith(LETHAL_ROOT)) {
    deny(`campaign fence: writes under ${LETHAL_ROOT} are refused — work in the worktree.`);
  }
}

if (tool === "Bash") {
  const cmd = String(input.command ?? "");
  if (/\blethal\b.*\brun\b/.test(cmd)) {
    const hasOnly = /--only\b/.test(cmd);
    const hasTestsOnly = /--tests-only\b/.test(cmd);
    if (!hasOnly || !hasTestsOnly) {
      deny(
        "campaign fence: `lethal run` requires BOTH --only and --tests-only in this session " +
          "(an unnarrowed DO run schedules 19,832 sites and can wedge the environment).",
      );
    }
  }
}

console.log(JSON.stringify({}));
