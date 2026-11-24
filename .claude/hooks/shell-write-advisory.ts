#!/usr/bin/env bun
/**
 * PreToolUse(Bash) hook, ADVISORY: warn when a shell command writes a file by redirect (`>`, `>>`, `&>`, `2>`), `tee`, or a
 * heredoc into such a redirect, OUTSIDE the scratch places (`/tmp/claude-*`, `/coord/handoff/`). Owner ruling
 * q-20261117T160215-30a6c3a9 (2026-11-17): advisory first (design mantra principle 4); count what it catches; propose
 * blocking once real use shows the numbers. Coord task PR-122.
 *
 * It NEVER blocks: it always exits 0 and sets no permission decision, so the normal permission flow is unchanged. A warning
 * is printed (stderr, and a `systemMessage` for the user), and each caught target is appended to a log: one line per target,
 * `<ISO time>\t<session id>\t<target path>`. The command's text is never logged (it can hold secrets).
 *
 * Not caught on purpose: `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/fd/*`, fd duplications (`2>&1`, `>&2`), and a `>`
 * inside quotes or inside a heredoc body. Variables assigned in the same command (`H=/coord/handoff ...`) are expanded first.
 * A relative target is resolved against the directory a `cd` earlier in the same command moved to (PR-401; R1132's week:
 * 892 of 1,121 lines were `cd /coord/handoff/X && ... > name` caught at the session's directory). A target the hook cannot
 * resolve (it holds a variable it cannot expand) is caught as written, unless its literal text before the first `$` names a
 * scratch directory (PR-401: 82 such lines, e.g. `/coord/handoff/R-984/x1.$w.txt`).
 *
 * Log: `$SHELL_WRITE_ADVISORY_LOG`, else `/coord/logs/shell-write-advisory.tsv`. Tests always set the variable.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, posix } from "node:path";

// Bash commands carry POSIX paths, also under Git Bash on Windows, so targets resolve as POSIX paths on every host.
const { isAbsolute, resolve } = posix;

const SCRATCH = [/^\/tmp\/claude-/, /^\/coord\/handoff(\/|$)/];
const HARMLESS = [/^\/dev\/(null|stdout|stderr|tty)$/, /^\/dev\/fd\//];

/** The command with quoted text and heredoc bodies blanked (same length), so operators inside them are not seen. */
function blankQuotesAndHeredocs(command: string): string {
  const out = [...command];
  let i = 0;
  const heredocTags: string[] = [];
  while (i < command.length) {
    const c = command[i];
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      const stop = end < 0 ? command.length : end;
      for (let j = i + 1; j < stop; j++) out[j] = " ";
      i = stop + 1;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const m = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(command.slice(i));
      if (m?.[2] !== undefined) heredocTags.push(m[2]);
    }
    if (c === "\n" && heredocTags.length > 0) {
      // Blank lines up to and including each heredoc's terminator.
      let pos = i + 1;
      while (heredocTags.length > 0 && pos <= command.length) {
        const tag = heredocTags[0];
        const nl = command.indexOf("\n", pos);
        const lineEnd = nl < 0 ? command.length : nl;
        const line = command.slice(pos, lineEnd);
        for (let j = pos; j < lineEnd; j++) out[j] = " ";
        if (line.trim() === tag) heredocTags.shift();
        pos = lineEnd + 1;
        if (nl < 0) break;
      }
      i = pos;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Read one shell word starting at `at` in the ORIGINAL command (quotes removed). */
function wordAt(command: string, at: number): string {
  let i = at;
  while (command[i] === " " || command[i] === "\t") i++;
  let word = "";
  while (i < command.length) {
    const c = command[i] ?? "";
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      const stop = end < 0 ? command.length : end;
      word += command.slice(i + 1, stop);
      i = stop + 1;
      continue;
    }
    if (/[\s;&|()<>`]/.test(c)) break;
    word += c;
    i++;
  }
  return word;
}

/** Every file a command writes by redirect or tee, as written (before expansion), with where it stands in the command. */
function targetsAt(command: string): { word: string; at: number }[] {
  const seen = blankQuotesAndHeredocs(command);
  const targets: { word: string; at: number }[] = [];
  // Redirects: optional fd or &, then > or >>, not followed by & (an fd duplication) or ( (process substitution).
  for (const m of seen.matchAll(/(?:^|[^<>&0-9])(?:[0-9]|&)?>>?(?![&(])/g)) {
    const end = (m.index ?? 0) + m[0].length;
    const w = wordAt(command, end);
    if (w !== "") targets.push({ word: w, at: end });
  }
  // tee [-a|-i|--append|...] FILE...
  for (const m of seen.matchAll(/(?:^|[;&|(\s])tee((?:\s+[^\s;&|)`]+)*)/g)) {
    const start = (m.index ?? 0) + m[0].length - (m[1] ?? "").length;
    let i = start;
    for (const raw of (m[1] ?? "").trim().split(/\s+/)) {
      const at = command.indexOf(raw, i);
      i = at < 0 ? i : at + raw.length;
      if (raw === "" || raw.startsWith("-")) continue;
      targets.push({ word: wordAt(command, at < 0 ? start : at), at: at < 0 ? start : at });
    }
  }
  return targets.sort((a, b) => a.at - b.at);
}

/** Every file a command writes by redirect or tee, as written (before expansion). Exported for the test. */
export function writeTargets(command: string): string[] {
  return targetsAt(command).map((t) => t.word);
}

/**
 * PR-401: the working directory each target is written from. A `cd DIR` (at the start of the command or after `;`, `&&`,
 * `||`, `|`, `(` or a newline) moves it for everything after it; a subshell `( ... )` puts it back at its `)`. `cd` alone is
 * $HOME; `cd -` or a DIR the hook cannot resolve leaves it unknown (`undefined`), so a relative target after it is caught as
 * written. Quoted text and heredoc bodies are blanked first, so a `cd` or a paren inside them is not seen.
 */
function cwdAtTargets(
  command: string,
  cwd: string,
  vars: Map<string, string>,
  env: NodeJS.ProcessEnv,
): { word: string; cwd: string | undefined }[] {
  const seen = blankQuotesAndHeredocs(command);
  type Ev = { at: number; kind: "cd" | "open" | "close"; dir?: string };
  const evs: Ev[] = [];
  for (const m of seen.matchAll(/(?:^|[;&|(\n])\s*cd(?=[\s;&|)]|$)/g)) {
    const end = (m.index ?? 0) + m[0].length;
    evs.push({ at: end, kind: "cd", dir: wordAt(command, end) });
  }
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] === "(") evs.push({ at: i, kind: "open" });
    else if (seen[i] === ")") evs.push({ at: i, kind: "close" });
  }
  evs.sort((a, b) => a.at - b.at);
  const out: { word: string; cwd: string | undefined }[] = [];
  let cur: string | undefined = cwd;
  const stack: (string | undefined)[] = [];
  let e = 0;
  for (const t of targetsAt(command)) {
    for (; e < evs.length && (evs[e]?.at ?? 0) < t.at; e++) {
      const ev = evs[e];
      if (ev === undefined) continue;
      if (ev.kind === "open") stack.push(cur);
      else if (ev.kind === "close") cur = stack.length > 0 ? stack.pop() : cur;
      else {
        const dir = ev.dir ?? "";
        if (dir === "" || dir === "~") cur = env.HOME;
        else if (dir === "-") cur = undefined;
        else if (
          cur === undefined &&
          !isAbsolute(dir) &&
          !dir.startsWith("~/") &&
          !dir.startsWith("$")
        )
          cur = undefined;
        else cur = resolveTarget(dir, cur ?? "/", vars, env);
      }
    }
    out.push({ word: t.word, cwd: cur });
  }
  return out;
}

/**
 * PR-401: for a target that still holds an unknown variable, the directory its literal text names before the first `$`
 * (everything up to the last `/` before it), resolved against `cwd`; `undefined` when there is no such directory to tell.
 * `/coord/handoff/R-984/x1.$w.txt` -> `/coord/handoff/R-984`; `base-$w.tsv` in `cwd` -> `cwd`; `$P/v3.json` -> undefined.
 * (A variable could still hold `../`; the hook is advisory, and a literal scratch directory is taken at its word.)
 */
function literalDir(
  target: string,
  cwd: string | undefined,
  vars: Map<string, string>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  let t = target;
  for (let n = 0; n < 5 && /\$/.test(t); n++)
    t = t.replace(
      /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
      (all, name: string) => vars.get(name) ?? env[name] ?? all,
    );
  if (t.startsWith("~/")) t = `${env.HOME ?? "~"}/${t.slice(2)}`;
  const lit = t.split("$", 1)[0] ?? "";
  if (lit === "") return undefined; // `$X/f`: the directory is the variable's, not known
  const slash = lit.lastIndexOf("/");
  const dirPart = slash < 0 ? "" : lit.slice(0, slash + 1);
  if (isAbsolute(dirPart)) return resolve(dirPart);
  if (cwd === undefined) return undefined;
  return resolve(cwd, dirPart === "" ? "." : dirPart);
}

/** `VAR=value` words of the command (values unquoted), for expanding targets. */
function assignments(command: string): Map<string, string> {
  const vars = new Map<string, string>();
  const seen = blankQuotesAndHeredocs(command);
  for (const m of seen.matchAll(/(?:^|[;&|(\s])([A-Za-z_][A-Za-z0-9_]*)=/g)) {
    const name = m[1] ?? "";
    const valueAt = (m.index ?? 0) + m[0].length;
    vars.set(name, wordAt(command, valueAt));
  }
  return vars;
}

/** The target as an absolute path where it can be resolved; `undefined` when it still holds an unknown variable. */
export function resolveTarget(
  target: string,
  cwd: string,
  vars: Map<string, string>,
  env: NodeJS.ProcessEnv,
): string | undefined {
  let t = target;
  for (let n = 0; n < 5 && /\$/.test(t); n++)
    t = t.replace(
      /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g,
      (all, name: string) => vars.get(name) ?? env[name] ?? all,
    );
  if (t.startsWith("~/")) t = `${env.HOME ?? "~"}/${t.slice(2)}`;
  if (/\$/.test(t)) return undefined;
  return isAbsolute(t) ? resolve(t) : resolve(cwd, t);
}

/** The targets the hook warns about (outside scratch, not harmless), each as resolved or as written. Exported for the test. */
export function caught(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const vars = assignments(command);
  const out: string[] = [];
  for (const { word, cwd: at } of cwdAtTargets(command, cwd, vars, env)) {
    // A relative target after an unresolvable `cd` cannot be placed: caught as written.
    const path =
      at === undefined && !isAbsolute(word) && !word.startsWith("~/") && !word.startsWith("$")
        ? undefined
        : resolveTarget(word, at ?? "/", vars, env);
    if (
      path !== undefined &&
      (HARMLESS.some((re) => re.test(path)) || SCRATCH.some((re) => re.test(path)))
    )
      continue;
    if (path === undefined) {
      // PR-401: an unknown variable inside a literal scratch directory is scratch too.
      const dir = literalDir(word, at, vars, env);
      if (dir !== undefined && SCRATCH.some((re) => re.test(`${dir}/`))) continue;
    }
    out.push(path ?? word);
  }
  return out;
}

if (import.meta.main) {
  let input: { tool_input?: { command?: unknown }; cwd?: unknown; session_id?: unknown } = {};
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0);
  }
  const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
  if (command === "") process.exit(0);
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  let hits: string[] = [];
  try {
    hits = caught(command, cwd);
  } catch {
    process.exit(0);
  }
  if (hits.length === 0) process.exit(0);
  const session = typeof input.session_id === "string" ? input.session_id : "-";
  const log = process.env.SHELL_WRITE_ADVISORY_LOG ?? "/coord/logs/shell-write-advisory.tsv";
  try {
    mkdirSync(dirname(log), { recursive: true });
    const at = new Date().toISOString();
    appendFileSync(
      log,
      hits.map((p) => `${at}\t${session}\t${p.replace(/[\t\n\r]/g, " ")}\n`).join(""),
    );
  } catch {
    // counting must never stop a command
  }
  const msg = `shell-write-advisory (owner, advisory only): this command writes ${hits.join(", ")} by shell redirect/tee outside /tmp/claude-* and /coord/handoff. Prefer the Write/Edit tools for files (CLAUDE.md). Not blocked; counted.`;
  console.error(msg);
  console.log(JSON.stringify({ systemMessage: msg }));
  process.exit(0);
}
