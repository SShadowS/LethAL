/**
 * R131: what al-runner's artifact cache costs on this machine, READ and never touched.
 *
 * al-runner resolves a project's BC version by PREFIX (`--auto-provision` prints
 * `[provision] Resolving BC version prefix '28.0'... Resolved: 28.0 -> 28.0.46665.53508`), so every
 * upstream Microsoft publish adds a directory rather than reusing one. Only the newest within a
 * prefix is ever selected again. Measured on this machine: three 28.0 directories on 2026-08-09,
 * SEVEN on 2026-08-14 (~117-137 MB each) plus one 28.1 (~358 MB), 1.3 GB total, from a handful of
 * gate runs over five days.
 *
 * ## Why this REPORTS and does not clean
 *
 * R131 weighed three options and this module implements the one that cannot be wrong. Deleting
 * directories LethAL did not create, out of a cache al-runner owns, is a destructive operation on
 * shared state: another tool on the machine may be pinned to one of them with `--bc-version`, and
 * LethAL has no way to know. A retention policy belongs upstream, in the tool that writes the
 * cache. What LethAL can honestly do is say how big it has grown and which builds are superseded,
 * and leave the decision to the operator.
 *
 * Nothing here writes, deletes, or spawns anything. It reads a directory tree and adds up sizes.
 *
 * ## "Superseded" is a claim about SELECTION, not about safety
 *
 * A build is superseded when a NEWER build shares its `MAJOR.MINOR` prefix, because that is the
 * prefix al-runner resolves forward. It does NOT mean the directory is unused: a run pinned with
 * `--bc-version` selects an exact build whatever its age. So the report names them and stops there.
 */
import { stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** One provisioned BC build in the cache. */
export interface AlRunnerCacheBuild {
  /** Directory name, e.g. `"28.0.46665.53508"` — al-runner's own key. */
  readonly version: string;
  readonly bytes: number;
  /** True when a NEWER build shares this one's `MAJOR.MINOR` prefix — see the module doc comment
   *  for why that is a statement about selection and not about safety. */
  readonly superseded: boolean;
}

export interface AlRunnerCacheReport {
  readonly dir: string;
  /** False when the directory does not exist — a machine that has never run al-runner. Reported
   *  rather than skipped: "no cache" and "a cache nobody measured" must not look alike. */
  readonly present: boolean;
  readonly totalBytes: number;
  /** Newest first, so the one al-runner will select again reads first. */
  readonly builds: readonly AlRunnerCacheBuild[];
}

/** al-runner's default artifact root. It also accepts `--cache DIR`; a caller that knows a
 *  different root passes it in rather than this module guessing. */
export function defaultAlRunnerCacheDir(): string {
  return join(homedir(), ".local", "share", "al-runner", "artifacts");
}

/** Numeric, component-wise. `28.0.46665.53508` must sort above `28.0.46665.53492`, which a string
 *  comparison gets right only by accident and gets wrong the moment a component gains a digit. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0);
    const nb = Number(pb[i] ?? 0);
    if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
    if (na !== nb) return na - nb;
  }
  return 0;
}

/** `28.0.46665.53508` -> `28.0`, the prefix `--auto-provision` resolves forward. */
function prefixOf(version: string): string {
  return version.split(".").slice(0, 2).join(".");
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  // Paths, not `Dirent`s: a recursive `readdir` returns each entry's path RELATIVE to `dir`, which
  // is all this needs and avoids depending on which of `parentPath`/`path` the runtime spells.
  const entries = await readdir(dir, { recursive: true });
  for (const rel of entries) {
    try {
      const st = await stat(join(dir, rel));
      if (st.isFile()) total += st.size;
    } catch {
      // A file that vanished between listing and stat (al-runner provisioning concurrently) is
      // not an error for a size REPORT — it is one file's bytes, and refusing the whole report
      // over it would be worse than being slightly low.
    }
  }
  return total;
}

/**
 * Read the cache. Never throws for an absent directory — that is a normal answer, reported as
 * `present: false` — but a directory that exists and cannot be read DOES throw, because a report
 * that silently said "0 bytes" for an unreadable cache is exactly the empty-vs-empty agreement
 * this project refuses to ship.
 */
export async function readAlRunnerCache(dir?: string): Promise<AlRunnerCacheReport> {
  const root = dir ?? defaultAlRunnerCacheDir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { dir: root, present: false, totalBytes: 0, builds: [] };
    }
    throw err;
  }
  const versions: string[] = [];
  for (const name of entries) {
    const full = join(root, String(name));
    const st = await stat(full).catch(() => null);
    if (st?.isDirectory() === true) versions.push(String(name));
  }
  const newestByPrefix = new Map<string, string>();
  for (const v of versions) {
    const p = prefixOf(v);
    const current = newestByPrefix.get(p);
    if (current === undefined || compareVersions(v, current) > 0) newestByPrefix.set(p, v);
  }
  const builds: AlRunnerCacheBuild[] = [];
  for (const version of versions.sort((a, b) => compareVersions(b, a))) {
    builds.push({
      version,
      bytes: await directoryBytes(join(root, version)),
      superseded: newestByPrefix.get(prefixOf(version)) !== version,
    });
  }
  return {
    dir: root,
    present: true,
    totalBytes: builds.reduce((n, b) => n + b.bytes, 0),
    builds,
  };
}

/** Human-readable size. Binary units, one decimal, because the numbers this reports are hundreds
 *  of MB and a whole-number GB would hide a doubling. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * The one-line summary `lethal doctor` prints. Names the total, the build count, how much sits in
 * superseded builds, and WHOSE cache it is — a reader who sees a number without being told LethAL
 * will not clean it has been handed a chore with no owner.
 */
export function describeAlRunnerCache(report: AlRunnerCacheReport): string {
  if (!report.present) {
    return `no al-runner artifact cache at ${report.dir} (nothing has provisioned one on this machine)`;
  }
  if (report.builds.length === 0) {
    return `${report.dir} exists but holds no BC build directories`;
  }
  const superseded = report.builds.filter((b) => b.superseded);
  const supersededBytes = superseded.reduce((n, b) => n + b.bytes, 0);
  const head = `${formatBytes(report.totalBytes)} across ${report.builds.length} BC build(s) in ${report.dir}`;
  if (superseded.length === 0) {
    return `${head}; none superseded`;
  }
  const names = superseded.map((b) => b.version).join(", ");
  const ruling =
    "al-runner resolves a version PREFIX forward, so these will not be selected again unless a run pins one with `--bc-version`. This cache belongs to al-runner and LethAL will not delete from it (ROADMAP R131) — remove them yourself if you want the space back.";
  return `${head}; ${superseded.length} superseded (${formatBytes(supersededBytes)}): ${names}. ${ruling}`;
}
