import { describe, expect, it } from "bun:test";
import { FileRefusedError, formatRefusal } from "../src/file-refused";

// R307: the refused row's `detail` is built from the structured fields only, never the throw text.
describe("formatRefusal", () => {
  const objects = [{ type: "codeunit", id: 50100, name: "Good One" }];
  const cases: [FileRefusedError, string][] = [
    [
      new FileRefusedError("x", { file: "src/A.al", shape: "overlap", lines: [3, 6] }),
      "overlap in src/A.al: two rewrites of this file overlap; lines 3-6",
    ],
    [
      new FileRefusedError("x", { file: "src/A.al", shape: "unsupported-kind", objects, lines: [4, 4] }),
      'unsupported-kind in src/A.al: a mutation guard sits in an object that cannot carry the selector var; objects codeunit:50100 "Good One"; lines 4-4',
    ],
    [
      new FileRefusedError("x", { file: "src/A.al", shape: "latch-owner" }),
      "latch-owner in src/A.al: a reach marker sits outside any member that could declare its latch",
    ],
    [
      new FileRefusedError("x", { file: "src/A.al", shape: "no-anchor", objects }),
      'no-anchor in src/A.al: no place was found to declare the selector var or reach latch; objects codeunit:50100 "Good One"',
    ],
    [
      new FileRefusedError("x", { file: "src/A.al", shape: "no-header" }),
      "no-header in src/A.al: the object header rule found no object header",
    ],
    [
      new FileRefusedError("x", {
        file: "src/A.al",
        shape: "object-mix",
        objects: [...objects, { type: "page", id: 50101, name: "P" }],
      }),
      'object-mix in src/A.al: an object that can carry the selector var shares the file with one that cannot; objects codeunit:50100 "Good One", page:50101 "P"',
    ],
    [
      new FileRefusedError("x", { file: "src/A.al", shape: "site-before-header", lines: [1, 1] }),
      "site-before-header in src/A.al: a mutation site sits before the first object header the header rule found; lines 1-1",
    ],
  ];
  for (const [err, expected] of cases) {
    it(`pins the exact detail for ${err.shape}`, () => {
      expect(formatRefusal(err)).toBe(expected);
    });
  }

  it("extends Error directly and keeps the throw text as its message", () => {
    const e = new FileRefusedError("the thrown text", { file: "f", shape: "no-header" });
    expect(e).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(FileRefusedError.prototype)).toBe(Error.prototype);
    expect(e.message).toBe("the thrown text");
    expect(e.name).toBe("FileRefusedError");
    expect(formatRefusal(e)).not.toContain("the thrown text");
  });
});
