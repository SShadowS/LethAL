import { describe, it, expect, beforeAll } from "bun:test";
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
  beforeAll(async () => { await initParser(); });

  it("zeros numeric returns and negates boolean returns; skips bare exit", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/return-value.al"),
      "utf8",
    );
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
