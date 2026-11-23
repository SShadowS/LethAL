// PR-362 (R1186): every BRANCH of a serve keep entry is tested against a REAL al-runner line (PR-361 proved one line per
// entry). Pre-commitment: docs/superpowers/specs/2026-11-23-pr362-keep-branches-real-lines.md. A real line proves that a
// branch CAN match real output; it says nothing about over-matching, so "proven" never means "safe".
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { V3_SERVE_SAFE_REFUSALS } from "../src/al-runner-server";
import { branchesOf, nonCapturingGroups } from "./helpers/regex-branches";

type Line = { readonly branch: string; readonly line: string; readonly from: string };
const raw = readFileSync(join(import.meta.dir, "pr362-keep-branch-lines.json"), "utf8");
const fx = JSON.parse(raw) as { readonly proven: readonly Line[] };

/** The branches no captured al-runner row has met yet. A new one goes red until it is measured or named here. */
const UNPROVEN_BRANCHES = [
  "company-table-read-named #1 FindFirst",
  "company-table-read-named #1 IsEmpty",
  "evaluate-decimal-comparison #1 >1000",
];

const all = Object.entries(V3_SERVE_SAFE_REFUSALS).flatMap(([entry, re]) =>
  branchesOf(entry, re).map((b) => ({ ...b, entry })),
);
const byKey = new Map(all.map((b) => [b.key, b]));

describe("PR-362: every keep entry branch against a real al-runner line", () => {
  // Red: rename one alternative in the source (its branch key then no longer exists).
  test("1. every proven line matches its branch and its entry", () => {
    const bad = fx.proven
      .filter((l) => {
        const b = byKey.get(l.branch);
        const entry = b === undefined ? undefined : V3_SERVE_SAFE_REFUSALS[b.entry];
        return b === undefined || entry === undefined || !b.re.test(l.line) || !entry.test(l.line);
      })
      .map((l) => l.branch);
    expect(bad).toEqual([]);
  });

  // Red: drop one proven line, or add an alternative to an entry.
  test("2. proven branches plus UNPROVEN_BRANCHES are exactly the keep list's branches, with no overlap", () => {
    const proven = fx.proven.map((l) => l.branch);
    expect(new Set(proven).size).toBe(proven.length);
    expect(proven.filter((k) => UNPROVEN_BRANCHES.includes(k))).toEqual([]);
    expect([...proven, ...UNPROVEN_BRANCHES].sort()).toEqual(all.map((b) => b.key).sort());
  });

  test("4. the fixture holds no DO, DC or Continia text", () => {
    const corpus = /Continia|Document Output|Document Capture|\bCDO\b|\bCDC\b|\b6[89]\d{3}\b/;
    expect(corpus.test(raw)).toBe(false);
    // The one replaced value: the 15-digit payment reference from a DO run became an invented one.
    expect([...raw.matchAll(/\b\d{15}\b/g)].map((m) => m[0])).toEqual(["000000001234567"]);
  });
});

describe("3. the branch helper, on invented regexes", () => {
  const keys = (re: RegExp): string[] => branchesOf("e", re).map((b) => b.key);

  test("an alternation gives each alternative; an optional group gives it and the empty text", () => {
    expect(keys(/^x(?:a|b|c)y$/)).toEqual(["e #1 a", "e #1 b", "e #1 c"]);
    expect(keys(/^x(?:new )?y$/)).toEqual(["e #1 new ", "e #1 ∅"]);
    const bs = branchesOf("e", /^x(?:a|b)(?:c)?y$/);
    expect(bs.map((b) => b.key)).toEqual(["e #1 a", "e #1 b", "e #2 c", "e #2 ∅"]);
    const a = bs.find((b) => b.key === "e #1 a");
    const none = bs.find((b) => b.key === "e #2 ∅");
    expect(a?.re.test("xacy")).toBe(true);
    expect(a?.re.test("xbcy")).toBe(false);
    expect(none?.re.test("xby")).toBe(true);
    expect(none?.re.test("xbcy")).toBe(false);
  });

  test("nested groups are each split, the outer keeping the inner whole", () => {
    expect(keys(/^(?:a(?:b|c)|d)$/)).toEqual(["e #1 a(?:b|c)", "e #1 d", "e #2 b", "e #2 c"]);
  });

  // Red: let the helper split a group inside a lookahead.
  test("a lookahead, and every group inside it, is never split", () => {
    expect(keys(/^x(?!.*(?:panic|timeout)).*$/)).toEqual([]);
    expect(keys(/^(?=y)(?:a|b)$/)).toEqual(["e #1 a", "e #1 b"]);
  });

  test("| and parentheses inside a character class or escaped are not group syntax", () => {
    expect(nonCapturingGroups(String.raw`[(|)]\(\|\)`)).toEqual([]);
    expect(keys(/^(?:[|(]|\))$/)).toEqual(["e #1 [|(]", "e #1 \\)"]);
  });
});
