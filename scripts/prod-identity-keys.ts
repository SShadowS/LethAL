// PRODUCTION counts of ONE project through the runner's own `generateMutationSet` (arm map, every filter, the R501
// dispatch check, and whatever the checkout's loop-hazard.ts says). A measurement tool for hang-refusal re-prices:
// dump one tree (a git archive of master, and one of the branch), then diff with scripts/prod-keydiff.ts.
// usage: bun scripts/prod-identity-keys.ts <checkout-root> <out.json> <project-dir>
// Optional env DEP_DIRS (':'-separated) is passed as R565's `dependencyPackageDirs`.
// Writes ONE JSON line: {"hang": n, "specs": n, "skipped": n, "byOp": {...}, "keys": ["<file>|<op>|<span>\t<tuple>|<ordinal>", ...]}
// or {"error": "<message>"}. The identity tuple may carry source text, so the output goes to
// /coord/cache/dumps/<master sha>/<set>/ (with a DONE file) or to scratch, never into git.
import { join } from "node:path";

const [root, out, proj] = process.argv.slice(2);
if (root === undefined || out === undefined || proj === undefined) throw new Error("usage");
const dirs = (process.env.DEP_DIRS ?? "").split(":").filter((d) => d !== "");
const orch = await import(join(root, "packages/runner/src/orchestrator.ts"));
const sch = await import(join(root, "packages/schemata/src/index.ts"));
let result: unknown;
try {
  const opts: Record<string, unknown> = { emit: () => {} };
  if (dirs.length > 0) opts.dependencyPackageDirs = dirs;
  const set = await orch.generateMutationSet(proj, opts);
  let hang = 0;
  const byOp: Record<string, number> = {};
  for (const r of set.hangRefused as { sites: number; operator?: string; operatorName?: string }[]) {
    hang += r.sites;
    const op = r.operator ?? r.operatorName ?? "?";
    byOp[op] = (byOp[op] ?? 0) + r.sites;
  }
  const specs = (set.files as { specs: unknown[] }[]).reduce((n, f) => n + f.specs.length, 0);
  const ord: Map<string, number> = orch.identityOrdinalsOf(set);
  type E = { file: string; startIndex: number; endIndex: number; operatorName: string; tuple: string };
  const entries: E[] = sch.runIdentityEntries(set.files, orch.operatorTiers, set.reservedIdentityEntries);
  const keys = entries
    .map((e) => {
      const k = sch.identitySiteKey(e.file, e.startIndex, e.endIndex, e.operatorName);
      return `${e.file}|${e.operatorName}|${e.startIndex}-${e.endIndex}\t${e.tuple}|${ord.get(k)}`;
    })
    .sort();
  const skipped = (set.skipped as { sites: number }[]).reduce((n, r) => n + r.sites, 0);
  result = { hang, specs, skipped, byOp, keys };
} catch (e) {
  result = { error: (e as Error).message.slice(0, 300) };
}
await Bun.write(out, JSON.stringify(result));
