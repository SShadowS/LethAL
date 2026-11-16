/**
 * PR-59: a scan of OUR open issues at aldevtools/BusinessCentral.AL.Runner that the maintainer reports fixed in an edge
 * build, against the build we run (`/work/tools/al-runner-v3/current`).
 *
 *   bun scripts/upstream-fixed-scan.ts [--repros <report.json>] [--candidate <commit>] [--json]
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
  | "fixed-in-current"
  | "fixed-in-candidate"
  | "fixed-not-pinned"
  | "no-fix-reported";

export interface ScanRow {
  readonly number: number;
  readonly title: string;
  readonly class: FixClass;
  readonly builds: readonly string[];
  readonly commentUrl?: string;
  readonly commentDate?: string;
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

/** Short hex ids a comment names: in backticks, or as `edge-<hex>`. At least one digit, so a word is never one. */
export function extractBuilds(body: string): string[] {
  const found = new Set<string>();
  const re = /`([0-9a-f]{7,40})`|\bedge[- ]([0-9a-f]{7,40})\b/gi;
  for (const m of body.matchAll(re)) {
    const id = (m[1] ?? m[2] ?? "").toLowerCase();
    if (/[0-9]/.test(id)) found.add(id);
  }
  return [...found];
}

/** The latest comment by the maintainer: not us; among those, the OWNER/MEMBER/COLLABORATOR ones when there are any. */
export function latestMaintainerComment(comments: readonly GhComment[]): GhComment | undefined {
  const others = comments.filter((c) => c.author?.login !== OUR_LOGIN);
  const privileged = others.filter((c) => MAINTAINER_ASSOC.has(c.authorAssociation ?? ""));
  const pool = privileged.length > 0 ? privileged : others;
  return [...pool].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")).at(-1);
}

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
  const rows: ScanRow[] = [];
  for (const issue of issues) {
    const entries = entriesOf(deps.manifest, issue.number);
    const comment = latestMaintainerComment(issue.comments ?? []);
    const builds: string[] = [];
    for (const b of comment === undefined ? [] : extractBuilds(comment.body ?? ""))
      if (await isCommit(b)) builds.push(b);
    let cls: FixClass = "no-fix-reported";
    if (builds.length > 0) {
      cls = "fixed-not-pinned";
      if (await anyAncestor(deps, builds, current)) cls = "fixed-in-current";
      else if (deps.candidate !== undefined && (await anyAncestor(deps, builds, deps.candidate)))
        cls = "fixed-in-candidate";
    }
    rows.push({
      number: issue.number,
      title: issue.title,
      class: cls,
      builds,
      ...(comment?.url !== undefined && builds.length > 0 ? { commentUrl: comment.url } : {}),
      ...(comment?.createdAt !== undefined && builds.length > 0
        ? { commentDate: comment.createdAt }
        : {}),
      entries,
      ...(deps.reproRows !== undefined && entries.length > 0
        ? { repro: summariseRepros(deps.reproRows, entries) }
        : {}),
    });
  }
  return rows;
}

async function anyAncestor(
  deps: ScanDeps,
  builds: readonly string[],
  of: string,
): Promise<boolean> {
  for (const b of builds) if (await deps.isAncestor(b, of)) return true;
  return false;
}

/** Rows to act on: fixed in current with no entry, or with an entry that still differs from BC. */
export function actionRows(rows: readonly ScanRow[]): { row: ScanRow; why: string }[] {
  const out: { row: ScanRow; why: string }[] = [];
  for (const row of rows) {
    if (row.class !== "fixed-in-current") continue;
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
    return (
      `#${r.number} ${r.title.slice(0, 70)} | ${r.class} | builds: ${r.builds.join(",") || "none"}` +
      ` | ${r.commentUrl ?? "-"} | entries: ${r.entries.join(",") || "none"}${repro}`
    );
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

async function run(argv: string[]): Promise<string> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if ((await p.exited) !== 0)
    throw new Error(`${argv.slice(0, 3).join(" ")} failed: ${err.slice(-300)}`);
  return out;
}

const CLONE = "/coord/cache/al-runner-v3-src";
const CURRENT_LINK = "/work/tools/al-runner-v3/current";
const MANIFEST = join(dirname(import.meta.path), "upstream-repros", "manifest.json");

/** The real deps: gh through `readOnlyGh`, the clone for git, the link for `current`. */
export function realScanDeps(opts: { repros?: string; candidate?: string } = {}): ScanDeps {
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
    isAncestor: (a, b) =>
      git("merge-base", "--is-ancestor", a, b).then(
        () => true,
        () => false,
      ),
    manifest,
    ...(opts.repros !== undefined
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
