// R586: run one project through LethAL's UNCHANGED al-runner backend and orchestrator, with
// al-runtime-rs behind `v2-shim.sh`, then compare per mutant with an oracle. Measurement tool only.
//
//   bun scripts/r586-probe/run-fixture.ts --alrunner <bin> --out <dir> --leg oneshot|server|resource
//     --project <dir> --tests <dir> --oracle <bcdev.baseline.json | SessionReport.json>
//     [--coverage al-runner|none] [--packages <dir>] [--only <glob>]... [--tests-only <glob>]...
//     [--ids selector,control,table]
//
// Writes <out>/<leg>.report.json, <out>/<leg>.shim.tsv (every alrunner call and its real exit) and
// <out>/<leg>.compare.txt (every per-mutant difference against the oracle, verdict and killing test).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseGateBaseline } from "../../packages/runner/itest/baseline-guard";
import {
  type NormalizedMutant,
  compareMutants,
  normalizeForComparison,
} from "../../packages/runner/itest/mutant-equality";
import { AlRunnerBackend } from "../../packages/runner/src/al-runner-backend";
import { alRunnerCoverageSupport } from "../../packages/runner/src/al-runner-coverage";
import { applyAlRunnerCoverageGuard } from "../../packages/runner/src/cli";
import { runSession } from "../../packages/runner/src/orchestrator";
import type { SessionReport } from "../../packages/runner/src/report";
import { ResultsStore } from "../../packages/runner/src/store";

const { values: a } = parseArgs({
  options: {
    alrunner: { type: "string" },
    out: { type: "string" },
    leg: { type: "string" },
    project: { type: "string" },
    tests: { type: "string" },
    oracle: { type: "string" },
    coverage: { type: "string", default: "al-runner" },
    packages: { type: "string" },
    only: { type: "string", multiple: true },
    "tests-only": { type: "string", multiple: true },
    ids: { type: "string", default: "79199,79198,79197" },
    define: { type: "string", multiple: true },
    "max-guards": { type: "string" },
    // one-shot only: replaces the `--isolation test` LethAL sends (see v2-shim.sh)
    isolation: { type: "string" },
    // a name for this run's files instead of the leg
    tag: { type: "string" },
  },
});
const symbols = a.define ?? [];
const maxGuards = a["max-guards"] !== undefined ? Number(a["max-guards"]) : undefined;
const need = (k: string, v: string | undefined): string => {
  if (v === undefined) throw new Error(`--${k} is required`);
  return v;
};
const alrunner = resolve(need("alrunner", a.alrunner));
const out = resolve(need("out", a.out));
const leg = need("leg", a.leg);
if (!["oneshot", "server", "resource"].includes(leg)) throw new Error(`bad --leg ${leg}`);
const project = resolve(need("project", a.project));
const tests = resolve(need("tests", a.tests));
const oracle = resolve(need("oracle", a.oracle));
const coverage = a.coverage === "none" ? "none" : "al-runner";
const [selectorId, controlId, tableId] = (a.ids ?? "").split(",").map(Number);
if (selectorId === undefined || controlId === undefined || tableId === undefined)
  throw new Error("--ids needs three numbers");
const selectorIds = { selectorId, controlId, tableId };

await mkdir(out, { recursive: true });
const tag = a.tag ?? leg;
const scratch = join(out, `${tag}-scratch`);
await rm(scratch, { recursive: true, force: true });
await mkdir(scratch, { recursive: true });
const shimLog = join(out, `${tag}.shim.tsv`);
await writeFile(shimLog, "", "utf8");
// The backend spawns with its own env, so the paths are baked into a per-leg launcher in <out>.
const shim = join(out, `${tag}-shim.sh`);
await writeFile(
  shim,
  `#!/usr/bin/env bash\n${a.isolation !== undefined ? `export R586_ISOLATION=${JSON.stringify(a.isolation)}\n` : ""}export R586_ALRUNNER=${JSON.stringify(alrunner)} R586_SHIM_LOG=${JSON.stringify(shimLog)} ALRUNNER_CACHE=${JSON.stringify(process.env.ALRUNNER_CACHE ?? "/work/tools/al-runtime-rs/cache")}\nexec ${JSON.stringify(join(import.meta.dir, "v2-shim.sh"))} "$@"\n`,
  { mode: 0o755 },
);

const events: string[] = [];
// R407: the CLI's own coverage guard, which runs LethAL's frame probe through the same launcher
// when the project has a multi-object file. `admitMultiObjectFiles` only when it answers admitted.
let admitMultiObjectFiles = false;
let effectiveCoverage: "al-runner" | "none" = coverage;
if (coverage === "al-runner" && !(await alRunnerCoverageSupport(project)).supported) {
  const guarded = await applyAlRunnerCoverageGuard(
    {
      alRunner: { alRunnerPath: shim, coverage, serverMode: leg !== "oneshot" },
      ...(symbols.length > 0 ? { preprocessorSymbols: symbols } : {}),
    },
    project,
    (line) => events.push(`guard: ${line}`),
    { testDir: tests },
  );
  admitMultiObjectFiles = guarded.admitMultiObjectFiles;
  if (!admitMultiObjectFiles) effectiveCoverage = "none";
}
const store = new ResultsStore(join(scratch, "lethal.sqlite"));
const backend = new AlRunnerBackend({
  alRunnerPath: shim,
  instrumentedDir: join(scratch, "instrumented"),
  testDir: tests,
  selectorObjectId: selectorIds.selectorId,
  coverage: effectiveCoverage,
  ...(admitMultiObjectFiles ? { admitMultiObjectFiles: true } : {}),
  ...(leg !== "oneshot" ? { serverMode: true } : {}),
  ...(leg === "resource" ? { selectorMode: "resource" as const } : {}),
  ...(a.packages !== undefined ? { packagesDir: resolve(a.packages) } : {}),
  ...(symbols.length > 0 ? { preprocessorSymbols: symbols } : {}),
});
const t0 = Date.now();
let report: SessionReport;
try {
  report = await runSession({
    backend,
    store,
    projectDir: project,
    testDir: tests,
    instrumentedDir: join(scratch, "instrumented"),
    selectorIds,
    ...(a.only !== undefined ? { only: a.only } : {}),
    ...(a["tests-only"] !== undefined ? { testsOnly: a["tests-only"] } : {}),
    ...(a.packages !== undefined ? { dependencyPackageDirs: [resolve(a.packages)] } : {}),
    ...(symbols.length > 0 ? { preprocessorSymbols: symbols } : {}),
    ...(maxGuards !== undefined ? { maxGuardsPerBatch: maxGuards } : {}),
    emit: [
      (e) => {
        if (e.type === "warning") events.push(`warning ${e.code}: ${e.message}`);
      },
    ],
  });
} finally {
  store.close();
  await backend.close();
}
const wallS = Math.round((Date.now() - t0) / 1000);
await writeFile(join(out, `${tag}.report.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");

// Oracle: a gate baseline ({entries}) or a whole SessionReport ({mutants}).
const oracleRaw = await readFile(oracle, "utf8");
const oracleJson = JSON.parse(oracleRaw) as { mutants?: unknown };
let before: readonly NormalizedMutant[];
let sameScheme = false;
if (Array.isArray(oracleJson.mutants)) {
  before = normalizeForComparison(oracleJson as SessionReport);
  sameScheme = (oracleJson as SessionReport).identityScheme === report.identityScheme;
} else {
  const base = parseGateBaseline(oracleRaw, oracle, "");
  before = base.entries;
  sameScheme = base.identityScheme !== undefined && base.identityScheme === report.identityScheme;
}
const after = normalizeForComparison(report);
const cmp = compareMutants(before, after, { sameScheme });
const lines = [
  `leg=${leg} tag=${tag} isolation=${a.isolation ?? "test (LethAL's)"} coverage=${effectiveCoverage} (asked ${coverage}, multi-object admitted=${admitMultiObjectFiles}) wall=${wallS}s alrunner=${alrunner}`,
  `counts=${JSON.stringify(report.counts)} baselineGreen=${report.baselineGreen} coverageMode=${report.coverageMode}`,
  `oracle=${oracle} mutants oracle=${before.length} run=${after.length} sameScheme=${sameScheme}`,
  `differences=${cmp.differences.length} textVerified=${cmp.textVerified} textUnverified=${cmp.textUnverified}`,
  ...cmp.differences.map((d) => `  - ${d}`),
  "per mutant (code verdict killingTest | error):",
  ...[...report.mutants]
    .sort((x, y) => x.mutantCode.localeCompare(y.mutantCode))
    .map(
      (m) =>
        `  ${m.mutantCode} ${m.procedureName ?? "?"} ${m.operatorName} ${m.verdict} ${m.killingTest ?? "-"}${
          m.verdict === "error" || m.verdict === "timeout-killed"
            ? ` | ${(m.killingTestFailure ?? (m as { errorMessage?: string }).errorMessage ?? "").slice(0, 300)}`
            : ""
        }`,
    ),
  "warnings:",
  ...events.map((e) => `  ${e.slice(0, 600)}`),
];
await writeFile(join(out, `${tag}.compare.txt`), `${lines.join("\n")}\n`, "utf8");
console.log(lines.slice(0, 4 + cmp.differences.length).join("\n"));
