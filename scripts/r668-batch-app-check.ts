/**
 * R668 end-to-end check, offline with alc: a target whose app.json has `resourceFolders: ["."]`
 * holds a `lethal.config.json` and a `--config` of another name (`conn.json`), both carrying the
 * invented marker DUMMY-NOT-A-SECRET-R668. LethAL's batch build (`prepareBatchProject`) must give
 * an .app with no `lethal.config*` entry and no marker anywhere. As a control, the same project
 * compiled as the user's own build DOES pack both, so the check cannot pass vacuously.
 *
 * Not in the unit suite: it needs a real alc (`LETHAL_ALC_DIR`), which CI does not have.
 *   bun scripts/r668-batch-app-check.ts
 * Exit 0 PASS, 1 FAIL, 2 no alc.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPackageEntries, readPackageEntry } from "../packages/runner/src/app-package";
import { prepareBatchProject } from "../packages/runner/src/orchestrator";

const MARKER = "DUMMY-NOT-A-SECRET-R668";
const APP = {
  id: "66866866-8668-4668-8668-668668668668",
  name: "R668 Check",
  publisher: "LethAL",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 50010 }],
  runtime: "17.0",
  resourceFolders: ["."],
};

function compile(alc: string, project: string, out: string, cache: string): void {
  const r = spawnSync(alc, [`/project:${project}`, `/packagecachepath:${cache}`, `/out:${out}`], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`alc failed on ${project} (exit ${r.status}):\n${r.stdout}${r.stderr}`);
  }
}

/** The entries of an .app that name a lethal config, or whose bytes hold the marker. */
function leaks(app: Buffer): string[] {
  return listPackageEntries(app).filter(
    (name) =>
      /(^|\/)lethal\.config/i.test(name) ||
      (readPackageEntry(app, name)?.toString("latin1").includes(MARKER) ?? false),
  );
}

async function main(): Promise<number> {
  const dir = process.env.LETHAL_ALC_DIR;
  const alc =
    dir === undefined ? undefined : join(dir, process.platform === "win32" ? "alc.exe" : "alc");
  if (alc === undefined || !existsSync(alc)) {
    console.error("r668-batch-app-check: no alc (set LETHAL_ALC_DIR)");
    return 2;
  }
  const root = await mkdtemp(join(tmpdir(), "lethal-r668-check-"));
  try {
    const project = join(root, "project");
    const batch = join(root, "batch");
    const cache = join(root, "cache");
    for (const d of [join(project, "src"), batch, cache]) await mkdir(d, { recursive: true });
    await writeFile(join(project, "app.json"), JSON.stringify(APP));
    await writeFile(
      join(project, "src", "Dummy.Codeunit.al"),
      'codeunit 50000 "R668 Dummy"\n{\n    procedure One(): Integer\n    begin\n        exit(1);\n    end;\n}\n',
    );
    const secret = `{"bcdev":{"password":"${MARKER}"}}`;
    await writeFile(join(project, "lethal.config.json"), secret);
    await writeFile(join(project, "conn.json"), secret);
    await writeFile(join(project, "notes.txt"), "a real resource");

    // Control: the user's own build packs both (alc packs every file under resourceFolders).
    const own = join(root, "own.app");
    compile(alc, project, own, cache);
    const ownLeaks = leaks(await readFile(own));
    if (ownLeaks.length < 2) {
      console.error(
        `FAIL control: the user's own build should pack both dummy configs, found ${JSON.stringify(ownLeaks)}`,
      );
      return 1;
    }

    // LethAL's batch build, with conn.json as the run's --config.
    await prepareBatchProject(
      project,
      batch,
      APP,
      "1.0.0.1",
      undefined,
      [],
      undefined,
      join(project, "conn.json"),
    );
    const built = join(root, "batch.app");
    compile(alc, batch, built, cache);
    const app = await readFile(built);
    const found = leaks(app);
    const hasNotes = listPackageEntries(app).some((n) => n.endsWith("notes.txt"));
    if (found.length > 0 || !hasNotes) {
      console.error(
        `FAIL batch .app: leaked entries ${JSON.stringify(found)}; real resource packed: ${hasNotes}`,
      );
      return 1;
    }
    console.log(
      `PASS: control packed ${ownLeaks.length} dummy config entr(ies); the batch .app holds none, and still packs notes.txt`,
    );
    return 0;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(await main());
