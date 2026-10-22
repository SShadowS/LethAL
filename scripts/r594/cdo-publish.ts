#!/usr/bin/env bun
/**
 * R594 step 4: build the bc3 package dir, publish the CDO target (a plain, uninstrumented build)
 * and its test app to bc3, then check P2 and P3. Run it under a bc3 coord lease the caller holds.
 *
 *   bun scripts/r594/cdo-publish.ts [--check-only]
 *
 * The package dir (`PACKAGES`, gitignored, LethAL-owned) holds bc3's OWN Microsoft symbols (the 11
 * apps of R546's packagesDir plus System, downloaded from bc3) and the 5 sha256-pinned Continia
 * packages. It is the bcdev legs' packageCachePath. cdo-r396's `Test/.alpackages` stays untouched:
 * it is pinned for al-runner.
 *
 * The login is read from the secret file inside this process. Nothing printed holds a credential
 * or CDO source text: only versions, counts and true/false.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import {
  publishedAlSources,
  readAppIdentity,
} from "../../packages/runner/src/published-test-app.ts";
import {
  CONTINIA_APPS,
  type Conn,
  PINNED_MICROSOFT,
  alcCompile,
  ensureApp,
  readContinia,
  readSecretFile,
  residentPackage,
} from "../bc-linux-setup.ts";

const REPO = join(import.meta.dir, "..", "..");
export const CDO = "/work/lethal-wt/cdo-r396";
export const WORK = join(REPO, ".kraken-local", "r594");
export const PACKAGES = join(WORK, "bc3-packages");
const TARGET = "Continia Document Output";
const TESTS = "Continia Document Output 365 - Test";
const PUB = "Continia Software";

const checkOnly = process.argv.includes("--check-only");
const alcDir = process.env.LETHAL_ALC_DIR;
if (alcDir === undefined) throw new Error("LETHAL_ALC_DIR is not set");
const alc = join(alcDir, "alc");
const login = readSecretFile();
const c: Conn = {
  server: "bc3",
  authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
};
async function version(publisher: string, name: string): Promise<string | null> {
  const b = await residentPackage(c, publisher, name);
  return b === null ? null : readAppIdentity(b).version;
}

console.log(
  `P2 before: target ${await version(PUB, TARGET)}, test app ${await version(PUB, TESTS)}`,
);

if (!checkOnly) {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(PACKAGES, { recursive: true });
  for (const name of ["System", ...PINNED_MICROSOFT]) {
    const pkg = await residentPackage(c, "Microsoft", name);
    if (pkg === null) throw new Error(`bc3 holds no Microsoft ${name} package`);
    const v = readAppIdentity(pkg).version;
    writeFileSync(join(PACKAGES, `Microsoft_${name}_${v}.app`), pkg);
    console.log(`symbols   Microsoft ${name} ${v}`);
  }
  for (const app of CONTINIA_APPS) writeFileSync(join(PACKAGES, app.file), readContinia(app));

  // Cloud: a copy whose app.json logo uses "/" (R422: the Linux alc reads "\" literally).
  const cloud = join(WORK, "Cloud");
  cpSync(join(CDO, "Cloud"), cloud, { recursive: true });
  const appJson = JSON.parse(readFileSync(join(cloud, "app.json"), "utf8")) as { logo?: string };
  if (appJson.logo !== undefined) appJson.logo = appJson.logo.replaceAll("\\", "/");
  writeFileSync(join(cloud, "app.json"), JSON.stringify(appJson, null, 2));
  const cloudApp = join(WORK, "cloud.app");
  await alcCompile(alc, cloud, PACKAGES, cloudApp);
  const t = await ensureApp(c, readFileSync(cloudApp), "CDO target");
  console.log(`target    ${t.outcome} ${t.version}`);

  // Test: the untouched sources, against the package dir plus the target bc3 now holds.
  const testCache = join(WORK, "test-cache");
  cpSync(PACKAGES, testCache, { recursive: true });
  const resident = await residentPackage(c, PUB, TARGET);
  if (resident === null) throw new Error("the CDO target is not on bc3 after its publish");
  writeFileSync(join(testCache, `${PUB}_${TARGET}.app`), resident);
  const testApp = join(WORK, "test.app");
  await alcCompile(alc, join(CDO, "Test"), testCache, testApp);
  const r = await ensureApp(c, readFileSync(testApp), "CDO test app");
  console.log(`test app  ${r.outcome} ${r.version}`);
}

// P3: the published test app's .al sources equal the local Test sources (LF, no BOM), as a multiset.
const norm = (s: string): string => s.replace(/^﻿/, "").replace(/\r\n/g, "\n");
const hash = (s: string): string => createHash("sha256").update(norm(s)).digest("hex");
const pkg = await residentPackage(c, PUB, TESTS);
if (pkg === null) throw new Error("P3: no CDO test app on bc3");
const remote = publishedAlSources(pkg)
  .map((x) => hash(x.text))
  .sort();
const local: string[] = [];
for (const f of new Glob("**/*.al").scanSync({ cwd: join(CDO, "Test") })) {
  if (!f.startsWith(".alpackages")) local.push(hash(readFileSync(join(CDO, "Test", f), "utf8")));
}
local.sort();
const equal = remote.length === local.length && remote.every((x, i) => x === local[i]);
console.log(`P3: remote ${remote.length} .al, local ${local.length} .al, multiset equal: ${equal}`);
console.log(
  `P2 after: target ${await version(PUB, TARGET)}, test app ${await version(PUB, TESTS)}`,
);
process.exit(equal && local.length > 0 ? 0 : 1);
