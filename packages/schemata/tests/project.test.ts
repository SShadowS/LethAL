import { describe, it, expect, beforeAll } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ALNodeKind, findFirst, initParser, parseAL, wrapRoot } from "@lethal/engine";
import type { MutationSpec } from "@lethal/engine";
import { writeInstrumentedProject } from "../src/project";

describe("writeInstrumentedProject", () => {
  beforeAll(async () => { await initParser(); });

  it("writes rewritten sources + selector + manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-"));
    try {
      const src = `codeunit 51040 "P" { procedure P() begin X := 1; end; }`;
      const root = wrapRoot(parseAL(src));
      const assign = findFirst(root, ALNodeKind.assignment_statement);
      if (assign === null) throw new Error("no assignment");
      const specs: MutationSpec[] = [
        {
          operatorName: "op.flip",
          operatorVersion: "1.0.0",
          astNodeId: `${assign.startIndex}`,
          before: assign,
          after: { ...assign, text: "X := 2;" } as never,
          parentContext: "statement-position",
        },
      ];
      await writeInstrumentedProject({
        targetDir: dir,
        files: [{ path: "P.Codeunit.al", source: src, root, specs }],
        selectorObjectId: 60000,
      });

      const entries = (await readdir(dir)).sort();
      expect(entries).toContain("P.Codeunit.al");
      expect(entries).toContain("MutationSelector.Codeunit.al");
      expect(entries).toContain("mutant-manifest.json");

      const manifest = JSON.parse(
        await readFile(join(dir, "mutant-manifest.json"), "utf8"),
      );
      expect(manifest.mutants).toHaveLength(1);
      expect(manifest.mutants[0].mutantId).toBe("M0001");
      expect(manifest.mutants[0].operatorName).toBe("op.flip");

      const selector = await readFile(
        join(dir, "MutationSelector.Codeunit.al"),
        "utf8",
      );
      expect(selector).toContain("codeunit 60000");

      const rewritten = await readFile(join(dir, "P.Codeunit.al"), "utf8");
      expect(rewritten).toContain("MutationSelector.Active('M0001')");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
