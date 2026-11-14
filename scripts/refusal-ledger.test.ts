import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LEDGER,
  RefusalLedgerError,
  WITHHELD,
  loadLedger,
  normaliseRefusal,
  readReport,
  readStore,
  refusalKind,
  render,
  tally,
} from "./refusal-ledger.ts";

const SUFFIX =
  " [al-runner v3 did not run this test (notRun), so whether the mutant changes its outcome on BC is unknown: NOT scored (R586 §5)]";
const NR = "NotRun: out-of-scope: ";
const dir = mkdtempSync(join(tmpdir(), "refusal-ledger-"));
const ledgerFile = (entries: unknown) => {
  const p = join(dir, `l${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(entries));
  return p;
};
const CALLBACK = "attempted to issue a client callback to show a confirmation dialog box: <text>";

describe("normaliseRefusal", () => {
  test("quoted names and literals, GUIDs and digits are masked; the al-runner suffix goes", () => {
    const guid = "{01234567-89ab-cdef-0123-456789abcdef}";
    expect(
      normaliseRefusal(
        `${NR}SetFilter: 'abc' is not an Integer in "Sales Line" 42 ${guid}${SUFFIX}`,
      ),
    ).toBe(`${NR}SetFilter: <x> is not an Integer in <x> N <guid>`);
  });
  test("a no-green-baseline note is unwrapped; a cascade is named a cascade, whatever ends it", () => {
    const inner = `${NR}SetFilter: empty filter term`;
    const note = `no green baseline tests — all 7 failed with the same message: ${inner}`;
    expect([normaliseRefusal(note), refusalKind(note)]).toEqual([inner, "baseline"]);
    expect(refusalKind(inner)).toBe("mutant");
    const head = `${NR}an earlier test of this codeunit was refused while it ran (TestA: did not run (SetFilter: empty filter term))`;
    for (const tail of [
      SUFFIX,
      ": it can change session state; this failure is not trusted: x (y)",
    ])
      expect(refusalKind(head + tail)).toBe("cascade");
  });
  test("a cascade's quoted failure (app text), its earlier test's name and its quoted refusal are masked", () => {
    const failed = `${NR}a test before this one in the codeunit did not pass (TestB: failed (Document service is not configured (setup))) and left a manual event subscription bound`;
    expect(normaliseRefusal(failed)).toBe(
      `${NR}a test before this one in the codeunit did not pass (<test>: failed (<failure>)) and left a manual event subscription bound`,
    );
    const reach = `${NR}an earlier test of this codeunit was refused while it ran (TestC: did not run (view field 'X')): part of its reach is not known (runs page 5, which is not`;
    expect(normaliseRefusal(reach)).toBe(
      `${NR}an earlier test of this codeunit was refused while it ran (<test>: did not run (<refusal>)): part of its reach is not known (<reach>`,
    );
    const seq = `${NR}an earlier test of this codeunit, TestD, changed number sequence 'S'`;
    expect(normaliseRefusal(seq)).toBe(
      `${NR}an earlier test of this codeunit, <test>, changed number sequence <x>`,
    );
  });
  test("a client callback's quoted question (app text) is masked", () => {
    const text =
      "Microsoft Dynamics 365 Business Central Server attempted to issue a client callback to show a confirmation dialog box: Do you want to post? (CodeUnit 1)";
    expect(normaliseRefusal(text)).toBe(`Microsoft Dynamics N Business Central Server ${CALLBACK}`);
  });
  // THE REPO IS PUBLIC: each shape below once let app text into a key (R-995 review)
  test("no app text: BC's apostrophe, a not-trusted failure tail, an unclosed quote, a doubled space", () => {
    const trusted = `${NR}an earlier test of this codeunit was refused while it ran (T: did not run (R)): it is not BC's; this failure is not trusted: Customer 'Acme' has no credit limit`;
    expect(normaliseRefusal(trusted)).toBe(
      `${NR}an earlier test of this codeunit was refused while it ran (<test>: did not run (<refusal>)): it is not BC's; this failure is not trusted: <failure>`,
    );
    expect(normaliseRefusal(`${NR}not BC's view of 'Acme Corp' here`)).toBe(
      `${NR}not BC's view of <x> here`,
    );
    expect(normaliseRefusal(`${NR}view field 'Acme Corp has no`)).toBe(`${NR}view field <x>`);
    expect(normaliseRefusal(`${NR}view field "Acme Corp has no`)).toBe(`${NR}view field <x>`);
    // no wording of al-runner's after it: masked to the end
    expect(normaliseRefusal(`${NR}x failed  (Customer Acme is blocked)`)).toBe(
      `${NR}x failed (<failure>`,
    );
  });
  // second review (R-995): each of these still leaked after the first round of fixes
  test("no app text: a parenthesis inside a failure or a quoted value, an unquoted filter value", () => {
    const left = ") and left a manual event subscription bound";
    for (const msg of ["Expected:<ab)c> Actual:<x>", "1) Pick SECRET customer", "a (b) c"])
      expect(
        normaliseRefusal(`${NR}a test before this one did not pass (T1: failed (${msg}))${left}`),
      ).toBe(`${NR}a test before this one did not pass (<test>: failed (<failure>)${left}`);
    expect(
      normaliseRefusal(`${NR}x did not run (Evaluate of \`a) SECRET\` into Date)): it can`),
    ).toBe(`${NR}x did not run (<refusal>)): it can`);
    expect(
      normaliseRefusal(`${NR}SetFilter: filter value not evaluated: Integer\tACME-SECRET`),
    ).toBe(`${NR}SetFilter: filter value not evaluated: Integer <value>`);
  });
  test("no app text: an apostrophe or a backtick inside a value, an unclosed backtick", () => {
    expect(normaliseRefusal(`${NR}view field 'It's SECRET' here`)).toBe(`${NR}view field <x> here`);
    expect(normaliseRefusal(`${NR}view field 'O'Brien SECRET' here`)).toBe(
      `${NR}view field <x> here`,
    );
    expect(normaliseRefusal(`${NR}Evaluate of \`a\`b SECRET\` into Date`)).toBe(
      `${NR}Evaluate of <x> into Date`,
    );
    expect(normaliseRefusal(`${NR}Evaluate of \`SECRET1\nline2\``)).toBe(`${NR}Evaluate of <x>`);
  });
  test("a GUID is masked only in its own shape", () => {
    expect(normaliseRefusal(`${NR}key {01234567-89AB-cdef-0123-456789abcdef} gone`)).toBe(
      `${NR}key <guid> gone`,
    );
    const dashes = "-".repeat(40);
    expect(normaliseRefusal(`${NR}rule ${dashes} end`)).toBe(`${NR}rule ${dashes} end`);
  });
  test("no app text: a SaveAsXml error, a .NET exception's message, a text that is no refusal", () => {
    const xml = `${NR}an error in a SaveAsXml run (what the handler sees is not pinned): Customer Acme is blocked`;
    expect(normaliseRefusal(xml)).toBe(
      `${NR}an error in a SaveAsXml run (what the handler sees is not pinned): <error>`,
    );
    const net = `${NR}DotNet System.UriBuilder raised the .NET exception System.UriFormatException: Invalid URI Acme; the text AL would see is not pinned`;
    expect(normaliseRefusal(net)).toBe(
      `${NR}DotNet System.UriBuilder raised the .NET exception System.UriFormatException: <message>; the text AL would see is not pinned`,
    );
    for (const t of ["Customer ACME is blocked.", "(no message)", "Assert.AreEqual failed. 5 <> 6"])
      expect(normaliseRefusal(t)).toBe(WITHHELD);
    const transport = "al-runner-v3 transport failure: v3 exited 3: anything at all";
    expect(normaliseRefusal(transport)).toBe(
      "al-runner-vN transport failure: vN exited N: <stderr>",
    );
  });
  test("a key is a fixed point, also when the 220-character cut ends on a space", () => {
    const k = normaliseRefusal(`${NR}${"word ".repeat(80)}`);
    expect(k.length).toBeLessThanOrEqual(220);
    expect(normaliseRefusal(k)).toBe(k);
  });
});

describe("the ledger", () => {
  // red both ways: the committed ledger knows this text, and a changed wording of it is new
  test("a known text matches the committed ledger; a changed wording is NEW", () => {
    const ledger = loadLedger(DEFAULT_LEDGER);
    const rows = tally(
      [
        { text: `${NR}SetFilter: empty filter term${SUFFIX}`, kind: "mutant", where: "a" },
        { text: `${NR}SetFilter: an empty filter term${SUFFIX}`, kind: "mutant", where: "b" },
      ],
      ledger,
    );
    expect(rows.map((r) => [r.key, r.entry?.state])).toEqual([
      [`${NR}SetFilter: an empty filter term`, undefined],
      [`${NR}SetFilter: empty filter term`, "fixed"],
    ]);
    const out = render(rows);
    expect(out).toContain("1 known, 1 NEW");
    expect(out.slice(out.indexOf("NEW, to reduce"))).toContain("SetFilter: an empty filter term");
  });
  // loadLedger itself refuses a key that is not normalised, so no quoted name or literal is left
  // (a lone apostrophe, as in "BC's", is al-runner's own English)
  test("the committed ledger loads, and every key is one of the known shapes", () => {
    const ledger = loadLedger(DEFAULT_LEDGER);
    expect(ledger.size).toBeGreaterThan(250);
    for (const k of ledger.keys()) {
      // no source text: an al-runner refusal, or one of the two platform shapes, app text masked
      const known =
        k.startsWith("NotRun: ") ||
        k.startsWith("al-runner-vN transport failure: ") ||
        k.endsWith(CALLBACK);
      expect([k, known]).toEqual([k, true]);
    }
  });
  test("refuses a key that is not normalised, an unknown state, a duplicate, a missing file", () => {
    const k = `${NR}SetFilter: empty filter term`;
    const bad = ledgerFile([{ key: "NotRun: 'x'", state: "open" }]);
    expect(() => loadLedger(bad)).toThrow(/not normalised/);
    expect(() => loadLedger(ledgerFile([{ key: k, state: "closed" }]))).toThrow(/unknown state/);
    const dup = ledgerFile([
      { key: k, state: "open" },
      { key: k, state: "fixed" },
    ]);
    expect(() => loadLedger(dup)).toThrow(/duplicate/);
    expect(() => loadLedger(join(dir, "none.json"))).toThrow(RefusalLedgerError);
  });
});

describe("inputs", () => {
  const SQL = [
    "create table runs (id integer primary key, backend text, finished_at text)",
    "create table mutants (id integer primary key, run_id int, mutant_code text, verdict text, failure_note text)",
    "create table test_results (id integer primary key, run_id int, mutant_row_id int, codeunit_id int, codeunit_name text, method text, outcome text, failure_message text)",
    // run 1 (older) is not read by default; run 3 is not finished; run 4 is newer but not v3
    "insert into runs values (1, 'al-runner-v3', 'x'), (2, 'al-runner-v3', 'y'), (3, 'al-runner-v3', null), (4, 'bcdev', 'z')",
    `insert into mutants values (5, 4, 'M0001', 'error', '${NR}a bcdev run')`,
    `insert into mutants values (1, 1, 'M0001', 'error', '${NR}old')`,
    `insert into mutants values (2, 2, 'M0001', 'error', '${NR}from the note')`,
    `insert into mutants values (3, 2, 'M0002', 'error', '${NR}the note loses')`,
    "insert into mutants values (4, 2, 'M0003', 'killed', null)",
    // M0002: an empty first message is skipped, the next one is the text
    "insert into test_results values (1, 2, 3, 5, 'C', 'S', 'error', '')",
    `insert into test_results values (4, 2, 3, 5, 'C', 'T', 'error', '${NR}from the test')`,
    `insert into test_results values (2, 2, null, 5, 'C', 'T', 'error', '${NR}a baseline refusal')`,
    "insert into test_results values (3, 2, null, 5, 'C', 'U', 'fail', 'Assert failed')",
    // a baseline error that is not a refusal is not a sighting
    "insert into test_results values (5, 2, null, 5, 'C', 'V', 'error', 'Customer ACME is blocked')",
  ];
  const store = () => {
    const p = join(dir, `s${Math.random().toString(36).slice(2)}.sqlite`);
    const db = new Database(p);
    for (const s of SQL) db.run(s);
    db.close();
    return p;
  };
  test("a store: the newest finished v3 run's error mutants (test message first) and its refused baseline rows", () => {
    expect(readStore(store()).map((x) => [x.text, x.kind])).toEqual([
      [`${NR}from the note`, "mutant"],
      [`${NR}from the test`, "mutant"],
      [`${NR}a baseline refusal`, "test"],
    ]);
    expect(readStore(store(), 1).map((x) => x.text)).toEqual([`${NR}old`]);
  });
  test("--run naming a run the store has not, or a run that is not v3, is refused by name", () => {
    expect(() => readStore(store(), 9)).toThrow(/no al-runner-v3 run 9 \(no such run\)/);
    expect(() => readStore(store(), 4)).toThrow(/no al-runner-v3 run 4 \(backend bcdev\)/);
  });
  test("a store with no finished v3 run is refused by name", () => {
    const p = join(dir, "empty.sqlite");
    const db = new Database(p);
    db.run("create table runs (id integer primary key, backend text, finished_at text)");
    db.close();
    expect(() => readStore(p)).toThrow(/no finished al-runner-v3 run/);
  });
  test("a report: each error mutant's failure note", () => {
    const p = join(dir, "r.json");
    const mutants = [
      { mutantCode: "M1", verdict: "error", failureNote: `${NR}x` },
      { mutantCode: "M2", verdict: "survived" },
    ];
    writeFileSync(p, JSON.stringify({ backend: "al-runner-v3", mutants }));
    expect(readReport(p).map((x) => [x.text, x.where.endsWith("0/M1")])).toEqual([
      [`${NR}x`, true],
    ]);
    const bc = join(dir, "bc.json");
    writeFileSync(bc, JSON.stringify({ backend: "bcdev", mutants }));
    expect(() => readReport(bc)).toThrow(/not an al-runner-v3 report \(backend bcdev\)/);
  });
});
