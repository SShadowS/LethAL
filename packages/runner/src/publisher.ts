import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CompiledArtifact } from "./artifact";
import { canonicalContainerKey, serializePublish } from "./publish-serializer";

export type SpawnFn = (
  argv: readonly string[],
  opts?: { signal?: AbortSignal; env?: Record<string, string>; cwd?: string },
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
    ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
};

export const defaultSpawn = bunSpawn;

/**
 * The publish half of a deployment channel. `ContainerDeployer` (altool against a container) and
 * `EnvToolPublisher` (an external environment CLI) both satisfy it, so `BcDevDeployment` can name
 * the contract rather than one implementation.
 */
export interface AppPublisher {
  publish(artifact: CompiledArtifact): Promise<void>;
}

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
export class ContainerDeployer implements AppPublisher {
  constructor(
    private readonly cfg: ContainerDeployerConfig,
    private readonly io: ContainerDeployerIo,
  ) {}

  async publish(artifact: CompiledArtifact): Promise<void> {
    // Everything below is serialized per physical container (see publish-serializer.ts): BC's
    // altool replace protocol races itself under genuine concurrent publishes to one container
    // (verified live, fixtures/README.md's "Deployment identity (Layer 5A)" section, Probe B,
    // 2026-07-20). This is an in-process guarantee only — it does not, and cannot, coordinate
    // two separate LethAL processes publishing to the same container; that is Layer 5C's
    // machine-global lease. Nothing inside this callback changed to add the wrap.
    await serializePublish(canonicalContainerKey(this.cfg), async () => {
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
          // BOTH streams, not `res.stderr || res.stdout` — verified live against Cronus281
          // (2026-07-20, Task 8's stale-publish probe): on a version-downgrade rejection, altool
          // prints only a generic one-line wrapper ("Publish failed: Publish operation failed.
          // Check the output for details.") to stderr, while the actual, machine-parseable BC
          // rejection ("Cannot install the extension ... because a newer version X.Y.Z.W was
          // already installed.") — the exact text `parseVersionConflict` (app-version.ts) needs —
          // is on STDOUT. `res.stderr || res.stdout` discarded stdout whenever stderr was
          // non-empty, silently losing that detail and breaking the version-conflict retry path
          // (orchestrator.ts) for every real publish failure, not just an edge case.
          const detail = [res.stdout, res.stderr].filter((s) => s.trim().length > 0).join("\n");
          throw new Error(`altool publishapp failed (exit ${res.exitCode}):\n${detail}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("altool publishapp failed")) {
          throw err;
        }
        throw new Error(
          `altool publishapp failed: ${err instanceof Error ? err.message : String(err)} (altoolPath: ${this.cfg.altoolPath})`,
        );
      }
    });
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
  // The AL Language extension ships native alc/altool binaries per-RID under bin/<platform>/,
  // not just bin/win32/. Hardcoding win32 here made every bcdev run on a Linux or macOS host spawn
  // a Windows PE binary that cannot execute, surfacing as an opaque empty-message spawn ENOENT
  // several layers up (ArtifactCompiler.compile's catch stringifies a message-less error).
  const platformDir = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const bin = join(extensionsDir, al, "bin", platformDir);
  return { alcPath: join(bin, `alc${exeSuffix}`), altoolPath: join(bin, `altool${exeSuffix}`) };
}
