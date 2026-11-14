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
 * The key is `normaliseRefusal(text)` (its comment has the rules): only an al-runner refusal and two
 * platform shapes keep their text, and every place in them that can quote the app's or a test's
 * own text is masked. THIS REPO IS PUBLIC: the ledger must hold no source text, and a text that is
 * none of those shapes is `WITHHELD`. A changed wording is a new key. The store is opened readonly;
 * nothing is written.
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

const NO_GREEN =
  /^no green baseline tests — (?:all \S+ failed with the same message|\S+ failed with \S+ distinct messages; the first was): (.*)$/;
/** A cascade: a test refused because of what an earlier test of its codeunit did. */
const CASCADE_HEADS = [
  "NotRun: out-of-scope: an earlier test of this codeunit",
  "NotRun: out-of-scope: a test before this one in the codeunit did not pass",
];

/**
 * The refusal a no-green-baseline note carries, and which kind of sighting it is. Whitespace is
 * collapsed first, so every mask below sees one space where the text had several.
 */
function unwrap(text: string): { inner: string; kind: Kind } {
  const line = (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  const g = NO_GREEN.exec(line);
  if (g?.[1] !== undefined) return { inner: unwrap(g[1]).inner, kind: "baseline" };
  return {
    inner: line,
    kind: CASCADE_HEADS.some((h) => line.startsWith(h)) ? "cascade" : "mutant",
  };
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

/**
 * The key of a text that is not one of the shapes below: a BC or app error message can quote the
 * app's own text unquoted ("Customer ACME is blocked"), so it never becomes a key. Its sightings
 * still count, and the tool's output names where the first one is.
 */
export const WITHHELD = "<not a refusal: the text is withheld; read it in the store>";
const CALLBACK = /^(.* attempted to issue a client callback to show an? [A-Za-z ]+?): .*$/;
// `N` too: a key (digits already `N`) must read as the same shape on the next pass
const TRANSPORT = /^(al-runner-v(?:\d+|N) transport failure: v(?:\d+|N) exited (?:\d+|N)): .*$/;

/**
 * The cause key. Only three shapes keep their text: an al-runner refusal (`NotRun: ...`), al-runner's
 * transport failure, and BC's client-callback error; anything else is `WITHHELD`. Inside them, every
 * place that can quote the app's or a test's own text is masked: a quoted string (an apostrophe
 * inside a word, as in "BC's", opens none; an unclosed quote masks to the end), a cascade's earlier
 * test, its failure (`failed (...)`, `this failure is not trusted: ...`), its refusal and reach,
 * a SaveAsXml run's error, a .NET exception's message, the callback's question and the transport's
 * stderr. Then GUIDs, digits, and a 220-character cut; trimming after the cut keeps the key a fixed
 * point, which `loadLedger` checks.
 */
export function normaliseRefusal(text: string): string {
  // a cut can land inside a mask (`did not run (<refu`); one more pass then gives the same text, so
  // the key is the first fixed point (two passes in every measured case)
  let k = normaliseOnce(text);
  for (let i = 0; i < 4; i++) {
    const next = normaliseOnce(k);
    if (next === k) return k;
    k = next;
  }
  throw new RefusalLedgerError(`refusal-ledger: no fixed point for the key of: ${k}`);
}

function normaliseOnce(text: string): string {
  const s = unwrap(text).inner.replace(/\s*\[al-runner v\d+ did not run.*$/, "");
  let k: string;
  if (CALLBACK.test(s)) k = s.replace(CALLBACK, "$1: <text>");
  else if (TRANSPORT.test(s)) k = s.replace(TRANSPORT, "$1: <stderr>");
  else if (s.startsWith("NotRun: ")) k = s;
  else return WITHHELD;
  return maskTestNames(maskFailures(k))
    .replace(/(this failure is not trusted): .*$/, "$1: <failure>")
    .replace(
      /(an error in a SaveAsXml run \(what the handler sees is not pinned\)): .*$/,
      "$1: <error>",
    )
    .replace(
      /(raised the \.NET exception [\w.+`]+): .*?(?=; the text AL would see|$)/,
      "$1: <message>",
    )
    .replace(/`[^`]*`/g, "<x>")
    .replace(/(?<![A-Za-z0-9])'[^']*'/g, "<x>")
    .replace(/"[^"]*"/g, "<x>")
    .replace(/(?<![A-Za-z0-9])'[^']*$/, "<x>")
    .replace(/"[^"]*$/, "<x>")
    .replace(
      /\{?[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}?/g,
      "<guid>",
    )
    .replace(/\d+/g, "N")
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
    // an explicit run must exist and be a v3 run: a wrong id must not read as "no refusals"
    const named = db.query("select backend from runs where id=?").get(run) as {
      backend: string;
    } | null;
    if (named?.backend !== "al-runner-v3")
      throw new RefusalLedgerError(
        `refusal-ledger: ${path} has no al-runner-v3 run ${run} (${named === null ? "no such run" : `backend ${named.backend}`})`,
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
    mutants?: { mutantCode: string; verdict: string; failureNote?: string; batchIndex?: number }[];
  };
  if (!Array.isArray(r.mutants))
    throw new RefusalLedgerError(`refusal-ledger: ${path} has no mutants array`);
  return r.mutants
    .filter((m) => m.verdict === "error")
    .map((m) => {
      const text =
        m.failureNote !== undefined && m.failureNote !== "" ? m.failureNote : "(no message)";
      // R231: a mutant code repeats across batches, so the batch names it too
      return {
        text,
        kind: refusalKind(text),
        where: `${path} ${m.batchIndex ?? 0}/${m.mutantCode}`,
      };
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
