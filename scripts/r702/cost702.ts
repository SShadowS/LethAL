// R-702 gap 1 cost: ONE project, generateMutationSet three times in this process:
// (A) R696 rule off, (B) R696 on, (C) R696 on + callee movers/inserters refused (scratch r702Seam).
// Counts only. usage: bun cost702.ts <tree> <out.json> <project-dir>
import { join } from "node:path";

const [root, out, proj] = process.argv.slice(2);
if (root === undefined || out === undefined || proj === undefined) throw new Error("usage");
const orch = await import(join(root, "packages/runner/src/orchestrator.ts"));
const lh = await import(join(root, "packages/builtin-tier1/src/loop-hazard.ts"));
type Set_ = { files: { specs: unknown[] }[]; hangRefused: { sites: number }[] };
const gen = async (r696: boolean, r702: boolean, callee = false): Promise<{ specs: number; hang: number }> => {
  lh.r696Seam.on = r696;
  lh.r702Seam.on = r702;
  lh.r702Seam.callee = callee;
  const set = (await orch.generateMutationSet(proj, { emit: () => {} })) as Set_;
  return {
    specs: set.files.reduce((a, f) => a + f.specs.length, 0),
    hang: set.hangRefused.reduce((a, h) => a + h.sites, 0),
  };
};
const a = await gen(false, false);
const b = await gen(true, false);
const c = await gen(true, true);
const d = await gen(true, true, true);
await Bun.write(out, JSON.stringify({ off: a, r696: b, r702: c, r702callee: d }));
