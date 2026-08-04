/**
 * Rung-3 fence preflight — the fix for the fail-open finding from fix round 2's adversarial
 * review.
 *
 * Claude Code's PreToolUse hooks FAIL OPEN: only exit code 2 (or a well-formed JSON deny on
 * stdout) blocks a tool call. A hook subprocess that fails to spawn, crashes, emits malformed
 * JSON, or — the exact case that shipped — is named by a settings.json pointing at a script that
 * does not exist yet, all let the tool call proceed SILENTLY. There is no error, no denial, no
 * signal at all that the fence was never there. `fixtures/do-campaign/settings.json` names the
 * MAIN-checkout path to `fence-hook.ts`, which does not exist until this branch merges — so
 * launching rung 3 from a pre-merge checkout gives NO fence, and nothing about the launch would
 * say so.
 *
 * This script is what makes that impossible to miss: it reads the SAME settings file rung 3 will
 * actually use, extracts every configured PreToolUse hook command from it (never hardcodes a
 * path — a wrong path in settings.json is exactly the failure mode this exists to catch), runs
 * each one exactly as the harness would (a JSON event piped to the command on stdin, the
 * command's own stdout read back), feeds it a small set of probes whose correct answer is already
 * known — two that must be denied and one that must be ALLOWED — and exits non-zero the moment
 * any of them answers differently. Rung 3 must not start unless this exits 0.
 *
 * FIX ROUND 3: a hook command that reads stdin and then awaits something that never resolves
 * (a bug in the configured hook itself, not in this script) used to hang this preflight forever —
 * `proc.exited` never resolves, nothing prints, a launcher doing
 * `bun preflight.ts settings.json && start-rung-3` just sits there with zero diagnostic. Each
 * probe now races against `HOOK_TIMEOUT_MS`; hitting it kills the child and fails loudly, because
 * a hook that never answers is itself a fail-open case — this script (and Claude Code) cannot
 * distinguish "still thinking" from "will never respond," so it must be treated as no fence.
 *
 * Usage: bun fixtures/do-campaign/preflight.ts <settings-file-path>
 */

const HOOK_TIMEOUT_MS = 10_000;

interface HookCommandEntry {
  readonly type?: string;
  readonly command?: string;
}

interface PreToolUseEntry {
  readonly matcher?: string;
  readonly hooks?: ReadonlyArray<HookCommandEntry>;
}

interface SettingsShape {
  readonly hooks?: {
    readonly PreToolUse?: ReadonlyArray<PreToolUseEntry>;
  };
}

// Probes whose answer we already know. Two must be DENIED — one exercises rule 1 (the write
// fence), one the escape-hatch flag rule — and one must be ALLOWED. If the configured hook command
// can't be run at all, or answers anything other than the known-correct decision, that is the
// scenario this script exists to catch.
//
// The allow probe is not symmetry for its own sake. A hook that denies everything passes a
// deny-only preflight and then makes rung 3 unrunnable, one refused tool call at a time — and
// under plan Task 8 step 4 each of those refusals looks like an agent confusion worth a roadmap
// row. That is exactly what round 4's `\blethal\b`-matches-`do-lethal` bug did, and a deny-only
// preflight could not see it.
const KNOWN_PROBES: ReadonlyArray<{
  readonly label: string;
  readonly expect: "deny" | "allow";
  readonly event: Record<string, unknown>;
}> = [
  {
    label: "Write under U:/Git/LethAL",
    expect: "deny",
    event: {
      tool_name: "Write",
      tool_input: { file_path: "U:/Git/LethAL/PROBE.txt", content: "x" },
    },
  },
  {
    label: "Bash `lethal run --allow-large-run` (opts out of the product's own size refusal)",
    expect: "deny",
    event: {
      tool_name: "Bash",
      tool_input: {
        command:
          'lethal run --project U:/Git/do-lethal/Cloud --only "x" --tests-only "y" --allow-large-run',
      },
    },
  },
  {
    label: "Bash inside the agent's OWN workspace (`cd U:/Git/do-lethal && bun run ...`)",
    expect: "allow",
    event: {
      tool_name: "Bash",
      tool_input: { command: "cd U:/Git/do-lethal && bun run scripts/x.ts" },
    },
  },
];

function fail(message: string): never {
  console.error(`PREFLIGHT FAILED: ${message}`);
  console.error(
    "Rung 3 MUST NOT start. This is the exact fail-open scenario this script exists to catch.",
  );
  process.exit(1);
}

const settingsPath = process.argv[2];
if (settingsPath === undefined || settingsPath.length === 0) {
  fail("usage: bun preflight.ts <settings-file-path>");
}

const settingsFile = Bun.file(settingsPath);
if (!(await settingsFile.exists())) {
  fail(`settings file does not exist: ${settingsPath}`);
}

let settings: SettingsShape;
try {
  settings = JSON.parse(await settingsFile.text()) as SettingsShape;
} catch (err) {
  fail(`settings file is not valid JSON: ${settingsPath} (${String(err)})`);
}

const preToolUse = settings.hooks?.PreToolUse;
if (preToolUse === undefined || preToolUse.length === 0) {
  fail(`settings file has no hooks.PreToolUse entries: ${settingsPath}`);
}

const commands: string[] = [];
for (const entry of preToolUse) {
  for (const h of entry.hooks ?? []) {
    if (h.type !== "command" || h.command === undefined || h.command.length === 0) {
      fail(`malformed PreToolUse hook entry in ${settingsPath}: ${JSON.stringify(h)}`);
    }
    commands.push(h.command);
  }
}
if (commands.length === 0) {
  fail(`settings file's hooks.PreToolUse has no command hooks: ${settingsPath}`);
}

type ProbeOutcome =
  | {
      readonly kind: "completed";
      readonly stdout: string;
      readonly stderr: string;
      readonly exitCode: number;
    }
  | { readonly kind: "timeout" };

async function runProbe(command: string, event: Record<string, unknown>): Promise<ProbeOutcome> {
  // Run the hook command through a shell, the same way Claude Code invokes a "command"-type
  // hook — not a naive whitespace split, so quoting/env-var expansion in the command string
  // (e.g. "$CLAUDE_PROJECT_DIR/...") behaves the same way it would for the real harness.
  const proc = Bun.spawn(["bash", "-c", command], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(event));
  proc.stdin.end();

  const collected = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // The timer must be cleared once the race settles either way — an uncleared setTimeout keeps
  // the process alive until it fires, which would make every NORMAL, fast-completing probe add
  // up to HOOK_TIMEOUT_MS of pure dead time at the end of the script for no reason.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), HOOK_TIMEOUT_MS);
  });

  try {
    const race = await Promise.race([collected, timeout]);
    if (race === "timeout") {
      proc.kill();
      return { kind: "timeout" };
    }
    const [stdout, stderr, exitCode] = race;
    return { kind: "completed", stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

let anyFailure = false;
for (const command of commands) {
  for (const probe of KNOWN_PROBES) {
    const outcome = await runProbe(command, probe.event);

    if (outcome.kind === "timeout") {
      console.error(
        `PROBE FAILED [${probe.label}] via \`${command}\`: hook did not respond within ${HOOK_TIMEOUT_MS}ms and was killed. A hook that never answers IS a fail-open: neither this script nor Claude Code can tell "still thinking" from "will never respond," so it must be treated as no fence.`,
      );
      anyFailure = true;
      // Don't burn another HOOK_TIMEOUT_MS proving the SAME broken command hangs on a second
      // probe too — it will. Move on to the next configured command, if any.
      break;
    }

    const { stdout, stderr, exitCode } = outcome;
    let decision: unknown;
    try {
      decision = JSON.parse(stdout.trim());
    } catch {
      console.error(
        `PROBE FAILED [${probe.label}] via \`${command}\`: stdout was not valid JSON (exit ${exitCode}). This IS a fail-open: Claude Code would see no parseable deny here either.`,
      );
      if (stdout.trim().length > 0) console.error(`  stdout: ${stdout.trim()}`);
      if (stderr.trim().length > 0) console.error(`  stderr: ${stderr.trim()}`);
      anyFailure = true;
      continue;
    }
    const permissionDecision = (
      decision as { hookSpecificOutput?: { permissionDecision?: string } }
    ).hookSpecificOutput?.permissionDecision;
    const actual = permissionDecision === "deny" ? "deny" : "allow";
    if (actual !== probe.expect) {
      console.error(
        probe.expect === "deny"
          ? `PROBE FAILED [${probe.label}] via \`${command}\`: expected a "deny" decision, got ${JSON.stringify(decision)}`
          : `PROBE FAILED [${probe.label}] via \`${command}\`: expected this to be ALLOWED and the hook denied it — ${JSON.stringify(decision)}. A fence that refuses the agent's ordinary work makes rung 3 unrunnable and manufactures the confusions the rung is measuring.`,
      );
      anyFailure = true;
      continue;
    }
    console.log(`PROBE OK [${probe.label}] via \`${command}\`: ${actual}.`);
  }
}

if (anyFailure) {
  fail("one or more known-answer probes did not produce the expected decision — see above.");
}

console.log(
  `PREFLIGHT PASSED: ${commands.length} hook command(s) in ${settingsPath}, all ${KNOWN_PROBES.length} probe(s) answered as expected.`,
);
// Explicit exit, belt-and-braces alongside the clearTimeout above: nothing about a normal
// successful run should be able to leave this process waiting around.
process.exit(0);
