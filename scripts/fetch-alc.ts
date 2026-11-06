#!/usr/bin/env bun
/**
 * R834: gets `alc` (the AL compiler) on a Linux box with no VS Code.
 *
 *   bun scripts/fetch-alc.ts <dir>
 *
 * Microsoft publishes no Linux alc download. The marketplace's AL Language VSIX is a universal one:
 * it holds `alc.dll` (a .NET program), not a native Linux binary. This script downloads that VSIX,
 * unpacks `extension/bin/` into `<dir>/bin/`, and writes `<dir>/alc`, a two-line shell wrapper that
 * runs `dotnet <dir>/bin/alc.dll`. You need the .NET runtime that alc.dll asks for; the script reads
 * the major version from `alc.runtimeconfig.json` and refuses by name if `dotnet` is not on PATH.
 */
import { realpathSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { listPackageEntries, readPackageEntry } from "../packages/runner/src/app-package";

/** A stable build, the one LethAL's gates use. `latest` is a pre-release, so it is not used. */
export const ALC_VERSION = "18.1.2842859";
export const vsixUrl = (version: string): string =>
  `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/ms-dynamics-smb/vsextensions/al/${version}/vspackage`;
export const VSIX_URL = vsixUrl(ALC_VERSION);
const PREFIX = "extension/bin/";

export type FetchFn = (url: string) => Promise<Response>;

export class DotnetMissingError extends Error {
  constructor(readonly major: string) {
    super(
      `dotnet is not on PATH. alc needs the .NET ${major} runtime (see https://dotnet.microsoft.com/download/dotnet/${major}.0). Install it, make sure \`dotnet\` runs, and run this again.`,
    );
    this.name = "DotnetMissingError";
  }
}

/** The .NET major version alc.dll asks for, read from its runtimeconfig (never guessed). */
export function dotnetMajor(runtimeConfigJson: string): string {
  const cfg = JSON.parse(runtimeConfigJson) as {
    runtimeOptions?: { framework?: { version?: string }; frameworks?: { version?: string }[] };
  };
  const v = cfg.runtimeOptions?.framework?.version ?? cfg.runtimeOptions?.frameworks?.[0]?.version;
  const major = v?.split(".")[0];
  if (major === undefined || !/^\d+$/.test(major)) {
    throw new Error("alc.runtimeconfig.json names no framework version");
  }
  return major;
}

/** Single-quotes a string for sh, so `$`, backtick, `"` and `'` in a path stay plain text. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

/** The version rides in a comment line: LethAL hashes this file, so a new alc is a new identity. */
export function wrapperText(
  dotnet: string,
  alcDll: string,
  version: string = ALC_VERSION,
  dotnetRoot: string = dirname(dotnet),
): string {
  // DOTNET_ROOT is the folder the real dotnet lives in, so a .NET installed under HOME (by
  // dotnet-install.sh) works without the user exporting anything.
  return `#!/bin/sh\n# alc from AL Language VSIX ${version}\nexport DOTNET_ROOT=${shellQuote(dotnetRoot)}\nexec ${shellQuote(dotnet)} ${shellQuote(alcDll)} "$@"\n`;
}

/** Unpacks the VSIX's `extension/bin/` into `<dir>/bin/` and writes `<dir>/alc`. Returns its path. */
export async function fetchAlc(
  dir: string,
  fetchFn: FetchFn,
  which: (cmd: string) => string | null = (c) => Bun.which(c),
  realpath: (p: string) => string = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  },
): Promise<string> {
  const root = resolve(dir);
  const r = await fetchFn(VSIX_URL);
  if (!r.ok) throw new Error(`GET ${VSIX_URL} answered ${r.status}`);
  const vsix = Buffer.from(await r.arrayBuffer());
  const names = listPackageEntries(vsix).filter((n) => n.startsWith(PREFIX) && !n.endsWith("/"));
  if (!names.includes(`${PREFIX}alc.dll`) || !names.includes(`${PREFIX}alc.runtimeconfig.json`)) {
    throw new Error(
      "the downloaded VSIX holds no extension/bin/alc.dll; Microsoft changed its layout",
    );
  }
  const cfgBytes = readPackageEntry(vsix, `${PREFIX}alc.runtimeconfig.json`);
  if (cfgBytes === null) throw new Error("cannot read alc.runtimeconfig.json");
  const major = dotnetMajor(cfgBytes.toString("utf8"));
  const dotnet = which("dotnet");
  if (dotnet === null) throw new DotnetMissingError(major);
  const binRoot = join(root, "bin");
  const dests = names.map((name) => {
    const dest = resolve(binRoot, name.slice(PREFIX.length));
    // A zip entry such as extension/bin/../../x must not write outside <dir>/bin.
    if (!dest.startsWith(binRoot + sep))
      throw new Error(`refusing VSIX entry outside bin/: ${name}`);
    return dest;
  });
  for (const [i, name] of names.entries()) {
    const bytes = readPackageEntry(vsix, name);
    if (bytes === null) throw new Error(`cannot read ${name}`);
    const dest = dests[i] ?? "";
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  }
  const alc = join(root, "alc");
  await writeFile(
    alc,
    wrapperText(dotnet, join(root, "bin", "alc.dll"), ALC_VERSION, dirname(realpath(dotnet))),
  );
  await chmod(alc, 0o755);
  return alc;
}

/** The wrapper is an sh script, and al-runner-v3 is Linux only: on Windows there is nothing to fetch. */
export function platformRefusal(platform: string): string | undefined {
  return platform === "win32"
    ? "fetch-alc is for Linux (and macOS). On Windows, alc comes with the AL Language VS Code extension."
    : undefined;
}

async function main(): Promise<number> {
  const dir = process.argv[2];
  if (dir === undefined) {
    console.error("usage: bun scripts/fetch-alc.ts <dir>   (example: ./alc)");
    return 2;
  }
  const refused = platformRefusal(process.platform);
  if (refused !== undefined) {
    console.error(refused);
    return 2;
  }
  const alc = await fetchAlc(dir, fetch);
  console.log(
    `wrote ${alc} (AL Language ${ALC_VERSION})\n\nSet in the config:  "alcPath": ${JSON.stringify(alc)}`,
  );
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
