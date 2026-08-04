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
 * command's own stdout read back), feeds it a small set of probes that must always be denied, and
 * exits non-zero the moment any of them is not. Rung 3 must not start unless this exits 0.
 *
 * Usage: bun fixtures/do-campaign/preflight.ts <settings-file-path>
 */

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

// Every probe here is expected to be denied under BOTH fix rounds' logic — one exercises rule 1
// (the write fence), one exercises the escape-hatch flag introduced in round 2 for rule 2. If the
// configured hook command can't be run at all, or answers anything other than a well-formed deny
// to either, that is the fail-open scenario this script exists to catch.
const KNOWN_DENY_PROBES: ReadonlyArray<{
  readonly label: string;
  readonly event: Record<string, unknown>;
}> = [
  {
    label: "Write under U:/Git/LethAL",
    event: {
      tool_name: "Write",
      tool_input: { file_path: "U:/Git/LethAL/PROBE.txt", content: "x" },
    },
  },
  {
    label: "Bash `lethal run --allow-large-run` (opts out of the product's own size refusal)",
    event: {
      tool_name: "Bash",
      tool_input: {
        command:
          'lethal run --project U:/Git/do-lethal/Cloud --only "x" --tests-only "y" --allow-large-run',
      },
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

let anyFailure = false;
for (const command of commands) {
  for (const probe of KNOWN_DENY_PROBES) {
    // Run the hook command through a shell, the same way Claude Code invokes a "command"-type
    // hook — not a naive whitespace split, so quoting/env-var expansion in the command string
    // (e.g. "$CLAUDE_PROJECT_DIR/...") behaves the same way it would for the real harness.
    const proc = Bun.spawn(["bash", "-c", command], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify(probe.event));
    proc.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

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
    if (permissionDecision !== "deny") {
      console.error(
        `PROBE FAILED [${probe.label}] via \`${command}\`: expected a "deny" decision, got ${JSON.stringify(decision)}`,
      );
      anyFailure = true;
      continue;
    }
    console.log(`PROBE OK [${probe.label}] via \`${command}\`: denied.`);
  }
}

if (anyFailure) {
  fail("one or more known-deny probes did not produce a well-formed deny — see above.");
}

console.log(
  `PREFLIGHT PASSED: ${commands.length} hook command(s) in ${settingsPath}, all ${KNOWN_DENY_PROBES.length} probe(s) denied as expected.`,
);
