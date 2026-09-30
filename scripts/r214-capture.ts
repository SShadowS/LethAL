// R-214's capture tool (lifted from the plan's scratch `sites.ts`, SHA-256 prefix 6f95c8b1, with
// `--listing` added and the default `--repo` made this checkout). It is the one instrument both
// halves of R-214's pre-commitment use: Task 1 ran it on master, Task 9 runs it on the branch.
//
//   bun scripts/r214-capture.ts <project> [--symbols A,B] [--repo <worktree>]
//       [--raw-out <file> --raw-files <regions.json>]
//   bun scripts/r214-capture.ts --listing <dir> --label <c>.<i> --from-expected <capture.txt>
//       --presence <presence.txt> --regions <regions.json> --root <corpus root>
//
// Capture mode runs `generateMutationSet` on whatever engine `--repo` holds (`--symbols` is passed
// as `preprocessorSymbols`; an engine without that option ignores it), then an offline
// `writeInstrumentedProject`, and prints one row per DEPLOYED mutant: `file:line`, operator,
// `proc=`, `hang=`, the serialized identity key, `start-end`, `grain=`, `plat=`; header
// `raw N deployed M skippedFiles K`. On stderr: the skipped files and `maxRSS_KB` at exit.
// `--raw-out` writes the raw (pre-dedup) spec rows of the files named in `--raw-files`.
//
// Listing mode writes `<c>.<i>.files.tsv` (one line per file with at least one row: path, row
// count, SHA-256 of that file's rows) and `<c>.<i>.rows.tsv.gz` (every row of every file WITH a
// directive line, one `EXCLUDED <reason>` row per classified exclusion, one
// `INACTIVE <file> <startLine>-<endLine>` row per inactive range). Each starts with a header line:
// corpus, set index, symbols, `hashTargetSource(root, [])`, and the root's git HEAD or `none`.
//
// No source text is printed or written anywhere: keys hold an AST hash and names only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const need = (name: string): string => {
  const v = flag(name);
  if (v === undefined) throw new Error(`r214-capture: ${name} is required`);
  return v;
};
const repo = flag("--repo") ?? join(import.meta.dir, "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const listingDir = flag("--listing");
if (listingDir !== undefined) {
  const label = need("--label");
  const [corpus = "", setIndex = ""] = label.split(".");
  const rowsText = readFileSync(need("--from-expected"), "utf8").split("\n").slice(1);
  const presence = readFileSync(need("--presence"), "utf8").split("\n");
  const regions = JSON.parse(readFileSync(need("--regions"), "utf8")) as {
    symbols: string[];
    files: Record<string, { inactive: [number, number][]; undecided: string | null }>;
  };
  const root = need("--root");
  const { hashTargetSource, hashSourceSnapshot, targetAlFiles } = await import(
    `${repo}/packages/runner/src/baseline-snapshot`
  );
  // A root with no app.json (the BC.History corpora) cannot use hashTargetSource, which reads
  // app.json: the same hash is then taken over the `.al` files alone, and the header says so.
  const sourceHash = async (): Promise<string> => {
    if (existsSync(join(root, "app.json")))
      return `hashTargetSource ${await hashTargetSource(root, [])}`;
    const snap = new Map<string, Buffer>();
    for (const rel of await targetAlFiles(root)) snap.set(rel, readFileSync(join(root, rel)));
    return `hashSourceSnapshot(al-only,no-app.json) ${hashSourceSnapshot(snap, [])}`;
  };
  let head = "none";
  try {
    head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* not a git checkout */
  }
  const header = `# corpus ${corpus} set ${setIndex} symbols [${regions.symbols.join(",")}] ${await sourceHash()} git ${head}`;
  const byFile = new Map<string, string[]>();
  for (const l of rowsText) {
    if (l.trim() === "") continue;
    const site = l.split("\t")[0] ?? "";
    const file = site.slice(0, site.lastIndexOf(":"));
    byFile.set(file, [...(byFile.get(file) ?? []), l]);
  }
  const files = [header];
  for (const [file, rs] of byFile)
    files.push(`${file}\t${rs.length}\t${sha(rs.map((r) => `${r}\n`).join(""))}`);
  // T1-h (R-214 pre-commitment, 2026-09-30): with --directive-members-only, a directive file's
  // rows are listed only when they start inside a MEMBER (procedure, trigger, split procedure)
  // that holds a directive line; the file's other rows stay pinned by files.tsv's digest and count.
  const membersOnly = args.includes("--directive-members-only");
  const { initParser, parseAL } = await import(`${repo}/packages/engine/src/ast/parser`);
  const { visit, wrapRoot } = await import(`${repo}/packages/engine/src/ast/syntax-node`);
  if (membersOnly) await initParser();
  const MEMBER = new Set([
    "procedure",
    "trigger_declaration",
    "preproc_split_procedure",
    "preproc_split_procedure_preamble",
  ]);
  const DIRECTIVE_LINE = /^[ \t]*#[ \t]*(if|elif|else|endif|define|undef)(?![A-Za-z0-9_])/gim;
  const holdingSpans = (src: string): [number, number][] => {
    const text = src.replace(/^\uFEFF/, " ");
    const at = [...text.matchAll(DIRECTIVE_LINE)].map((m) => m.index ?? 0);
    const spans: [number, number][] = [];
    visit(
      wrapRoot(parseAL(src)),
      (n: { rawKind: string; startIndex: number; endIndex: number }) => {
        if (MEMBER.has(n.rawKind) && at.some((o) => n.startIndex <= o && o < n.endIndex))
          spans.push([n.startIndex, n.endIndex]);
      },
    );
    return spans;
  };
  let listedRows = 0;
  const rows = [header];
  for (const file of Object.keys(regions.files).sort()) {
    const src = readFileSync(join(root, file), "utf8");
    let fileRows = byFile.get(file) ?? [];
    if (membersOnly) {
      const spans = holdingSpans(src);
      fileRows = fileRows.filter((r) => {
        const start = Number((r.split("\t")[5] ?? "").split("-")[0]);
        return spans.some(([a, b]) => a <= start && start < b);
      });
    }
    listedRows += fileRows.length;
    rows.push(...fileRows);
    const lineAt = (offset: number) => {
      let n = 1;
      for (let k = src.indexOf("\n"); k >= 0 && k < offset; k = src.indexOf("\n", k + 1)) n++;
      return n;
    };
    for (const [a, b] of regions.files[file]?.inactive ?? [])
      rows.push(`INACTIVE ${file} ${lineAt(a)}-${lineAt(b - 1)}`);
  }
  for (const l of presence) if (l.startsWith("EXCLUDED ")) rows.push(l);
  mkdirSync(listingDir, { recursive: true });
  writeFileSync(join(listingDir, `${label}.files.tsv`), files.map((l) => `${l}\n`).join(""));
  writeFileSync(
    join(listingDir, `${label}.rows.tsv.gz`),
    gzipSync(rows.map((l) => `${l}\n`).join(""), { level: 9 }),
  );
  console.error(
    `listing ${label}: ${files.length - 1} files, ${rows.length - 1} rows (${listedRows} capture rows${membersOnly ? ", directive members only" : ""})`,
  );
  process.exit(0);
}

const projectDir = args[0];
if (projectDir === undefined || projectDir.startsWith("--"))
  throw new Error("usage: r214-capture.ts <project> [--symbols A,B]");
const symbolsArg = flag("--symbols");
const symbols = symbolsArg === undefined || symbolsArg === "" ? [] : symbolsArg.split(",");
const { generateMutationSet, operatorTiers } = await import(
  `${repo}/packages/runner/src/orchestrator`
);
const { identityKeyOf, serializeKey } = await import(`${repo}/packages/runner/src/selection`);
const { writeInstrumentedProject } = await import(`${repo}/packages/schemata/src/project`);

const out = await mkdtemp(join(tmpdir(), "r214-sites-"));
const set = await generateMutationSet(projectDir, { preprocessorSymbols: symbols });
await writeInstrumentedProject({
  targetDir: out,
  files: set.files,
  selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
  artifactId: "0123456789abcdef0123456789abcdef",
  targetAppId: "00000000-0000-0000-0000-000000000000",
  operatorTiers,
});
const m = JSON.parse(await readFile(join(out, "mutant-manifest.json"), "utf8"));
const raw = set.files.reduce((n: number, f: { specs: unknown[] }) => n + f.specs.length, 0);
console.log(`raw ${raw} deployed ${m.mutants.length} skippedFiles ${set.skipped.length}`);
type E = {
  file: string;
  startLine: number;
  operatorName: string;
  startIndex: number;
  endIndex: number;
  procedureName: string;
  hangCapable?: string;
  reachGrain?: string;
  platformKillMechanism?: string;
};
for (const e of [...(m.mutants as E[])].sort(
  (a, b) =>
    a.file.localeCompare(b.file) ||
    a.startLine - b.startLine ||
    a.operatorName.localeCompare(b.operatorName) ||
    a.startIndex - b.startIndex,
))
  console.log(
    `${e.file.replaceAll("\\", "/")}:${e.startLine}\t${e.operatorName}\tproc=${e.procedureName === "" ? "<none>" : e.procedureName}\thang=${e.hangCapable ?? "-"}\t${serializeKey(identityKeyOf(e))}\t${e.startIndex}-${e.endIndex}\tgrain=${e.reachGrain ?? "-"}\tplat=${e.platformKillMechanism ?? "-"}`,
  );
const rawOut = flag("--raw-out");
const rawFilesPath = flag("--raw-files");
if (rawOut !== undefined && rawFilesPath !== undefined) {
  const wanted = new Set(Object.keys(JSON.parse(readFileSync(rawFilesPath, "utf8")).files));
  const lines: string[] = [];
  type F = {
    path: string;
    specs: { operatorName: string; before: { startIndex: number; endIndex: number } }[];
  };
  for (const f of set.files as F[]) {
    const file = f.path.replaceAll("\\", "/");
    if (!wanted.has(file)) continue;
    for (const sp of f.specs)
      lines.push(
        ["R", file, `${sp.before.startIndex}-${sp.before.endIndex}`, sp.operatorName].join("\t"),
      );
  }
  writeFileSync(rawOut, lines.map((l) => `${l}\n`).join(""));
}
for (const s of set.skipped as { file: string; sites: number }[])
  console.error(["SKIPPED", s.file.replaceAll("\\", "/"), s.sites].join("\t"));
console.error(`maxRSS_KB ${process.resourceUsage().maxRSS}`);
await rm(out, { recursive: true, force: true });
