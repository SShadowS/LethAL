#!/usr/bin/env bun
/**
 * PreToolUse(Bash) hook: refuse in-place edits with `sed` (owner, 2026-11-13).
 *
 * CLAUDE.md says to edit files with the Edit and Write tools, never with an inline script, because
 * hand-written find-and-replace fails often while the Edit tool checks the match. Sessions and their
 * subagents still reached for `sed -i` (five times in two days on 2026-11-12/13, once on source), so
 * the rule is now enforced here instead of remembered.
 *
 * Scope is deliberately narrow: only `sed` with an in-place flag (`-i`, `-i.bak`, `--in-place`, or a
 * combined short flag such as `-ni` / `-Ei`). A read-only `sed -n` and the word "sed" inside text
 * are left alone. Exit 2 blocks the call and shows the reason to Claude. Anything unexpected exits 0:
 * a hook that cannot parse its input must not be able to halt a session.
 */

/** True when `command` runs `sed` with an in-place flag. Exported for the test. */
export function isInPlaceSed(command: string): boolean {
  // Each `sed` invocation: the word `sed` at a command position (start, or after a separator/pipe,
  // optionally behind `sudo`/`xargs`/`env`), then its arguments up to the next separator.
  const invocation =
    /(?:^|[;&|(]|\$\(|`|\bxargs\s+|\bsudo\s+|\benv\s+)\s*sed((?:\s+[^\s;&|)`]+)*)/g;
  for (const m of command.matchAll(invocation)) {
    const args = (m[1] ?? "").trim().split(/\s+/);
    for (const a of args) {
      if (a === "--in-place" || a.startsWith("--in-place=")) return true;
      if (/^-[a-zA-Z]*i/.test(a) && !a.startsWith("--")) return true;
    }
  }
  return false;
}

if (import.meta.main) {
  let raw = "";
  try {
    raw = await Bun.stdin.text();
  } catch {
    process.exit(0);
  }
  let command = "";
  try {
    command = (JSON.parse(raw)?.tool_input?.command ?? "") as string;
  } catch {
    process.exit(0);
  }
  if (command === "" || !isInPlaceSed(command)) process.exit(0);
  console.error(
    [
      "Refusing `sed` with an in-place flag (-i / --in-place) (owner rule, 2026-11-13; CLAUDE.md:",
      "edit files with the Edit and Write tools, never with an inline script).",
      "",
      "Use the Edit tool (exact old_string -> new_string) or Write for a whole file.",
      "A read-only `sed -n` is fine.",
    ].join("\n"),
  );
  process.exit(2);
}
