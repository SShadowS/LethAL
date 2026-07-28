#!/usr/bin/env bun
/**
 * PreToolUse(Write|Edit) hook: refuse to write credential-shaped content into the REPO TREE.
 *
 * The standing rule here is that the environment tool's config and `continia env users --json`
 * contain plaintext credentials, and that none of it may reach a report, a commit, or a tracked
 * file. That rule is currently kept by remembering it. Sessions that resolve a live environment
 * routinely materialise a config carrying a real username/password — the recovery path for a
 * stranded lease needs one — and the only thing standing between that file and the repo is
 * whoever chose the path.
 *
 * Scope is deliberately narrow, because a guard that fires on ordinary work gets disabled:
 *
 *  - only paths INSIDE the project dir (a scratch or `U:/Git` path is the correct place for these
 *    files and is left alone),
 *  - only values of 6+ characters, so the repo's own test stubs (`password: "p"`) and the
 *    container password already documented in plans (`1234`) do not trip it,
 *  - verified against every tracked file at the time of writing: 0 matches.
 *
 * Exit 2 blocks the call and shows this reason to Claude. Anything unexpected exits 0 — a hook that
 * cannot parse its input must not be able to halt a session.
 */
const SECRET_PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly what: string }> = [
  {
    re: /"(password|clientSecret|client_secret|apiKey|api_key|accessToken|access_token|token)"\s*:\s*"[^"]{6,}"/i,
    what: "a JSON credential field with a real-looking value",
  },
  {
    re: /\b(BC_SERVER_PASSWORD|BC_DEV_PASSWORD|LETHAL_PASSWORD|AZURE_CLIENT_SECRET)\s*=\s*\S{6,}/,
    what: "an inline credential environment assignment",
  },
];

let raw = "";
try {
  raw = await Bun.stdin.text();
} catch {
  process.exit(0);
}

let file = "";
let content = "";
try {
  const input = JSON.parse(raw)?.tool_input ?? {};
  file = (input.file_path ?? "") as string;
  // Write carries `content`; Edit carries `new_string`. Only the text being INTRODUCED matters —
  // an Edit that merely moves an existing line around should not be judged on the old text.
  content = `${input.content ?? ""}\n${input.new_string ?? ""}`;
} catch {
  process.exit(0);
}

if (file === "" || content.trim() === "") process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR;
if (projectDir === undefined || projectDir === "") process.exit(0);

const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
if (!norm(file).startsWith(`${norm(projectDir)}/`)) process.exit(0); // outside the repo: not ours

const hit = SECRET_PATTERNS.find((p) => p.re.test(content));
if (hit === undefined) process.exit(0);

console.error(
  [
    `Refusing to write ${hit.what} into the repository tree (${file}).`,
    "",
    "Environment-tool configs and `continia env users --json` carry PLAINTEXT credentials, and this",
    "project's standing rule is that none of it reaches a report, a commit, or a tracked file.",
    "",
    "Write it outside the project dir instead (the scratchpad, or U:/Git), use it, and delete it.",
    "If this is a test stub rather than a real credential, keep the value under 6 characters — that",
    "is how every existing fixture in this repo stays under the threshold.",
  ].join("\n"),
);
process.exit(2);
