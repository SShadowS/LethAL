/**
 * PR-59: a scan of OUR open issues at aldevtools/BusinessCentral.AL.Runner whose latest maintainer comment NAMES an edge
 * build, against the build we run (`/work/tools/al-runner-v3/current`).
 *
 *   bun scripts/upstream-fixed-scan.ts [--repros <report.json>] [--candidate <commit>] [--json]
 *
 * A comment that names a build is not a fix: it may say "first step", "related fix" or "your repro still refuses". So the
 * classes only say which builds a comment names (`build-named-in-current`, `-in-candidate`, `-not-pinned`, `no-build-named`,
 * and R1083's `latest-comment-names-no-build`: an older comment named a build but the newest names none, a plan or a reply),
 * with an excerpt of the comment, and no keyword rule reads the text. "Fixed" is decided by the regression entry's repro
 * result (`--repros`, or the daily run's own run of the set on current: the rows describe CURRENT), never by the comment.
 * Only comments by OWNER/MEMBER/COLLABORATOR (not SShadowS) count; quoted lines (`>`) are dropped before ids are read;
 * a row is `build-named-in-current` only when EVERY named build is an ancestor of current.
 *
 * READ-ONLY toward GitHub: the only gh calls are `issue list`, and `readOnlyGh` throws on anything else. This module has no
 * function that posts, comments, closes, labels or edits. A reply upstream is the lane's own decision (PR-58's steps).
 * The daily update logs the lines (`al-runner-v3-update.ts`, `fixedScan`); it never decides a gate.
 */
import { readFileSync } from "node:fs";
import { readlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const UPSTREAM = "aldevtools/BusinessCentral.AL.Runner";
export const OUR_LOGIN = "SShadowS";
const MAINTAINER_ASSOC = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export interface GhComment {
  readonly author?: { readonly login?: string };
  readonly authorAssociation?: string;
  readonly body?: string;
  readonly createdAt?: string;
  readonly url?: string;
}
export interface GhIssue {
  readonly number: number;
  readonly title: string;
  readonly comments?: readonly GhComment[];
}
export interface ManifestEntry {
  readonly id: string;
  readonly issue: string;
}
export interface ReproRow {
  readonly repro: string;
  readonly test: string;
  readonly change: string;
}

export type FixClass =
  | "build-named-in-current"
  | "build-named-in-candidate"
  | "build-named-not-pinned"
  // R1083: an older maintainer comment named a build, but the newest names none (a plan or a reply, not a fix); the row
  // shows the newest comment's excerpt, which tells the two apart (no keyword rules)
  | "latest-comment-names-no-build"
  | "no-build-named";

export interface ScanRow {
  readonly number: number;
  readonly title: string;
  readonly class: FixClass;
  readonly builds: readonly string[];
  readonly commentUrl?: string;
  readonly commentDate?: string;
  /** About 120 characters of the comment that names the builds. */
  readonly excerpt?: string;
  readonly entries: readonly string[];
  /** Present only when a repro report was given and the issue has entries. */
  readonly repro?: { readonly differ: number; readonly match: number; readonly other: number };
}

export interface ScanDeps {
  /** Runs `gh <args>`; returns stdout. The scan only ever passes `issue list ...`. */
  gh(args: readonly string[]): Promise<string>;
  /** The commit the pinned `current` was built from. */
  currentCommit(): Promise<string>;
  /** Is the commit present in the read-only clone? */
  known(commit: string): Promise<boolean>;
  /** `git fetch` in the read-only clone. */
  fetch(): Promise<void>;
  /** `git merge-base --is-ancestor a b`. */
  isAncestor(a: string, b: string): Promise<boolean>;
  manifest: readonly ManifestEntry[];
  reproRows?: readonly ReproRow[];
  candidate?: string;
}

/** Wraps a gh runner so that anything but `issue list`/`issue view` throws (the "never post" guard). */
export function readOnlyGh(run: (args: readonly string[]) => Promise<string>) {
  return (args: readonly string[]): Promise<string> => {
    if (args[0] !== "issue" || (args[1] !== "list" && args[1] !== "view"))
      throw new Error(`upstream-fixed-scan is read-only: refused gh ${args.slice(0, 2).join(" ")}`);
    return run(args);
  };
}

/** The commit in a build directory name: `edge-5a58a0f16-5a58a0f16` and `3.0.0-alpha.14-ef00a6a8f` both end in it. */
export function commitOfDirName(dir: string): string {
  const c = /-([0-9a-f]{7,40})$/.exec(basename(dir))?.[1];
  if (c === undefined) throw new Error(`no commit at the end of the build name "${dir}"`);
  return c;
}

/**
 * Short hex ids a comment names: in backticks, or as `edge-<hex>`. At least one digit, so a word is never one.
 * Lines starting with `>` are a quote of someone else's words (ours, usually): dropped first.
 */
export function extractBuilds(body: string): string[] {
  const found = new Set<string>();
  const re = /`([0-9a-f]{7,40})`|\bedge[- ]([0-9a-f]{7,40})\b/gi;
  const own = body
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join("\n");
  for (const m of own.matchAll(re)) {
    const id = (m[1] ?? m[2] ?? "").toLowerCase();
    if (/[0-9]/.test(id)) found.add(id);
  }
  return [...found];
}

/** The maintainer's comments, newest first: OWNER/MEMBER/COLLABORATOR only, never SShadowS. No fallback to anyone else. */
export function maintainerComments(comments: readonly GhComment[]): GhComment[] {
  return comments
    .filter((c) => c.author?.login !== OUR_LOGIN && MAINTAINER_ASSOC.has(c.authorAssociation ?? ""))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

const excerptOf = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 120);

export function entriesOf(manifest: readonly ManifestEntry[], issue: number): string[] {
  return manifest.filter((e) => e.issue.endsWith(`/${issue}`)).map((e) => e.id);
}

export function summariseRepros(rows: readonly ReproRow[], entries: readonly string[]) {
  const mine = rows.filter((r) => entries.includes(r.repro));
  const differ = mine.filter(
    (r) => r.change === "still-differs" || r.change === "regressed",
  ).length;
  const match = mine.filter((r) => r.change === "still-matches" || r.change === "flipped").length;
  return { differ, match, other: mine.length - differ - match };
}

export async function scan(deps: ScanDeps, issues: readonly GhIssue[]): Promise<ScanRow[]> {
  const current = await deps.currentCommit();
  let fetched = false;
  /** A named id that is no commit in the clone (even after one fetch) is not a build. */
  const isCommit = async (c: string): Promise<boolean> => {
    if (await deps.known(c)) return true;
    if (!fetched) {
      fetched = true;
      await deps.fetch();
    }
    return deps.known(c);
  };
  // A current or candidate the clone cannot find would turn every row into a silent "not pinned".
  for (const [what, c] of [
    ["current", current],
    ["candidate", deps.candidate],
  ] as const)
    if (c !== undefined && !(await isCommit(c)))
      throw new Error(
        `upstream-fixed-scan: ${what} commit ${c} is not in the clone, even after a fetch`,
      );
  const rows: ScanRow[] = [];
  for (const issue of issues) {
    const entries = entriesOf(deps.manifest, issue.number);
    // The newest maintainer comment that names a commit the clone knows: a later "thanks" hides nothing.
    let comment: GhComment | undefined;
    let builds: string[] = [];
    const ordered = maintainerComments(issue.comments ?? []);
    for (const c of ordered) {
      const known: string[] = [];
      for (const b of extractBuilds(c.body ?? "")) if (await isCommit(b)) known.push(b);
      if (known.length > 0) {
        comment = c;
        builds = known;
        break;
      }
    }
    let cls: FixClass = "no-build-named";
    // R1083: a newer maintainer comment that names no build; the row reports it, not the older build's class.
    const newest = ordered[0];
    if (builds.length > 0 && newest !== undefined && newest !== comment) {
      cls = "latest-comment-names-no-build";
      comment = newest;
    } else if (builds.length > 0) {
      cls = "build-named-not-pinned";
      if (await allAncestors(deps, builds, current)) cls = "build-named-in-current";
      else if (deps.candidate !== undefined && (await allAncestors(deps, builds, deps.candidate)))
        cls = "build-named-in-candidate";
    }
    rows.push({
      number: issue.number,
      title: issue.title,
      class: cls,
      builds,
      ...(comment?.url !== undefined ? { commentUrl: comment.url } : {}),
      ...(comment?.createdAt !== undefined ? { commentDate: comment.createdAt } : {}),
      ...(comment !== undefined ? { excerpt: excerptOf(comment.body ?? "") } : {}),
      entries,
      ...(deps.reproRows !== undefined && entries.length > 0
        ? { repro: summariseRepros(deps.reproRows, entries) }
        : {}),
    });
  }
  return rows;
}

async function allAncestors(
  deps: ScanDeps,
  builds: readonly string[],
  of: string,
): Promise<boolean> {
  for (const b of builds) if (!(await deps.isAncestor(b, of))) return false;
  return true;
}

/** Rows to act on: a build named in current with no entry, or with an entry that still differs from BC. */
export function actionRows(rows: readonly ScanRow[]): { row: ScanRow; why: string }[] {
  const out: { row: ScanRow; why: string }[] = [];
  for (const row of rows) {
    if (row.class !== "build-named-in-current") continue;
    if (row.entries.length === 0)
      out.push({ row, why: "no regression entry: build one, run it, comment (PR-58)" });
    else if (row.repro !== undefined && row.repro.differ > 0)
      out.push({
        row,
        why: `entry still differs from BC in ${row.repro.differ} test(s): step 1 only, or not fixed`,
      });
  }
  return out;
}

export function formatRows(rows: readonly ScanRow[]): string[] {
  const lines = rows.map((r) => {
    const repro =
      r.repro === undefined
        ? ""
        : ` | repro: ${r.repro.differ} differ, ${r.repro.match} match${r.repro.other > 0 ? `, ${r.repro.other} other` : ""}`;
    const head = `#${r.number} ${r.title.slice(0, 70)} | ${r.class} | builds: ${r.builds.join(",") || "none"}`;
    const mid = ` | ${r.commentUrl ?? "-"} | entries: ${r.entries.join(",") || "none"}${repro}`;
    return `${head}${mid}${r.excerpt !== undefined ? ` | comment: "${r.excerpt}"` : ""}`;
  });
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.class, (counts.get(r.class) ?? 0) + 1);
  lines.push(`counts: ${[...counts].map(([k, v]) => `${k} ${v}`).join(", ") || "no open issues"}`);
  const actions = actionRows(rows);
  lines.push(actions.length === 0 ? "action: none" : "action:");
  for (const a of actions) lines.push(`  #${a.row.number}: ${a.why}`);
  return lines;
}

export async function listOurIssues(gh: ScanDeps["gh"]): Promise<GhIssue[]> {
  const out = await gh([
    "issue",
    "list",
    "-R",
    UPSTREAM,
    "--author",
    OUR_LOGIN,
    "--state",
    "open",
    "--limit",
    "300",
    "--json",
    "number,title,comments",
  ]);
  return JSON.parse(out) as GhIssue[];
}

const SPAWN_TIMEOUT_MS = 120_000;

/** Runs `argv` with a timeout; throws when it is stopped for time. */
async function spawnOut(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, SPAWN_TIMEOUT_MS);
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  clearTimeout(timer);
  if (timedOut)
    throw new Error(`${argv.slice(0, 3).join(" ")} timed out after ${SPAWN_TIMEOUT_MS / 1000} s`);
  return { code, out, err };
}

async function run(argv: string[]): Promise<string> {
  const { code, out, err } = await spawnOut(argv);
  if (code !== 0) throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${err.slice(-300)}`);
  return out;
}

/** `git merge-base --is-ancestor`: exit 0 is yes, exit 1 is no, anything else (a bad clone, a signal) is an error. */
export function ancestorFromExit(code: number, err: string): boolean {
  if (code === 0) return true;
  if (code === 1) return false;
  throw new Error(`git merge-base --is-ancestor exited ${code}: ${err.slice(-300)}`);
}

const CLONE = "/coord/cache/al-runner-v3-src";
const CURRENT_LINK = "/work/tools/al-runner-v3/current";
const MANIFEST = join(dirname(import.meta.path), "upstream-repros", "manifest.json");

/** The real deps: gh through `readOnlyGh`, the clone for git, the link for `current`. */
export function realScanDeps(
  opts: { repros?: string; reproRows?: readonly ReproRow[]; candidate?: string } = {},
): ScanDeps {
  const git = (...a: string[]) => run(["git", "-C", CLONE, ...a]);
  const manifest = (JSON.parse(readFileSync(MANIFEST, "utf8")) as { repros: ManifestEntry[] })
    .repros;
  return {
    gh: readOnlyGh((a) => run(["gh", ...a])),
    currentCommit: async () => commitOfDirName(await readlink(CURRENT_LINK)),
    known: async (c) =>
      git("cat-file", "-e", `${c}^{commit}`).then(
        () => true,
        () => false,
      ),
    fetch: async () => void (await git("fetch", "--quiet", "origin")),
    isAncestor: async (a, b) => {
      const r = await spawnOut(["git", "-C", CLONE, "merge-base", "--is-ancestor", a, b]);
      return ancestorFromExit(r.code, r.err);
    },
    manifest,
    ...(opts.reproRows !== undefined
      ? { reproRows: opts.reproRows }
      : opts.repros !== undefined
        ? { reproRows: JSON.parse(readFileSync(opts.repros, "utf8")) as ReproRow[] }
        : {}),
    ...(opts.candidate !== undefined ? { candidate: opts.candidate } : {}),
  };
}

/** For the daily update: the scan's lines. Throws when gh or the clone is unreachable; the caller catches. */
export async function fixedScanLines(deps: ScanDeps = realScanDeps()): Promise<string[]> {
  return formatRows(await scan(deps, await listOurIssues(deps.gh)));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repros = opt("--repros");
  const candidate = opt("--candidate");
  const deps = realScanDeps({
    ...(repros !== undefined ? { repros } : {}),
    ...(candidate !== undefined ? { candidate } : {}),
  });
  const rows = await scan(deps, await listOurIssues(deps.gh));
  console.log(
    argv.includes("--json") ? JSON.stringify(rows, null, 2) : formatRows(rows).join("\n"),
  );
}
