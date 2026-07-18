import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type SpawnFn = (
  argv: readonly string[],
  opts?: { signal?: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface PublisherConfig {
  readonly alcPath: string;
  readonly altoolPath: string;
  readonly packageCachePath: string; // target project's .alpackages
  readonly outputDir: string; // where the .app lands
  readonly server: string;
  readonly serverInstance: string;
  readonly tenant?: string;
}

const bunSpawn: SpawnFn = async (argv, opts) => {
  // Bun.spawn supports `signal` natively (kills the child with SIGTERM when
  // the AbortSignal fires) — no manual proc.kill() wiring needed.
  const proc = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
    ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
};

export const defaultSpawn = bunSpawn;

function toForwardSlashes(p: string): string {
  return p.replaceAll("\\", "/");
}

export class Publisher {
  constructor(
    private readonly cfg: PublisherConfig,
    private readonly spawn: SpawnFn = bunSpawn,
  ) {}

  async compile(instrumentedDir: string): Promise<string> {
    const appPath = toForwardSlashes(join(this.cfg.outputDir, "lethal-instrumented.app"));
    const projectPath = toForwardSlashes(instrumentedDir);
    const cachePath = toForwardSlashes(this.cfg.packageCachePath);
    try {
      const res = await this.spawn([
        this.cfg.alcPath,
        `/project:${projectPath}`,
        `/packagecachepath:${cachePath}`,
        `/out:${appPath}`,
      ]);
      if (res.exitCode !== 0) {
        throw new Error(`alc compile failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`);
      }
      return appPath;
    } catch (err) {
      if (err instanceof Error && err.message.includes("alc compile failed")) {
        throw err;
      }
      throw new Error(
        `alc compile failed: ${err instanceof Error ? err.message : String(err)} (alcPath: ${this.cfg.alcPath})`,
      );
    }
  }

  async publish(appPath: string): Promise<void> {
    const argv = [
      this.cfg.altoolPath,
      "publishapp",
      appPath,
      "--server",
      this.cfg.server,
      "--serverInstance",
      this.cfg.serverInstance,
      "--schemaSyncMode",
      "ForceSync",
    ];
    if (this.cfg.tenant) argv.push("--tenant", this.cfg.tenant);
    try {
      const res = await this.spawn(argv);
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
