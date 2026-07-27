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
import { emptyBlock } from "../src/empty-block";

describe("emptyBlock", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("generates one spec per non-empty block; skips already-empty blocks", async () => {
    const src = await readFile(resolve(__dirname, "./fixtures/al/empty-block.al"), "utf8");
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const specs = findAll(root, ALNodeKind.block)
      .filter((n) => emptyBlock.targets(n, ctx))
      .flatMap((n) => emptyBlock.generate(n, ctx));

    expect(specs.length).toBe(2);
    for (const s of specs) {
      expect(s.parentContext).toBe("statement-position");
      expect(s.after.text).toBe("begin end");
      expect(s.operatorName).toBe("lethal.empty-block");
    }
  });
});
