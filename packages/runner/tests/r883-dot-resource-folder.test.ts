import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readTargetSource } from "../src/baseline-snapshot";
import { isProjectResource, prepareBatchProject, resourceFolderKeys } from "../src/orchestrator";
import { ProjectChangedDuringRunError, watchProjectInputs } from "../src/source-drift";
import { scratchDirs } from "./helpers/scratch";

/**
 * R883: an app whose app.json `resourceFolders` names a dot-folder (`.resources`) lost it from the
 * batch (every dot-segment path was "a tool directory"), so alc failed with AL0863. A folder the
 * manifest names is app content; other dot-folders (`.vscode`, an unnamed one) stay out. The
 * source-drift watch reads the same set. Invented content only.
 */
const scratch = scratchDirs();

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function project(resourceFolders: readonly string[]) {
  const root = scratch("lethal-r883-");
  const projectDir = join(root, "project");
  const batchDir = join(root, "batch");
  const manifest = {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    name: "T",
    version: "1.0.0.0",
    resourceFolders,
  };
  await write(projectDir, "app.json", JSON.stringify(manifest));
  await write(projectDir, "src/Thing.Codeunit.al", "codeunit 50000 T { }");
  await write(projectDir, ".resources/prompt.txt", "hello");
  await write(projectDir, ".resources/.hidden/x.txt", "nested tool dir");
  await write(projectDir, ".vscode/settings.json", "{}");
  await write(projectDir, ".other/y.txt", "not named");
  await mkdir(batchDir, { recursive: true });
  return { projectDir, batchDir, manifest };
}

describe("R883: a dot-folder named in resourceFolders is a project resource", () => {
  // Revert: pass no folders to isToolResourcePath (or drop the named-folder exemption).
  it("the batch holds it; .vscode, an unnamed dot-folder and a dot-folder below it stay out", async () => {
    const { projectDir, batchDir, manifest } = await project([".resources"]);
    await prepareBatchProject(projectDir, batchDir, manifest, "1.0.0.1");
    expect(existsSync(join(batchDir, ".resources/prompt.txt"))).toBe(true);
    expect(existsSync(join(batchDir, ".vscode/settings.json"))).toBe(false);
    expect(existsSync(join(batchDir, ".other/y.txt"))).toBe(false);
    expect(existsSync(join(batchDir, ".resources/.hidden/x.txt"))).toBe(false);
  });

  it("without the manifest entry the dot-folder is still left out", async () => {
    const { projectDir, batchDir, manifest } = await project([]);
    await prepareBatchProject(projectDir, batchDir, manifest, "1.0.0.1");
    expect(existsSync(join(batchDir, ".resources/prompt.txt"))).toBe(false);
  });

  it("normalises names: ./, backslash, trailing slash, case, and the project root", () => {
    expect(
      resourceFolderKeys({ resourceFolders: ["./.Resources/", ".a\\b", ".\\c", "res", ".", 5] }),
    ).toEqual([".resources", ".a/b", "c", "res", ""]);
    expect(isProjectResource(".resources/p.txt", [".resources"])).toBe(true);
    expect(isProjectResource(".RESOURCES\\p.txt", [".resources"])).toBe(true);
    expect(isProjectResource(".resources/p.txt")).toBe(false);
  });

  // Revert: call isProjectResource(rel) without the folders in the watch.
  it("the source-drift watch sees an edit in the named dot-folder, not in .vscode", async () => {
    const { projectDir } = await project([".resources"]);
    const watch = watchProjectInputs(projectDir, await readTargetSource(projectDir));
    await watch.check();
    await writeFile(join(projectDir, ".vscode/settings.json"), '{"a":1}', "utf8");
    await watch.check();
    await writeFile(join(projectDir, ".resources/prompt.txt"), "changed!", "utf8");
    let caught: unknown;
    try {
      await watch.check();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProjectChangedDuringRunError);
    expect((caught as ProjectChangedDuringRunError).changes).toEqual([
      `changed ${join(".resources", "prompt.txt")}`,
    ]);
  });
});
