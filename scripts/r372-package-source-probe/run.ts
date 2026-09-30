// R-372 probe: what the dev endpoint's /packages download carries per resourceExposurePolicy.
// Run from the repo root: bun scripts/r372-package-source-probe/run.ts
// Publishes a scratch app "LethAL R372 Probe" to Cronus28 only. Credentials are read at runtime
// from the gitignored sandbox-harden config and never printed. Unpublishing is a separate
// PowerShell step (UnPublish-BcContainerApp), recorded in RESULTS.md.
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listPackageEntries, readPackageEntry } from "../../packages/runner/src/app-package";
import { devPackagesUrl } from "../../packages/runner/src/bcdev-backend";

const DIR = import.meta.dir;
const SRC = join(DIR, "src", "R372Probe.Codeunit.al");
const OUT = join(DIR, "output.txt");
const BUILD = join(tmpdir(), "r372-probe-build");
mkdirSync(BUILD, { recursive: true });
const SYMBOLS = "U:/Git/LethAL/fixtures/sandbox-harden-tests/.alpackages";
const cfg = JSON.parse(
  readFileSync("U:/Git/LethAL/fixtures/sandbox-harden/lethal.config.local.json", "utf8"),
).bcdev;
if (cfg.server !== "http://Cronus28")
  throw new Error(`config targets ${cfg.server}, not Cronus28; refusing`);
const user: string = cfg.env.BC_DEV_USER;
const pass: string = cfg.env.BC_DEV_PASSWORD;

const extRoot = join(homedir(), ".vscode", "extensions");
const ext = readdirSync(extRoot)
  .filter((d) => d.startsWith("ms-dynamics-smb.al-"))
  .sort()
  .reverse()[0];
if (ext === undefined) throw new Error("no AL extension");
const bin = join(extRoot, ext, "bin");
const alc = join(bin, "alc.exe");
const altool = join(bin, "altool.exe");

const APP = { publisher: "LethAL", name: "LethAL R372 Probe" };
const log = (s: string) => {
  console.log(s);
  appendFileSync(OUT, `${s}\n`);
};
const norm = (s: string) => s.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

function writeAppJson(version: string, policy: Record<string, boolean> | undefined) {
  const app: Record<string, unknown> = {
    id: "5d0c3b7e-8a51-4f7e-9c2b-372a0f0e7a11",
    name: APP.name,
    publisher: APP.publisher,
    version,
    brief: "R-372 scratch probe. Not for production use.",
    description: "Measures what the dev /packages download carries per resourceExposurePolicy.",
    idRanges: [{ from: 79900, to: 79909 }],
    runtime: "13.0",
    dependencies: [],
    features: [],
  };
  if (policy !== undefined) app.resourceExposurePolicy = policy;
  writeFileSync(join(DIR, "app.json"), `${JSON.stringify(app, null, 2)}\n`);
}

function run(argv: string[], env?: Record<string, string>) {
  const r = Bun.spawnSync(argv, {
    env: { ...process.env, ...(env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() };
}

function describe(label: string, buf: Buffer, disk: string) {
  const all = listPackageEntries(buf);
  const entries = all.filter((e) => e.toLowerCase().endsWith(".al"));
  const manifest = readPackageEntry(buf, "NavxManifest.xml")?.toString("utf8") ?? "";
  const ver = /Version="([^"]+)"/.exec(manifest.slice(manifest.indexOf("<App ")))?.[1];
  const eq = entries.map((e) => {
    const t = readPackageEntry(buf, e);
    return `${e}=${t !== null && norm(t.toString("utf8")) === norm(disk) ? "EQUAL" : "DIFFERENT"}`;
  });
  log(
    `  ${label}: bytes=${buf.length} manifestVersion=${ver} allEntries=${all.length} alEntries=${entries.length} [${eq.join(", ")}]`,
  );
  log(`    entries: ${all.join(", ")}`);
  return entries;
}

async function download() {
  const url = devPackagesUrl(cfg, APP);
  if (url === null) throw new Error("devPackagesUrl returned null");
  const res = await fetch(url, { headers: { authorization: `Basic ${btoa(`${user}:${pass}`)}` } });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

async function publishCase(
  label: string,
  version: string,
  policy: Record<string, boolean> | undefined,
) {
  writeAppJson(version, policy);
  const appPath = join(BUILD, `r372_${version}.app`);
  const c = run([alc, `/project:${DIR}`, `/packagecachepath:${SYMBOLS}`, `/out:${appPath}`]);
  if (c.code !== 0) throw new Error(`alc failed for ${label}:\n${c.out}`);
  const p = run(
    [
      altool,
      "publishapp",
      appPath,
      "--server",
      cfg.server,
      "--serverinstance",
      cfg.serverInstance,
      "--environmenttype",
      "OnPrem",
      "--authentication",
      "UserPassword",
      "--schemaupdatemode",
      "ForceSync",
      "--tenant",
      cfg.tenant,
    ],
    { BC_SERVER_USERNAME: user, BC_SERVER_PASSWORD: pass },
  );
  if (p.code !== 0)
    throw new Error(`altool publishapp failed for ${label} (exit ${p.code}):\n${p.out}`);
  return appPath;
}

const A_FLAGS = {
  allowDebugging: true,
  allowDownloadingSource: true,
  includeSourceInSymbolFile: true,
};
const CASES: [string, string, Record<string, boolean> | undefined][] = [
  ["A", "1.0.0.1", A_FLAGS],
  [
    "B",
    "1.0.0.2",
    { allowDebugging: true, allowDownloadingSource: true, includeSourceInSymbolFile: false },
  ],
  [
    "C",
    "1.0.0.3",
    { allowDebugging: true, allowDownloadingSource: false, includeSourceInSymbolFile: true },
  ],
  ["D", "1.0.0.4", undefined],
];

writeFileSync(OUT, "");
const original = readFileSync(SRC, "utf8");
log(
  `R-372 probe, ${new Date().toISOString()}, AL extension ${ext}, target ${cfg.server}/${cfg.serverInstance} tenant ${cfg.tenant}`,
);
log(`alc: ${run([alc, "/?"]).out.split("\n")[0]}`);
try {
  for (const [label, version, policy] of CASES) {
    log(
      `CASE ${label} version ${version} resourceExposurePolicy=${policy === undefined ? "(absent)" : JSON.stringify(policy)}`,
    );
    const appPath = await publishCase(label, version, policy);
    log("  published: OK");
    describe("local .app", readFileSync(appPath), original);
    const d = await download();
    log(`  download: HTTP ${d.status}`);
    if (d.status === 200) describe("downloaded", d.buf, original);
    else log(`  body: ${d.buf.toString("utf8").slice(0, 300)}`);
  }

  log(
    "UNPUBLISHED-EDIT CHECK (uses CASE A flags: allowDownloadingSource true, includeSourceInSymbolFile true)",
  );
  await publishCase("A-edit", "1.0.0.5", A_FLAGS);
  log("  published 1.0.0.5 with body X (ProbeAlpha: X := 1)");
  const edited = original.replace("X := 1;", "X := 2;");
  if (edited === original) throw new Error("edit did not apply");
  writeFileSync(SRC, edited);
  log("  edited disk ProbeAlpha to X := 2, NOT republished");
  const d = await download();
  log(`  download: HTTP ${d.status}`);
  const entries = describe("downloaded vs ORIGINAL body X", d.buf, original);
  describe("downloaded vs EDITED disk body", d.buf, edited);
  const text = entries.map((e) => readPackageEntry(d.buf, e)?.toString("utf8") ?? "").join("\n");
  log(
    `  downloaded source holds OLD body (X := 1): ${text.includes("X := 1;")}; holds NEW body (X := 2): ${text.includes("X := 2;")}`,
  );
} finally {
  writeFileSync(SRC, original);
  writeAppJson("1.0.0.1", A_FLAGS);
}
