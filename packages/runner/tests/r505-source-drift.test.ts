import { describe, expect, test } from "bun:test";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readTargetSource } from "../src/baseline-snapshot";
import { ProjectChangedDuringRunError, watchProjectInputs } from "../src/source-drift";
import { scratchDirs } from "./helpers/scratch";

/**
 * R505: coverage is read only while the live project's build inputs still equal what the run
 * started from (al-runner c39ad5de labels coverage with the CURRENT project's files). Each change
 * kind is pinned, with a no-change control, and the run's own outputs never count.
 */
const scratch = scratchDirs();

async function project(): Promise<string> {
  const dir = scratch("lethal-r505-proj-");
  await writeFile(join(dir, "app.json"), JSON.stringify({ id: "x", version: "1.0.0.0" }), "utf8");
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "A.al"), 'codeunit 50100 "Alpha"\n{\n}\n', "utf8");
  await writeFile(join(dir, "src", "B.al"), 'codeunit 50101 "Beta"\n{\n}\n', "utf8");
  await mkdir(join(dir, "addin"));
  await writeFile(join(dir, "addin", "x.js"), "console.log(1);\n", "utf8");
  return dir;
}

/** A watch from the project's own snapshot, first check passed, as at the start of a run. */
async function started(dir: string, outputs: readonly string[] = []) {
  const watch = watchProjectInputs(dir, await readTargetSource(dir), outputs);
  await watch.check();
  return watch;
}

async function changesOf(watch: { check(): Promise<void> }): Promise<readonly string[] | null> {
  try {
    await watch.check();
    return null;
  } catch (e) {
    if (e instanceof ProjectChangedDuringRunError) return e.changes;
    throw e;
  }
}

describe("R505: the project's build inputs must not change during the run", () => {
  // The control. Revert direction: a watch that throws on every check goes red here.
  test("no change, and a touch with the same bytes, pass", async () => {
    const dir = await project();
    const watch = await started(dir);
    expect(await changesOf(watch)).toBeNull();
    await writeFile(join(dir, "src", "A.al"), 'codeunit 50100 "Alpha"\n{\n}\n', "utf8");
    expect(await changesOf(watch)).toBeNull();
  });

  // Revert: drop the byte comparison of a present file.
  test("an .al edited in place is named", async () => {
    const dir = await project();
    const watch = await started(dir);
    await writeFile(join(dir, "src", "A.al"), 'codeunit 50100 "Alpha"\n{\n    // x\n}\n', "utf8");
    expect(await changesOf(watch)).toEqual([`changed ${join("src", "A.al")}`]);
  });

  // Revert: drop the "added" branch.
  test("an .al added is named", async () => {
    const dir = await project();
    const watch = await started(dir);
    await writeFile(join(dir, "src", "C.al"), 'codeunit 50102 "Gamma"\n{\n}\n', "utf8");
    expect(await changesOf(watch)).toEqual([`added ${join("src", "C.al")}`]);
  });

  // Revert: drop the "removed" loop.
  test("an .al deleted is named", async () => {
    const dir = await project();
    const watch = await started(dir);
    await rm(join(dir, "src", "B.al"));
    expect(await changesOf(watch)).toEqual([`removed ${join("src", "B.al")}`]);
  });

  // A rename is the S7 shape: the object's label would name a file the batch does not have.
  test("an .al renamed is named as removed plus added", async () => {
    const dir = await project();
    const watch = await started(dir);
    await rename(join(dir, "src", "A.al"), join(dir, "src", "C.al"));
    expect(await changesOf(watch)).toEqual([
      `added ${join("src", "C.al")}`,
      `removed ${join("src", "A.al")}`,
    ]);
  });

  test("app.json changed is named", async () => {
    const dir = await project();
    const watch = await started(dir);
    await writeFile(join(dir, "app.json"), JSON.stringify({ id: "x", version: "1.0.0.1" }), "utf8");
    expect(await changesOf(watch)).toEqual(["changed app.json"]);
  });

  // Revert: read only `.al` and `app.json` (no resources).
  test("a resource changed is named", async () => {
    const dir = await project();
    const watch = await started(dir);
    await writeFile(join(dir, "addin", "x.js"), "console.log(2);\n", "utf8");
    expect(await changesOf(watch)).toEqual([`changed ${join("addin", "x.js")}`]);
  });

  // Revert: drop the output exclusion. The results database written into the project must not
  // stop the run it belongs to; a tool directory never counts.
  test("the run's own output files and tool directories never count", async () => {
    const dir = await project();
    const db = join(dir, "lethal.sqlite");
    await writeFile(db, "1", "utf8");
    const watch = await started(dir, [db]);
    await writeFile(db, "22", "utf8");
    await mkdir(join(dir, ".alpackages"));
    await writeFile(join(dir, ".alpackages", "Some.app"), "x", "utf8");
    expect(await changesOf(watch)).toBeNull();
  });

  test("the error names what changed, at most five, and says --resume continues", async () => {
    const dir = await project();
    const watch = await started(dir);
    for (const n of [1, 2, 3, 4, 5, 6, 7])
      await writeFile(join(dir, "src", `N${n}.al`), `codeunit ${50200 + n} N${n}\n{\n}\n`, "utf8");
    const err = await watch.check().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProjectChangedDuringRunError);
    const message = String((err as Error).message);
    expect(message).toContain(`added ${join("src", "N1.al")}`);
    expect(message).toContain("and 2 more");
    expect(message).toContain("--resume");
  });
});
