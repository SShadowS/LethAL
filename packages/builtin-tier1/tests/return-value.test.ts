import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  buildSemanticContext,
  findAll,
  initParser,
  parseAL,
  wrapRoot,
} from "@lethal/engine";
import { returnValue } from "../src/return-value";

describe("returnValue", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("zeros numeric returns and negates boolean returns; skips bare exit", async () => {
    const src = await readFile(resolve(__dirname, "./fixtures/al/return-value.al"), "utf8");
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const specs = findAll(root, ALNodeKind.exit_statement)
      .filter((n) => returnValue.targets(n, ctx))
      .flatMap((n) => returnValue.generate(n, ctx));

    const mapping = new Map(specs.map((s) => [s.before.text.trim(), s.after.text.trim()]));
    // CountPositive -> Integer: exit(n) -> exit(0); exit(0) is not mutated (already 0)
    expect(mapping.get("exit(n)")).toBe("exit(0)");
    expect(mapping.has("exit(0)")).toBe(false);
    // IsPositive -> Boolean: exit(n > 0) -> exit(not (n > 0))
    expect(mapping.get("exit(n > 0)")).toBe("exit(not (n > 0))");
    // LogOnly: `exit;` has no expression -> skipped
    expect([...mapping.keys()]).not.toContain("exit");

    for (const s of specs) {
      expect(s.parentContext).toBe("statement-position");
      expect(s.operatorName).toBe("lethal.return-value");
    }
  });
});

// R302 place 4: the return type of a split member is the one EVERY arm declares. An `exit` in a
// member whose arms agree is mutated exactly as in its plain twin; when the arms disagree the
// mutated text differs per build (`0.0` against `0`), so nothing is emitted.
describe("returnValue: split members (R302)", () => {
  beforeAll(async () => {
    await initParser();
  });
  const sites = (src: string) => {
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);
    return findAll(root, ALNodeKind.exit_statement)
      .filter((n) => returnValue.targets(n, ctx))
      .flatMap((n) => returnValue.generate(n, ctx))
      .map((s) => [s.before.text.trim(), s.after.text.trim()]);
  };
  const split = (a: string, b: string) => `codeunit 50100 "Repro R"
{
#if CLEAN27
    procedure Pick(X: Integer): ${a}
#else
    procedure Pick(X: Integer): ${b}
#endif
    begin
        exit(X + 1);
    end;
}
`;
  const twin = `codeunit 50100 "Repro R"
{
    procedure Pick(X: Integer): Integer
    begin
        exit(X + 1);
    end;
}
`;

  it("agreeing arms are mutated as the plain twin is", () => {
    const got = sites(split("Integer", "Integer"));
    expect(got).toEqual(sites(twin));
    expect(got).toHaveLength(1);
  });

  it("disagreeing arms give nothing", () => {
    expect(sites(split("Decimal", "Integer"))).toEqual([]);
  });
});
