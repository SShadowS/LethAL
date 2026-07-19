import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompiledArtifact } from "./artifact";

export type SpawnFn = (
  argv: readonly string[],
  opts?: { signal?: AbortSignal; env?: Record<string, string> },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const bunSpawn: SpawnFn = async (argv, opts) => {
  // Bun.spawn supports `signal` natively (kills the child with SIGTERM when
  // the AbortSignal fires) — no manual proc.kill() wiring needed.
  const proc = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
    // Bun.spawn's `env`, when given, REPLACES the child's environment rather than merging
    // with process.env (unlike leaving it unset, which fully inherits) — merge explicitly so
    // adding credentials for altool doesn't drop PATH/SystemRoot/etc. that alc/altool need.
    ...(opts?.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
};

export const defaultSpawn = bunSpawn;

/**
 * Config for `ContainerDeployer.publish()` — only the fields that concern shipping an
 * already-compiled artifact to a BC server (see `ArtifactCompilerConfig` in artifact.ts for
 * the compile-side half), so a publish-only caller doesn't need to know about
 * alc/packageCachePath/outputDir.
 */
export interface ContainerDeployerConfig {
  readonly altoolPath: string;
  readonly server: string;
  readonly serverInstance: string;
  readonly tenant?: string;
  // altool publishapp defaults --authentication to AAD; on-prem UserPassword auth (verified
  // against real altool.exe --help plus the BC_SERVER_USERNAME/BC_SERVER_PASSWORD strings in
  // Microsoft.Dynamics.Nav.Deployment.dll) needs these passed as env vars to the altool
  // process, not as CLI flags — altool has no --username/--password option.
  readonly username: string;
  readonly password: string;
}

export interface ContainerDeployerIo {
  readonly spawn: SpawnFn;
  readonly readArtifact: (path: string) => Promise<Uint8Array>;
}

/** Real-filesystem `ContainerDeployerIo`: spawn the actual altool, read the actual bytes. */
export const defaultDeployerIo: ContainerDeployerIo = {
  spawn: defaultSpawn,
  readArtifact: async (path) => new Uint8Array(await readFile(path)),
};

/**
 * Publishes an immutable, content-addressed `CompiledArtifact` (see artifact.ts) to a BC
 * server. Re-hashes the artifact's bytes on disk immediately before spawning altool and
 * refuses to publish on a mismatch: the file at `artifact.appPath` must be exactly what
 * `ArtifactCompiler` produced, not something that changed underneath it between compile and
 * publish.
 */
export class ContainerDeployer {
  constructor(
    private readonly cfg: ContainerDeployerConfig,
    private readonly io: ContainerDeployerIo,
  ) {}

  async publish(artifact: CompiledArtifact): Promise<void> {
    const bytes = await this.io.readArtifact(artifact.appPath);
    const actual = Bun.SHA256.hash(bytes, "hex");
    if (actual !== artifact.sha256) {
      throw new Error(
        `refusing to publish ${artifact.appPath}: digest ${actual} does not match the compiled ` +
          `artifact's ${artifact.sha256} — the file changed after compilation`,
      );
    }
    // Flag names verified against `altool publishapp --help` (all lowercase,
    // no camelCase): --server, --serverinstance, --schemaupdatemode, --tenant,
    // --authentication, --environmenttype. Default --authentication is AAD,
    // which would try interactive/device-code login against our UserPassword
    // on-prem server — must be overridden explicitly.
    const argv = [
      this.cfg.altoolPath,
      "publishapp",
      artifact.appPath,
      "--server",
      this.cfg.server,
      "--serverinstance",
      this.cfg.serverInstance,
      "--environmenttype",
      "OnPrem",
      "--authentication",
      "UserPassword",
      "--schemaupdatemode",
      "ForceSync",
    ];
    if (this.cfg.tenant) argv.push("--tenant", this.cfg.tenant);
    try {
      const res = await this.io.spawn(argv, {
        env: { BC_SERVER_USERNAME: this.cfg.username, BC_SERVER_PASSWORD: this.cfg.password },
      });
      if (res.exitCode !== 0) {
        throw new Error(
          `altool publishapp failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("altool publishapp failed")) {
        throw err;
      }
      throw new Error(
        `altool publishapp failed: ${err instanceof Error ? err.message : String(err)} (altoolPath: ${this.cfg.altoolPath})`,
      );
    }
  }
}

function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const parts2 = v2.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const maxLen = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLen; i++) {
    const p1 = parts1[i] ?? 0;
    const p2 = parts2[i] ?? 0;
    if (p1 !== p2) return p1 - p2;
  }
  return 0;
}

export async function defaultAlToolPaths(
  extensionsDir: string = join(homedir(), ".vscode", "extensions"),
): Promise<{ alcPath: string; altoolPath: string } | undefined> {
  let entries: string[];
  try {
    entries = await readdir(extensionsDir);
  } catch {
    return undefined;
  }
  const alExtensions = entries.filter((e) => e.startsWith("ms-dynamics-smb.al-"));
  if (alExtensions.length === 0) return undefined;

  const sorted = alExtensions.sort((a, b) => {
    const versionA = a.slice("ms-dynamics-smb.al-".length);
    const versionB = b.slice("ms-dynamics-smb.al-".length);
    return compareVersions(versionA, versionB);
  });

  const al = sorted.at(-1);
  if (!al) return undefined;
  const bin = join(extensionsDir, al, "bin", "win32");
  return { alcPath: join(bin, "alc.exe"), altoolPath: join(bin, "altool.exe") };
}
