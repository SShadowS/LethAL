/**
 * R593: a SHARED master-corpus snapshot (production identity keys), and a branch diff against it.
 *
 *   bun scripts/corpus-snapshot.ts snapshot <set> --master
 *   bun scripts/corpus-snapshot.ts diff <set> --branch <worktree> [--projects <n|dir>[,...]] [--all]
 *                                       [--legacy-master <sha>]
 *
 * Sets: `fixtures` (`<tree>/fixtures`), `cdo` /work/src/do-lethal, `bch` /work/src/BC.History,
 * `dc` /work/src/DC, `do` /work/src/DO. Projects are directories holding `app.json`, sorted.
 *
 * Cache (`LETHAL_DUMP_CACHE`, default /coord/cache/dumps):
 *   <master sha>/<set>/<dumperKey>/{<n>.jsonl, projects.tsv, manifest.json, DONE}
 * `dumperKey` = sha256(FORMAT + "\n" + sha256(scripts/prod-identity-keys.ts)), first 16 hex. Only
 * the dumper keys an entry, so a different dumper writes BESIDE an existing entry and an edit to this
 * file (the CLI and report) changes no key. An entry is created by an exclusive mkdir, filled, and
 * `DONE` is written last; it is never edited. The legacy 15c3a620 entry (top-level DONE, no manifest,
 * no tags) is read only by `diff --legacy-master <sha>`, which reports `dumper unrecorded`.
 *
 * `snapshot` (B = origin/master as fetched by the caller): `cached` when B has an entry with this
 * checkout's key; else REUSE the newest ancestor entry A with the same key when no generation-code
 * path (`generationChanged`) changed between A and B and the corpus head and DEP_DIRS are equal; else
 * dump. `diff`: the master side is the entry `snapshot` would pick for merge-base(<worktree>,
 * origin/master); the branch side is dumped from the worktree as it is, into a temp dir that is
 * deleted afterwards. Projects are joined by path RELATIVE to the set's corpus root.
 *
 * Heavy-job guard (owner rule R642: three heavy jobs container-wide, of which at most two BaseApp
 * (BC.History, set `bch`) corpus jobs; a BaseApp job counts against both caps), for every set but
 * `fixtures`, before a dump: the tool re-execs itself under `flock -n -E 75 <locks>/heavy.<n>`
 * (slot 1, then 2, then 3;
 * `LETHAL_HEAVY_LOCK_DIR`, default /coord/locks). The kernel holds the lock for as long as any
 * process holds the fd, project children included, so SIGKILL needs no cleanup. Inside the slot, a
 * `ps` scan counts OTHER heavy jobs that take no slot (one per itest:alrunner root, else one per
 * distinct process group): corpus jobs and
 * local runners (al-runner, itest:alrunner; `isHeavy`). Known limit:
 * two jobs started from ONE non-interactive shell (`a & b`) share a pgid and count as one, and a job
 * on a corpus COPY is invisible to the scan; both should take a slot themselves:
 * `flock -n /coord/locks/heavy.<n> <cmd>`. A slot taken by hand (`flock heavy.N <cmd>`) counts
 * toward the BaseApp cap only while one of its processes names /work/src/BC.History; a job over a
 * COPY of the corpus counts toward the total cap only.
 *
 * Exit codes: 0 ok / identical, 1 different or a dump failure, 2 refused for good (no master entry,
 * unknown set, error projects, bad flag: retrying never helps), 75 the heavy-job guard refused (no
 * free slot: retry later). A retry loop waits only on 75 (`until [ $rc != 75 ]`), never on 2 (R724).
 * The report prints paths, operators and counts only, never tuple text (it can carry source).
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseArgs as parseCli } from "node:util";
import { FORMAT } from "./prod-identity-keys.ts";

const REPO_ROOT = join(import.meta.dir, "..");

export class RefusedError extends Error {
  /** True only for the heavy-job guard: retrying later is right. Every other refusal is permanent. */
  readonly transient: boolean;
  constructor(message: string, transient = false) {
    super(message);
    this.name = "RefusedError";
    this.transient = transient;
  }
}

/** Exit code of the heavy-job guard refusal (EX_TEMPFAIL); a retry loop may wait on it (R724). */
export const HEAVY_GUARD_EXIT = 75;

export function exitCodeOf(e: unknown): number {
  if (!(e instanceof RefusedError)) return 1;
  return e.transient ? HEAVY_GUARD_EXIT : 2;
}

export const EXTERNAL_SETS: Readonly<Record<string, string>> = {
  cdo: "/work/src/do-lethal",
  bch: "/work/src/BC.History",
  dc: "/work/src/DC",
  do: "/work/src/DO",
};
export const SET_NAMES = ["fixtures", ...Object.keys(EXTERNAL_SETS)];
/** A process whose argv names one of these is a corpus job. */
export const CORPUS_ROOT_RE = /\/work\/src\/(BC\.History|do-lethal|DC|DO)(\/|\s|$)/;

/** A reader, log watcher or search that merely NAMES a corpus is not a corpus job. Shells are NOT in
 *  this list: `bash -c 'cd /work/src/BC.History && bun census.ts .'` is a corpus job whose bun child
 *  names no corpus (review r2), so a shell naming a corpus counts. That is over-cautious for a shell
 *  wrapping a plain grep, which errs on the safe side. */
export const READER =
  /^(\S*\/)?(tail|grep|ugrep|rg|ps|less|more|cat|head|git|find|ls|du|vi|vim|nano)(\s|$)/;

/** READER plus shells: for verify-equivalence.ts, which waits on a job by NAME, a shell that only
 *  mentions a job (another agent's `bash -c ... grep al-runner`) is not the job; its child is. */
export const WATCHER = new RegExp(`^(\\S*\\/)?(bash|sh)(\\s|$)|${READER.source}`);

const INTERPRETERS = new Set(["bun", "node", "dotnet", "bash", "sh"]);

/** The script an interpreter runs (`bun [run] <x>`, `dotnet exec <x>`), else undefined. */
function scriptOf(argv: readonly string[]): string | undefined {
  const exe = (argv[0] ?? "").slice((argv[0] ?? "").lastIndexOf("/") + 1);
  if (!INTERPRETERS.has(exe)) return undefined;
  return argv.slice(1).find((a) => !a.startsWith("-") && a !== "run" && a !== "exec");
}

/**
 * A heavy job by the runbook's rule (three container-wide, R642): a corpus job (its argv names a corpus
 * root), or a LOCAL runner: an `al-runner` executable (v2, or the v3 Rust binary), al-runner's
 * `.dll` under dotnet, or the itest:alrunner root process. Matched on the EXECUTABLE or SCRIPT,
 * never on an argument that merely contains the name (a unit test file `al-runner-v3-x.test.ts`
 * is not a runner). A parallel itest counts once: its `--worker` processes are not counted, and
 * the al-runner children they spawn count under the itest root (`heavyVerdict`). A BC
 * gate against a remote server (itest:hang, itest:bcdev, ...) is not heavy.
 */
export function isHeavy(args: string): boolean {
  if (READER.test(args)) return false;
  if (CORPUS_ROOT_RE.test(args)) return true;
  const argv = args.trim().split(/\s+/);
  if (argv.includes("--worker")) return false;
  const exe = (argv[0] ?? "").slice((argv[0] ?? "").lastIndexOf("/") + 1);
  if (exe === "al-runner" || exe === "al-runner.exe") return true;
  const script = scriptOf(argv);
  if (script === undefined) return false;
  return isItestScript(script) || /(^|\/)al-runner\.dll$/.test(script);
}

/** The itest:alrunner root, decided by the SCRIPT, never by an argument that contains the name. */
function isItestScript(script: string): boolean {
  return script === "itest:alrunner" || /(^|\/)al-runner\.itest\.ts$/.test(script);
}
function isItestRoot(args: string): boolean {
  const script = scriptOf(args.trim().split(/\s+/));
  return script !== undefined && isItestScript(script) && isHeavy(args);
}

/** B1: a path whose change can move a production key. */
export function isGenerationPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (/^packages\/[^/]+\/src\//.test(path)) return !path.endsWith(".test.ts");
  return (
    path.startsWith("packages/engine/native/") ||
    path === "bun.lock" ||
    base === "package.json" ||
    base === "bunfig.toml" ||
    /^tsconfig.*\.json$/.test(base) ||
    path === "scripts/prod-identity-keys.ts"
  );
}

export function generationChanged(paths: readonly string[]): string[] {
  return paths.filter(isGenerationPath);
}

/** N2: the key of the dumper in `checkout`. Only scripts/prod-identity-keys.ts is hashed. */
export function dumperKeyOf(checkout: string): { key: string; dumperHash: string } {
  const dumperHash = createHash("sha256")
    .update(readFileSync(join(checkout, "scripts", "prod-identity-keys.ts")))
    .digest("hex");
  const key = createHash("sha256").update(`${FORMAT}\n${dumperHash}`).digest("hex").slice(0, 16);
  return { key, dumperHash };
}

/** Directories holding `app.json` under `top` (the R-500 rule), sorted. A linked folder is never
 *  descended (R631: `lstat`, not `stat`), and is said on stderr. */
export function findProjects(top: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (existsSync(join(d, "app.json"))) out.push(d);
    for (const e of readdirSync(d)) {
      if (e === ".alpackages" || e === ".git" || e === "node_modules") continue;
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) console.error(`findProjects: link ${p} not followed (R631)`);
      else if (st.isDirectory()) walk(p);
    }
  };
  walk(top);
  return out.sort();
}

export type Git = (args: string[]) => string;

export function gitIn(cwd: string): Git {
  return (args) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if ((r.exitCode ?? 1) !== 0) {
      throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString().trim()}`);
    }
    return r.stdout.toString().trim();
  };
}

function isAncestor(git: Git, a: string, b: string): boolean {
  try {
    git(["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch {
    return false;
  }
}

/** The corpus identity a dump at `sha` depends on besides the code: fixtures' tree hash, or the
 *  external corpus's HEAD. */
export function corpusHeadOf(set: string, sha: string, git: Git, roots = EXTERNAL_SETS): string {
  if (set === "fixtures") return git(["rev-parse", `${sha}:fixtures`]);
  const root = roots[set];
  if (root === undefined)
    throw new RefusedError(`unknown set '${set}' (have ${SET_NAMES.join(", ")})`);
  return gitIn(root)(["rev-parse", "HEAD"]);
}

export interface Manifest {
  readonly format: number;
  readonly masterSha: string;
  readonly set: string;
  readonly dumperKey: string;
  readonly dumperHash: string;
  readonly bunVersion: string;
  readonly corpusRoot: string;
  readonly corpusHead: string;
  readonly depDirs: readonly string[];
  readonly started: string;
  readonly finished: string;
  readonly projects: number;
}

export function entryDir(cacheRoot: string, sha: string, set: string, key: string): string {
  return join(cacheRoot, sha, set, key);
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
}

/** DEP_DIRS compared as a SET: order alone never refuses reuse. */
function sameDirs(a: readonly string[], b: readonly string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

export type Pick =
  | { kind: "cached"; dir: string; message: string }
  | { kind: "reuse"; dir: string; from: string; message: string }
  | { kind: "dump"; message: string };

/**
 * Steps 2 and 3 of `snapshot`: an entry for B with `key`, or a reusable ancestor entry with `key`,
 * or "dump" with the reason. Entries with another key are never looked at.
 */
export function pickMaster(o: {
  cacheRoot: string;
  set: string;
  sha: string;
  key: string;
  corpusHead: string;
  depDirs: readonly string[];
  git: Git;
}): Pick {
  const own = entryDir(o.cacheRoot, o.sha, o.set, o.key);
  if (existsSync(join(own, "DONE"))) {
    // Review r1 #2: the same sha is not enough. A re-pinned external corpus or other DEP_DIRS would
    // make a branch diff blame the corpus change on the branch. The entry cannot be replaced
    // in place (it is never edited), so refuse and name the reason.
    const m = readManifest(own);
    const why =
      m.corpusHead !== o.corpusHead
        ? `its corpus head ${m.corpusHead} is not today's ${o.corpusHead}`
        : !sameDirs(m.depDirs, o.depDirs)
          ? `its DEP_DIRS ${JSON.stringify(m.depDirs)} are not today's ${JSON.stringify(o.depDirs)}`
          : undefined;
    if (why !== undefined) {
      throw new RefusedError(
        `cached entry ${own} does not match this run: ${why}. Delete it by hand to re-dump, or restore the corpus/DEP_DIRS it was dumped with.`,
      );
    }
    return { kind: "cached", dir: own, message: `cached: ${own}` };
  }
  const candidates: { sha: string; distance: number }[] = [];
  for (const a of existsSync(o.cacheRoot) ? readdirSync(o.cacheRoot) : []) {
    if (a === o.sha || !/^[0-9a-f]{40}$/.test(a)) continue;
    if (!existsSync(join(entryDir(o.cacheRoot, a, o.set, o.key), "DONE"))) continue;
    if (!isAncestor(o.git, a, o.sha)) continue;
    candidates.push({ sha: a, distance: Number(o.git(["rev-list", "--count", `${a}..${o.sha}`])) });
  }
  candidates.sort((x, y) => x.distance - y.distance);
  let reason = `no cached ancestor entry for set ${o.set} with dumper ${o.key}`;
  for (const [i, c] of candidates.entries()) {
    const dir = entryDir(o.cacheRoot, c.sha, o.set, o.key);
    const changed = o
      .git(["diff", "--name-only", c.sha, o.sha])
      .split("\n")
      .filter((l) => l !== "");
    const gen = generationChanged(changed);
    const m = readManifest(dir);
    const why =
      gen.length > 0
        ? `generation code changed since ${c.sha.slice(0, 8)}: ${gen[0]}${gen.length > 1 ? ` (+${gen.length - 1} more)` : ""}`
        : m.corpusHead !== o.corpusHead
          ? `corpus head changed since ${c.sha.slice(0, 8)}: ${m.corpusHead} -> ${o.corpusHead}`
          : !sameDirs(m.depDirs, o.depDirs)
            ? `DEP_DIRS differ from ${c.sha.slice(0, 8)}'s`
            : undefined;
    if (why === undefined) {
      return {
        kind: "reuse",
        dir,
        from: c.sha,
        message: `reuse ${c.sha} for ${o.sha}: ${c.distance} commits, ${changed.length} files changed, none is generation code`,
      };
    }
    if (i === 0) reason = why;
  }
  return { kind: "dump", message: `dump: ${reason}` };
}

export type Dumper = (treeRoot: string, outFile: string, projectDir: string) => void;

/** The real dumper: this checkout's prod-identity-keys.ts over `treeRoot`, one process per project. */
export function realDumper(depDirs: readonly string[]): Dumper {
  return (treeRoot, outFile, projectDir) => {
    const r = Bun.spawnSync(
      [
        process.execPath,
        join(REPO_ROOT, "scripts", "prod-identity-keys.ts"),
        treeRoot,
        outFile,
        projectDir,
      ],
      {
        cwd: treeRoot,
        env: { ...process.env, DEP_DIRS: depDirs.join(":") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if ((r.exitCode ?? 1) !== 0 && !existsSync(outFile)) {
      writeFileSync(outFile, JSON.stringify({ error: r.stderr.toString().trim().slice(-300) }));
    }
  };
}

/**
 * Writes a NEW entry: exclusive mkdir of the entry dir (EEXIST is a refusal; nothing is touched),
 * one `<n>.jsonl` per project, then projects.tsv and manifest.json, and `DONE` last. Stops at the
 * first `{error}` project: no DONE, and the error is thrown.
 */
export function writeEntry(o: {
  dir: string;
  manifest: Omit<Manifest, "started" | "finished" | "projects">;
  treeRoot: string;
  projects: readonly string[];
  dumper: Dumper;
  print: (line: string) => void;
}): void {
  mkdirSync(dirname(o.dir), { recursive: true });
  try {
    mkdirSync(o.dir);
  } catch (e) {
    if ((e as { code?: string }).code !== "EEXIST") throw e;
    throw new RefusedError(
      `${o.dir} exists (DONE: ${existsSync(join(o.dir, "DONE")) ? "yes" : "no"}). A cache entry is never edited, only replaced whole: delete it by hand to re-dump.`,
    );
  }
  const started = new Date().toISOString();
  for (const [n, p] of o.projects.entries()) {
    const out = join(o.dir, `${n}.jsonl`);
    o.dumper(o.treeRoot, out, p);
    const j = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as { error?: string }) : {};
    if (!existsSync(out) || j.error !== undefined) {
      throw new Error(
        `project ${n} ${p}: ${j.error ?? "no output"}; entry left without DONE: ${o.dir}`,
      );
    }
    if ((n + 1) % 50 === 0) o.print(`  ${n + 1}/${o.projects.length} projects`);
  }
  writeFileSync(
    join(o.dir, "projects.tsv"),
    `${o.projects.map((p, i) => `${i}\t${p}`).join("\n")}\n`,
  );
  const manifest: Manifest = {
    ...o.manifest,
    started,
    finished: new Date().toISOString(),
    projects: o.projects.length,
  };
  writeFileSync(join(o.dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(o.dir, "DONE"), `${manifest.finished}\n`);
}

// ---------------------------------------------------------------------------------------------
// diff

export interface Dump {
  readonly hang?: number;
  readonly specs?: number;
  readonly skipped?: number;
  readonly keys?: readonly string[];
  readonly error?: string;
}

interface KeyRow {
  tuple: string;
  ord: string;
  tag: string | undefined;
}

/** `<key>\t<tuple>|<ordinal>` (format 1) or `<key>\t<tuple>|<ordinal>|<tag>` (format 2). */
export function parseKeyLine(line: string, format: number): [string, KeyRow] {
  const tab = line.indexOf("\t");
  const key = line.slice(0, tab);
  let rest = line.slice(tab + 1);
  let tag: string | undefined;
  if (format >= 2) {
    const i = rest.lastIndexOf("|");
    tag = rest.slice(i + 1);
    rest = rest.slice(0, i);
  }
  const i = rest.lastIndexOf("|");
  return [key, { tuple: rest.slice(0, i), ord: rest.slice(i + 1), tag }];
}

function rows(d: Dump, format: number): Map<string, KeyRow> {
  return new Map((d.keys ?? []).map((l) => parseKeyLine(l, format)));
}

function grouped(label: string, keys: readonly string[]): string[] {
  const by = new Map<string, number>();
  for (const k of keys) {
    const [file, op] = k.split("|");
    const g = `${file} ${op}`;
    by.set(g, (by.get(g) ?? 0) + 1);
  }
  return [`  ${label} ${keys.length}`, ...[...by].sort().map(([g, n]) => `    ${n}\t${g}`)];
}

/**
 * The report. `master` and `branch` map a project's path RELATIVE to its set's corpus root to its
 * dump. Refuses (RefusedError) an `{error}` project on either side and a total of zero keys on both
 * sides. Prints paths, operators and counts, never tuple text.
 */
export function diffDumps(
  master: ReadonlyMap<string, Dump>,
  branch: ReadonlyMap<string, Dump>,
  masterFormat: number,
): { lines: string[]; different: boolean } {
  const errors = [
    ...[...master]
      .filter(([, d]) => d.error !== undefined)
      .map(([p, d]) => `master ${p}: ${d.error}`),
    ...[...branch]
      .filter(([, d]) => d.error !== undefined)
      .map(([p, d]) => `branch ${p}: ${d.error}`),
  ];
  if (errors.length > 0) throw new RefusedError(`error projects:\n  ${errors.join("\n  ")}`);
  const total = (m: ReadonlyMap<string, Dump>): number =>
    [...m.values()].reduce((n, d) => n + (d.keys?.length ?? 0), 0);
  if (total(master) === 0 && total(branch) === 0) {
    throw new RefusedError("zero keys on both sides: an empty comparison is never 'identical'");
  }
  const lines: string[] = [];
  let different = false;
  const sum = { added: 0, removed: 0, tuples: 0, ords: 0, tags: 0 };
  const tagMoves = new Map<string, number>();
  const onlyMaster = [...master.keys()].filter((p) => !branch.has(p)).sort();
  const onlyBranch = [...branch.keys()].filter((p) => !master.has(p)).sort();
  for (const p of onlyMaster) lines.push(`only in master: ${p}`);
  for (const p of onlyBranch) lines.push(`only in branch: ${p}`);
  if (onlyMaster.length + onlyBranch.length > 0) different = true;
  for (const p of [...master.keys()].filter((k) => branch.has(k)).sort()) {
    const a = master.get(p) ?? {};
    const b = branch.get(p) ?? {};
    const ra = rows(a, masterFormat);
    const rb = rows(b, FORMAT);
    const added = [...rb.keys()].filter((k) => !ra.has(k));
    const removed = [...ra.keys()].filter((k) => !rb.has(k));
    let tuples = 0;
    let ords = 0;
    let tags = 0;
    for (const [k, v] of ra) {
      const w = rb.get(k);
      if (w === undefined) continue;
      if (w.tuple !== v.tuple) tuples++;
      else if (w.ord !== v.ord) ords++;
      if (v.tag !== undefined && w.tag !== v.tag) {
        tags++;
        const move = `${v.tag || "(none)"} -> ${w.tag || "(none)"}`;
        tagMoves.set(move, (tagMoves.get(move) ?? 0) + 1);
      }
    }
    const counts = `specs ${a.specs} -> ${b.specs}; hang ${a.hang} -> ${b.hang}; skipped ${a.skipped} -> ${b.skipped}`;
    const changed =
      added.length + removed.length + tuples + ords + tags > 0 ||
      a.specs !== b.specs ||
      a.hang !== b.hang ||
      a.skipped !== b.skipped;
    sum.added += added.length;
    sum.removed += removed.length;
    sum.tuples += tuples;
    sum.ords += ords;
    sum.tags += tags;
    if (!changed) continue;
    different = true;
    lines.push(`${p}:`, ...grouped("added", added), ...grouped("removed", removed));
    lines.push(
      `  tuples moved ${tuples}; ordinals moved ${ords}; tags changed ${masterFormat >= 2 ? tags : "n/a"}`,
      `  ${counts}`,
    );
  }
  lines.push(
    `TOTAL over ${[...master.keys()].filter((k) => branch.has(k)).length} joined projects: added ${sum.added}, removed ${sum.removed}, tuples moved ${sum.tuples}, ordinals moved ${sum.ords}, tags changed ${masterFormat >= 2 ? sum.tags : "n/a (format-1 master)"}`,
  );
  for (const [m, n] of [...tagMoves].sort()) lines.push(`  tags ${m}: ${n}`);
  lines.push(different ? "RESULT: different" : "RESULT: identical");
  return { lines, different };
}

/** A project's path relative to its set's corpus root (the `diff` join key). */
export function relProject(set: string, corpusRoot: string | undefined, dir: string): string {
  if (corpusRoot !== undefined) return relative(corpusRoot, dir);
  // A legacy entry records no corpus root: fixtures are found by their segment, others by set root.
  if (set === "fixtures") return dir.slice(dir.lastIndexOf("/fixtures/") + "/fixtures/".length);
  return relative(EXTERNAL_SETS[set] ?? "/", dir);
}

/** Reads an entry dir (format 2 with manifest, or legacy) into rel path -> dump, plus n -> rel. */
export function readEntry(
  dir: string,
  set: string,
): { format: number; dumps: Map<string, Dump>; index: Map<string, string> } {
  const manifest = existsSync(join(dir, "manifest.json")) ? readManifest(dir) : undefined;
  const format = manifest?.format ?? 1;
  const dumps = new Map<string, Dump>();
  const index = new Map<string, string>();
  for (const line of readFileSync(join(dir, "projects.tsv"), "utf8").split("\n")) {
    if (line === "") continue;
    const [n = "", abs = ""] = line.split("\t");
    const rel = relProject(set, manifest?.corpusRoot, abs);
    index.set(n, rel);
    dumps.set(rel, JSON.parse(readFileSync(join(dir, `${n}.jsonl`), "utf8")) as Dump);
  }
  return { format, dumps, index };
}

// ---------------------------------------------------------------------------------------------
// heavy-job guard

export interface Proc {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly args: string;
}

/** `ps -eo pid,ppid,pgid,args` output, header dropped. */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), args: m[4] ?? "" });
  }
  return out;
}

function descendants(procs: readonly Proc[], root: number): Set<number> {
  const out = new Set<number>([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of procs) {
      if (!out.has(p.pid) && out.has(p.ppid)) {
        out.add(p.pid);
        grew = true;
      }
    }
  }
  return out;
}

function ancestors(procs: readonly Proc[], pid: number): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set<number>();
  for (
    let cur = byPid.get(pid);
    cur !== undefined && !out.has(cur.pid);
    cur = byPid.get(cur.ppid)
  ) {
    out.add(cur.pid);
  }
  return out;
}

/** The heavy slots, tried in this order (owner rule R642: three heavy jobs container-wide). */
export const SLOTS = [1, 2, 3] as const;
/** Heavy jobs container-wide, and of those, BaseApp (BC.History) corpus jobs (R642). */
const TOTAL_CAP = 3;
const BASEAPP_CAP = 2;
/** A process whose argv names the BaseApp (BC.History) corpus root. */
const BASEAPP_ROOT_RE = /\/work\/src\/BC\.History(\/|\s|$)/;
/**
 * Is this slot holder dumping the BaseApp set? Read by the tool's own CLI parser, because flags may
 * come before the set (`diff --branch /x bch`) and the in-slot re-exec keeps that order (review B1).
 * An argv the parser refuses counts as BaseApp, which errs on the safe side.
 */
function holderIsBaseApp(args: string): boolean {
  const argv = args.trim().split(/\s+/);
  const at = argv.findIndex((a) => /(^|\/)corpus-snapshot\.ts$/.test(a));
  try {
    return parseCliArgs(argv.slice(at + 1)).positionals[1] === "bch";
  } catch {
    return true;
  }
}

/**
 * The scan for corpus jobs that take no slot: processes whose argv names a corpus root, minus this
 * process's ancestors and descendants and the descendants of every pid recorded in a held slot,
 * counted by itest:alrunner root (one job, however many al-runner children its workers spawn), else
 * by DISTINCT pgid. Refuse when those plus the slots held by others reach 3 (the total cap), or,
 * for a BaseApp job (`selfBaseApp`), when the other BaseApp jobs reach 2 (the BaseApp cap): held
 * slots whose live holder dumps `bch`, plus unslotted jobs with a process naming BC.History.
 */
const SLOT_HOLDER_RE = /(^|\/)corpus-snapshot\.ts\b.*--in-slot [123]\b/;

export function heavyVerdict(
  procs: readonly Proc[],
  self: number,
  slotPids: readonly number[],
  otherSlotsHeld: number,
  selfBaseApp = false,
): { refuse: boolean; foreign: Proc[]; message: string } {
  const skip = new Set<number>([...ancestors(procs, self), ...descendants(procs, self)]);
  // A slot file's pid is trusted only when it names a live corpus-snapshot slot holder. A manual
  // `flock heavy.<n> <cmd>` writes nothing (empty reads as 0, and pid 0's descendants are the whole
  // container), and a stale pid names someone else. Untrusted -> exclude nothing; a manual holder is
  // then counted as a held slot AND as a foreign job, which errs on the safe side (review r1 #1).
  // An untrusted slot counts toward the total only; its process, if it names BC.History, is
  // counted as a BaseApp job by the scan below.
  let baseAppSlots = 0;
  for (const s of slotPids) {
    const p = procs.find((x) => x.pid === s);
    if (!(s > 1) || p === undefined || !SLOT_HOLDER_RE.test(p.args)) continue;
    if (holderIsBaseApp(p.args)) baseAppSlots++;
    for (const d of descendants(procs, s)) skip.add(d);
  }
  // A job is keyed by its itest:alrunner root when it has one (its workers' al-runner children sit
  // in their own process groups, R626), else by process group.
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const itestRoot = (p: Proc): Proc | undefined => {
    let root: Proc | undefined; // the OUTERMOST match: `bun run itest:alrunner` wraps the .itest.ts
    for (const a of ancestors(procs, p.pid)) {
      const q = byPid.get(a);
      if (q !== undefined && !skip.has(q.pid) && isItestRoot(q.args)) root = q;
    }
    return root;
  };
  const jobs = new Map<string, Proc>();
  const baseAppJobs = new Set<string>(); // a job is BaseApp when ANY of its processes names BC.History
  for (const p of procs) {
    if (skip.has(p.pid) || !isHeavy(p.args)) continue;
    const root = itestRoot(p);
    const key = root !== undefined ? `root:${root.pid}` : `pgid:${p.pgid}`;
    if (!jobs.has(key)) jobs.set(key, root ?? p);
    if (BASEAPP_ROOT_RE.test(p.args)) baseAppJobs.add(key);
  }
  const foreign = [...jobs.values()];
  const otherBaseApp = baseAppSlots + baseAppJobs.size;
  const totalRefuse = foreign.length + otherSlotsHeld >= TOTAL_CAP;
  const baseAppRefuse = selfBaseApp && otherBaseApp >= BASEAPP_CAP;
  const refuse = totalRefuse || baseAppRefuse;
  const why = totalRefuse
    ? " -> REFUSED (at most three heavy jobs container-wide)"
    : baseAppRefuse
      ? " -> REFUSED (at most two BaseApp corpus jobs)"
      : "";
  const message = [
    `heavy-job guard: ${otherSlotsHeld} other slot(s) held, ${foreign.length} other heavy job(s) (corpus or local runner) by itest root, else by process group; ${otherBaseApp} other BaseApp corpus job(s)${why}`,
    ...foreign.map((p) => `  pgid ${p.pgid} pid ${p.pid}: ${p.args.slice(0, 100)}`),
  ].join("\n");
  return { refuse, foreign, message };
}

export const SLOT_BUSY = 75;

/**
 * N3: run `cmd(n)` under `flock -n -E 75 <lockDir>/heavy.<n>`, slot 1, then 2, then 3. Returns the
 * slot and the command's exit code, or null when every slot is held (each returned 75).
 */
export function trySlots(
  lockDir: string,
  cmd: (slot: number) => string[],
  inherit = false,
): { slot: number; code: number } | null {
  mkdirSync(lockDir, { recursive: true });
  for (const slot of SLOTS) {
    const r = Bun.spawnSync(
      ["flock", "-n", "-E", String(SLOT_BUSY), join(lockDir, `heavy.${slot}`), ...cmd(slot)],
      inherit
        ? { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
        : { stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== SLOT_BUSY) return { slot, code: r.exitCode ?? 1 };
  }
  return null;
}

/** Is the slot's lock held by someone (a probe that takes and drops it at once when free)? */
export function slotHeld(lockDir: string, slot: number): boolean {
  const r = Bun.spawnSync(
    ["flock", "-n", "-E", String(SLOT_BUSY), join(lockDir, `heavy.${slot}`), "true"],
    { stdout: "pipe", stderr: "pipe" },
  );
  return r.exitCode === SLOT_BUSY;
}

function lockDir(): string {
  return process.env.LETHAL_HEAVY_LOCK_DIR ?? "/coord/locks";
}

/** Inside slot `mine`: record our pid, then the ps scan. Throws RefusedError. */
function guardInSlot(mine: number, baseApp: boolean, print: (l: string) => void): void {
  const dir = lockDir();
  writeFileSync(join(dir, `heavy.${mine}`), `${process.pid}\n`);
  const held = SLOTS.filter((s) => s !== mine && slotHeld(dir, s));
  const pids = held
    .map((s) => Number(readFileSync(join(dir, `heavy.${s}`), "utf8").trim()))
    .filter((p) => !Number.isNaN(p));
  const ps = Bun.spawnSync(["ps", "-eo", "pid,ppid,pgid,args"], {
    stdout: "pipe",
  }).stdout.toString();
  const v = heavyVerdict(parsePs(ps), process.pid, pids, held.length, baseApp);
  print(v.message);
  if (v.refuse) throw new RefusedError(v.message, true);
}

// ---------------------------------------------------------------------------------------------
// trees

/** A clean tree of `sha` with node_modules and the native parser, under `<tmpRoot>/<sha>-<pid>`. */
function prepareTree(sha: string, tmpRoot: string, print: (l: string) => void): string {
  const tree = join(tmpRoot, `${sha}-${process.pid}`);
  mkdirSync(tree, { recursive: true });
  try {
    fillTree(sha, tree, print);
    return tree;
  } catch (e) {
    rmSync(tree, { recursive: true, force: true });
    throw e;
  }
}

/**
 * node_modules from this checkout: hard links (`cp -al`) when the tree is on the same mount, a real
 * copy otherwise (/coord and /work are separate mounts here, so links fail with EXDEV, measured in the
 * R-588 smoke). A copy, never a symlink: the workspace links inside are relative, and through a
 * symlink they would resolve to THIS checkout's packages instead of the tree's.
 */
function copyModules(from: string, to: string): string {
  const linked = Bun.spawnSync(["cp", "-al", from, to], { stderr: "pipe" });
  if (linked.exitCode === 0) return "link-copied";
  rmSync(to, { recursive: true, force: true });
  const copied = Bun.spawnSync(["cp", "-a", from, to], { stderr: "pipe" });
  if (copied.exitCode !== 0) throw new Error(`cp -a ${from}: ${copied.stderr.toString()}`);
  return "copied (hard links refused across mounts)";
}

function fillTree(sha: string, tree: string, print: (l: string) => void): void {
  const archive = Bun.spawnSync(["bash", "-c", `git archive ${sha} | tar -x -C "${tree}"`], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (archive.exitCode !== 0) throw new Error(`git archive ${sha}: ${archive.stderr.toString()}`);
  const sameLock = readFileSync(join(tree, "bun.lock")).equals(
    readFileSync(join(REPO_ROOT, "bun.lock")),
  );
  if (sameLock) {
    const dirs = [
      "node_modules",
      ...readdirSync(join(REPO_ROOT, "packages")).map((p) => `packages/${p}/node_modules`),
    ];
    let how = "";
    for (const d of dirs) {
      if (!existsSync(join(REPO_ROOT, d))) continue;
      how = copyModules(join(REPO_ROOT, d), join(tree, d));
    }
    print(`tree: node_modules ${how} (bun.lock identical)`);
  } else {
    const r = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
      cwd: tree,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) throw new Error(`bun install in ${tree}: ${r.stderr.toString()}`);
    print("tree: bun install --frozen-lockfile (bun.lock differs)");
  }
  const vendor = join("packages", "engine", "vendor", "native");
  mkdirSync(join(tree, vendor), { recursive: true });
  for (const f of readdirSync(join(REPO_ROOT, vendor)))
    copyFileSync(join(REPO_ROOT, vendor, f), join(tree, vendor, f));
}

/** The native parser copied from this checkout is refused when stale: rebuild it in the tree. */
function rebuildNative(tree: string, print: (l: string) => void): void {
  print("tree: the copied native parser was refused; running build-native-parser.ts in the tree");
  const r = Bun.spawnSync(["bun", "scripts/build-native-parser.ts"], {
    cwd: tree,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0)
    throw new Error(`build-native-parser in ${tree}: ${r.stderr.toString().slice(-500)}`);
}

/** The real dumper over a tree, rebuilding the native parser once if the first project needs it. */
function treeDumper(tree: string, depDirs: readonly string[], print: (l: string) => void): Dumper {
  const dump = realDumper(depDirs);
  let first = true;
  return (root, out, proj) => {
    dump(root, out, proj);
    if (!first) return;
    first = false;
    const j = JSON.parse(readFileSync(out, "utf8")) as Dump;
    if (j.error === undefined || !/NativeParser/.test(j.error)) return;
    rmSync(out);
    rebuildNative(tree, print);
    dump(root, out, proj);
  };
}

// ---------------------------------------------------------------------------------------------
// CLI

function cacheRoot(): string {
  return process.env.LETHAL_DUMP_CACHE ?? "/coord/cache/dumps";
}

function depDirsEnv(): string[] {
  return (process.env.DEP_DIRS ?? "").split(":").filter((d) => d !== "");
}

/** Re-exec under a heavy slot unless already in one or the set is fixtures. Returns the exit code
 *  of the slotted child, or undefined to go on in this process. */
function slotted(
  set: string,
  argv: readonly string[],
  inSlot: number | undefined,
  print: (l: string) => void,
): number | undefined {
  if (set === "fixtures") return undefined;
  if (inSlot !== undefined) {
    guardInSlot(inSlot, set === "bch", print);
    return undefined;
  }
  const r = trySlots(
    lockDir(),
    (n) => [
      process.execPath,
      join(REPO_ROOT, "scripts", "corpus-snapshot.ts"),
      ...argv,
      "--in-slot",
      String(n),
    ],
    true,
  );
  if (r === null)
    throw new RefusedError(
      `heavy-job guard: all three heavy slots held (${lockDir()}/heavy.1, heavy.2, heavy.3)`,
      true,
    );
  return r.code;
}

function runSnapshot(
  set: string,
  argv: readonly string[],
  inSlot: number | undefined,
  print: (l: string) => void,
): number {
  const git = gitIn(REPO_ROOT);
  const sha = git(["rev-parse", "origin/master"]);
  print(`master: origin/master = ${sha} (not fetched by this tool)`);
  const { key, dumperHash } = dumperKeyOf(REPO_ROOT);
  const depDirs = depDirsEnv();
  const corpusHead = corpusHeadOf(set, sha, git);
  const pick = pickMaster({ cacheRoot: cacheRoot(), set, sha, key, corpusHead, depDirs, git });
  print(pick.message);
  if (pick.kind !== "dump") return 0;
  const code = slotted(set, argv, inSlot, print);
  if (code !== undefined) return code;
  const tree = prepareTree(sha, join(dirname(cacheRoot()), "tmp"), print);
  try {
    const corpusRoot = set === "fixtures" ? join(tree, "fixtures") : (EXTERNAL_SETS[set] ?? "");
    const projects = findProjects(corpusRoot);
    const dir = entryDir(cacheRoot(), sha, set, key);
    print(`dump: ${projects.length} projects into ${dir}`);
    writeEntry({
      dir,
      manifest: {
        format: FORMAT,
        masterSha: sha,
        set,
        dumperKey: key,
        dumperHash,
        bunVersion: Bun.version,
        corpusRoot,
        corpusHead,
        depDirs,
      },
      treeRoot: tree,
      projects,
      dumper: treeDumper(tree, depDirs, print),
      print,
    });
    print(`DONE: ${dir}`);
    return 0;
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

function runDiff(
  set: string,
  argv: readonly string[],
  o: { branch: string; projects?: string; all: boolean; legacyMaster?: string; inSlot?: number },
  print: (l: string) => void,
): number {
  const git = gitIn(o.branch);
  const base = git(["merge-base", "HEAD", "origin/master"]);
  const { key } = dumperKeyOf(REPO_ROOT);
  let masterDir: string;
  if (o.legacyMaster !== undefined) {
    masterDir = join(cacheRoot(), o.legacyMaster, set);
    if (
      !existsSync(join(cacheRoot(), o.legacyMaster, "DONE")) ||
      existsSync(join(masterDir, "manifest.json"))
    ) {
      throw new RefusedError(`${masterDir} is not a legacy entry (top-level DONE, no manifest)`);
    }
    print(`master: LEGACY entry ${o.legacyMaster} (dumper unrecorded), not merge-base ${base}`);
  } else {
    const pick = pickMaster({
      cacheRoot: cacheRoot(),
      set,
      sha: base,
      key,
      corpusHead: corpusHeadOf(set, base, git),
      depDirs: depDirsEnv(),
      git,
    });
    if (pick.kind === "dump") {
      const here = join(cacheRoot(), base, set);
      const keys = existsSync(here)
        ? readdirSync(here).filter((k) => existsSync(join(here, k, "DONE")))
        : [];
      throw new RefusedError(
        `no master entry for ${base} with dumper ${key} (${pick.message}); keys present there: ${keys.join(", ") || "none"}. Run \`snapshot ${set} --master\` first.`,
      );
    }
    print(`master: ${pick.message}`);
    masterDir = pick.dir;
  }
  const master = readEntry(masterDir, set);
  const corpusRoot = set === "fixtures" ? join(o.branch, "fixtures") : (EXTERNAL_SETS[set] ?? "");
  let wanted: Set<string> | undefined;
  if (o.projects !== undefined) {
    wanted = resolveProjects(
      o.projects,
      master.index,
      new Set(master.dumps.keys()),
      new Set(findProjects(corpusRoot).map((p) => relative(corpusRoot, p))),
    );
  } else if (!o.all && set === "bch") {
    throw new RefusedError(
      "bch has hundreds of projects: name them with --projects, or pass --all",
    );
  }
  const code = slotted(set, argv, o.inSlot, print);
  if (code !== undefined) return code;
  const tmp = join(dirname(cacheRoot()), "tmp", `branch-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const projects = findProjects(corpusRoot).filter(
      (p) => wanted === undefined || wanted.has(relative(corpusRoot, p)),
    );
    const dumper = realDumper(depDirsEnv());
    const branch = new Map<string, Dump>();
    for (const [n, p] of projects.entries()) {
      const out = join(tmp, `${n}.jsonl`);
      dumper(o.branch, out, p);
      branch.set(relative(corpusRoot, p), JSON.parse(readFileSync(out, "utf8")) as Dump);
    }
    const masterSide = new Map(
      [...master.dumps].filter(([rel]) => wanted === undefined || wanted.has(rel)),
    );
    const r = diffDumps(masterSide, branch, master.format);
    for (const l of r.lines) print(l);
    return r.different ? 1 : 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * `--projects`: each name is a master index (`<n>`) or a path relative to the corpus root, and must
 * name a project on at least one side. An unknown name is refused BY NAME (review r1 #3): silently
 * dropping it would print `identical` for a typo.
 */
export function resolveProjects(
  names: string,
  index: ReadonlyMap<string, string>,
  masterRels: ReadonlySet<string>,
  branchRels: ReadonlySet<string>,
): Set<string> {
  const wanted = new Set<string>();
  const unknown: string[] = [];
  for (const raw of names.split(",")) {
    const x = raw.trim().replace(/\/+$/, "");
    const rel = index.get(x) ?? x;
    if (x === "" || (!masterRels.has(rel) && !branchRels.has(rel))) unknown.push(raw);
    else wanted.add(rel);
  }
  if (unknown.length > 0) {
    throw new RefusedError(`--projects names no project on either side: ${unknown.join(", ")}`);
  }
  return wanted;
}

/** The CLI table. Strict: an unknown flag throws. */
export function parseCliArgs(argv: readonly string[]) {
  return parseCli({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      master: { type: "boolean", default: false },
      branch: { type: "string" },
      projects: { type: "string" },
      all: { type: "boolean", default: false },
      "legacy-master": { type: "string" },
      "in-slot": { type: "string" },
    },
  });
}

function main(argv: readonly string[]): number {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (e) {
    // Review r1 #7: a bad flag is a refusal (2), never "different or a dump failure" (1).
    throw new RefusedError(e instanceof Error ? e.message : String(e));
  }
  const { values, positionals } = parsed;
  const [cmd, set] = positionals;
  if (set === undefined || !SET_NAMES.includes(set)) {
    throw new RefusedError(`usage: corpus-snapshot.ts snapshot|diff <${SET_NAMES.join("|")}> ...`);
  }
  const inSlot = values["in-slot"] === undefined ? undefined : Number(values["in-slot"]);
  const outer = argv.filter((a, i) => a !== "--in-slot" && argv[i - 1] !== "--in-slot");
  const print = (l: string): void => console.log(l);
  if (cmd === "snapshot") {
    if (!values.master)
      throw new RefusedError("snapshot needs --master (branch dumps are never cached)");
    return runSnapshot(set, outer, inSlot, print);
  }
  if (cmd === "diff") {
    if (values.branch === undefined) throw new RefusedError("diff needs --branch <worktree>");
    return runDiff(
      set,
      outer,
      {
        branch: values.branch,
        all: values.all ?? false,
        ...(values.projects !== undefined ? { projects: values.projects } : {}),
        ...(values["legacy-master"] !== undefined ? { legacyMaster: values["legacy-master"] } : {}),
        ...(inSlot !== undefined ? { inSlot } : {}),
      },
      print,
    );
  }
  throw new RefusedError(`unknown command '${cmd}' (snapshot | diff)`);
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(exitCodeOf(e));
  }
}
