/**
 * R565: reads a report OUTSIDE the project from the dependency packages, so R555's preset-writer
 * rule can see what the report's procedures do (R561). Only reads: nothing is written or extracted,
 * and every entry is read by its exact name.
 *
 * Packages are searched in the folders given, in order (al-runner: the pinned platform-apps folder,
 * then `packagesDir`; bcdev and envtool: `packageCachePath`). Per app id, the first folder holding
 * the app wins, and within it the highest version; only those selected packages are read. A report
 * declared by two app ids is `ambiguous` and is not read.
 *
 * A ReadyToRun wrapper (al-runner's platform apps) is accepted only in the measured shape: a
 * top-level `readytorunappmanifest.json`, exactly one top-level `.app` entry named exactly its
 * `EmbeddedAppFileName`, whose `NavxManifest.xml` id, name, publisher and version equal the
 * `Embedded*` values and which carries `SymbolReference.json`. Anything else is `unwrap-failed`.
 *
 * Every lookup and every package that could not be used leaves a record. The records feed the
 * warning `dependency-report-source-unavailable`, `SessionReport.dependencyReportSources` and
 * `dependencySourceDigest`, which the carry rule compares (`carryRecord`, rule 1).
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ALSyntaxNode,
  type ArmEvaluation,
  type DependencyReport,
  buildSemanticContext,
  normalizeAlName,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { listPackageEntries, readPackageEntry } from "./app-package";
import { compareAppVersions } from "./app-version";
import { decodeSource } from "./baseline-snapshot";
import { readAppIdentity } from "./published-test-app";

export type DependencySourceOutcome =
  /** read (a report or an extension) */
  | "ok"
  /** read, but the parse has errors: R555's `damagedProcs` handling applies */
  | "parse-damaged"
  /** no selected package declares the report */
  | "not-found"
  /** two app ids declare it: nothing is read */
  | "ambiguous"
  /** the package declares it but carries no `src/<ReferenceSourceFileName>` entry */
  | "no-source"
  /** a package with `readytorunappmanifest.json` not in the accepted shape */
  | "unwrap-failed"
  /** a package with neither `SymbolReference.json` nor a wrapper manifest (a runtime package) */
  | "no-symbols"
  /** a package that cannot be opened, or holds one entry name twice */
  | "unreadable";

/** One lookup (`report`, `extension`) or one package that could not be used (`package`). */
export interface DependencyReportSourceRecord {
  readonly kind: "report" | "extension" | "package";
  /** the report as the project spells it (normalized name or id); absent on a package record */
  readonly report?: string;
  readonly outcome: DependencySourceOutcome;
  /** the package file name (several, comma-separated, when `ambiguous`) */
  readonly package?: string;
  /** the selected package's app id and version (the inner app's, for a wrapper) */
  readonly appId?: string;
  readonly version?: string;
  /** the entry read, or the one that was missing */
  readonly entry?: string;
  readonly entrySha256?: string;
  /** why a package could not be used */
  readonly detail?: string;
}

export interface DependencyReportReader {
  readonly lookup: (nameOrId: string) => DependencyReport | null;
  /** Every record so far, in a stable order. */
  records(): DependencyReportSourceRecord[];
}

const SYMBOLS = "SymbolReference.json";
const WRAPPER_MANIFEST = "readytorunappmanifest.json";

interface Opened {
  readonly buf: Buffer;
  readonly entries: ReadonlySet<string>;
  readonly id: string;
  readonly version: string;
}
interface Candidate extends Opened {
  readonly file: string;
  readonly dirIndex: number;
}
interface Selected extends Candidate {
  readonly reports: readonly { name: string; id: number | undefined; ref: string }[];
  readonly exts: readonly { target: string; ref: string }[];
}
type Refused = { readonly outcome: DependencySourceOutcome; readonly detail: string };

const stripBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** Entry names, refusing a package that holds one exact name twice (which one would be read?). */
function entriesOf(buf: Buffer): ReadonlySet<string> {
  const list = listPackageEntries(buf);
  const set = new Set(list);
  if (set.size !== list.length) throw new Error("the package holds an entry name twice");
  return set;
}

function entry(buf: Buffer, name: string): Buffer {
  const b = readPackageEntry(buf, name);
  if (b === null) throw new Error(`no ${name}`);
  return b;
}

function openPackage(buf: Buffer): Opened | Refused {
  try {
    const top = entriesOf(buf);
    if (top.has(WRAPPER_MANIFEST)) return unwrap(buf, top);
    if (!top.has(SYMBOLS)) return { outcome: "no-symbols", detail: `no ${SYMBOLS}` };
    const { id, version } = readAppIdentity(buf);
    compareAppVersions(version, version); // a version that does not parse is unreadable
    return { buf, entries: top, id: id.toLowerCase(), version };
  } catch (err) {
    return { outcome: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
}

function unwrap(buf: Buffer, top: ReadonlySet<string>): Opened | Refused {
  const fail = (detail: string): Refused => ({ outcome: "unwrap-failed", detail });
  const m = JSON.parse(stripBom(entry(buf, WRAPPER_MANIFEST).toString("utf8"))) as Record<
    string,
    unknown
  >;
  const want = (k: string): string | undefined => (typeof m[k] === "string" ? m[k] : undefined);
  const fileName = want("EmbeddedAppFileName");
  const apps = [...top].filter((e) => !e.includes("/") && e.toLowerCase().endsWith(".app"));
  if (apps.length !== 1) return fail(`${apps.length} top-level .app entries, not 1`);
  if (fileName === undefined || apps[0] !== fileName)
    return fail(`the inner .app is not named EmbeddedAppFileName (${String(fileName)})`);
  const inner = entry(buf, fileName);
  const entries = entriesOf(inner);
  if (!entries.has(SYMBOLS)) return fail(`the inner package has no ${SYMBOLS}`);
  let got: ReturnType<typeof readAppIdentity>;
  try {
    got = readAppIdentity(inner);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const id = want("EmbeddedAppId");
  if (
    id === undefined ||
    got.id.toLowerCase() !== id.toLowerCase() ||
    got.version !== want("EmbeddedAppVersion") ||
    got.name !== want("EmbeddedAppName") ||
    got.publisher !== want("EmbeddedAppPublisher")
  )
    return fail("the inner app's identity differs from the wrapper's Embedded* values");
  compareAppVersions(got.version, got.version);
  return { buf: inner, entries, id: got.id.toLowerCase(), version: got.version };
}

/** `Reports` and `ReportExtensions` of every namespace of a package's `SymbolReference.json`. */
function symbolsOf(c: Candidate): Selected {
  const reports: { name: string; id: number | undefined; ref: string }[] = [];
  const exts: { target: string; ref: string }[] = [];
  type Scope = {
    Reports?: { Name?: string; Id?: number; ReferenceSourceFileName?: string }[];
    ReportExtensions?: { Target?: string; ReferenceSourceFileName?: string }[];
    Namespaces?: Scope[];
  };
  const walk = (s: Scope): void => {
    for (const r of s.Reports ?? [])
      reports.push({
        name: normalizeAlName(r.Name ?? ""),
        id: r.Id,
        ref: r.ReferenceSourceFileName ?? "",
      });
    for (const r of s.ReportExtensions ?? [])
      exts.push({ target: normalizeAlName(r.Target ?? ""), ref: r.ReferenceSourceFileName ?? "" });
    for (const n of s.Namespaces ?? []) walk(n);
  };
  walk(JSON.parse(stripBom(entry(c.buf, SYMBOLS).toString("utf8"))) as Scope);
  return { ...c, reports, exts };
}

/** The packages read: per app id, the first folder holding it, then its highest version there. */
function index(dirs: readonly string[], refused: DependencyReportSourceRecord[]): Selected[] {
  const candidates: Candidate[] = [];
  for (const [dirIndex, dir] of dirs.entries()) {
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".app"));
    } catch {
      continue; // a missing folder: its reports show up as `not-found`
    }
    for (const file of names.sort()) {
      let got: Opened | Refused;
      try {
        got = openPackage(readFileSync(join(dir, file)));
      } catch (err) {
        got = { outcome: "unreadable", detail: err instanceof Error ? err.message : String(err) };
      }
      if ("outcome" in got)
        refused.push({ kind: "package", package: file, outcome: got.outcome, detail: got.detail });
      else candidates.push({ ...got, file, dirIndex });
    }
  }
  const best = new Map<string, Candidate>();
  for (const c of candidates) {
    const b = best.get(c.id);
    if (
      b === undefined ||
      c.dirIndex < b.dirIndex ||
      (c.dirIndex === b.dirIndex && compareAppVersions(c.version, b.version) > 0)
    )
      best.set(c.id, c);
  }
  const out: Selected[] = [];
  for (const c of [...best.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    try {
      out.push(symbolsOf(c));
    } catch (err) {
      refused.push({
        kind: "package",
        package: c.file,
        outcome: "unreadable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Every `#if` arm of a dependency file is active: no arm map is known for its build. */
const ALL_ACTIVE: ArmEvaluation = { kind: "decided", inactive: [] };

export function dependencyReportReader(dirs: readonly string[]): DependencyReportReader {
  const records: DependencyReportSourceRecord[] = [];
  let selected: Selected[] | undefined;
  const memo = new Map<string, DependencyReport | null>();
  const read = (
    p: Selected,
    ref: string,
  ): { entry: string; root?: ALSyntaxNode; sha?: string; outcome: DependencySourceOutcome } => {
    const name = `src/${ref}`;
    if (ref === "" || !p.entries.has(name)) return { entry: name, outcome: "no-source" };
    const bytes = entry(p.buf, name);
    const root = wrapRoot(parseAL(decodeSource(bytes)));
    return {
      entry: name,
      root,
      sha: createHash("sha256").update(bytes).digest("hex"),
      outcome: root.hasError ? "parse-damaged" : "ok",
    };
  };
  const lookupUncached = (x: string): DependencyReport | null => {
    selected ??= index(dirs, records);
    const byId = /^\d+$/.test(x);
    const hits = selected.flatMap((p) =>
      p.reports.filter((r) => (byId ? r.id === Number(x) : r.name === x)).map((r) => ({ p, r })),
    );
    const first = hits[0];
    if (first === undefined) {
      records.push({ kind: "report", report: x, outcome: "not-found" });
      return null;
    }
    // one package per app id is selected, so two hits are two apps
    if (hits.length > 1) {
      const pkgs = [...new Set(hits.map((h) => h.p.file))].sort().join(", ");
      records.push({ kind: "report", report: x, outcome: "ambiguous", package: pkgs });
      return null;
    }
    const { p, r } = first;
    const pkg = { package: p.file, appId: p.id, version: p.version };
    const base = read(p, r.ref);
    records.push({
      kind: "report",
      report: x,
      outcome: base.outcome,
      ...pkg,
      entry: base.entry,
      ...(base.sha !== undefined ? { entrySha256: base.sha } : {}),
    });
    if (base.root === undefined) return null;
    const files = [{ path: `${p.file}:${base.entry}`, root: base.root }];
    for (const q of selected)
      for (const e of q.exts) {
        if (e.target !== r.name) continue;
        const got = read(q, e.ref);
        records.push({
          kind: "extension",
          report: x,
          outcome: got.outcome,
          package: q.file,
          appId: q.id,
          version: q.version,
          entry: got.entry,
          ...(got.sha !== undefined ? { entrySha256: got.sha } : {}),
        });
        if (got.root !== undefined) files.push({ path: `${q.file}:${got.entry}`, root: got.root });
      }
    const arms = new Map(files.map((f) => [f.root, ALL_ACTIVE] as const));
    const ctx = { ...buildSemanticContext(files, arms), allReportsExtended: true };
    return { name: r.name, roots: files.map((f) => f.root), ctx };
  };
  return {
    lookup: (x) => {
      if (memo.has(x)) return memo.get(x) ?? null;
      const got = lookupUncached(x);
      memo.set(x, got);
      return got;
    },
    records: () => [...records].sort((a, b) => recordLine(a).localeCompare(recordLine(b))),
  };
}

/** One record as the digest reads it: every field but `detail`. */
function recordLine(r: DependencyReportSourceRecord): string {
  return JSON.stringify([
    r.kind,
    r.report ?? null,
    r.outcome,
    r.package ?? null,
    r.appId ?? null,
    r.version ?? null,
    r.entry ?? null,
    r.entrySha256 ?? null,
  ]);
}

/** R565: `dependencySourceSha256`, over every record (plan r2 item 5). */
export function dependencySourceDigest(records: readonly DependencyReportSourceRecord[]): string {
  return createHash("sha256").update(records.map(recordLine).sort().join("\n")).digest("hex");
}

/** The warning text for a record that is not `ok`. */
export function dependencySourceWarning(r: DependencyReportSourceRecord): string {
  if (r.kind === "package")
    return `[lethal] dependency package ${r.package} was not read (${r.outcome}: ${r.detail ?? ""}), so no report in it is checked for preset writers (R565).`;
  const where = r.package !== undefined ? ` in ${r.package}` : "";
  const what =
    r.kind === "extension" ? `a reportextension of report "${r.report}"` : `report "${r.report}"`;
  return `[lethal] ${what}: dependency source ${r.outcome}${where}${r.entry !== undefined ? ` (${r.entry})` : ""}. A call to it from the project is checked against what was read, as before R565 when nothing was (R561).`;
}
