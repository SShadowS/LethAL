// Read-only pre-flight for the move to kraken (plan 3, Task 12 Step 4). It changes nothing and
// deletes nothing: it prints one table, and exits 0 only when every line is ready (1 when a line
// is not, 2 when an inventory command failed and nothing was judged).
//
//   bun scripts/kraken-preflight.ts --move-commit <sha> [--repo <dir>] [--run R-307=lethal/lane-code ...]
//   bun scripts/kraken-preflight.ts --host-scan     (Windows host: scheduled tasks and processes)
//
// The logic is pure functions over text a fake can supply; `repoRows` and `hostScanRows` take an
// `Exec` so a test can inject failures; only `main` passes the real one.

export type Row = { area: string; subject: string; ready: boolean; detail: string };

// An inventory command failed, or printed something that is not a complete inventory. The run
// stops: an inventory that could not be read must never read as an empty one.
export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

export type Exec = (
  cmd: string[],
  cwd?: string,
) => Promise<{ code: number; out: string; err: string }>;

async function must(exec: Exec, what: string, cmd: string[], cwd?: string): Promise<string> {
  const r = await exec(cmd, cwd);
  if (r.code !== 0)
    throw new InventoryError(`${what} failed (exit ${r.code}): ${r.err.trim() || "(no stderr)"}`);
  return r.out;
}

export type Worktree = { path: string; head: string; branch: string | null };

// `git worktree list --porcelain`: blocks separated by a blank line.
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    let path = "";
    let head = "";
    let branch: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (line.startsWith("HEAD ")) head = line.slice(5);
      else if (line.startsWith("branch ")) branch = line.slice(7).replace(/^refs\/heads\//, "");
    }
    if (path !== "") out.push({ path, head, branch });
  }
  return out;
}

// `git ls-remote --heads origin`: "<sha>\trefs/heads/<name>" per line.
export function parseRemoteHeads(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref?.startsWith("refs/heads/")) m.set(ref.slice(11), sha);
  }
  return m;
}

// `git status --porcelain --ignored` hides nothing: ignored entries start with "!! ". Plain
// `--porcelain` never shows them, so scratch under an ignored `.superpowers/` was invisible.
export function ignoredSuperpowers(porcelainIgnored: string): string[] {
  return porcelainIgnored
    .split(/\r?\n/)
    .filter((l) => l.startsWith("!! .superpowers/"))
    .map((l) => l.slice(3));
}

// `dirty` is whether `git status --porcelain` printed anything; null means it could not be read.
// `ignored` is `ignoredSuperpowers(...)` for the same worktree.
export function worktreeRow(
  wt: Worktree,
  dirty: boolean | null,
  remote: Map<string, string>,
  ignored: string[] = [],
): Row {
  const base = { area: "worktree", subject: wt.path };
  if (dirty === null)
    return { ...base, ready: false, detail: "cannot read status (folder missing?)" };
  const problems: string[] = [];
  if (dirty) problems.push("dirty (uncommitted changes)");
  if (ignored.length > 0)
    problems.push(
      `ignored .superpowers/ content (${ignored.join(", ")}): copy into the container worktree at cutover or acknowledge`,
    );
  if (wt.branch === null) {
    problems.push(`detached HEAD ${wt.head.slice(0, 8)}, no branch to push`);
  } else {
    const o = remote.get(wt.branch);
    if (o === undefined) problems.push(`branch ${wt.branch} is not on origin`);
    else if (o !== wt.head)
      problems.push(
        `branch ${wt.branch} differs from origin (local ${wt.head.slice(0, 8)}, origin ${o.slice(0, 8)})`,
      );
  }
  return {
    ...base,
    ready: problems.length === 0,
    detail: problems.join("; ") || `clean, ${wt.branch} on origin`,
  };
}

// A local branch with no worktree whose tip origin lacks would be lost by deleting the host
// clone: missing on origin, or on origin at a different tip (local commits never pushed).
// `refs`: `git for-each-ref --format=%(refname:short) %(objectname) refs/heads`.
export const BRANCH_REFS_FORMAT = "--format=%(refname:short) %(objectname)";
export function orphanBranchRows(
  refs: string,
  worktrees: Worktree[],
  remote: Map<string, string>,
): Row[] {
  const used = new Set(worktrees.map((w) => w.branch));
  const rows: Row[] = [];
  for (const line of refs.split(/\r?\n/)) {
    const [b, tip] = line.trim().split(/\s+/);
    if (b === undefined || b === "" || used.has(b)) continue;
    if (tip === undefined) throw new InventoryError(`branch listing line without a tip: ${line}`);
    const o = remote.get(b);
    if (o === tip) continue;
    rows.push({
      area: "local branch",
      subject: b,
      ready: false,
      detail:
        o === undefined
          ? "no worktree and not on origin"
          : `no worktree and differs from origin (local ${tip.slice(0, 8)}, origin ${o.slice(0, 8)})`,
    });
  }
  return rows;
}

// `git stash list`: one line per stash. Stashes live only in this clone.
export function stashRows(text: string): Row[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => ({ area: "stash", subject: l.split(":")[0] ?? l, ready: false, detail: l }));
}

// An open run is ready when its branch tip (local) is the tip on origin. A run whose branch
// could not be found is reported as unknown, which is not ready.
export function runRow(
  run: string,
  branch: string | null,
  localTip: string | null,
  remote: Map<string, string>,
): Row {
  const base = { area: "open run", subject: run };
  if (branch === null) return { ...base, ready: false, detail: "branch unknown" };
  const o = remote.get(branch);
  if (o === undefined) return { ...base, ready: false, detail: `${branch} is not on origin` };
  if (localTip === null)
    return { ...base, ready: false, detail: `${branch} has no local branch to compare` };
  if (localTip !== o)
    return {
      ...base,
      ready: false,
      detail: `${branch} local ${localTip.slice(0, 8)} differs from origin ${o.slice(0, 8)}`,
    };
  return { ...base, ready: true, detail: `${branch} pushed at ${o.slice(0, 8)}` };
}

// `contains`: exit code of `git merge-base --is-ancestor <move> <lane tip>` (0 yes, 1 no, other = could not check).
export function laneRow(
  lane: string,
  moveCommit: string | undefined,
  remote: Map<string, string>,
  contains: number | null,
): Row {
  const base = { area: "lane branch", subject: lane };
  if (moveCommit === undefined)
    return { ...base, ready: false, detail: "no --move-commit given, cannot check" };
  if (!remote.has(lane)) return { ...base, ready: false, detail: "not on origin" };
  if (contains === 0)
    return { ...base, ready: true, detail: `origin/${lane} contains ${moveCommit.slice(0, 8)}` };
  if (contains === 1)
    return {
      ...base,
      ready: false,
      detail: `origin/${lane} does NOT contain ${moveCommit.slice(0, 8)}`,
    };
  return { ...base, ready: false, detail: "could not check ancestry (commit unknown locally?)" };
}

// ponytail: fixed-width text table, no wrapping.
export function formatTable(rows: Row[]): string {
  const lines = rows.map(
    (r) =>
      `${r.ready ? "READY    " : "NOT READY"}  ${r.area.padEnd(11)}  ${r.subject}\n           ${r.detail}`,
  );
  const bad = rows.filter((r) => !r.ready).length;
  lines.push("", `${rows.length - bad} ready, ${bad} not ready`);
  return lines.join("\n");
}

export const allReady = (rows: Row[]): boolean => rows.every((r) => r.ready);

// ---- host scan ----

export type HostEntry = { kind: "task" | "process"; name: string; state: string; text: string };

// "watchdog" counts only as a script or program name (Edge passes --gpu-watchdog-timeout-seconds).
const WATCHED =
  /lethal-coord|agent-coord|watchdog[\w.-]*\.(ps1|ts|sh|js|cmd|bat|exe)\b|coord\.sh|coord\.ts/i;

// Input: the JSON array of HostEntry the PowerShell below prints. Anything else (empty output,
// not JSON, a malformed entry, or a scan that saw no scheduled task or no process at all, which
// no real Windows host has) is an InventoryError, never "none found".
// A scan's own PowerShell names the patterns, so any entry that runs Get-CimInstance or
// Get-ScheduledTask is the scan itself and is dropped.
export function parseHostScan(json: string): Row[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InventoryError(`host scan printed no JSON: ${json.slice(0, 200) || "(empty)"}`);
  }
  if (!Array.isArray(parsed)) throw new InventoryError("host scan did not print a JSON array");
  const list: HostEntry[] = [];
  for (const e of parsed as Record<string, unknown>[]) {
    if (
      (e?.kind !== "task" && e?.kind !== "process") ||
      typeof e.name !== "string" ||
      typeof e.state !== "string" ||
      typeof e.text !== "string"
    )
      throw new InventoryError(`host scan entry is malformed: ${JSON.stringify(e)}`);
    list.push(e as HostEntry);
  }
  for (const kind of ["task", "process"] as const)
    if (!list.some((e) => e.kind === kind))
      throw new InventoryError(`host scan saw no ${kind} at all, so it did not scan`);
  const rows: Row[] = [];
  for (const e of list) {
    const text = `${e.name} ${e.text}`;
    if (!WATCHED.test(text)) continue;
    if (/centralgauge/i.test(text)) continue;
    if (/Get-CimInstance|Get-ScheduledTask|kraken-preflight/i.test(text)) continue;
    const disabled = e.kind === "task" && /disabled/i.test(e.state);
    rows.push({
      area: e.kind === "task" ? "sched task" : "process",
      subject: e.name,
      ready: disabled,
      detail: e.kind === "task" ? `state ${e.state}: ${e.text}` : e.text,
    });
  }
  if (rows.length === 0)
    rows.push({
      area: "host scan",
      subject: "scheduled tasks and processes",
      ready: true,
      detail: "none found",
    });
  return rows;
}

// Every error is terminating; the catch prints it to stderr and exits 1, so a failed enumeration
// can never reach ConvertTo-Json and print a short list.
export const SCAN_PS = `
$ErrorActionPreference = 'Stop'
try {
$t = Get-ScheduledTask | ForEach-Object { [pscustomobject]@{ kind = 'task'; name = [string]($_.TaskPath + $_.TaskName); state = [string]$_.State; text = [string](($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' ') } }
$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ForEach-Object { [pscustomobject]@{ kind = 'process'; name = "pid $($_.ProcessId) $($_.Name)"; state = 'running'; text = [string]$_.CommandLine } }
ConvertTo-Json -Compress -Depth 3 -InputObject @(@($t) + @($p))
} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }
`;

export async function hostScanRows(exec: Exec): Promise<Row[]> {
  return parseHostScan(
    await must(exec, "host scan (PowerShell)", [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      SCAN_PS,
    ]),
  );
}

// ---- main ----

const realExec: Exec = async (cmd, cwd) => {
  const p = Bun.spawn(cmd, { ...(cwd ? { cwd } : {}), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
};

// Found by reading the coord handoff notes (2026-10-03): R-307 on lane-code, R-396 on its own
// branch, R-403 on lane-preproc. Override with --run <id>=<branch>; "<id>=" means unknown.
const DEFAULT_RUNS: Record<string, string> = {
  "R-307": "lethal/lane-code",
  "R-396": "lethal/r396",
  "R-403": "lethal/lane-preproc",
};
const LANES = ["lethal/lane-code", "lethal/lane-bugs", "lethal/lane-preproc"];

// The repo inventory. Every listing command must exit 0 or this throws InventoryError with its
// stderr. Only per-item probes keep their own exit codes: a worktree whose status cannot be read
// is a NOT READY row, `rev-parse --verify -q` exits 1 for a missing branch, and merge-base's
// exit code is the answer.
export async function repoRows(
  exec: Exec,
  repo: string,
  moveCommit: string | undefined,
  runs: Record<string, string>,
): Promise<Row[]> {
  const git = (args: string[], cwd = repo) => exec(["git", "-C", cwd, ...args]);
  const mustGit = (what: string, args: string[], cwd = repo) =>
    must(exec, what, ["git", "-C", cwd, ...args]);
  const remote = parseRemoteHeads(
    await mustGit("origin listing (ls-remote)", ["ls-remote", "--heads", "origin"]),
  );
  const rows: Row[] = [];
  const wts = parseWorktrees(
    await mustGit("worktree listing", ["worktree", "list", "--porcelain"]),
  );
  for (const wt of wts) {
    const s = await git(["status", "--porcelain"], wt.path);
    if (s.code !== 0) {
      rows.push(worktreeRow(wt, null, remote));
      continue;
    }
    const ig = await mustGit(
      `ignored-files scan of ${wt.path}`,
      ["status", "--porcelain", "--ignored"],
      wt.path,
    );
    rows.push(worktreeRow(wt, s.out.trim() !== "", remote, ignoredSuperpowers(ig)));
  }
  rows.push(
    ...orphanBranchRows(
      await mustGit("local branch listing", ["for-each-ref", BRANCH_REFS_FORMAT, "refs/heads"]),
      wts,
      remote,
    ),
  );
  rows.push(...stashRows(await mustGit("stash listing", ["stash", "list"])));
  for (const id of ["R-307", "R-396", "R-403", ...Object.keys(runs)].filter(
    (v, i, a) => a.indexOf(v) === i,
  )) {
    const br = runs[id] ?? null;
    const tip =
      br === null
        ? null
        : (await git(["rev-parse", "--verify", "-q", `refs/heads/${br}`])).out.trim() || null;
    rows.push(runRow(id, br, tip, remote));
  }
  for (const lane of LANES) {
    const tip = remote.get(lane);
    const c =
      moveCommit && tip ? (await git(["merge-base", "--is-ancestor", moveCommit, tip])).code : null;
    rows.push(laneRow(lane, moveCommit, remote, c));
  }
  return rows;
}

async function main(argv: string[]): Promise<number> {
  const arg = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const runs = { ...DEFAULT_RUNS };
  argv.forEach((a, i) => {
    if (a === "--run") {
      const [id, br] = (argv[i + 1] ?? "").split("=");
      if (id) {
        if (br) runs[id] = br;
        else delete runs[id];
      }
    }
  });
  let rows: Row[];
  try {
    rows = argv.includes("--host-scan")
      ? await hostScanRows(realExec)
      : await repoRows(realExec, arg("--repo") ?? process.cwd(), arg("--move-commit"), runs);
  } catch (e) {
    if (!(e instanceof InventoryError)) throw e;
    console.error(`kraken-preflight: INVENTORY FAILED, nothing was judged: ${e.message}`);
    return 2;
  }
  console.log(formatTable(rows));
  return allReady(rows) ? 0 : 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
