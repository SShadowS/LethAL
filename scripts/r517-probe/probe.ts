/**
 * R517 probe: the measurements in R517's close (`docs/roadmap/R517.md`) came from this, run on
 * al-runner 2.12.0-main.43f76177. Throwaway. Lives beside app/ and tests/ (the AL probe project).
 * Usage, from this directory:
 *   bun probe.ts backend <oneshot|server|resource-server|resource-oneshot> <timeoutMs>
 *       LethAL's own AlRunnerBackend: deploy, activate(null), run() each of the three tests.
 *       The session's floor is handed over first, as `runSession` does (R517 D1: the server
 *       variants refuse to start a daemon without it): PROBE_FLOOR_MS (default 180000) and a
 *       120000 ms baseline timeout, so the daemon's --test-timeout is the larger of the two. Set
 *       PROBE_FLOOR_MS=150000 to see the stop move to 150 s.
 *   bun probe.ts raw
 *       LethAL's AlRunnerServer directly, two runTests rounds; prints each row's own durationMs.
 *       PROBE_EXTRA_ARGS="--test-timeout 20" appends daemon start flags.
 *   bun probe.ts field <name>
 *       one raw runTests request carrying an extra field <name>: 5.
 * The daemon inherits this process's environment, so AL_RUNNER_TEST_TIMEOUT_SEC set on the bun
 * command reaches it exactly as it would reach LethAL's `defaultServerSpawn`.
 */
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlRunnerBackend, defaultServerSpawn } from "../../packages/runner/src/al-runner-backend";
import { AlRunnerServer } from "../../packages/runner/src/al-runner-server";

const here = import.meta.dir;
const alRunner = process.env.LETHAL_ALRUNNER_PATH ?? "/work/tools/al-runner/current/al-runner";
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
console.log(
  `env AL_RUNNER_TEST_TIMEOUT_SEC=${process.env.AL_RUNNER_TEST_TIMEOUT_SEC ?? "<unset>"}`,
);

const tests = ["ShortA", "LongSpin", "ShortB"].map((method) => ({
  codeunitId: 79620,
  codeunitName: "R517 Probe Tests",
  method,
}));

const [mode, a1, a2] = process.argv.slice(2);
if (mode === "backend") {
  const variant = a1 ?? "server";
  const timeoutMs = Number(a2 ?? "180000");
  const floorMs = Number(process.env.PROBE_FLOOR_MS ?? "180000");
  const scratch = await mkdtemp(join(tmpdir(), "r517-"));
  const src = join(scratch, "src-copy");
  await cp(join(here, "app"), src, { recursive: true });
  const backend = new AlRunnerBackend(
    {
      alRunnerPath: alRunner,
      instrumentedDir: join(scratch, "inst"),
      testDir: join(here, "tests"),
      selectorObjectId: 79610,
      ...(variant.includes("server") ? { serverMode: true } : {}),
      ...(variant.startsWith("resource") ? { selectorMode: "resource" as const } : {}),
    },
    undefined,
    defaultServerSpawn,
  );
  backend.useMutantBudgetFloor(floorMs, 120_000);
  console.log(
    `${at()} variant=${variant} timeoutMs=${timeoutMs} floorMs=${floorMs} inRunStopMs=${backend.inRunStopMs ?? "-"} inRunStopIsBudget=${backend.inRunStopIsBudget}`,
  );
  try {
    await backend.deploy(src);
    await backend.activate(null);
    for (const ref of tests) {
      const s = Date.now();
      const v = await backend.run(ref, { coverage: "none", timeoutMs });
      console.log(
        `${at()} ${ref.method}: outcome=${v.outcome} durationMs=${v.durationMs} measuredDurationMs=${v.measuredDurationMs ?? "-"} reportedStopMs=${v.reportedStopMs ?? "-"} callWallMs=${Date.now() - s} msg=${JSON.stringify((v.failureMessage ?? "").slice(0, Number(process.env.PROBE_MSG_LEN ?? "160")))}`,
      );
    }
  } finally {
    await backend.close();
    await rm(scratch, { recursive: true, force: true });
  }
} else if (mode === "raw") {
  const extra = (process.env.PROBE_EXTRA_ARGS ?? "").split(" ").filter((s) => s !== "");
  console.log(`extra daemon argv: ${JSON.stringify(extra)}`);
  const server = new AlRunnerServer(alRunner, (argv) => defaultServerSpawn([...argv, ...extra]));
  await server.start(10 * 60 * 1000);
  console.log(`${at()} ready`);
  for (const round of [1, 2]) {
    const s = Date.now();
    const res = await server.runTests(
      { sourcePaths: [join(here, "app"), join(here, "tests")], testIsolation: "test" },
      10 * 60 * 1000,
    );
    console.log(
      `${at()} round ${round}: suite wall ${Date.now() - s} ms, total=${res.total} exit=${res.exitCode}`,
    );
    for (const t of res.tests) {
      console.log(
        `   ${t.name}: status=${t.status} durationMs=${t.durationMs ?? "-"} msg=${JSON.stringify(t.message ?? "")}`,
      );
    }
  }
  await server.close();
} else if (mode === "field") {
  const field = a1 ?? "testTimeout";
  const child = spawn(alRunner, ["--server"], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let n = 0;
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    for (;;) {
      const i = buf.indexOf("\n");
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      console.log(`${at()} < ${line.slice(0, 400)}`);
      n++;
      if (n === 1) {
        const req = {
          command: "runTests",
          sourcePaths: [join(here, "app"), join(here, "tests")],
          testIsolation: "test",
          [field]: 5,
        };
        console.log(`${at()} > ${JSON.stringify(req)}`);
        child.stdin.write(`${JSON.stringify(req)}\n`);
      } else if (line.includes('"summary"') || line.includes('"error"')) {
        child.stdin.end();
      }
    }
  });
  await new Promise((r) => child.on("exit", r));
} else {
  console.error("usage: see header");
  process.exit(2);
}
