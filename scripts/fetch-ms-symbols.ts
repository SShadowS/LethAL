#!/usr/bin/env bun
/**
 * R834: downloads Microsoft's public symbol packages for one Business Central major version, for a
 * user with no BC server (the al-runner-v3 backend needs them in `alRunnerV3.packagesDir`).
 *
 *   bun scripts/fetch-ms-symbols.ts <bc-major> <out-dir>
 *
 * Source: Microsoft's public, anonymous NuGet feed `MSSymbols`. No login. A `.nupkg` is a plain zip
 * holding the `.app`; each package is picked on its own (their version numbers differ, and
 * Microsoft.Platform has only three numbers). At the end it prints the `bcVersion` a config must
 * name: the System Application's version.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { listPackageEntries, readPackageEntry } from "../packages/runner/src/app-package";

export const FEED_INDEX =
  "https://dynamicssmb2.pkgs.visualstudio.com/DynamicsBCPublicFeeds/_packaging/MSSymbols/nuget/v3/index.json";

/** The packages alc and al-runner read. Business Foundation's id was read from the feed (BC 26 and
 *  later: Base Application depends on it). */
export const PACKAGE_IDS = [
  "Microsoft.Platform.symbols",
  "Microsoft.Application.symbols",
  "Microsoft.SystemApplication.symbols.63ca2fa4-4f03-4f2b-a480-172fef340d3f",
  "Microsoft.BaseApplication.symbols.437dbf0e-84ff-417a-965d-ed2bb9650972",
  "Microsoft.BusinessFoundation.symbols.f3552374-a1f2-4356-848e-196002525837",
] as const;
const SYSTEM_APPLICATION_ID = PACKAGE_IDS[2];

export type FetchFn = (url: string) => Promise<Response>;

export class NoBuildForMajorError extends Error {
  constructor(
    readonly major: number,
    readonly packageId: string,
  ) {
    super(
      `the symbol feed has no build of ${packageId} for BC major ${major}. Pick a major the feed carries (it holds the recent ones).`,
    );
    this.name = "NoBuildForMajorError";
  }
}

/** The newest plain-numbered version with this major, or undefined. Compares number by number. */
export function pickNewest(versions: readonly string[], major: number): string | undefined {
  const parsed = versions
    .filter((v) => /^\d+(\.\d+)+$/.test(v) && Number(v.split(".")[0]) === major)
    .map((v) => ({ v, n: v.split(".").map(Number) }));
  parsed.sort((a, b) => {
    for (let i = 0; i < Math.max(a.n.length, b.n.length); i++) {
      const d = (b.n[i] ?? 0) - (a.n[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  });
  return parsed[0]?.v;
}

async function getJson(fetchFn: FetchFn, url: string): Promise<unknown> {
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`GET ${url} answered ${r.status}`);
  return r.json();
}

export interface PlannedPackage {
  readonly id: string;
  readonly version: string;
  readonly url: string;
}

/** Chooses each package's newest build of `major`. Throws `NoBuildForMajorError` when one has none. */
export async function planDownloads(major: number, fetchFn: FetchFn): Promise<PlannedPackage[]> {
  const index = (await getJson(fetchFn, FEED_INDEX)) as {
    resources?: { "@id": string; "@type": string }[];
  };
  const base = index.resources
    ?.find((r) => r["@type"].startsWith("PackageBaseAddress"))
    ?.["@id"].replace(/\/?$/, "/");
  if (base === undefined) throw new Error("the feed index lists no PackageBaseAddress resource");
  const plan: PlannedPackage[] = [];
  for (const id of PACKAGE_IDS) {
    const lower = id.toLowerCase();
    const list = (await getJson(fetchFn, `${base}${lower}/index.json`)) as { versions?: string[] };
    const version = pickNewest(list.versions ?? [], major);
    if (version === undefined) throw new NoBuildForMajorError(major, id);
    plan.push({ id, version, url: `${base}${lower}/${version}/${lower}.${version}.nupkg` });
  }
  return plan;
}

/** The `.app` entries of a `.nupkg` (a zip). */
export function appEntries(nupkg: Buffer): string[] {
  return listPackageEntries(nupkg).filter((n) => n.toLowerCase().endsWith(".app"));
}

/** Downloads the plan into `outDir`. Returns the files written and the `bcVersion` to configure. */
export async function fetchSymbols(
  major: number,
  outDir: string,
  fetchFn: FetchFn,
): Promise<{ files: string[]; bcVersion: string }> {
  const plan = await planDownloads(major, fetchFn);
  await mkdir(outDir, { recursive: true });
  const files: string[] = [];
  for (const p of plan) {
    const r = await fetchFn(p.url);
    if (!r.ok) throw new Error(`GET ${p.url} answered ${r.status}`);
    const pkg = Buffer.from(await r.arrayBuffer());
    const apps = appEntries(pkg);
    if (apps.length === 0) throw new Error(`${p.id} ${p.version} holds no .app file`);
    for (const name of apps) {
      const bytes = readPackageEntry(pkg, name);
      if (bytes === null) throw new Error(`${p.id}: cannot read ${name}`);
      const dest = join(outDir, basename(name));
      await writeFile(dest, bytes);
      files.push(dest);
    }
  }
  const sys = plan.find((p) => p.id === SYSTEM_APPLICATION_ID);
  if (sys === undefined) throw new Error("internal: the plan has no System Application");
  return { files, bcVersion: sys.version };
}

/** Printed under the config line: the printed "environment" is a guess the user must check. */
export const ENVIRONMENT_HINT =
  'Change "environment" to "saas" if your target runs on a SaaS server: it must match the target.';

/** The config line to print: `packagesDir` is absolute, so it works from any folder. */
export function configLine(outDir: string, bcVersion: string): string {
  // JSON.stringify escapes a Windows path's backslashes, so the printed line is valid JSON.
  return `"alRunnerV3": { "packagesDir": ${JSON.stringify(resolve(outDir))}, "bcVersion": ${JSON.stringify(bcVersion)}, "environment": "onprem" }`;
}

async function main(): Promise<number> {
  const [majorArg, outDir] = process.argv.slice(2);
  const major = Number(majorArg);
  if (!Number.isInteger(major) || major < 1 || outDir === undefined) {
    console.error(
      "usage: bun scripts/fetch-ms-symbols.ts <bc-major> <out-dir>   (example: 28 ./symbols)",
    );
    return 2;
  }
  const { files, bcVersion } = await fetchSymbols(major, outDir, fetch);
  for (const f of files) console.log(`  wrote ${f}`);
  console.log(`\nSet in the config:  ${configLine(outDir, bcVersion)}`);
  console.log(ENVIRONMENT_HINT);
  return 0;
}

if (import.meta.main) {
  main().then(
    (c) => process.exit(c),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
