#!/usr/bin/env bun
/**
 * Builds the standalone `lethal` executable(s) with `bun build --compile`.
 *
 *   bun run build:binary     — this machine's platform only
 *   bun run build:binaries   — every target in `TARGETS`
 *
 * LethAL ships as a compiled binary rather than an npm package: the audience is Business Central
 * AL developers on Windows who do not necessarily have Bun (or Node) installed, and the internal
 * `@lethal/*` workspace packages are implementation detail that a registry publish would expose.
 * See `docs/releasing.md`.
 *
 * The version stamped into each filename comes from the root `package.json` — the single source of
 * truth for the release version (workspace packages stay at `0.0.0`, see `docs/releasing.md`).
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = join(import.meta.dir, "..");
const ENTRY = join(REPO_ROOT, "packages", "runner", "src", "cli.ts");
const OUT_DIR = join(REPO_ROOT, "build");

interface BuildTarget {
  /** The value passed to `bun build --target`. */
  readonly target: string;
  /**
   * The npm package holding that target's Bun runtime. `bun build --compile --target` downloads
   * and extracts this; see `seedRuntime` for why we sometimes have to install it ourselves first.
   * Note aarch64/arm64: the PACKAGE name says `aarch64`, its npm `cpu` gate says `arm64`.
   */
  readonly runtimePackage: string;
  /** npm `os` field of `runtimePackage` — verified against the registry, not guessed. */
  readonly npmOs: string;
  /** npm `cpu` field of `runtimePackage` — verified against the registry, not guessed. */
  readonly npmCpu: string;
  /** Trailing part of the output filename, extension included. */
  readonly suffix: string;
}

const TARGETS: readonly BuildTarget[] = [
  {
    target: "bun-windows-x64",
    runtimePackage: "@oven/bun-windows-x64",
    npmOs: "win32",
    npmCpu: "x64",
    suffix: "windows-x64.exe",
  },
  {
    target: "bun-linux-x64",
    runtimePackage: "@oven/bun-linux-x64",
    npmOs: "linux",
    npmCpu: "x64",
    suffix: "linux-x64",
  },
  {
    target: "bun-linux-arm64",
    runtimePackage: "@oven/bun-linux-aarch64",
    npmOs: "linux",
    npmCpu: "arm64",
    suffix: "linux-arm64",
  },
  {
    target: "bun-darwin-x64",
    runtimePackage: "@oven/bun-darwin-x64",
    npmOs: "darwin",
    npmCpu: "x64",
    suffix: "darwin-x64",
  },
  {
    target: "bun-darwin-arm64",
    runtimePackage: "@oven/bun-darwin-aarch64",
    npmOs: "darwin",
    npmCpu: "arm64",
    suffix: "darwin-arm64",
  },
];

/**
 * The target matching the machine running this script, or `undefined` on a platform LethAL has no
 * entry for. `process.platform`/`process.arch` use npm's own vocabulary (`win32`/`x64`), which is
 * exactly what `npmOs`/`npmCpu` hold — so this is a direct comparison, not a translation table.
 */
function hostTarget(): BuildTarget | undefined {
  return TARGETS.find((t) => t.npmOs === process.platform && t.npmCpu === process.arch);
}

async function readVersion(): Promise<string> {
  const raw = await readFile(join(REPO_ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(raw) as { version?: unknown };
  const { version } = pkg;
  if (typeof version !== "string" || version === "") {
    throw new Error(
      "root package.json has no usable `version` — it is the release single source of truth",
    );
  }
  return version;
}

/** `bun pm cache` — Bun's shared install cache, which is also where `--compile` looks for a
 *  target runtime. Read from Bun itself rather than assumed to be `~/.bun/install/cache`, since
 *  `$BUN_INSTALL` moves it. */
async function bunCacheDir(): Promise<string> {
  const proc = Bun.spawn(["bun", "pm", "cache"], { stdout: "pipe", stderr: "pipe" });
  const [out, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const dir = out.trim();
  if (exitCode !== 0 || dir === "") {
    throw new Error(`\`bun pm cache\` exited ${exitCode} without naming a cache directory`);
  }
  return dir;
}

/**
 * Makes a cross-target Bun runtime available to `bun build --compile`, for the case where Bun
 * cannot fetch it itself.
 *
 * Measured 2026-07-27 on Windows: `bun build --compile --target=bun-linux-x64` fails with
 * `Failed to extract executable for 'bun-linux-x64-v1.3.14'. The download may be incomplete.` The
 * message points at the network, and the network is fine — the tarball is HTTP 200 and
 * `bun add --dry-run` resolves it. The real cause is the npm platform gate: `@oven/bun-linux-x64`
 * declares `"os": ["linux"], "cpu": ["x64"]`, Bun's installer honours that, so on a Windows host
 * the package resolves but never lands on disk and there is nothing to extract.
 *
 * Two steps, both measured rather than inferred:
 *
 *  1. `bun install --os=<os> --cpu=<cpu>` overrides the gate and extracts the foreign runtime to
 *     `<seedDir>/node_modules/<runtimePackage>/bin/bun`. This runs in a THROWAWAY directory under
 *     the OS temp dir, never in the repo — the same command inside LethAL would rewrite the repo's
 *     own `bun.lock` and `node_modules` for a foreign platform.
 *  2. Copy that executable to `<bun pm cache>/<pkg>-v<version>`, a FLAT FILE (not a directory),
 *     which is precisely where `--compile` looks. Installing alone is not enough: the seeded
 *     `node_modules` is in a directory Bun's compile step never consults, and the same failure
 *     repeats.
 *
 * Done once per target per machine — the cache file persists, so `alreadySeeded` short-circuits
 * every later build.
 */
async function seedRuntime(t: BuildTarget): Promise<void> {
  // `@oven/bun-linux-aarch64` -> `bun-linux-aarch64-v1.3.14`. Derived from the PACKAGE name, not
  // from `t.target`: Bun names this file with the package's `aarch64` spelling while `--target`
  // takes `arm64`, and the two must not be conflated.
  const pkgBase = t.runtimePackage.replace("@oven/", "");
  const cacheFile = join(await bunCacheDir(), `${pkgBase}-v${Bun.version}`);
  if (await Bun.file(cacheFile).exists()) return;

  const seedDir = join(tmpdir(), "lethal-bun-targets", t.target);
  await mkdir(seedDir, { recursive: true });
  await writeFile(
    join(seedDir, "package.json"),
    `${JSON.stringify(
      {
        name: `lethal-bun-target-${t.target}`,
        version: "0.0.0",
        private: true,
        dependencies: { [t.runtimePackage]: Bun.version },
      },
      null,
      2,
    )}\n`,
  );
  const proc = Bun.spawn(["bun", "install", `--os=${t.npmOs}`, `--cpu=${t.npmCpu}`], {
    cwd: seedDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `could not seed the ${t.target} runtime (${t.runtimePackage}@${Bun.version}) — ` +
        `\`bun install --os=${t.npmOs} --cpu=${t.npmCpu}\` exited ${exitCode}: ${stderr.trim()}`,
    );
  }

  const binDir = join(seedDir, "node_modules", ...t.runtimePackage.split("/"), "bin");
  // A Windows target ships `bun.exe`; every other target ships `bun`. Probed rather than branched
  // on `t.npmOs`, so a future target that names it differently fails on the explicit throw below
  // instead of on a confusing copy error.
  let source: string | undefined;
  for (const name of ["bun", "bun.exe"]) {
    if (await Bun.file(join(binDir, name)).exists()) {
      source = join(binDir, name);
      break;
    }
  }
  if (source === undefined) {
    throw new Error(
      `seeded ${t.runtimePackage}@${Bun.version} but found no bun executable in ${binDir} — the package layout changed; this script's assumption about \`bin/bun\` needs revisiting`,
    );
  }
  await copyFile(source, cacheFile);
}

/** Compiles one target. Returns the output path and its size in bytes. */
async function build(
  t: BuildTarget,
  version: string,
): Promise<{ readonly outPath: string; readonly bytes: number }> {
  const outPath = join(OUT_DIR, `lethal-${version}-${t.suffix}`);
  const proc = Bun.spawn(
    ["bun", "build", "--compile", `--target=${t.target}`, ENTRY, "--outfile", outPath],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    const stdout = await new Response(proc.stdout).text();
    throw new Error(`bun build --compile exited ${exitCode}: ${(stderr + stdout).trim()}`);
  }
  const bytes = (await Bun.file(outPath).stat()).size;
  return { outPath, bytes };
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { all: { type: "boolean", default: false } },
  });

  const version = await readVersion();
  await mkdir(OUT_DIR, { recursive: true });

  let selected: readonly BuildTarget[];
  if (values.all === true) {
    selected = TARGETS;
  } else {
    const host = hostTarget();
    if (host === undefined) {
      throw new Error(
        `no build target for this machine (${process.platform}/${process.arch}); ` +
          `known targets: ${TARGETS.map((t) => t.target).join(", ")}`,
      );
    }
    selected = [host];
  }

  console.log(`lethal ${version} — building ${selected.length} target(s) into ${OUT_DIR}\n`);

  const failures: { readonly target: string; readonly reason: string }[] = [];
  for (const t of selected) {
    try {
      let built: { readonly outPath: string; readonly bytes: number };
      try {
        // Attempt the plain build FIRST, always. Where Bun can fetch the target runtime by itself
        // — every same-platform build, and every host whose npm platform gate lets the `@oven/*`
        // package through — this is the whole story, and `seedRuntime`'s measured-on-Windows
        // assumptions about cache-file naming never come into play.
        built = await build(t, version);
      } catch (firstErr) {
        const detail = firstErr instanceof Error ? firstErr.message : String(firstErr);
        console.log(`  seed  ${t.target.padEnd(18)} fetching runtime (${t.runtimePackage})`);
        await seedRuntime(t);
        try {
          built = await build(t, version);
        } catch (retryErr) {
          const retryDetail = retryErr instanceof Error ? retryErr.message : String(retryErr);
          throw new Error(`${retryDetail} (first attempt, before seeding: ${detail})`);
        }
      }
      console.log(
        `  OK    ${t.target.padEnd(18)} ${mib(built.bytes).padStart(10)}  ${built.outPath}`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL  ${t.target.padEnd(18)} ${reason}`);
      failures.push({ target: t.target, reason });
    }
  }

  if (failures.length > 0) {
    // Loud and non-zero: a release that silently shipped four of five platforms would look
    // complete on the release page and be missing exactly the platform nobody tested.
    console.error(`\n${failures.length} of ${selected.length} target(s) failed to build.`);
    return 1;
  }
  console.log(`\nAll ${selected.length} target(s) built.`);
  return 0;
}

if (import.meta.main) {
  main()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? (err.stack ?? String(err)) : String(err));
      process.exit(1);
    });
}
