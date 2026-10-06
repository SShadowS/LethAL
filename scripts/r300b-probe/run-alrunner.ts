// R-300b al-runner legs. Needs no BC and no credential. Raw outputs go to out/.
//   bun scripts/r300b-probe/run-alrunner.ts dry <round>      print both argvs, spawn nothing
//   bun scripts/r300b-probe/run-alrunner.ts oneshot <round>  one al-runner process per Reach test, --coverage
//   bun scripts/r300b-probe/run-alrunner.ts server <round>   one --server daemon, one runTests, perTestCoverage
// Add `--define` as a last argument ONLY for the pre-committed fallback round (al-runner did not read
// the target's app.json preprocessorSymbols, so the wrapped objects compiled out).
// Uses LethAL's own argv builder and daemon client, so the invocation is the one a session makes.
// Each round gets a FRESH --cache dir: al-runner 2.12 reuses a dependency built under other symbols
// (R352), and a fresh root removes that confound.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultServerSpawn } from "../../packages/runner/src/al-runner-backend";
import { AlRunnerServer } from "../../packages/runner/src/al-runner-server";
import {
  alRunnerEnv,
  buildAlRunnerArgv,
  qualifiedTestName,
} from "../../packages/runner/src/al-runner-transport";

const AL_RUNNER = process.env.LETHAL_ALRUNNER_PATH ?? "/work/tools/al-runner/current/al-runner";
const here = import.meta.dir;
const OUT = join(here, "out");
const REACH = ["ReachW1", "ReachC1", "ReachE1", "ReachP", "ReachQ", "ReachR"];
const [mode, round, flag] = process.argv.slice(2);
if (round === undefined || !/^\d+$/.test(round)) throw new Error("give a round number");
const defines = flag === "--define" ? ["PROBESYM"] : [];
const tag = `r${round}${defines.length > 0 ? "D" : ""}`;

// Bundles: the target as is; the test app WITHOUT the Fence codeunit and its Test Runner dependency
// (Fence reads BC's Code Coverage table, which is a BC-only measurement).
const target = join(OUT, "ar-target");
const tests = join(OUT, "ar-tests");
rmSync(target, { recursive: true, force: true });
rmSync(tests, { recursive: true, force: true });
cpSync(join(here, "target"), target, { recursive: true });
mkdirSync(join(tests, "src"), { recursive: true });
cpSync(join(here, "tests/src/Reach.Codeunit.al"), join(tests, "src/Reach.Codeunit.al"));
const appJson = JSON.parse(readFileSync(join(here, "tests/app.json"), "utf8")) as {
  dependencies: { name: string }[];
};
appJson.dependencies = appJson.dependencies.filter((d) => d.name !== "Test Runner");
writeFileSync(join(tests, "app.json"), JSON.stringify(appJson, null, 2));
const cache = join(OUT, `ar-cache-${tag}-${mode}`);
rmSync(cache, { recursive: true, force: true });
const withCache = (argv: readonly string[]): string[] => [argv[0] ?? "", "--cache", cache, ...argv.slice(1)];

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(argv, { env: { ...process.env, ...alRunnerEnv(120) }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

if (mode === "dry" || mode === "oneshot") {
  for (const m of REACH) {
    const xml = join(OUT, `ar-${tag}-oneshot-${m}.xml`);
    const argv = withCache(
      buildAlRunnerArgv(AL_RUNNER, {
        sourceDir: target,
        testDir: tests,
        qualifiedTest: qualifiedTestName(91930, m),
        coverageOut: xml,
        ...(defines.length > 0 ? { preprocessorSymbols: defines } : {}),
      }),
    );
    if (mode === "dry") {
      console.log(argv.join(" "));
      continue;
    }
    const r = await run(argv);
    writeFileSync(join(OUT, `ar-${tag}-oneshot-${m}.log`), `exit ${r.code}\n--- stdout\n${r.out}\n--- stderr\n${r.err}`);
    console.log(`${m}: exit ${r.code} -> out/ar-${tag}-oneshot-${m}.xml`);
  }
  if (mode === "dry")
    console.log(`server: ${AL_RUNNER} --server --cache ${cache}${defines.map((d) => ` --define ${d}`).join("")}`);
} else if (mode === "server") {
  const server = new AlRunnerServer(AL_RUNNER, (argv) => defaultServerSpawn(withCache(argv)), defines);
  try {
    await server.start(600_000);
    const res = await server.runTests(
      { sourcePaths: [target, tests], coverage: true, perTestCoverage: true, testIsolation: "test" },
      600_000,
    );
    writeFileSync(join(OUT, `ar-${tag}-server.json`), JSON.stringify(res, null, 2));
    console.log(`exit ${res.exitCode}, ${res.tests.length} tests -> out/ar-${tag}-server.json`);
  } finally {
    await server.close();
  }
} else throw new Error("mode: dry | oneshot | server");
