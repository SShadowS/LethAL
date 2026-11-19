// PR-195: the keep entry for y2's collation refusal (U+516C and U+041A, by name), measured CLEAN by the strict census of family
// `y2-collation` and by a direct DO check on one daemon against fresh daemons (/coord/handoff/PR-195/).
import { describe, expect, test } from "bun:test";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");
const names = Object.keys(V3_SERVE_SAFE_REFUSALS);
const text = (cp: string) => `ordering of the character U+${cp} (no collation weight)`;

describe("PR-195 keep entry", () => {
  test("each measured code point is kept by this entry alone", () => {
    for (const cp of ["516C", "041A"]) {
      const t = text(cp);
      expect([t, keeps(P + t)]).toEqual([t, true]);
      expect([t, names.filter((n) => V3_SERVE_SAFE_REFUSALS[n]?.test(P + t))]).toEqual([
        t,
        ["collation-no-weight-measured"],
      ]);
    }
  });

  test("a reworded text closes: a tail, a prefix, a line break, a dropped end, and a row that is not notRun", () => {
    for (const cp of ["516C", "041A"]) {
      const t = text(cp);
      for (const m of [`${t} x`, `x ${t}`, `${t}\n`, t.slice(0, -1)])
        expect([m, keeps(P + m)]).toEqual([m, false]);
      expect([t, keeps(P + t, false)]).toEqual([t, false]);
    }
  });

  test("only the measured code points: other characters, lower-case hex and other lengths close", () => {
    for (const cp of [
      "4E2D",
      "3042",
      "D55C",
      "0416",
      "00E6",
      "516c",
      "041a",
      "516C0",
      "16C",
      "516D",
      "041B",
    ])
      expect([cp, keeps(P + text(cp))]).toEqual([cp, false]);
  });
});
