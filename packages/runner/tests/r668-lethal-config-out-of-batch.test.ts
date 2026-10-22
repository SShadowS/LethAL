import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readTargetSource } from "../src/baseline-snapshot";
import { runOutputPaths } from "../src/cli";
import { prepareBatchProject, sameFileAs } from "../src/orchestrator";
import { ProjectChangedDuringRunError, watchProjectInputs } from "../src/source-drift";
import { scratchDirs } from "./helpers/scratch";

/**
 * R668: LethAL's own config holds the server login, and its default place is the target folder.
 * The batch copy took every non-AL file as a resource, so the config landed in every batch dir,
 * and in the built .app whenever app.json's `resourceFolders` covered it. Two rules keep it out:
 * the file NAME (`lethal.config*.json`, any depth) and the file IDENTITY of the run's `--config`
 * (device + inode, so another name, a symlinked parent dir or a hard link is caught too).
 * Every content here is an invented dummy.
 */
const scratch = scratchDirs();
const manifest = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "T", version: "1.0.0.0" };
const DUMMY = '{"bcdev":{"password":"DUMMY-NOT-A-SECRET-R668"}}';

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function dirs(): Promise<{ root: string; projectDir: string; batchDir: string }> {
  const root = scratch("lethal-r668-");
  const projectDir = join(root, "project");
  const batchDir = join(root, "batch");
  await write(projectDir, "app.json", JSON.stringify(manifest));
  await write(projectDir, "src/Thing.Codeunit.al", "codeunit 50000 T { }");
  await mkdir(batchDir, { recursive: true });
  return { root, projectDir, batchDir };
}

const inBatch = (batchDir: string, rel: string): boolean => existsSync(join(batchDir, rel));

describe("R668: a lethal.config*.json is never copied into a batch, by name", () => {
  // Revert direction: drop the name rule from `isProjectResource` and every one of these is copied.
  it("leaves out lethal.config.json, lethal.config.bc1.json, LETHAL.CONFIG.JSON and a nested one", async () => {
    const { projectDir, batchDir } = await dirs();
    for (const rel of [
      "lethal.config.json",
      "lethal.config.bc1.json",
      "LETHAL.CONFIG.JSON",
      "sub/lethal.config.json",
    ]) {
      await write(projectDir, rel, DUMMY);
    }
    await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");
    expect(inBatch(batchDir, "lethal.config.json")).toBe(false);
    expect(inBatch(batchDir, "lethal.config.bc1.json")).toBe(false);
    expect(inBatch(batchDir, "LETHAL.CONFIG.JSON")).toBe(false);
    expect(inBatch(batchDir, "sub/lethal.config.json")).toBe(false);
  });

  // Other direction: a rule that matches too much (a prefix, a substring, any .json) goes red here.
  it("still copies the near-misses and a real resource", async () => {
    const { projectDir, batchDir } = await dirs();
    const near = [
      "lethal.config.json.bak",
      "my-lethal.config.json",
      "lethal.configuration.json",
      "Translations/App.da-DK.xlf",
    ];
    for (const rel of near) await write(projectDir, rel, "x");
    await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");
    for (const rel of near) expect(inBatch(batchDir, rel)).toBe(true);
  });

  // Pin: the dot rule (`isToolResourcePath`) is unchanged.
  it("still leaves out dot-files and dot-directories", async () => {
    const { projectDir, batchDir } = await dirs();
    await write(projectDir, ".lethal-demo.env", "x");
    await write(projectDir, ".vscode/launch.json", "{}");
    await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");
    expect(inBatch(batchDir, ".lethal-demo.env")).toBe(false);
    expect(inBatch(batchDir, ".vscode/launch.json")).toBe(false);
  });
});

describe("R668: the run's --config file is never copied into a batch, by identity", () => {
  async function prepare(projectDir: string, batchDir: string, configPath: string): Promise<void> {
    await prepareBatchProject(
      projectDir,
      batchDir,
      { ...manifest },
      "1.0.2.0",
      undefined,
      [],
      undefined,
      configPath,
    );
  }

  // Revert direction for each: drop the identity rule and the file is copied.
  it("leaves out a --config of another name inside the project", async () => {
    const { projectDir, batchDir } = await dirs();
    await write(projectDir, "settings/conn.json", DUMMY);
    await prepare(projectDir, batchDir, join(projectDir, "settings/conn.json"));
    expect(inBatch(batchDir, "settings/conn.json")).toBe(false);
  });

  it("leaves it out when --config names it through a symlinked parent directory", async () => {
    const { root, projectDir, batchDir } = await dirs();
    await write(projectDir, "conn.json", DUMMY);
    await symlink(projectDir, join(root, "via"), "dir");
    await prepare(projectDir, batchDir, join(root, "via", "conn.json"));
    expect(inBatch(batchDir, "conn.json")).toBe(false);
  });

  it("leaves out a hard link to the --config file", async () => {
    const { root, projectDir, batchDir } = await dirs();
    await write(root, "outside/conn.json", DUMMY);
    await link(join(root, "outside/conn.json"), join(projectDir, "copy-of-conn.json"));
    await prepare(projectDir, batchDir, join(root, "outside/conn.json"));
    expect(inBatch(batchDir, "copy-of-conn.json")).toBe(false);
  });

  it("leaves it out when --config names it in another letter case, where the filesystem allows", async () => {
    const { projectDir, batchDir } = await dirs();
    await write(projectDir, "Conn.json", DUMMY);
    const upper = join(projectDir, "CONN.JSON");
    if (!existsSync(upper)) return; // case-sensitive filesystem: the hard-link case covers identity
    await prepare(projectDir, batchDir, upper);
    expect(inBatch(batchDir, "Conn.json")).toBe(false);
  });

  // Other direction: a rule that compares content, or drops every JSON once a config is given.
  it("still copies a different file with identical content", async () => {
    const { root, projectDir, batchDir } = await dirs();
    await write(root, "outside/conn.json", DUMMY);
    await write(projectDir, "twin.json", DUMMY);
    await prepare(projectDir, batchDir, join(root, "outside/conn.json"));
    expect(await readFile(join(batchDir, "twin.json"), "utf8")).toBe(DUMMY);
  });

  it("changes nothing when there is no --config", async () => {
    const { projectDir, batchDir } = await dirs();
    await write(projectDir, "conn.json", DUMMY);
    await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");
    expect(inBatch(batchDir, "conn.json")).toBe(true);
  });
});

describe("R668: on a filesystem that reports inode 0 for every file", () => {
  // Some SMB and FAT mounts do. Revert direction: without the ino-0 guard every file "is" the
  // config, so the different file is dropped too. Other direction: the exact path still matches.
  it("matches only the exact --config path, never a different file", async () => {
    const statOf = async () => ({ dev: 7n, ino: 0n });
    const isConfig = await sameFileAs("/proj/conn.json", statOf);
    expect(await isConfig("/proj/conn.json")).toBe(true);
    expect(await isConfig("/proj/other.json")).toBe(false);
  });
});

describe("R668: the drift check ignores the run's --config file", () => {
  async function changesOf(watch: { check(): Promise<void> }): Promise<readonly string[] | null> {
    try {
      await watch.check();
      return null;
    } catch (e) {
      if (e instanceof ProjectChangedDuringRunError) return e.changes;
      throw e;
    }
  }

  async function started(): Promise<{ projectDir: string; watch: { check(): Promise<void> } }> {
    const { projectDir } = await dirs();
    await write(projectDir, "conn.json", DUMMY);
    await write(projectDir, "addin/x.js", "1");
    const outputs = runOutputPaths({ configPath: join(projectDir, "conn.json") });
    const watch = watchProjectInputs(projectDir, await readTargetSource(projectDir), outputs);
    await watch.check();
    return { projectDir, watch };
  }

  // Revert: leave the config out of `runOutputPaths`, and the edit is reported.
  it("does not report a changed --config file of another name inside the project", async () => {
    const { projectDir, watch } = await started();
    await write(projectDir, "conn.json", '{"bcdev":{"password":"DUMMY-ROTATED-R668"}}');
    expect(await changesOf(watch)).toBeNull();
  });

  // Other direction: a watch that ignores everything goes red here.
  it("still reports a changed real resource", async () => {
    const { projectDir, watch } = await started();
    await write(projectDir, "addin/x.js", "2");
    expect(await changesOf(watch)).toEqual([`changed ${join("addin", "x.js")}`]);
  });
});
