/**
 * Generates the repo-root `ROADMAP.md` index from the one-file-per-row store under
 * `docs/roadmap/`.
 *
 * WHY THIS EXISTS. The roadmap used to be a single markdown table, 311 KB and 116 rows, whose
 * cells contain unescaped inline pipes. Reading it cost ~78K tokens for a question ("is this
 * already filed?") that only needs titles, and a field-wise read on `|` silently returned a
 * fraction of a row while looking complete — ROADMAP R118, which cost two wrong versions of a
 * shipped skill. One file per row makes that truncation impossible by construction.
 *
 * `ROADMAP.md` is GENERATED. Never hand-edit it: edit `docs/roadmap/R<nnn>.md` (or the header
 * prose in `docs/roadmap/_template.md`) and re-run this script. A hand-maintained index is a
 * second copy of the data, and a second copy rots.
 *
 *   bun scripts/roadmap-index.ts            # rewrite ROADMAP.md
 *   bun scripts/roadmap-index.ts --check    # exit 1 if ROADMAP.md is not what the store implies
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A row of the roadmap: one `docs/roadmap/R<nnn>.md` file, parsed. */
export interface RoadmapRow {
  /** Stable id, e.g. `"R69"`. Never renumbered, never reused. */
  readonly id: string;
  /** `id` without the `R`, for sorting and for the zero-padded filename. */
  readonly numericId: number;
  /** One-line label for the index. The body is the authority; this is its handle. */
  readonly title: string;
  /** The full status prose — `open`, `done (<commit>) — <evidence>`, `blocked (<on what>)`. */
  readonly status: string;
  /** Section slug; must match a `<!-- rows: <slug> -->` marker in the template. */
  readonly section: string;
  /** Position within the section. The ordering inside a section IS the priority. */
  readonly order: number;
  /** Everything after the frontmatter: the row's full prose. */
  readonly body: string;
}

/**
 * A row file, the template, or the generated index is malformed. Extends `Error` directly (this
 * repo forbids typed errors that extend each other) and always names the offending file.
 */
export class RoadmapFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoadmapFormatError";
  }
}

/** Directory holding the row files, relative to the repo root. */
export const ROW_DIR = "docs/roadmap";
/** The hand-edited header prose + section headings + row markers. */
export const TEMPLATE_FILE = "_template.md";
/** The generated index, relative to the repo root. */
export const INDEX_FILE = "ROADMAP.md";

/** `R069.md` — zero-padded to three digits so a directory listing sorts. */
export function rowFileName(numericId: number): string {
  return `R${String(numericId).padStart(3, "0")}.md`;
}

const FRONTMATTER_KEYS = ["id", "title", "status", "section", "order"] as const;
const ROW_FILE_RE = /^R(\d{3,})\.md$/;
const ID_RE = /^R(\d+)$/;
const MARKER_RE = /^<!-- rows: ([a-z0-9-]+) -->$/;

/**
 * Parses one row file. Fails loudly on every contract violation — a plausible empty default here
 * would drop a row from the index and nothing downstream could tell.
 *
 * Frontmatter values are JSON-encoded scalars (a valid YAML double-quoted scalar, and something
 * this parser can read back without a YAML dependency). Row prose is single-line in origin and
 * may contain quotes, backslashes and pipes; JSON encoding makes all three unambiguous.
 */
export function parseRowFile(text: string, sourceName: string): RoadmapRow {
  if (!text.startsWith("---\n")) {
    throw new RoadmapFormatError(`${sourceName}: does not start with a '---' frontmatter fence`);
  }
  const end = text.indexOf("\n---\n", 3);
  if (end < 0) {
    throw new RoadmapFormatError(`${sourceName}: frontmatter is not closed by a '---' line`);
  }
  const fields = new Map<string, unknown>();
  for (const line of text.slice(4, end + 1).split("\n")) {
    if (line === "") continue;
    const colon = line.indexOf(": ");
    if (colon < 0) {
      throw new RoadmapFormatError(`${sourceName}: frontmatter line is not 'key: value': ${line}`);
    }
    const key = line.slice(0, colon);
    if (!(FRONTMATTER_KEYS as readonly string[]).includes(key)) {
      throw new RoadmapFormatError(
        `${sourceName}: unknown frontmatter key '${key}' (expected ${FRONTMATTER_KEYS.join(", ")})`,
      );
    }
    if (fields.has(key)) throw new RoadmapFormatError(`${sourceName}: duplicate key '${key}'`);
    let value: unknown;
    try {
      value = JSON.parse(line.slice(colon + 2));
    } catch {
      throw new RoadmapFormatError(`${sourceName}: '${key}' is not a JSON-encoded scalar`);
    }
    fields.set(key, value);
  }
  for (const key of FRONTMATTER_KEYS) {
    if (!fields.has(key)) throw new RoadmapFormatError(`${sourceName}: missing '${key}'`);
  }
  const [id, title, status, section, order] = FRONTMATTER_KEYS.map((k) => fields.get(k));
  for (const [key, value] of [
    ["id", id],
    ["title", title],
    ["status", status],
    ["section", section],
  ] as const) {
    if (typeof value !== "string" || value === "") {
      throw new RoadmapFormatError(`${sourceName}: '${key}' must be a non-empty string`);
    }
  }
  if (typeof order !== "number" || !Number.isInteger(order)) {
    throw new RoadmapFormatError(`${sourceName}: 'order' must be an integer`);
  }
  // The four string reads above are guarded by the loop; re-narrow for the type system.
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof status !== "string" ||
    typeof section !== "string"
  ) {
    throw new RoadmapFormatError(`${sourceName}: frontmatter types are not as validated`);
  }
  const idMatch = ID_RE.exec(id);
  if (idMatch === null) throw new RoadmapFormatError(`${sourceName}: id '${id}' is not R<n>`);
  const [, digits] = idMatch;
  if (digits === undefined) throw new RoadmapFormatError(`${sourceName}: id '${id}' has no digits`);

  const body = text
    .slice(end + 5)
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  if (body === "") throw new RoadmapFormatError(`${sourceName}: has no body prose`);

  return { id, numericId: Number(digits), title, status, section, order, body };
}

/**
 * Drops the tail of `s` back past any opener a truncation left unclosed — an odd backtick, then a
 * `(` with no `)`. Both render as garbage in a markdown list otherwise.
 */
function trimToBalanced(s: string): string {
  let out = s;
  if ((out.match(/`/g) ?? []).length % 2 === 1) out = out.slice(0, out.lastIndexOf("`"));
  let depth = 0;
  let outermost = -1;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === "(") {
      if (depth === 0) outermost = i;
      depth += 1;
    } else if (out[i] === ")" && depth > 0) {
      depth -= 1;
    }
  }
  if (depth > 0 && outermost >= 0) out = out.slice(0, outermost);
  return out.replace(/[\s—,;:-]+$/u, "");
}

/**
 * Shortens a status for the index line. The row file keeps the full text; this is display only.
 *
 * Deliberately ONE rule — truncate on a word boundary — rather than "cut at the first ` — `".
 * That looked tidier and was worse: `done (2026-07-26 — 3 killed / 10 survived / 3 no-coverage)`
 * became `done (2026-07-26`, losing the measurement and an unbalanced paren with it.
 *
 * `**` is stripped unconditionally so the index line's ONLY bold span is its `**R<n>**` id —
 * `packages/runner/tests/interpretation.test.ts` scans the generated file for exactly that shape
 * to resolve every shipped `basis:` value.
 */
export function shortStatus(status: string, max = 110): string {
  const full = status.replaceAll("**", "").trim();
  if (full.length <= max) return full;
  const space = full.lastIndexOf(" ", max - 1);
  return `${trimToBalanced(full.slice(0, space > 0 ? space : max - 1))}…`;
}

/** One index line. `·` separates the fields; titles are full of em dashes, so `—` cannot. */
export function indexLine(row: RoadmapRow): string {
  const title = row.title.replaceAll("**", "").trim();
  const file = rowFileName(row.numericId);
  return `- **${row.id}** · ${title} · [${file}](${ROW_DIR}/${file}) · ${shortStatus(row.status)}`;
}

/**
 * Substitutes each `<!-- rows: <slug> -->` marker in the template with its section's index lines.
 *
 * Then asserts the property the whole scheme rests on: the set of `**R<n>**` spans in the output
 * is EXACTLY the set of row ids. `packages/runner/tests/interpretation.test.ts` resolves all 26
 * shipped `basis:` values against that scan, so an id the scan cannot see is a shipped
 * interpretation citing nothing, and an id the scan invents is a citation that resolves falsely.
 */
export function renderIndex(template: string, rows: readonly RoadmapRow[]): string {
  const byId = new Map<string, RoadmapRow>();
  for (const row of rows) {
    const clash = byId.get(row.id);
    if (clash !== undefined) {
      throw new RoadmapFormatError(`duplicate row id '${row.id}' (ids are never reused)`);
    }
    byId.set(row.id, row);
  }
  const bySection = new Map<string, RoadmapRow[]>();
  for (const row of rows) {
    const list = bySection.get(row.section);
    if (list === undefined) bySection.set(row.section, [row]);
    else list.push(row);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of template.split("\n")) {
    const marker = MARKER_RE.exec(line);
    if (marker === null) {
      out.push(line);
      continue;
    }
    const [, slug] = marker;
    if (slug === undefined) throw new RoadmapFormatError(`${TEMPLATE_FILE}: unreadable marker`);
    if (seen.has(slug)) {
      throw new RoadmapFormatError(`${TEMPLATE_FILE}: section '${slug}' has two row markers`);
    }
    seen.add(slug);
    const section = [...(bySection.get(slug) ?? [])].sort(
      (a, b) => a.order - b.order || a.numericId - b.numericId,
    );
    for (const row of section) out.push(indexLine(row));
  }

  for (const slug of bySection.keys()) {
    if (!seen.has(slug)) {
      throw new RoadmapFormatError(
        `section '${slug}' is declared by a row file but has no '<!-- rows: ${slug} -->' marker in ${TEMPLATE_FILE}`,
      );
    }
  }

  const rendered = `${out.join("\n").replace(/\n+$/, "")}\n`;
  const scanned = [...rendered.matchAll(/\*\*(R\d+)\*\*/g)].map(([, id]) => id);
  const missing = [...byId.keys()].filter((id) => !scanned.includes(id));
  if (missing.length > 0) {
    throw new RoadmapFormatError(
      `generated index does not expose ${missing.join(", ")} as **R<n>**`,
    );
  }
  const phantom = scanned.filter((id) => id !== undefined && !byId.has(id));
  if (phantom.length > 0) {
    throw new RoadmapFormatError(
      `generated index exposes ${phantom.join(", ")} as **R<n>** with no row file behind it`,
    );
  }
  return rendered;
}

/** Reads and parses every `R<nnn>.md` under `dir`, refusing a filename that disagrees with its id. */
export function readRows(dir: string): RoadmapRow[] {
  const rows: RoadmapRow[] = [];
  for (const name of readdirSync(dir).sort()) {
    const match = ROW_FILE_RE.exec(name);
    if (match === null) continue;
    const row = parseRowFile(readFileSync(join(dir, name), "utf8"), `${ROW_DIR}/${name}`);
    if (rowFileName(row.numericId) !== name) {
      throw new RoadmapFormatError(
        `${ROW_DIR}/${name}: declares id '${row.id}', which belongs in ${rowFileName(row.numericId)}`,
      );
    }
    rows.push(row);
  }
  if (rows.length === 0) throw new RoadmapFormatError(`${dir}: no R<nnn>.md row files found`);
  return rows;
}

/** Builds the index from a repo root. Returns the text; writing is the caller's decision. */
export function buildIndex(repoRoot: string): string {
  const dir = join(repoRoot, ROW_DIR);
  return renderIndex(readFileSync(join(dir, TEMPLATE_FILE), "utf8"), readRows(dir));
}

function main(argv: readonly string[]): number {
  const repoRoot = join(import.meta.dir, "..");
  const indexPath = join(repoRoot, INDEX_FILE);
  const generated = buildIndex(repoRoot);
  if (argv.includes("--check")) {
    const onDisk = readFileSync(indexPath, "utf8");
    if (onDisk === generated) {
      console.log(`${INDEX_FILE} is up to date`);
      return 0;
    }
    console.error(
      `${INDEX_FILE} does not match ${ROW_DIR}/. It is GENERATED — run 'bun scripts/roadmap-index.ts'.`,
    );
    return 1;
  }
  writeFileSync(indexPath, generated);
  // byteLength, not .length: this index is full of em dashes and `·`, so the two differ by ~800.
  const rows = readRows(join(repoRoot, ROW_DIR)).length;
  console.log(`${INDEX_FILE}: ${Buffer.byteLength(generated)} bytes from ${rows} rows`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
