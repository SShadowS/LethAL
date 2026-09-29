import { describe, expect, test } from "bun:test";
import { EQUIVALENCE_MARKS_FILENAME, loadEquivalenceMarks } from "../src/cli";
import {
  type EquivalenceMark,
  EquivalenceMarksError,
  applyEquivalenceMarks,
  equivalenceMarkWarnings,
  parseEquivalenceMarks,
} from "../src/equivalence-marks";

/**
 * R172 proposal 3. Two things have to hold and neither is visible from reading the output: a
 * malformed marks file must FAIL rather than load partially, and a mark that this run contradicts
 * must be reported as the reader being wrong rather than quietly applied.
 */

const KEY_A = "aaaa|Sandbox Logic|LogAudit|lethal.shift-integer|1";
const KEY_B = "bbbb|Hang Logic|CountUpTo|lethal.shift-integer|1";

function file(marks: unknown): string {
  return JSON.stringify({ marks });
}

describe("parseEquivalenceMarks refuses rather than loading partially", () => {
  test("a well-formed file loads, trimming the reason", () => {
    const got = parseEquivalenceMarks(
      file([{ key: KEY_A, reason: "  self-assignment, nothing reads it  ", markedBy: "tll" }]),
      "marks.json",
    );
    expect(got).toEqual([
      {
        key: KEY_A,
        reason: "self-assignment, nothing reads it",
        markedBy: "tll",
        identityScheme: 1,
      },
    ]);
  });

  // R325: a file without `identityScheme` was written before the field existed, so its keys were
  // made under scheme 1. One with it states its scheme; anything else is refused.
  test("the file's identityScheme is read, absent reads as 1, and a bad one is refused", () => {
    const [plain] = parseEquivalenceMarks(file([{ key: KEY_A, reason: "r" }]), "m.json");
    expect(plain?.identityScheme).toBe(1);
    const [stated] = parseEquivalenceMarks(
      JSON.stringify({ identityScheme: 2, marks: [{ key: KEY_A, reason: "r" }] }),
      "m.json",
    );
    expect(stated?.identityScheme).toBe(2);
    for (const bad of [0, 1.5, "2", null]) {
      expect(() =>
        parseEquivalenceMarks(
          JSON.stringify({ identityScheme: bad, marks: [{ key: KEY_A, reason: "r" }] }),
          "m.json",
        ),
      ).toThrow(/"identityScheme" must be a positive integer/);
    }
  });

  test("a mark with NO reason is refused, not defaulted", () => {
    // The whole point: an unexplained mark is an unreviewable subtraction from the survivor list.
    expect(() => parseEquivalenceMarks(file([{ key: KEY_A }]), "m.json")).toThrow(
      /"reason" is required/,
    );
    expect(() => parseEquivalenceMarks(file([{ key: KEY_A, reason: "   " }]), "m.json")).toThrow(
      /"reason" is required/,
    );
  });

  test("a key that is not the 5-field R166 identity is refused, and the error says the shape", () => {
    expect(() =>
      parseEquivalenceMarks(file([{ key: "aaaa|Sandbox Logic", reason: "x" }]), "m.json"),
    ).toThrow(/expected 5/);
  });

  test("R230: a six-field key loads when the sixth is a positive integer as serializeKey writes it", () => {
    const five = "aaaa|Sandbox Logic|Bump|lethal.remove-assignment|1";
    for (const ordinal of ["1", "2", "10", "123"]) {
      const marks = parseEquivalenceMarks(file([{ key: `${five}|${ordinal}`, reason: "x" }]), "m");
      expect(marks.map((m) => m.key)).toEqual([`${five}|${ordinal}`]);
    }
    // Anything else serializeKey never writes: 0 (a first twin has no sixth field), a leading
    // zero, a sign, a decimal, a blank, a non-number, and a seventh field.
    for (const bad of ["0", "01", "+1", "-1", "1.0", "", " 1", "x"]) {
      expect(() =>
        parseEquivalenceMarks(file([{ key: `${five}|${bad}`, reason: "x" }]), "m"),
      ).toThrow(EquivalenceMarksError);
      expect(() =>
        parseEquivalenceMarks(file([{ key: `${five}|${bad}`, reason: "x" }]), "m"),
      ).toThrow(/not a positive integer/);
    }
    expect(() => parseEquivalenceMarks(file([{ key: `${five}|1|1`, reason: "x" }]), "m")).toThrow(
      /has 7 field\(s\), expected 5/,
    );
  });

  test("a duplicate key is refused rather than last-wins", () => {
    expect(() =>
      parseEquivalenceMarks(
        file([
          { key: KEY_A, reason: "first" },
          { key: KEY_A, reason: "second" },
        ]),
        "m.json",
      ),
    ).toThrow(/duplicate key/);
  });

  test("a missing `marks` array is refused, and so is a bare array file", () => {
    expect(() => parseEquivalenceMarks("{}", "m.json")).toThrow(/missing required "marks"/);
    expect(() => parseEquivalenceMarks("[]", "m.json")).toThrow(/expected an object/);
  });

  test("invalid JSON names the file rather than surfacing a bare parse error", () => {
    expect(() => parseEquivalenceMarks("{not json", "marks.json")).toThrow(/marks\.json/);
    expect(() => parseEquivalenceMarks("{not json", "marks.json")).toThrow(EquivalenceMarksError);
  });
});

describe("applyEquivalenceMarks separates matched, stale and contradicted", () => {
  const marks: EquivalenceMark[] = [
    { key: KEY_A, reason: "self-assignment", identityScheme: 2 },
    { key: KEY_B, reason: "returns 3 from either start", identityScheme: 2 },
  ];

  // R325: a mark made under another scheme may name another mutant, so it is stale even when its
  // key equals a mutant's identity, and it is never matched or contradicted.
  test("a mark made under another identity scheme is stale, even on a matching key", () => {
    const old: EquivalenceMark[] = [
      { key: KEY_A, reason: "self-assignment", identityScheme: 1 },
      { key: KEY_B, reason: "returns 3 from either start", identityScheme: 1 },
    ];
    const r = applyEquivalenceMarks(
      old,
      [
        { mutantCode: "M0001", identity: KEY_A, verdict: "survived" },
        { mutantCode: "M0002", identity: KEY_B, verdict: "killed" },
      ],
      2,
    );
    expect(r.matched).toEqual([]);
    expect(r.contradicted).toEqual([]);
    expect(r.stale.map((m) => m.key)).toEqual([KEY_A, KEY_B]);
  });

  test("a mark on a survivor matches", () => {
    const r = applyEquivalenceMarks(
      marks,
      [
        { mutantCode: "M0001", identity: KEY_A, verdict: "survived" },
        { mutantCode: "M0002", identity: KEY_B, verdict: "survived" },
      ],
      2,
    );
    expect(r.matched.map((m) => m.mutantCode)).toEqual(["M0001", "M0002"]);
    expect(r.stale).toEqual([]);
    expect(r.contradicted).toEqual([]);
  });

  test("a mark matching nothing is STALE, not silently dropped", () => {
    // The identity carries the mutated subtree's hash, so editing the code retires the mark. That
    // is safe, but a ruling nobody is told they lost is not.
    const r = applyEquivalenceMarks(
      marks,
      [{ mutantCode: "M0001", identity: KEY_A, verdict: "survived" }],
      2,
    );
    expect(r.stale.map((s) => s.key)).toEqual([KEY_B]);
  });

  test("a mark on a KILLED mutant is CONTRADICTED — the reader was wrong and the kill stands", () => {
    // The only decidable check this feature can make: someone said no test could distinguish this
    // mutant, and a test did.
    const r = applyEquivalenceMarks(
      marks,
      [
        { mutantCode: "M0001", identity: KEY_A, verdict: "killed" },
        { mutantCode: "M0002", identity: KEY_B, verdict: "survived" },
      ],
      2,
    );
    expect(r.contradicted).toEqual([
      { key: KEY_A, reason: "self-assignment", mutantCode: "M0001", verdict: "killed" },
    ]);
    expect(r.matched.map((m) => m.mutantCode)).toEqual(["M0002"]);
  });

  test("`known-survivor` is a survival, not a contradiction", () => {
    // It is a survivor carried from a prior run, so it does not refute the mark.
    const r = applyEquivalenceMarks(
      [marks[0] as EquivalenceMark],
      [{ mutantCode: "M0001", identity: KEY_A, verdict: "known-survivor" }],
      2,
    );
    expect(r.matched).toHaveLength(1);
    expect(r.contradicted).toEqual([]);
  });

  test("no-coverage CONTRADICTS a mark rather than matching it", () => {
    // A mutant nobody ran is not a mutant nobody could kill, and conflating the two is the exact
    // confusion R175 exists to prevent.
    const r = applyEquivalenceMarks(
      [marks[0] as EquivalenceMark],
      [{ mutantCode: "M0001", identity: KEY_A, verdict: "no-coverage" }],
      2,
    );
    expect(r.contradicted.map((c) => c.verdict)).toEqual(["no-coverage"]);
  });
});

describe("equivalenceMarkWarnings", () => {
  test("says the score is NOT changed, so a mark cannot read as a subtraction", () => {
    const lines = equivalenceMarkWarnings({
      matched: [{ key: KEY_A, reason: "r", mutantCode: "M0001" }],
      stale: [],
      contradicted: [],
    }).join(" ");
    expect(lines).toMatch(/STILL counted as survivors/);
    expect(lines).toMatch(/still in the mutation score/);
  });

  test("a contradiction names the mutant and its verdict", () => {
    const lines = equivalenceMarkWarnings({
      matched: [],
      stale: [],
      contradicted: [
        { key: KEY_A, reason: "self-assignment", mutantCode: "M0001", verdict: "killed" },
      ],
    }).join(" ");
    expect(lines).toMatch(/CONTRADICTED/);
    expect(lines).toMatch(/M0001 is killed/);
  });

  test("nothing to say produces no lines", () => {
    expect(equivalenceMarkWarnings({ matched: [], stale: [], contradicted: [] })).toEqual([]);
  });
});

describe("loadEquivalenceMarks: discovery is a fixed filename, and absence is not failure", () => {
  test("an ABSENT file is undefined, silently — the overwhelmingly common case", async () => {
    const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
    const got = await loadEquivalenceMarks("/p", async () => {
      throw enoent;
    });
    expect(got).toBeUndefined();
  });

  test("an UNREADABLE file throws rather than being treated as absent", async () => {
    // A permissions error and "no marks recorded" must not look alike: one means nobody has ruled
    // on anything, the other means every ruling was silently discarded.
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect(
      loadEquivalenceMarks("/p", async () => {
        throw eacces;
      }),
    ).rejects.toThrow(/not treated as an absent one/);
  });

  test("a present file is parsed, and the path is what the error names", async () => {
    await expect(loadEquivalenceMarks("/p", async () => "{bad")).rejects.toThrow(
      new RegExp(EQUIVALENCE_MARKS_FILENAME.replace(".", ".")),
    );
  });

  test("the filename is a constant, so a mark applies to the PROJECT and not to one invocation", () => {
    expect(EQUIVALENCE_MARKS_FILENAME).toBe("lethal.equivalent.json");
  });
});
