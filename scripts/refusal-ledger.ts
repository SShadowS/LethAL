/**
 * R-995: the standing refusal ledger. Reads al-runner v3 stores (`lethal.sqlite`) or `lethal run`
 * reports (JSON), normalises every refusal or error text, and matches each against the committed
 * ledger (`docs/measurements/refusal-ledger.json`): known causes with their counts, issue and state,
 * then NEW texts, the only ones a corpus run still has to reduce.
 *
 *   bun scripts/refusal-ledger.ts [--ledger <file>] [--run <id>] <store.sqlite | report.json> ...
 *
 * What is read:
 * - a store: the `error` mutants of its newest finished al-runner-v3 run (or `--run <id>`), each by
 *   its first non-pass test message, else its failure note (R-983's mine.py rule), plus the
 *   baseline rows that are refusals (`error` with a `NotRun` text);
 * - a report: the `failureNote` of each `error` mutant.
 *
 * The key is `normaliseRefusal(text)`: the first line, a cascade or no-green-baseline wrapper
 * unwrapped to the refusal inside it, the "[al-runner v3 did not run ...]" suffix dropped, quoted
 * names and literals made `<x>`, GUIDs `<guid>`, digits `N`, capped at 220 characters. So the
 * ledger holds no quoted name or literal and no source text, and a changed wording is a new key.
 * The store is opened readonly; nothing is written.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class RefusalLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusalLedgerError";
  }
}

export const LEDGER_STATES = ["open", "fixed", "by-design", "unexamined"] as const;
export type LedgerState = (typeof LEDGER_STATES)[number];
export interface LedgerEntry {
  readonly key: string;
  readonly state: LedgerState;
  readonly issue?: string;
  readonly repro?: string;
  readonly note?: string;
}
export type Kind = "mutant" | "cascade" | "baseline" | "test";
export interface Sighting {
  readonly text: string;
  readonly kind: Kind;
  readonly where: string;
}

const CASCADE =
  /^NotRun: out-of-scope: (an earlier test of this codeunit was refused while it ran|a test before this one in the codeunit did not pass) \([^:]*: (.*)\)\s*(\[al-runner.*)?$/;
const NO_GREEN =
  /^no green baseline tests — (?:all \S+ failed with the same message|\S+ failed with \S+ distinct messages; the first was): (.*)$/;

/** The refusal a wrapper carries, and which wrapper it was. */
function unwrap(text: string): { inner: string; kind: Kind } {
  const line = text.split("\n")[0] ?? "";
  const g = NO_GREEN.exec(line);
  if (g?.[1] !== undefined) return { inner: unwrap(g[1]).inner, kind: "baseline" };
  const c = CASCADE.exec(line);
  if (c?.[1] !== undefined && c[2] !== undefined) {
    const inner = c[2].replace(/^did not run \((.*)\)$/, "$1"); // a `failed (...)` stays, for maskFailures
    const head = c[1].startsWith("an earlier") ? "NotRun: out-of-scope: " : "FAILED-BEFORE: ";
    return { inner: head + inner, kind: "cascade" };
  }
  return { inner: line, kind: "mutant" };
}

export function refusalKind(text: string): Kind {
  return unwrap(text).kind;
}

/**
 * Masks what follows `open` up to its matching parenthesis (or the end, when the text was cut off)
 * as `mask`. A cascade quotes (1) the earlier test's failure, `failed (<message>)`, which is the
 * app's or the test's own text (a Label, a Confirm question), and (2) the earlier test's refusal,
 * `did not run (<refusal>)`, and why the cascade applies, `part of its reach is not known (<what>)`:
 * those are causes of their own (keys of their own where they were met), cut at varying lengths, so
 * one cascade shape would otherwise make a new key per earlier test.
 */
function maskParen(s: string, open: string, mask: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const at = s.indexOf(open, i);
    if (at < 0) return out + s.slice(i);
    out += `${s.slice(i, at)}${open}${mask}`;
    let depth = 1;
    let j = at + open.length;
    for (; j < s.length && depth > 0; j++) {
      if (s[j] === "(") depth += 1;
      else if (s[j] === ")") depth -= 1;
    }
    if (depth === 0) {
      out += ")";
      i = j;
    } else return out;
  }
}
function maskFailures(s: string): string {
  return maskParen(
    maskParen(maskParen(s, "failed (", "<failure>"), "did not run (", "<refusal>"),
    "part of its reach is not known (",
    "<reach>",
  );
}

/** The earlier test a cascade names is not part of its cause: one cause, whichever test met it first. */
function maskTestNames(s: string): string {
  return s
    .replace(/(did not pass|was refused while it ran) \([A-Za-z0-9_]+: /g, "$1 (<test>: ")
    .replace(/(an earlier test of this codeunit), [A-Za-z0-9_]+, /g, "$1, <test>, ");
}

export function normaliseRefusal(text: string): string {
  // BC's client-callback error quotes the app's own question or message after the colon; a cut
  // can end on a space, and trimming after it keeps the key a fixed point
  return maskTestNames(maskFailures(unwrap(text).inner))
    .replace(/(attempted to issue a client callback to show an? [A-Za-z ]+?): .*$/, "$1: <text>")
    .replace(/\s*\[al-runner v\d+ did not run.*$/, "")
    .replace(/`[^`]*`/g, "<x>")
    .replace(/'[^']*'/g, "<x>")
    .replace(/"[^"]*"/g, "<x>")
    .replace(/\{[0-9A-Fa-f-]{36}\}|[0-9A-Fa-f-]{36}/g, "<guid>")
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220)
    .trimEnd();
}

export const DEFAULT_LEDGER = join(
  import.meta.dir,
  "..",
  "docs",
  "measurements",
  "refusal-ledger.json",
);

/** The ledger, checked: every key normalised already (so no literal), states known, keys unique. */
export function loadLedger(path: string): Map<string, LedgerEntry> {
  if (!existsSync(path)) throw new RefusalLedgerError(`refusal-ledger: no ledger at ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw))
    throw new RefusalLedgerError(`refusal-ledger: ${path} is not a JSON array`);
  const out = new Map<string, LedgerEntry>();
  for (const e of raw as LedgerEntry[]) {
    if (typeof e?.key !== "string" || e.key === "")
      throw new RefusalLedgerError(`refusal-ledger: an entry without a key in ${path}`);
    if (normaliseRefusal(e.key) !== e.key)
      throw new RefusalLedgerError(
        `refusal-ledger: key is not normalised (a literal or a wrapper is left): ${e.key}`,
      );
    if (!LEDGER_STATES.includes(e.state))
      throw new RefusalLedgerError(`refusal-ledger: unknown state ${String(e.state)} for ${e.key}`);
    if (out.has(e.key)) throw new RefusalLedgerError(`refusal-ledger: duplicate key ${e.key}`);
    out.set(e.key, e);
  }
  return out;
}

/** The sightings of one store: its newest finished v3 run's error mutants and refused baseline tests. */
export function readStore(path: string, runId?: number): Sighting[] {
  const db = new Database(path, { readonly: true });
  try {
    const run =
      runId ??
      (
        db
          .query(
            "select max(id) as id from runs where finished_at is not null and backend = 'al-runner-v3'",
          )
          .get() as { id: number | null }
      ).id;
    if (run === null || run === undefined)
      throw new RefusalLedgerError(
        `refusal-ledger: ${path} has no finished al-runner-v3 run; pass --run <id>`,
      );
    const out: Sighting[] = [];
    const errs = db
      .query(
        "select id, mutant_code as code, coalesce(failure_note,'') as note from mutants where run_id=? and verdict='error'",
      )
      .all(run) as { id: number; code: string; note: string }[];
    const msgs = db.query(
      "select coalesce(failure_message,'') as m from test_results where run_id=? and mutant_row_id=? and outcome<>'pass' order by id",
    );
    for (const e of errs) {
      const first = (msgs.all(run, e.id) as { m: string }[]).map((r) => r.m).find((m) => m !== "");
      const text = first ?? (e.note !== "" ? e.note : "(no message)");
      out.push({ text, kind: refusalKind(text), where: `${path} run ${run} ${e.code}` });
    }
    const base = db
      .query(
        "select codeunit_name as cu, codeunit_id as id, method, failure_message as m from test_results where run_id=? and mutant_row_id is null and outcome='error' and failure_message like 'NotRun%' order by id",
      )
      .all(run) as { cu: string | null; id: number; method: string; m: string }[];
    for (const b of base)
      out.push({
        text: b.m,
        kind: "test",
        where: `${path} run ${run} ${b.cu ?? b.id}.${b.method}`,
      });
    return out;
  } finally {
    db.close();
  }
}

export function readReport(path: string): Sighting[] {
  const r = JSON.parse(readFileSync(path, "utf8")) as {
    mutants?: { mutantCode: string; verdict: string; failureNote?: string }[];
  };
  if (!Array.isArray(r.mutants))
    throw new RefusalLedgerError(`refusal-ledger: ${path} has no mutants array`);
  return r.mutants
    .filter((m) => m.verdict === "error")
    .map((m) => {
      const text =
        m.failureNote !== undefined && m.failureNote !== "" ? m.failureNote : "(no message)";
      return { text, kind: refusalKind(text), where: `${path} ${m.mutantCode}` };
    });
}

export interface Tally {
  readonly key: string;
  readonly count: number;
  readonly kinds: Readonly<Record<string, number>>;
  readonly example: string;
  readonly entry?: LedgerEntry;
}

export function tally(
  sightings: readonly Sighting[],
  ledger: ReadonlyMap<string, LedgerEntry>,
): Tally[] {
  const by = new Map<string, { count: number; kinds: Record<string, number>; example: string }>();
  for (const s of sightings) {
    const key = normaliseRefusal(s.text);
    const t = by.get(key) ?? { count: 0, kinds: {}, example: s.where };
    t.count += 1;
    t.kinds[s.kind] = (t.kinds[s.kind] ?? 0) + 1;
    by.set(key, t);
  }
  return [...by]
    .map(([key, t]) => {
      const entry = ledger.get(key);
      return { key, ...t, ...(entry !== undefined ? { entry } : {}) };
    })
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function render(rows: readonly Tally[]): string {
  const kinds = (k: Readonly<Record<string, number>>) =>
    Object.entries(k)
      .map(([n, c]) => `${n} ${c}`)
      .join(", ");
  const known = rows.filter((r) => r.entry !== undefined);
  const fresh = rows.filter((r) => r.entry === undefined);
  const lines = [
    `refusal-ledger: ${rows.reduce((s, r) => s + r.count, 0)} sighting(s), ${rows.length} cause(s): ${known.length} known, ${fresh.length} NEW`,
    "",
    "KNOWN (count, state, issue, key):",
  ];
  for (const r of known)
    lines.push(
      `${r.count}\t${r.entry?.state}\t${r.entry?.issue ?? "-"}\t${r.key}\t(${kinds(r.kinds)})`,
    );
  lines.push("", "NEW, to reduce (count, key, first seen):");
  for (const r of fresh) lines.push(`${r.count}\t${r.key}\t(${kinds(r.kinds)})\t${r.example}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let ledgerPath = DEFAULT_LEDGER;
  let runId: number | undefined;
  const inputs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--ledger") ledgerPath = args[++i] ?? "";
    else if (a === "--run") runId = Number(args[++i]);
    else inputs.push(a);
  }
  if (inputs.length === 0 || (runId !== undefined && !Number.isInteger(runId))) {
    console.error(
      "usage: bun scripts/refusal-ledger.ts [--ledger <file>] [--run <id>] <store.sqlite | report.json> ...",
    );
    process.exit(2);
  }
  const ledger = loadLedger(ledgerPath);
  // An input that cannot be read is named and the exit code is 1, but the other inputs are still
  // read: one crashed run must not hide a whole corpus sweep's texts.
  const unread: string[] = [];
  const sightings = inputs.flatMap((p) => {
    try {
      if (!existsSync(p)) throw new RefusalLedgerError(`refusal-ledger: no such input ${p}`);
      return p.endsWith(".json") ? readReport(p) : readStore(p, runId);
    } catch (e) {
      unread.push(e instanceof Error ? e.message : String(e));
      return [];
    }
  });
  console.log(render(tally(sightings, ledger)));
  if (unread.length > 0) {
    console.log(`\nNOT READ (${unread.length}):\n${unread.join("\n")}`);
    process.exitCode = 1;
  }
}
