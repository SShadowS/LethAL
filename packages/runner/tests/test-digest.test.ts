import { beforeAll, describe, expect, test } from "bun:test";
import { initParser } from "@lethal/engine";
import { testsInAlSource } from "../src/discovery";
import { testDigestKey, testDigestsOfSources } from "../src/test-digest";

beforeAll(async () => {
  await initParser();
});

const unit = (methods: string, header = `codeunit 50100 "T"`) =>
  `${header}\n{\n    Subtype = Test;\n\n${methods}}\n`;
const A = "    [Test]\n    procedure A()\n    begin\n        X := 1;\n    end;\n";
const B = "    [Test]\n    procedure B()\n    begin\n    end;\n";

/** Every discovered test's digest in one file. */
function digests(text: string): Record<string, string> {
  return testDigestsOfSources([{ path: "T.al", text }], testsInAlSource("T.al", text));
}
const digestOf = (text: string, method = "A") => digests(text)[`50100::${method.toLowerCase()}`];

describe("R-278: testDigestsOfSources", () => {
  test("a digest is recorded for every discovered test, keyed by codeunit id and lowercased method", () => {
    const d = digests(unit(A + B));
    expect(Object.keys(d).sort()).toEqual(["50100::a", "50100::b"]);
    expect(d["50100::a"]).toMatch(/^[0-9a-f]{64}$/);
    expect(testDigestKey({ codeunitId: 50100, method: "MyTest" })).toBe(
      testDigestKey({ codeunitId: 50100, method: "mytest" }),
    );
  });

  test("CRLF and LF give equal digests, and trailing whitespace is ignored", () => {
    const lf = unit(A + B);
    expect(digestOf(lf.replaceAll("\n", "\r\n"))).toBe(digestOf(lf));
    expect(digestOf(lf.replace("X := 1;", "X := 1;  \t"))).toBe(digestOf(lf));
  });

  test("a comment edit inside the method changes the digest", () => {
    // Comment text against comment text, so a normalizer that stripped comments would equate them.
    const lf = unit(A + B).replace("X := 1;", "X := 1; // old");
    expect(digestOf(lf.replace("// old", "// now asserts"))).not.toBe(digestOf(lf));
  });

  test("an attribute change changes the digest", () => {
    const lf = unit(A + B);
    const withHandler = lf.replace(
      "[Test]\n    procedure A()",
      "[Test]\n    [HandlerFunctions('ConfirmYes')]\n    procedure A()",
    );
    expect(digestOf(withHandler)).not.toBe(digestOf(lf));
    const otherHandler = withHandler.replace("ConfirmYes", "ConfirmNo");
    expect(digestOf(otherHandler)).not.toBe(digestOf(withHandler));
  });

  test("an edit to a sibling method does not change the digest", () => {
    const lf = unit(A + B);
    expect(
      digestOf(lf.replace("procedure B()\n    begin", "procedure B()\n    begin\n        Y := 2;")),
    ).toBe(digestOf(lf));
  });

  test("a method declared in two #if arms is digested as both: an edit in either arm changes it", () => {
    const arms = (one: string, two: string) =>
      unit(
        `#if CLEAN\n    [Test]\n    procedure A()\n    begin\n${one}    end;\n#else\n    [Test]\n    procedure A()\n    begin\n${two}    end;\n#endif\n${B}`,
      );
    const base = digestOf(arms("        X := 1;\n", "        X := 2;\n"));
    expect(digestOf(arms("        X := 9;\n", "        X := 2;\n"))).not.toBe(base);
    expect(digestOf(arms("        X := 1;\n", "        X := 9;\n"))).not.toBe(base);
  });

  test("a discovered test the parser cannot find throws, never digests nothing", () => {
    const text = unit(A);
    expect(() =>
      testDigestsOfSources(
        [{ path: "T.al", text }],
        [{ codeunitId: 50100, codeunitName: "T", method: "Missing", file: "T.al" }],
      ),
    ).toThrow(/found no procedure of that name/);
  });
});
