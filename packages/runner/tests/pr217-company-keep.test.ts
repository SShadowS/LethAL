// PR-217 (pre-commitment docs/superpowers/specs/2026-11-19-pr217-company-keep-widening.md, master f24ed4448): the Company-table
// keep pair also keeps upstream's wording after edge-4ebfe7913 (records.rs:751), EXACTLY, beside the old wording; nothing looser.
import { describe, expect, test } from "bun:test";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const OLD = (m: string) =>
  `${m} on the Company table: the database may hold companies this runtime does not know (ADR-046 decision 4a)`;
const NEW = (m: string) =>
  `${m} on the Company table: the database may hold companies this runtime does not know; name them with --companies NAME[,NAME...] (serve: the \`companies\` field); \`all\` needs test data (ADR-046 decision 4a)`;
const keeps = (m: string): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun: true, message: m }], "v3");

describe("PR-217: the Company-table keep pair, old and reworded text", () => {
  test("the old and the new wording are both kept, for every measured method", () => {
    for (const m of ["FindSet", "FindFirst", "IsEmpty"]) {
      expect([m, "old", keeps(P + OLD(m))]).toEqual([m, "old", true]);
      expect([m, "new", keeps(P + NEW(m))]).toEqual([m, "new", true]);
    }
  });

  test("company-findset itself matches both FindSet texts and no other method", () => {
    const re = V3_SERVE_SAFE_REFUSALS["company-findset"];
    expect(re?.test(P + OLD("FindSet"))).toBe(true);
    expect(re?.test(P + NEW("FindSet"))).toBe(true);
    expect(re?.test(P + NEW("Insert"))).toBe(false);
  });

  test("the new row matches only the new text, for the measured methods only", () => {
    const re = V3_SERVE_SAFE_REFUSALS["company-table-read-named"];
    expect(re).toBeDefined();
    expect(re?.test(P + NEW("FindFirst"))).toBe(true);
    expect(re?.test(P + OLD("FindFirst"))).toBe(false);
    expect(re?.test(P + NEW("Delete"))).toBe(false);
  });

  test("nothing looser: a reworded or truncated variant of either text closes", () => {
    const t = NEW("FindSet");
    const variants = [
      `${t} x`, // a tail
      t.slice(0, -1), // a dropped end
      t.replace("--companies", "--company"), // one word changed
      t.replace(
        "; name them with --companies NAME[,NAME...] (serve: the `companies` field); `all` needs test data",
        "; name them",
      ), // a partial clause
      t.replace(" (ADR-046 decision 4a)", ""), // the clause without the tail
      `${t}\n`,
      NEW("Insert"), // a write, never measured
    ];
    for (const v of variants) expect([v, keeps(P + v)]).toEqual([v, false]);
    // a plain error row (notRun false) is never kept
    expect(
      serveDaemonReusable([{ name: "C.X1", status: "error", notRun: false, message: P + t }], "v3"),
    ).toBe(false);
  });
});
