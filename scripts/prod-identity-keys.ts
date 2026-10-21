// PRODUCTION identity keys of ONE project through the runner's own `generateMutationSet` (arm map, every filter,
// the R501 dispatch check, and whatever the checkout's loop-hazard.ts says). The dumper behind
// scripts/corpus-snapshot.ts (R593), ported from 1b1fc501 (lethal/r572) with the kill tag added.
// usage: bun scripts/prod-identity-keys.ts <checkout-root> <out.json> <project-dir>
// It imports the code of <checkout-root>, so one copy of this script dumps any tree.
// Optional env DEP_DIRS (':'-separated) is passed as R565's `dependencyPackageDirs`.
// Writes ONE JSON line (format 2):
//   {"format": 2, "hang": n, "specs": n, "skipped": n, "byOp": {...},
//    "keys": ["<file>|<op>|<start>-<end>\t<tuple>|<ordinal>|<tag>", ...]}
// where <tag> is the spec's `platformKillMechanism` or empty, or {"error": "<message>"}.
// The identity tuple may carry source text, so the output goes to /coord/cache/dumps/ or to scratch,
// never into git.
//
// FORMAT and anything that changes the key lines live HERE: corpus-snapshot.ts keys a cache entry by
// the sha256 of this file's bytes (its `dumperKey`), so editing this file starts a new entry.
import { join } from "node:path";

export const FORMAT = 2;

const [root, out, proj] = process.argv.slice(2);
if (import.meta.main) {
  if (root === undefined || out === undefined || proj === undefined) {
    throw new Error("usage: prod-identity-keys.ts <checkout-root> <out.json> <project-dir>");
  }
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
    for (const r of set.hangRefused as {
      sites: number;
      operator?: string;
      operatorName?: string;
    }[]) {
      hang += r.sites;
      const op = r.operator ?? r.operatorName ?? "?";
      byOp[op] = (byOp[op] ?? 0) + r.sites;
    }
    type Spec = {
      operatorName: string;
      platformKillMechanism?: string;
      before: { startIndex: number; endIndex: number };
    };
    const files = set.files as { path: string; specs: Spec[] }[];
    const specs = files.reduce((n, f) => n + f.specs.length, 0);
    const tagOf = new Map<string, string>();
    for (const f of files) {
      for (const s of f.specs) {
        if (s.platformKillMechanism === undefined) continue;
        const k = sch.identitySiteKey(
          f.path,
          s.before.startIndex,
          s.before.endIndex,
          s.operatorName,
        );
        tagOf.set(k, s.platformKillMechanism);
      }
    }
    const ord: Map<string, number> = orch.identityOrdinalsOf(set);
    type E = {
      file: string;
      startIndex: number;
      endIndex: number;
      operatorName: string;
      tuple: string;
    };
    const entries: E[] = sch.runIdentityEntries(
      set.files,
      orch.operatorTiers,
      set.reservedIdentityEntries,
    );
    const keys = entries
      .map((e) => {
        const k = sch.identitySiteKey(e.file, e.startIndex, e.endIndex, e.operatorName);
        return `${e.file}|${e.operatorName}|${e.startIndex}-${e.endIndex}\t${e.tuple}|${ord.get(k)}|${tagOf.get(k) ?? ""}`;
      })
      .sort();
    const skipped = (set.skipped as { sites: number }[]).reduce((n, r) => n + r.sites, 0);
    result = { format: FORMAT, hang, specs, skipped, byOp, keys };
  } catch (e) {
    result = { error: (e as Error).message.slice(0, 300) };
  }
  await Bun.write(out, JSON.stringify(result));
}
