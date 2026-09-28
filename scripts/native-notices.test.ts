import { describe, expect, it } from "bun:test";
import { spdxAllowed } from "./native-notices";

describe("spdxAllowed", () => {
  const cases: [string, boolean][] = [
    ["MIT", true],
    ["MIT OR Apache-2.0", true],
    ["MIT/Apache-2.0", true],
    ["MIT OR GPL-3.0-only", true],
    ["MIT AND GPL-3.0-only", false],
    ["(MIT OR Apache-2.0) AND Unicode-3.0", true],
    ["(MIT OR GPL-3.0-only) AND GPL-2.0-only", false],
    ["Apache-2.0 WITH LLVM-exception", true],
    ["GPL-2.0-only WITH Classpath-exception-2.0", false],
    ["", false],
  ];
  for (const [expr, want] of cases)
    it(`${expr || "(empty)"} -> ${want}`, () => expect(spdxAllowed(expr)).toBe(want));
  it("throws on an unbalanced expression", () =>
    expect(() => spdxAllowed("(MIT OR Apache-2.0")).toThrow());
});
