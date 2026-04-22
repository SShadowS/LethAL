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
import { voidMethodCall } from "../src/void-method-call";

describe("voidMethodCall", () => {
  beforeAll(async () => { await initParser(); });

  it("generates deletion specs only for statement-position calls", async () => {
    const src = await readFile(
      resolve(__dirname, "./fixtures/al/void-method-call.al"),
      "utf8",
    );
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "fixture.al", root }]);

    const specs = findAll(root, ALNodeKind.procedure_call)
      .filter((n) => voidMethodCall.targets(n, ctx))
      .flatMap((n) => voidMethodCall.generate(n, ctx));

    const beforeTexts = specs.map((s) => s.before.text).sort();
    expect(beforeTexts).toEqual(["DoThing(A)", "Log('start')"]);
    for (const s of specs) {
      expect(s.parentContext).toBe("statement-position");
      expect(s.after.text).toBe("");
      expect(s.operatorName).toBe("lethal.void-method-call");
    }
  });
});
