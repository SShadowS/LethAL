import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type SpawnFn = (
  argv: readonly string[],
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

const bunSpawn: SpawnFn = async (argv) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
};

export const defaultSpawn = bunSpawn;

export class Publisher {
  constructor(
    private readonly cfg: PublisherConfig,
    private readonly spawn: SpawnFn = bunSpawn,
  ) {}

  async compile(instrumentedDir: string): Promise<string> {
    const appPath = join(this.cfg.outputDir, "lethal-instrumented.app").replaceAll("\\", "/");
    const res = await this.spawn([
      this.cfg.alcPath,
      `/project:${instrumentedDir}`,
      `/packagecachepath:${this.cfg.packageCachePath}`,
      `/out:${appPath}`,
    ]);
    if (res.exitCode !== 0) {
      throw new Error(`alc compile failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`);
    }
    return appPath;
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
    const res = await this.spawn(argv);
    if (res.exitCode !== 0) {
      throw new Error(
        `altool publishapp failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`,
      );
    }
  }
}

export async function defaultAlToolPaths(): Promise<
  { alcPath: string; altoolPath: string } | undefined
> {
  const extDir = join(homedir(), ".vscode", "extensions");
  let entries: string[];
  try {
    entries = await readdir(extDir);
  } catch {
    return undefined;
  }
  const al = entries
    .filter((e) => e.startsWith("ms-dynamics-smb.al-"))
    .sort()
    .at(-1);
  if (!al) return undefined;
  const bin = join(extDir, al, "bin", "win32");
  return { alcPath: join(bin, "alc.exe"), altoolPath: join(bin, "altool.exe") };
}
