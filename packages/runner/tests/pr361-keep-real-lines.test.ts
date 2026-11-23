// PR-361 (R1153 b): every serve keep entry is tested against a REAL al-runner line, never a normalised census key.
// Pre-commitment: docs/superpowers/specs/2026-11-23-pr361-keep-entries-real-lines.md. The fixture's lines were copied from
// captured al-runner rows under /coord/handoff (each `from`), with al-runner's words byte for byte.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { V3_SERVE_SAFE_REFUSALS, keepNearMiss } from "../src/al-runner-server";

type Line = { readonly entry: string; readonly line: string; readonly from: string };
const FIXTURE = join(import.meta.dir, "pr361-keep-real-lines.json");
const raw = readFileSync(FIXTURE, "utf8");
const fx = JSON.parse(raw) as {
  readonly proven: readonly Line[];
  readonly nearMiss: readonly Line[];
};

/** R1153's 12: no real line matches them yet. (a) widens each only with its own DO proof; then it leaves this list. */
const UNPROVEN = [
  "asdecimal-text-control",
  "dotnet-copilot-platform-authorization",
  "geturl-company-characters",
  "geturl-object-type-or-arguments",
  "gotokey-statement-no-row",
  "page-no-record-onopenpage",
  "part-visible-other-shape",
  "xmlport-import-header",
  "yaml-blank-line-nested",
  "yaml-flow-quoted-key",
  "yaml-list-indent",
  "yaml-null-or-number",
];

const entryRe = (name: string): RegExp => {
  const re = V3_SERVE_SAFE_REFUSALS[name];
  if (re === undefined) throw new Error(`no keep entry named ${name}`);
  return re;
};

describe("PR-361: every keep entry against a real al-runner line", () => {
  // Red: break one entry's anchor (for example `commit`'s literal) in al-runner-server.ts.
  test("1. every proven line matches its own entry", () => {
    const bad = fx.proven.filter((l) => !entryRe(l.entry).test(l.line)).map((l) => l.entry);
    expect(bad).toEqual([]);
  });

  // Red: remove one proven line (its entry is then in neither list), or add an entry with no real line.
  test("2. proven entries plus UNPROVEN are exactly the keep list, with no overlap", () => {
    const proven = fx.proven.map((l) => l.entry);
    expect(new Set(proven).size).toBe(proven.length);
    expect(proven.filter((e) => UNPROVEN.includes(e))).toEqual([]);
    expect([...proven, ...UNPROVEN].sort()).toEqual(Object.keys(V3_SERVE_SAFE_REFUSALS).sort());
  });

  // Red: widen one of the 12 (its real line then matches).
  test("3. each unproven entry's real line matches NO entry, and keepNearMiss names that entry", () => {
    expect(fx.nearMiss.map((l) => l.entry).sort()).toEqual([...UNPROVEN].sort());
    for (const l of fx.nearMiss) {
      expect(Object.values(V3_SERVE_SAFE_REFUSALS).some((re) => re.test(l.line))).toBe(false);
      expect(keepNearMiss(l.line)?.entry).toBe(l.entry);
    }
  });

  // Red: put a corpus name into one line.
  test("4. the fixture holds no DO, DC or Continia text", () => {
    const corpus =
      /Continia|Document Output|Document Capture|\bCDO\b|\bCDC\b|\b6[89]\d{3}\b|\b\d{15}\b/;
    const hits = [...fx.proven, ...fx.nearMiss]
      .filter((l) => corpus.test(l.line))
      .map((l) => l.entry);
    expect(hits).toEqual([]);
    expect(corpus.test(raw)).toBe(false);
  });

  test("every line is an al-runner refusal row's message, from a named capture", () => {
    for (const l of [...fx.proven, ...fx.nearMiss]) {
      expect(l.line.startsWith("NotRun: out-of-scope: ")).toBe(true);
      expect(l.from).not.toBe("");
    }
  });
});
