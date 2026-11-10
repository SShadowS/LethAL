import { expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareBatchProject } from "../src/orchestrator";

/** R901: alc on Linux reads `Res\a.js` as one file name (AL0327). The batch copy says `/`. */

const manifest = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "T", version: "1.0.0.0" };

const ADDIN = `controladdin "Inv Addin"
{
    // note 'Res\\x.js' in a comment stays
    Scripts = 'Res\\a.js', 'It''s\\b.js';
    StartupScript = 'Res\\a.js';
    StyleSheets =
        'Res\\Css\\s.css';
    RequestedHeight = 100;
}

codeunit 50101 "Inv Same File"
{
    procedure Q()
    begin
        Error('p\\q');
    end;
}
`;
const CODEUNIT = `codeunit 50100 "Inv Logic"
{
    procedure P()
    begin
        Error('x\\y');
    end;
}
`;

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function run(): Promise<{ batch: string; user: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r901-"));
  const projectDir = join(root, "project");
  const batchDir = join(root, "batch");
  await mkdir(batchDir, { recursive: true });
  await write(projectDir, "app.json", JSON.stringify(manifest));
  await write(projectDir, "Inv.ControlAddIn.al", ADDIN);
  await write(projectDir, "Inv.Codeunit.al", CODEUNIT);
  await write(projectDir, "Res/a.js", "js");
  await write(projectDir, "Res/Css/s.css", "css");
  await prepareBatchProject(projectDir, batchDir, manifest, "1.0.0.1");
  return {
    batch: batchDir,
    user: projectDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

it("rewrites backslashes in controladdin resource strings, same length, nothing else", async () => {
  const { batch, user, cleanup } = await run();
  try {
    const addin = await readFile(join(batch, "Inv.ControlAddIn.al"), "utf8");
    expect(addin).toBe(
      ADDIN.replace("Scripts = 'Res\\a.js', 'It''s\\b.js'", "Scripts = 'Res/a.js', 'It''s/b.js'")
        .replace("StartupScript = 'Res\\a.js'", "StartupScript = 'Res/a.js'")
        .replace("'Res\\Css\\s.css'", "'Res/Css/s.css'"),
    );
    expect(addin.length).toBe(ADDIN.length);
    expect(addin).toContain("// note 'Res\\x.js' in a comment stays");
    expect(await readFile(join(batch, "Inv.Codeunit.al"), "utf8")).toBe(CODEUNIT);
    expect(await readFile(join(user, "Inv.ControlAddIn.al"), "utf8")).toBe(ADDIN);
    // issue #8's rebased copy still serves a `/` name
    expect(await Bun.file(join(batch, "Res/a.js")).exists()).toBe(true);
  } finally {
    await cleanup();
  }
});
