/**
 * R766 (follow-up) probe. Does user AL state (a SingleInstance codeunit's global) carry between
 * entries of one `serve` request, and between requests on one daemon? Measurement only.
 *
 *   flock -n /coord/locks/heavy.<n> bun scripts/r766-probe/drive.ts
 *
 * Self-contained: al-runner reads AL source (sourcePaths), so no alc build. Every wait is bounded;
 * the daemon is always killed. Texts go whole to OUT. No BC server, no login. See README.md.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const BIN = "/work/tools/al-runner-v3/current/al-runner";
const OUT = process.env.R766_OUT ?? "/coord/handoff/R-766/carryover";
const BC = "28.0.46665.47126";
const DEPS_FROM =
  process.env.R766_DEPS ?? "/work/lethal-wt/al-runner-v3-gate/fixtures/sandbox-tests/.alpackages";
const READY_MS = 180_000;
const REQUEST_MS = 120_000;
const ONESHOT_MS = 180_000;
const TARGET = join(HERE, "target");
const TESTS = join(HERE, "tests");
const A = 50761;
const B = 50762;
const C = 50763; // always fails; its message is the counter after two bumps (2 if fresh)

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const PKG = join(OUT, "packages");
mkdirSync(PKG);
for (const f of readdirSync(DEPS_FROM))
  if (f.startsWith("Microsoft_")) cpSync(join(DEPS_FROM, f), join(PKG, f));

const version = Bun.spawnSync([BIN, "--version"]).stdout.toString().trim();
console.log(version);
writeFileSync(join(OUT, "version.txt"), `${version}\n`);

// ---- control: each test codeunit in a fresh one-shot process
const control: Record<string, unknown> = {};
for (const cu of [A, B, C]) {
  const p = Bun.spawn(
    [
      BIN,
      "test",
      "--output-json",
      "--isolation",
      "test",
      "--test-timeout-secs",
      "60",
      "--codeunit",
      String(cu),
      "--package-cache",
      PKG,
      "--bc-version",
      BC,
      "--no-download",
      TARGET,
      TESTS,
    ],
    { stdout: "pipe", stderr: "pipe", cwd: OUT },
  );
  const timer = setTimeout(() => p.kill(), ONESHOT_MS);
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(timer);
  writeFileSync(join(OUT, `oneshot-${cu}.stdout.txt`), o);
  writeFileSync(join(OUT, `oneshot-${cu}.stderr.txt`), e);
  control[String(cu)] = { exit: p.exitCode, stdout: o };
  console.log(`one-shot ${cu}: exit ${p.exitCode}`);
}

// ---- serve daemon
const d = Bun.spawn(
  [
    BIN,
    "serve",
    "--package-cache",
    PKG,
    "--test-timeout",
    "60",
    "--bc-version",
    BC,
    "--no-download",
  ],
  {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: OUT,
  },
);
let stderr = "";
(async () => {
  for await (const c of d.stderr) stderr += new TextDecoder().decode(c);
})();
const reader = d.stdout.getReader();
let buf = "";
const dec = new TextDecoder();
async function line(ms: number): Promise<string> {
  const end = Date.now() + ms;
  for (;;) {
    const i = buf.indexOf("\n");
    if (i >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      return l;
    }
    const left = end - Date.now();
    if (left <= 0) throw new Error(`timeout after ${ms} ms; stderr: ${stderr.slice(-600)}`);
    const r = await Promise.race([
      reader.read(),
      new Promise<null>((ok) => setTimeout(() => ok(null), left)),
    ]);
    if (r === null) continue;
    if (r.done) throw new Error(`daemon stdout closed; stderr: ${stderr.slice(-600)}`);
    buf += dec.decode(r.value);
  }
}
const results: Record<string, unknown> = {};
try {
  console.log(`ready: ${await line(READY_MS)}`);
  const entries = [
    { id: "e1-A", test: `Codeunit${A}.` },
    { id: "e2-A-again", test: `Codeunit${A}.` },
    { id: "e3-B", test: `Codeunit${B}.` },
    { id: "e4-C-control", test: `Codeunit${C}.` },
    { id: "e5-A-after-C", test: `Codeunit${A}.` },
  ];
  for (const req of ["request1", "request2"]) {
    d.stdin.write(
      `${JSON.stringify({ command: "runTests", sourcePaths: [TARGET, TESTS], testIsolation: "test", entries })}\n`,
    );
    d.stdin.flush();
    const lines: unknown[] = [];
    for (;;) {
      const l = await line(REQUEST_MS);
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(l);
      } catch {
        lines.push({ unparseable: l });
        break;
      }
      lines.push(m);
      if (m.type === "summary" || (m.type === undefined && "error" in m)) break;
    }
    results[req] = lines;
    writeFileSync(join(OUT, `${req}.lines.json`), JSON.stringify(lines, null, 2));
    console.log(`${req}: ${lines.length} lines`);
    for (const m of lines as Record<string, unknown>[])
      if (m.type === "test") console.log("  ", JSON.stringify(m));
  }
} finally {
  d.kill();
  await Promise.race([d.exited, new Promise((ok) => setTimeout(ok, 5000))]);
  writeFileSync(join(OUT, "serve.stderr.txt"), stderr);
}
writeFileSync(join(OUT, "all.json"), JSON.stringify({ version, control, results }, null, 2));
