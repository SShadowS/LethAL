import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type MutationSpec,
  buildSemanticContext,
  initParser,
  parseAL,
  visit,
  wrapRoot,
} from "@lethal/engine";
import { compileSchemataForFile, writeInstrumentedProject } from "@lethal/schemata";
import { tier1Operators } from "../src";

const SRC_PATH = fileURLToPath(new URL("./fixtures/al/mixed-operators.al", import.meta.url));

describe("end-to-end Layer 3", () => {
  beforeAll(async () => {
    await initParser();
  });

  it("runs all Tier 1 operators and composes a valid instrumented output", async () => {
    const src = await readFile(SRC_PATH, "utf8");
    const root = wrapRoot(parseAL(src));
    const ctx = buildSemanticContext([{ path: "mixed.al", root }]);

    const specs: MutationSpec[] = [];
    visit(root, (node) => {
      for (const op of tier1Operators) {
        if (op.targets(node, ctx)) {
          for (const s of op.generate(node, ctx)) specs.push(s);
        }
      }
    });

    // Sanity: fixture should produce at least one spec per operator that
    // applies to it.
    const names = new Set(specs.map((s) => s.operatorName));
    expect(names.has("lethal.conditional-boundary")).toBe(true);
    expect(names.has("lethal.negate-conditional")).toBe(true);
    expect(names.has("lethal.void-method-call")).toBe(true);
    expect(names.has("lethal.return-value")).toBe(true);
    expect(names.has("lethal.empty-block")).toBe(true);

    // Specs may target overlapping statements. Layer 3 compile rejects
    // overlap — filter to one spec per non-overlapping site.
    const kept = dedupeByFirstSite(specs);
    expect(kept.length).toBeGreaterThan(0);

    const compiled = compileSchemataForFile(src, root, kept);
    expect(compiled).toContain("MutationSelector.Active(");

    // Write to tmp dir and read back
    const dir = await mkdtemp(join(tmpdir(), "lethal-e2e-"));
    try {
      await writeInstrumentedProject({
        targetDir: dir,
        files: [{ path: "mixed.al", source: src, root, specs: kept }],
        selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
      });
      const written = await readFile(join(dir, "mixed.al"), "utf8");
      expect(written).toBe(compiled);
      const manifest = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8"));
      expect(manifest.mutants.length).toBe(kept.length);
      expect(manifest.selectorIds).toEqual({
        selectorId: 60000,
        controlId: 60001,
        tableId: 60002,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Keep the first spec whose `before` span does not overlap any already-kept
 * spec's span.
 */
function dedupeByFirstSite(specs: readonly MutationSpec[]): MutationSpec[] {
  const kept: MutationSpec[] = [];
  const used: Array<{ start: number; end: number }> = [];
  for (const s of specs) {
    const r = { start: s.before.startIndex, end: s.before.endIndex };
    if (used.some((u) => !(r.end <= u.start || r.start >= u.end))) continue;
    used.push(r);
    kept.push(s);
  }
  return kept;
}
