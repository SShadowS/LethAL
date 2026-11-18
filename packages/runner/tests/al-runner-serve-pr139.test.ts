// PR-139: the NUL-run widths DO window x3 closed its serve daemon on, kept by name after family `x3-refusals` measured
// each width CLEAN (/coord/handoff/PR-139/census/) and a direct check on DO matched a kept daemon to fresh ones row for row.
// Spec: docs/superpowers/specs/2026-11-18-pr139-x3-restarts-precommitment.md.
import { describe, expect, test } from "bun:test";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");
const names = Object.keys(V3_SERVE_SAFE_REFUSALS);
const nul = (n: number) => "\u0000".repeat(n);
const ev = (v: string, into = "Decimal") =>
  `Evaluate of \`${v}\` into ${into} (form not pinned by the corpus)`;

describe("PR-139 NUL-run widths", () => {
  test("every measured width is kept, by the NUL-run entry alone", () => {
    for (const n of [3, 4, 5, 6, 10, 12, 14, 30, 37, 40]) {
      const t = P + ev(nul(n));
      expect([n, keeps(t)]).toEqual([n, true]);
      expect([n, names.filter((e) => V3_SERVE_SAFE_REFUSALS[e]?.test(t))]).toEqual([
        n,
        ["evaluate-decimal-nul-run"],
      ]);
    }
  });

  test("unmeasured widths close: no open range", () => {
    for (const n of [0, 1, 2, 7, 8, 9, 11, 13, 15, 29, 31, 36, 38, 39, 41, 300])
      expect([n, keeps(P + ev(nul(n)))]).toEqual([n, false]);
  });

  test("a NUL run that is not only NULs, another target type, a reworded text and a row that is not notRun all close", () => {
    for (const v of [
      `${nul(5)} ${nul(4)}`,
      ` ${nul(10)}`,
      `${nul(10)} `,
      `${nul(10)}1`,
      `${nul(9)}\n`,
      " ".repeat(10),
    ])
      expect([v, keeps(P + ev(v))]).toEqual([v, false]);
    // BigInteger and Duration give other texts (spec r2 step 0); they stay unkept
    expect(keeps(P + ev(nul(10), "BigInteger"))).toBe(false);
    expect(keeps(`${P}Evaluate of \`${nul(10)}\` into Duration with format 0 (not pinned)`)).toBe(
      false,
    );
    for (const m of [`${ev(nul(10))} x`, `x ${ev(nul(10))}`, ev(nul(10)).slice(0, -1)])
      expect(keeps(P + m)).toBe(false);
    expect(keeps(P + ev(nul(10)), false)).toBe(false);
  });
});
