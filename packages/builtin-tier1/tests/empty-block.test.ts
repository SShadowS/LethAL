import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ALNodeKind,
  type ALSyntaxNode,
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

  // R244: a `repeat` body is never claimed, whether its `until` advances a cursor or not. The only
  // blocks claimed below are the two procedure bodies; a claimed repeat body would make it 3 or more.
  it("claims no repeat body, Next-terminated or not, plain or begin...end", () => {
    const src = `codeunit 51702 "R" {
      procedure CursorLoop(var Cust: Record Customer)
      begin
        if Cust.FindSet() then
          repeat
            Cust.Mark(true);
          until Cust.Next() = 0;
        if Cust.FindSet() then
          repeat
            begin
              Cust.Mark(false);
            end;
          until Cust.Next() = 0;
      end;
      procedure CounterLoop(Limit: Integer)
      var
        Counter: Integer;
      begin
        repeat
          Counter += 1;
        until Counter >= Limit;
        repeat
          begin
            Counter += 1;
          end;
        until Counter >= Limit;
      end;
    }`;
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "repeat.al", root }]);
    // Every node is offered, not only `code_block`s, so claiming a repeat's `statement_block` (the
    // shape option (B) would take) also shows here.
    const all: ALSyntaxNode[] = [];
    const walk = (n: ALSyntaxNode): void => {
      all.push(n);
      for (const c of n.namedChildren) walk(c);
    };
    walk(root);
    const claimed = all.filter((n) => emptyBlock.targets(n, ctx));
    expect(claimed.map((n) => n.parent?.kind)).toEqual([ALNodeKind.procedure, ALNodeKind.procedure]);
    // Positive control: the four repeats exist, and so do the begin...end blocks inside two of them.
    expect(findAll(root, ALNodeKind.repeat_statement)).toHaveLength(4);
    expect(findAll(root, ALNodeKind.block)).toHaveLength(4);
  });
});
