import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The hook is run as a process, as Claude Code runs it (and as no-shell-edits-hook.test.ts does): .claude/hooks is outside
// this tsconfig's rootDir.
const HOOK = join(import.meta.dir, "..", ".claude", "hooks", "shell-write-advisory.ts");
const CWD = "/work/lethal-wt/some-worktree";

/** Runs the hook; the log goes to a fresh temp dir, never under /coord. Returns the caught paths from the log. */
function runHook(command: string, cwd = CWD) {
  const dir = mkdtempSync(join(tmpdir(), "swa-"));
  const log = join(dir, "log.tsv");
  const r = spawnSync("bun", [HOOK], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd,
      session_id: "sess-1",
    }),
    encoding: "utf8",
    env: { ...process.env, HOME: "/home/dev", SHELL_WRITE_ADVISORY_LOG: log },
  });
  const text = existsSync(log) ? readFileSync(log, "utf8") : "";
  const lines = text.split("\n").filter((l) => l !== "");
  return {
    status: r.status,
    stdout: r.stdout,
    log: text,
    paths: lines.map((l) => l.split("\t")[2]),
    sessions: lines.map((l) => l.split("\t")[1]),
  };
}

describe("shell-write-advisory hook (owner q-20261117T160215-30a6c3a9, PR-122)", () => {
  test.each([
    ["echo x > out.txt", `${CWD}/out.txt`],
    ["echo x >> /work/lethal-wt/lane-bugs/src/a.ts", "/work/lethal-wt/lane-bugs/src/a.ts"],
    ["cat > notes.md <<EOF\nhello > there\nEOF", `${CWD}/notes.md`],
    ["printf 'a' | tee docs/x.md", `${CWD}/docs/x.md`],
    ["printf 'a' | tee -a /home/dev/f.txt", "/home/dev/f.txt"],
    ["ls 2> errors.log", `${CWD}/errors.log`],
    ["make &> build.log", `${CWD}/build.log`],
    ['echo x > "/work/with space/f"', "/work/with space/f"],
    ["echo x > $UNKNOWN_DIR_PR122/f", "$UNKNOWN_DIR_PR122/f"],
  ])("warns on %s", (cmd, path) => {
    const r = runHook(cmd);
    expect(r.status).toBe(0); // never blocks
    expect(r.paths).toEqual([path]);
    expect(r.sessions).toEqual(["sess-1"]);
    expect(JSON.parse(r.stdout).systemMessage).toContain(path);
  });

  test.each([
    "echo x > /tmp/claude-1000/scratch/out.txt",
    "echo x > /coord/handoff/PR-1/out.txt",
    "H=/coord/handoff && echo x > $H/t.txt",
    "echo x > /dev/null",
    "cmd 2>/dev/null",
    "cmd > /dev/null 2>&1",
    "cmd >&2",
    "cat file.txt",
    "grep -n '>' file.ts",
    'echo "a > b"',
    "diff <(sort a) <(sort b)",
    "bun - <<EOF\nconsole.log(1 > 0)\nEOF",
    "sed -n 1,5p f.ts",
  ])("does not warn on %s", (cmd) => {
    const r = runHook(cmd);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.log).toBe("");
  });

  test("a relative write inside a scratch cwd is not caught", () => {
    expect(runHook("echo x > out.txt", "/tmp/claude-1000/scratch").log).toBe("");
  });

  test("the log holds time, session and path, never the command text", () => {
    const r = runHook("SECRET=hunter2 && echo $SECRET > out.txt");
    expect(r.log).not.toContain("hunter2");
    expect(r.log).not.toContain("echo");
    expect(r.log.trimEnd().split("\t")).toHaveLength(3);
  });

  test("every redirect and tee target is caught, one log line each", () => {
    expect(runHook("a > x; b >> y | tee z w").paths).toEqual(
      ["x", "y", "z", "w"].map((f) => `${CWD}/${f}`),
    );
  });

  test("unparseable input never blocks", () => {
    const r = spawnSync("bun", [HOOK], { input: "not json", encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});
