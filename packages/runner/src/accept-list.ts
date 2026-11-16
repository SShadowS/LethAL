// PR-79: the accept list. A team writes `lethal.accepted.json` to say "this survivor on a changed line
// is acceptable". An entry accepts a survivor only while the survivor's own lines, its whole member
// (procedure or trigger, with its attributes) and its build are unchanged. Spec:
// docs/superpowers/specs/2026-11-16-pr79-accept-list.md
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ALNodeKind,
  type ALSyntaxNode,
  attributeRun,
  initParser,
  isObjectContainer,
  isProcedureLike,
  parseAL,
  spanText,
  wrapRoot,
} from "@lethal/engine";
import { clipMutationText } from "@lethal/schemata";
import { decodeSource } from "./baseline-snapshot";
import { SURVIVING_VERDICTS } from "./equivalence-marks";
import { markTupleOfRow, mutantRef } from "./report";
import type { MutantOutcome } from "./report";

export const ACCEPT_LIST_FILENAME = "lethal.accepted.json";

/** The `reason` a ready entry is printed with. The parser refuses it unchanged. */
export const ACCEPT_REASON_PLACEHOLDER = "TODO: write why this survivor is acceptable";

export class AcceptListError extends Error {}

export interface AcceptEntry {
  readonly file: string;
  readonly tuple: string;
  readonly lineInProcedure: number;
  readonly column: number;
  readonly siteText: string;
  readonly procedureText: string;
  readonly preprocessorSymbols: readonly string[];
  readonly reason: string;
  readonly acceptedBy?: string;
  readonly acceptedOn?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

const symbolsOf = (s: readonly string[]): string[] => [...new Set(s)].sort();

/** The anchor of an entry or a row: every field an entry is matched on (not `reason`). */
function anchorKey(
  file: string,
  tuple: string,
  lineInProcedure: number,
  column: number,
  siteText: string,
  procedureText: string,
  symbols: readonly string[],
): string {
  return JSON.stringify([
    file.toLowerCase(),
    tuple,
    lineInProcedure,
    column,
    siteText,
    procedureText,
    symbolsOf(symbols),
  ]);
}

/**
 * Parse the accept file. Throws `AcceptListError` on anything malformed instead of skipping the bad
 * entry: a list that silently loaded 4 of its 5 entries would re-open a survivor nobody knows was
 * accepted, or worse, hide which one.
 */
export function parseAcceptList(text: string, sourceName: string): AcceptEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new AcceptListError(
      `${sourceName}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AcceptListError(
      `${sourceName}: expected an object with an "accepted" array, got ${Array.isArray(raw) ? "an array" : typeof raw}`,
    );
  }
  const list = (raw as { accepted?: unknown }).accepted;
  if (!Array.isArray(list)) {
    throw new AcceptListError(`${sourceName}: missing required "accepted" array`);
  }
  const seen = new Map<number, string>();
  return list.map((entry, i) => {
    const at = `${sourceName}: accepted[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new AcceptListError(`${at}: expected an object`);
    }
    const e = entry as Record<string, unknown>;
    const file = e.file;
    if (typeof file !== "string" || file.trim() === "") {
      throw new AcceptListError(`${at}: "file" is required and must be a non-empty string`);
    }
    if (file.includes("\\")) {
      throw new AcceptListError(`${at}: "file" must use "/" as the separator, got ${file}`);
    }
    const tuple = e.tuple;
    if (typeof tuple !== "string" || tuple.split("|").length < 5) {
      throw new AcceptListError(
        `${at}: "tuple" is required: astHash|object|procedure|operator|major, as \`lethal run\` prints it. Got: ${JSON.stringify(tuple)}`,
      );
    }
    const nonNegative = (k: "lineInProcedure" | "column"): number => {
      const v = e[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new AcceptListError(
          `${at}: "${k}" is required and must be an integer of 0 or more. Got: ${JSON.stringify(v)}`,
        );
      }
      return v;
    };
    const lineInProcedure = nonNegative("lineInProcedure");
    const column = nonNegative("column");
    const hex = (k: "siteText" | "procedureText"): string => {
      const v = e[k];
      if (typeof v !== "string" || !HEX64.test(v)) {
        throw new AcceptListError(
          `${at}: "${k}" is required and must be 64 lowercase hex characters (a sha256, as \`lethal run\` prints it). Got: ${JSON.stringify(v)}`,
        );
      }
      return v;
    };
    const siteText = hex("siteText");
    const procedureText = hex("procedureText");
    let symbols: string[] = [];
    if (e.preprocessorSymbols !== undefined) {
      const given = e.preprocessorSymbols;
      if (!Array.isArray(given) || !given.every((s) => typeof s === "string" && s.trim() !== "")) {
        throw new AcceptListError(
          `${at}: "preprocessorSymbols" must be an array of non-empty strings when present. Got: ${JSON.stringify(given)}`,
        );
      }
      symbols = symbolsOf(given as string[]);
    }
    const reason = e.reason;
    if (
      typeof reason !== "string" ||
      reason.trim() === "" ||
      reason.trim() === ACCEPT_REASON_PLACEHOLDER
    ) {
      throw new AcceptListError(
        `${at}: "reason" is required and must be non-empty, and not the placeholder \`lethal run\` prints. An accepted survivor without a stated reason is an unexplained subtraction from the survivor list, and nobody can review it later.`,
      );
    }
    for (const k of ["acceptedBy", "acceptedOn"] as const) {
      if (e[k] !== undefined && typeof e[k] !== "string") {
        throw new AcceptListError(`${at}: "${k}" must be a string when present`);
      }
    }
    const key = anchorKey(file, tuple, lineInProcedure, column, siteText, procedureText, symbols);
    const id = [...seen.entries()].find(([, k]) => k === key);
    if (id !== undefined) {
      throw new AcceptListError(
        `${at}: the same anchor as accepted[${id[0]}] (file, tuple, place, both texts and symbols), so two entries claim one survivor. Remove one; picking one silently is the guess this project refuses.`,
      );
    }
    seen.set(i, key);
    const acceptedBy = e.acceptedBy;
    const acceptedOn = e.acceptedOn;
    return {
      file,
      tuple,
      lineInProcedure,
      column,
      siteText,
      procedureText,
      preprocessorSymbols: symbols,
      reason: reason.trim(),
      ...(typeof acceptedBy === "string" && acceptedBy.trim() !== "" ? { acceptedBy } : {}),
      ...(typeof acceptedOn === "string" && acceptedOn.trim() !== "" ? { acceptedOn } : {}),
    };
  });
}

export interface LoadedAcceptList {
  /** Where the file was looked for. */
  readonly path: string;
  /** `undefined`: no file there. */
  readonly entries: readonly AcceptEntry[] | undefined;
}

/** Read and validate the project's accept file. Absent is fine; present and malformed throws. */
export async function loadAcceptList(
  projectDir: string,
  readFileFn: (p: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<LoadedAcceptList> {
  const path = join(projectDir, ACCEPT_LIST_FILENAME);
  let text: string;
  try {
    text = await readFileFn(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { path, entries: undefined };
    throw new AcceptListError(
      `cannot read ${path}: ${err instanceof Error ? err.message : String(err)}. Remove the file to run without an accept list; an unreadable one is not treated as an absent one.`,
    );
  }
  return { path, entries: parseAcceptList(text, path) };
}

// --- Anchors -----------------------------------------------------------------------------------

interface Anchor {
  readonly file: string;
  readonly tuple: string;
  readonly lineInProcedure: number;
  readonly column: number;
  readonly siteText: string;
  readonly procedureText: string;
}

type Anchored = { readonly anchor: Anchor } | { readonly cannot: string };

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** Each line trimmed (drops `\r`, tabs, the BOM), joined by `\n`. */
const cut = (s: string): string =>
  s
    .split("\n")
    .map((l) => l.trim())
    .join("\n");

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line of `index`. */
function lineAt(starts: readonly number[], index: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((starts[mid] ?? 0) <= index) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(1, lo);
}

interface FileCtx {
  readonly text: string;
  readonly starts: readonly number[];
  root?: ALSyntaxNode;
}

/** The innermost node that covers `[s, e)`. */
function nodeAt(root: ALSyntaxNode, s: number, e: number): ALSyntaxNode {
  let n = root;
  for (;;) {
    const c = n.children.find((k) => k.startIndex <= s && k.endIndex >= e);
    if (c === undefined) return n;
    n = c;
  }
}

/** `enclosingMemberOf`'s rule (schemata): the nearest procedure-like ancestor, else the nearest trigger. */
function memberOf(node: ALSyntaxNode): ALSyntaxNode | null {
  for (let p = node.parent; p !== null; p = p.parent) if (isProcedureLike(p)) return p;
  for (let c: ALSyntaxNode | null = node; c !== null; c = c.parent) {
    if (c.kind === ALNodeKind.trigger) return c;
  }
  return null;
}

/**
 * For a trigger: the header text up to `{` of EVERY enclosing declaration between the trigger and
 * the object (field, action, control, part, dataitem, xmlport elements, `modify(...)`, ...),
 * outermost first. A header is taken whole, so a wrapped one is not read by its first line.
 */
function headerChain(member: ALSyntaxNode, text: string): string[] {
  if (member.kind !== ALNodeKind.trigger) return [];
  const out: string[] = [];
  for (let a = member.parent; a !== null; a = a.parent) {
    if (a.parent === null || isObjectContainer(a.parent)) break; // `a` is the object itself
    const brace = a.children.find((c) => c.rawKind === "{");
    if (brace !== undefined) out.push(text.slice(a.startIndex, brace.startIndex));
  }
  return out.reverse();
}

function anchorOf(row: MutantOutcome, ctx: FileCtx): Anchored {
  const { text, starts } = ctx;
  const { startIndex: s, endIndex: e } = row;
  if (!(Number.isInteger(s) && Number.isInteger(e) && 0 <= s && s < e && e <= text.length)) {
    return { cannot: "its offsets are not in this run's source of the file" };
  }
  if (clipMutationText(text.slice(s, e)) !== row.originalText) {
    return { cannot: "its original text is not the text at its offsets in this run's source" };
  }
  const { procedureStartLine: ps, procedureEndLine: pe } = row;
  if (ps === undefined || pe === undefined) return { cannot: "it has no procedure span" };
  if (
    !(Number.isInteger(ps) && Number.isInteger(pe) && 1 <= ps && ps <= pe && pe <= starts.length)
  ) {
    return { cannot: "its procedure span is outside the file" };
  }
  ctx.root ??= wrapRoot(parseAL(text));
  const member = memberOf(nodeAt(ctx.root, s, e));
  if (member === null) return { cannot: "no procedure or trigger encloses it" };
  const first = lineAt(starts, member.startIndex);
  const last = lineAt(starts, member.endIndex);
  if (first !== ps || last !== pe) {
    throw new AcceptListError(
      `${mutantRef(row.batchIndex, row.mutantCode)} (${row.file}): the member found by re-parsing this run's source spans lines ${first}-${last}, but the report says ${ps}-${pe}. An entry computed from it could never match, so nothing is printed. This is a bug in LethAL, not in your accept list.`,
    );
  }
  if (member.endIndex <= member.startIndex) return { cannot: "its procedure span is empty" };
  const run = attributeRun(member, false, member.endIndex, true);
  const procedureText = [...headerChain(member, text).map(cut), cut(spanText(text, run))].join(
    "\n",
  );
  const lastPiece = run.pieces[run.pieces.length - 1];
  if (lastPiece === undefined) return { cannot: "its procedure span is empty" };
  const siteFirst = lineAt(starts, s);
  const siteLast = lineAt(starts, e);
  const lineInProcedure = siteFirst - lineAt(starts, lastPiece[0]);
  if (lineInProcedure < 0) return { cannot: "its site is before its member" };
  const lineStart = starts[siteFirst - 1] ?? 0;
  const lineText = text.slice(lineStart, s);
  const column = Math.max(0, s - lineStart - (lineText.length - lineText.trimStart().length));
  const siteEnd = siteLast < starts.length ? (starts[siteLast] ?? text.length) - 1 : text.length;
  const siteText = cut(text.slice(starts[siteFirst - 1] ?? 0, siteEnd));
  if (siteText === "" || procedureText.trim() === "") return { cannot: "its text is empty" };
  const chain = headerChain(member, text).map((h) => cut(h).split("\n").join(" "));
  const tuple =
    chain.length === 0
      ? markTupleOfRow(row)
      : `${row.astHash}|${row.codeunitName}|${chain.join(" > ")} > ${row.procedureName || row.triggerName || ""}|${row.operatorName}|${row.operatorMajor}`;
  return {
    anchor: {
      file: row.file,
      tuple,
      lineInProcedure,
      column,
      siteText: sha256(siteText),
      procedureText: sha256(procedureText),
    },
  };
}

// --- The result --------------------------------------------------------------------------------

export interface AcceptReportView {
  readonly mutants?: readonly MutantOutcome[];
  readonly buildSymbols?: readonly string[];
}

/** An entry as `lethal run` prints it for a counted survivor: the reason is the placeholder. */
export type ReadyEntry = Omit<AcceptEntry, "acceptedBy" | "acceptedOn">;

export interface AcceptResult {
  /** Where `lethal.accepted.json` was looked for. */
  readonly path: string;
  readonly fileFound: boolean;
  /** `mutantRef` of every survivor an entry accepts, with the entry's reason. */
  readonly accepted: ReadonlyMap<string, string>;
  /** Per survivor (by ref): the ready entry, or why none can be printed. */
  readonly ready: ReadonlyMap<string, { readonly entry: ReadyEntry } | { readonly cannot: string }>;
  /** One line per entry that is not accepted: killed, not measured, re-opened, identity changed, ambiguous. */
  readonly entryLines: readonly string[];
  /** Entries that match no site of this run. */
  readonly notInRun: number;
}

const describeEntry = (e: AcceptEntry): string =>
  `${e.file} ${e.tuple} (+${e.lineInProcedure}:${e.column})`;

/**
 * Match the accept list against the run. The text comes from `snapshot`, the source the run
 * parsed, never from disk. Throws `AcceptListError` when a re-parsed member disagrees with the
 * report's row.
 */
export async function computeAcceptResult(input: {
  readonly report: AcceptReportView;
  readonly snapshot: ReadonlyMap<string, Buffer>;
  readonly list: LoadedAcceptList;
}): Promise<AcceptResult> {
  const { report, snapshot, list } = input;
  const entries = list.entries ?? [];
  const rows = report.mutants ?? [];
  const survivors = rows.filter((m) => SURVIVING_VERDICTS.has(m.verdict));
  const base = { path: list.path, fileFound: list.entries !== undefined };
  const empty: AcceptResult = {
    ...base,
    accepted: new Map(),
    ready: new Map(),
    entryLines: [],
    notInRun: 0,
  };
  if (survivors.length === 0 && entries.length === 0) return empty;
  const symbols = report.buildSymbols;
  if (symbols === undefined) {
    // Never read as []: a report with no symbol set cannot show an entry's build is this build.
    const cannot = "this report records no build symbols, so no entry can be shown to apply";
    return {
      ...empty,
      ready: new Map(survivors.map((m) => [mutantRef(m.batchIndex, m.mutantCode), { cannot }])),
      entryLines: entries.length > 0 ? [`${entries.length} entries: ${cannot}; none applied`] : [],
    };
  }
  await initParser();
  const texts = new Map<string, string>();
  for (const [rel, bytes] of snapshot) {
    if (rel.toLowerCase().endsWith(".al"))
      texts.set(rel.replaceAll("\\", "/"), decodeSource(bytes));
  }
  const wanted = new Set([
    ...survivors.map((m) => m.file.toLowerCase()),
    ...entries.map((e) => e.file.toLowerCase()),
  ]);
  const ctxs = new Map<string, FileCtx>();
  const anchors = new Map<MutantOutcome, Anchored>();
  for (const m of rows) {
    if (!wanted.has(m.file.toLowerCase())) continue;
    const text = texts.get(m.file);
    if (text === undefined) {
      anchors.set(m, { cannot: "its file is not in this run's source" });
      continue;
    }
    let ctx = ctxs.get(m.file);
    if (ctx === undefined) {
      ctx = { text, starts: lineStartsOf(text) };
      ctxs.set(m.file, ctx);
    }
    anchors.set(m, anchorOf(m, ctx));
  }
  const rowKey = (a: Anchor): string =>
    anchorKey(a.file, a.tuple, a.lineInProcedure, a.column, a.siteText, a.procedureText, symbols);
  const byKey = new Map<string, MutantOutcome[]>();
  for (const [m, a] of anchors) {
    if (!("anchor" in a)) continue;
    const k = rowKey(a.anchor);
    byKey.set(k, [...(byKey.get(k) ?? []), m]);
  }
  const refOf = (m: MutantOutcome): string => mutantRef(m.batchIndex, m.mutantCode);
  const anchoredRows = [...anchors].flatMap(([m, a]) =>
    "anchor" in a ? [{ m, a: a.anchor }] : [],
  );

  const accepted = new Map<string, string>();
  const entryLines: string[] = [];
  let notInRun = 0;
  for (const e of entries) {
    const matched =
      byKey.get(
        anchorKey(
          e.file,
          e.tuple,
          e.lineInProcedure,
          e.column,
          e.siteText,
          e.procedureText,
          e.preprocessorSymbols,
        ),
      ) ?? [];
    const [only] = matched;
    const name = describeEntry(e);
    if (matched.length > 1) {
      entryLines.push(
        `entry ${name}: ambiguous: ${matched.length} rows of this run share its anchor (${matched.map(refOf).join(", ")}), so it accepts none of them`,
      );
    } else if (only !== undefined) {
      const ref = refOf(only);
      if (SURVIVING_VERDICTS.has(only.verdict)) accepted.set(ref, e.reason);
      else if (only.verdict === "killed" || only.verdict === "timeout-killed") {
        entryLines.push(
          `entry ${name}: killed: a test now kills it (${ref} is ${only.verdict}); remove the entry`,
        );
      } else {
        entryLines.push(
          `entry ${name}: not measured this run (${ref} is ${only.verdict}); keep the entry`,
        );
      }
    } else {
      const sameSite = anchoredRows.filter(
        ({ a }) => a.file.toLowerCase() === e.file.toLowerCase() && a.tuple === e.tuple,
      );
      const operator = e.tuple.split("|").at(-2);
      const renamed = anchoredRows.filter(
        ({ m, a }) =>
          a.file.toLowerCase() === e.file.toLowerCase() &&
          a.lineInProcedure === e.lineInProcedure &&
          a.column === e.column &&
          a.siteText === e.siteText &&
          a.procedureText === e.procedureText &&
          m.operatorName === operator &&
          a.tuple !== e.tuple &&
          JSON.stringify(symbolsOf(symbols)) === JSON.stringify(symbolsOf(e.preprocessorSymbols)),
      );
      if (sameSite.length > 0) {
        const fresh = sameSite
          .filter(({ m }) => SURVIVING_VERDICTS.has(m.verdict))
          .map(({ m }) => refOf(m));
        entryLines.push(
          `entry ${name}: re-opened: the site, its procedure or its build changed since it was accepted. Re-review the survivor${fresh.length > 0 ? ` (${fresh.join(", ")}) and replace the entry with the one printed under it` : ""}`,
        );
      } else if (renamed.length > 0) {
        entryLines.push(
          `entry ${name}: identity changed: LethAL's identity for this site changed, not the code (${renamed.map(({ m, a }) => `${refOf(m)} is now ${a.tuple}`).join("; ")}). Replace the entry's tuple${renamed.some(({ m }) => SURVIVING_VERDICTS.has(m.verdict)) ? " with the one printed under the survivor" : ""}`,
        );
      } else notInRun++;
    }
  }
  if (notInRun > 0) {
    entryLines.push(
      `${notInRun} entries match no site of this run (not on a changed line, or moved or renamed); not checked`,
    );
  }
  const ready = new Map<string, { entry: ReadyEntry } | { cannot: string }>();
  for (const m of survivors) {
    const a = anchors.get(m);
    if (a === undefined) continue;
    if (!("anchor" in a)) {
      ready.set(refOf(m), { cannot: `cannot be accepted: ${a.cannot}` });
      continue;
    }
    if ((byKey.get(rowKey(a.anchor))?.length ?? 0) > 1) {
      ready.set(refOf(m), { cannot: "cannot be accepted: ambiguous" });
      continue;
    }
    ready.set(refOf(m), {
      entry: {
        file: a.anchor.file,
        tuple: a.anchor.tuple,
        lineInProcedure: a.anchor.lineInProcedure,
        column: a.anchor.column,
        siteText: a.anchor.siteText,
        procedureText: a.anchor.procedureText,
        preprocessorSymbols: symbolsOf(symbols),
        reason: ACCEPT_REASON_PLACEHOLDER,
      },
    });
  }
  return { ...base, accepted, ready, entryLines, notInRun };
}
