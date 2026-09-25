import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type SpawnFn, defaultSpawn } from "../../src/publisher";

/** A path git will never find a config file at — used to disable both the global and system
 *  config for every hermetic git invocation below. */
const NONEXISTENT_GITCONFIG = join(tmpdir(), "lethal-nonexistent-gitconfig");

/**
 * A HERMETIC git environment for the fixture repositories.
 *
 * Measured on a hosted `windows-latest` runner (CI run 32075875426, 2026-08-17): `git commit` in a
 * fresh temp repo exceeded the 5 s default test timeout and was killed, so the suite failed with
 * `git commit ... failed (143)` — SIGTERM, empty stderr — on a commit that only touched a markdown
 * file. It had passed on the commit before and the commit after, which is the signature of a flaky
 * gate rather than a defect, and a flaky gate is how people learn to ignore a red build.
 *
 * Disabling the global and system config is both the speed fix and a correctness one: a fixture
 * repository should not inherit the machine's `hooksPath`, `commit.gpgsign`, or anything else the
 * developer happens to have set. `GIT_TERMINAL_PROMPT=0` makes any credential prompt an error
 * instead of a hang, which is the other way a spawned git eats a timeout. `GIT_CEILING_DIRECTORIES`
 * stops git from walking up past the temp dir into a real `.git` (this machine's, or a parent
 * worktree's) when a fixture repo is created without one yet.
 */
export const HERMETIC_GIT_ENV: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_GLOBAL: NONEXISTENT_GITCONFIG,
  GIT_CONFIG_SYSTEM: NONEXISTENT_GITCONFIG,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CEILING_DIRECTORIES: tmpdir(),
};

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: HERMETIC_GIT_ENV,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
  return stdout;
}

/**
 * The same hermetic environment as {@link HERMETIC_GIT_ENV}, for callers that spawn through a
 * `SpawnFn` (production code paths under test) rather than through {@link git} directly.
 * `defaultSpawn` merges `env` over `process.env` itself (`publisher.ts`), so only the overrides
 * are passed here — spreading `process.env` on top would be redundant.
 */
export const hermeticSpawn: SpawnFn = (argv, opts) =>
  defaultSpawn(argv, {
    ...opts,
    env: {
      GIT_CONFIG_GLOBAL: NONEXISTENT_GITCONFIG,
      GIT_CONFIG_SYSTEM: NONEXISTENT_GITCONFIG,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CEILING_DIRECTORIES: tmpdir(),
    },
  });

async function writeAt(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/** A real repository with `files` committed in one commit, optionally preceded by `localConfig`
 *  entries (each set with `git config <key> <value>` before anything is written). `realpathSync`
 *  because containment checks elsewhere compare real paths, and a temp dir can be a link. */
export async function makeGitRepo(
  files: Record<string, string>,
  localConfig: Record<string, string> = {},
): Promise<string> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "lethal-campaign-cli-")));
  await git(root, ["init", "-q", "-b", "main"]);
  await git(root, ["config", "user.email", "campaign@example.invalid"]);
  await git(root, ["config", "user.name", "Campaign Fixture"]);
  for (const [key, value] of Object.entries(localConfig)) {
    await git(root, ["config", key, value]);
  }
  for (const [rel, content] of Object.entries(files)) await writeAt(root, rel, content);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "campaign fixture"]);
  return root;
}
