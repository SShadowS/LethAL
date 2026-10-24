import { describe, expect, test } from "bun:test";
import { BC_HTTP_INTERNAL_TEXT } from "../../packages/runner/src/al-runner-v3-contract";
import {
  BLOCKED,
  NONE,
  type PathClass,
  type Reading,
  type RunClasses,
  SECURITY,
  outcomeOf,
  pathClass,
  readingOf,
} from "./classify";

const measured = (raw: string, code: string) => `MEASURED [${raw}] [${code}]\nCodeunit callstack`;
const r = (cls: Reading["cls"], raw: string | null = null): Reading => ({
  cls,
  raw,
  code: null,
  codeMismatch: false,
});
const pc = (cls: PathClass["cls"], raw: string | null = null): PathClass => ({ cls, raw });
const run = (ws: PathClass, hub: PathClass): RunClasses => ({ ws, hub });
const B = pc("BLOCKED", BLOCKED);
const S = pc("SECURITY", SECURITY);

describe("constants", () => {
  test("BLOCKED is the contract's text", () => expect(BLOCKED).toBe(BC_HTTP_INTERNAL_TEXT));
  test("SECURITY is one line", () => expect(SECURITY.includes("\n")).toBe(false));
});

describe("readingOf", () => {
  test("92911 BLOCKED with code HttpRequest", () => {
    expect(readingOf(92911, measured(BLOCKED, "HttpRequest"))).toEqual({
      cls: "BLOCKED",
      raw: BLOCKED,
      code: "HttpRequest",
      codeMismatch: false,
    });
  });
  test("92910 SECURITY from the first line", () =>
    expect(readingOf(92910, `${SECURITY}\nstack`).cls).toBe("SECURITY"));
  test("exact match: a trailing space or other case is OTHER", () => {
    expect(readingOf(92910, `${BLOCKED} `).cls).toBe("OTHER");
    expect(readingOf(92910, BLOCKED.toLowerCase()).cls).toBe("OTHER");
  });
  test("a third text is OTHER and kept raw", () =>
    expect(readingOf(92910, "something else\nx")).toMatchObject({
      cls: "OTHER",
      raw: "something else",
    }));
  test("no text is NONE", () => {
    expect(readingOf(92910, undefined)).toEqual(NONE);
    expect(readingOf(92911, "")).toEqual(NONE);
  });
  test("code and text disagree: class follows the text, the mismatch is reported", () => {
    expect(readingOf(92911, measured(BLOCKED, "Other"))).toMatchObject({
      cls: "BLOCKED",
      code: "Other",
      codeMismatch: true,
    });
    expect(readingOf(92911, measured(SECURITY, "HttpRequest"))).toMatchObject({
      cls: "SECURITY",
      codeMismatch: true,
    });
  });
  test("92911 text with no MEASURED line is OTHER", () =>
    expect(readingOf(92911, "plain failure").cls).toBe("OTHER"));
});

describe("pathClass", () => {
  test("agreeing readings keep their class", () =>
    expect(pathClass(r("BLOCKED", BLOCKED), r("BLOCKED", BLOCKED)).cls).toBe("BLOCKED"));
  test("mixed (92910 and 92911 disagree) is SPLIT", () =>
    expect(pathClass(r("BLOCKED", BLOCKED), r("SECURITY", SECURITY)).cls).toBe("SPLIT"));
  test("two different third texts are SPLIT", () =>
    expect(pathClass(r("OTHER", "a"), r("OTHER", "b")).cls).toBe("SPLIT"));
});

describe("outcomeOf: one case per table row", () => {
  test("row 1: a SPLIT path", () =>
    expect(outcomeOf([run(B, pc("SPLIT")), run(B, S)]).row).toBe(1));
  test("row 1: run 1 and run 2 disagree on a path", () =>
    expect(outcomeOf([run(B, S), run(B, B)]).row).toBe(1));
  test("row 1: two runs, different third texts", () =>
    expect(outcomeOf([run(B, pc("OTHER", "a")), run(B, pc("OTHER", "b"))]).row).toBe(1));
  test("row 2: hub NONE", () =>
    expect(outcomeOf([run(B, pc("NONE")), run(B, pc("NONE"))]).row).toBe(2));
  test("row 1 (run disagreement) beats row 2: hub NONE in one run only", () =>
    expect(outcomeOf([run(B, S), run(B, pc("NONE"))]).row).toBe(1));
  test("row 3: hub SECURITY, web-service BLOCKED", () => {
    const o = outcomeOf([run(B, S), run(B, S)]);
    expect(o.row).toBe(3);
    expect(o.outcome).toBe("Outcome A");
  });
  test("row 4: both BLOCKED", () => expect(outcomeOf([run(B, B), run(B, B)]).row).toBe(4));
  test("row 5: both SECURITY", () => expect(outcomeOf([run(S, S), run(S, S)]).row).toBe(5));
  test("row 6: hub BLOCKED, web-service SECURITY", () =>
    expect(outcomeOf([run(S, B), run(S, B)]).row).toBe(6));
  test("row 7: a third text, checked before rows 3-6", () => {
    const t = pc("OTHER", "third");
    expect(outcomeOf([run(B, t), run(B, t)]).row).toBe(7);
    expect(outcomeOf([run(t, S), run(t, S)]).row).toBe(7);
  });
  test("gap: web-service NONE with a hub text", () =>
    expect(outcomeOf([run(pc("NONE"), S), run(pc("NONE"), S)]).row).toBe(0));
});
