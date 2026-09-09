import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareBatchProject } from "../src/orchestrator";

/**
 * R39. `prepareBatchProject` assembles the directory `alc` actually compiles: the instrumented
 * files `writeInstrumentedProject` already wrote, plus everything else the project needs. It used
 * to copy `*.al` and nothing else, so `app.json`'s own `logo` never arrived and `alc` stopped at
 * `AL1001: Source file 'Images\Logo.png' could not be found` — before compiling a single line, so
 * the failure could not even be attributed to instrumentation. Every fixture in this repo is
 * resource-free, which is why it took the real Continia Document Output app to surface it.
 */

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

async function exists(p: string): Promise<boolean> {
  return await Bun.file(p).exists();
}

const manifest = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "T", version: "1.0.0.0" };

async function withDirs(
  body: (projectDir: string, batchDir: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lethal-batch-"));
  const projectDir = join(root, "project");
  const batchDir = join(root, "batch");
  await mkdir(projectDir, { recursive: true });
  await mkdir(batchDir, { recursive: true });
  try {
    await body(projectDir, batchDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("prepareBatchProject — non-AL resources", () => {
  it("copies a project's resources, preserving the relative paths app.json names", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify({ ...manifest, logo: "Images/Logo.png" }));
      await write(projectDir, "Images/Logo.png", "PNGBYTES");
      await write(projectDir, "Translations/App.da-DK.xlf", "<xliff/>");
      await write(projectDir, "Layouts/Report.rdl", "<Report/>");
      await write(projectDir, "Permissions/Set.xml", "<PermissionSets/>");
      await write(projectDir, "Al/Codeunit/Thing.Codeunit.al", "codeunit 1 T { }");

      await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");

      expect(await exists(join(batchDir, "Images/Logo.png"))).toBe(true);
      expect(await exists(join(batchDir, "Translations/App.da-DK.xlf"))).toBe(true);
      expect(await exists(join(batchDir, "Layouts/Report.rdl"))).toBe(true);
      expect(await exists(join(batchDir, "Permissions/Set.xml"))).toBe(true);
      // Content, not just presence: a zero-byte placeholder would satisfy `exists` and still
      // fail the compile.
      expect(await readFile(join(batchDir, "Images/Logo.png"), "utf8")).toBe("PNGBYTES");
    });
  });

  /**
   * Issue #8. This used to assert the opposite, that `.al` files were flattened onto the batch
   * root. A `controladdin` resolves its `Scripts` and `StyleSheets` relative to the AL file that
   * declares them, and `alc` checks those paths at compile time, so moving the declaration to the
   * root while its resources stayed at their own depth made the build fail with AL0327 on a
   * resource that had been copied correctly all along.
   */
  it("keeps .al files at their own project-relative path", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      await write(projectDir, "Al/Codeunit/Thing.Codeunit.al", "codeunit 1 T { }");

      await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");

      expect(await exists(join(batchDir, "Al/Codeunit/Thing.Codeunit.al"))).toBe(true);
      expect(await exists(join(batchDir, "Thing.Codeunit.al"))).toBe(false);
    });
  });

  /**
   * The shape the old flattening had to refuse outright, now simply supported.
   *
   * Two files may share a name in different folders: AL requires object names to be unique, not
   * file names. Flattening made them collide, so `prepareBatchProject` carried a loud throw telling
   * the user to rename one of their files for a reason that was ours rather than AL's. Keeping the
   * depth means nothing collides and both objects reach the published app.
   */
  it("keeps two .al files that share a basename in different folders", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      await write(projectDir, "Al/Sales/Helper.Codeunit.al", "codeunit 1 S { }");
      await write(projectDir, "Al/Purchase/Helper.Codeunit.al", "codeunit 2 P { }");

      await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");

      expect(await exists(join(batchDir, "Al/Sales/Helper.Codeunit.al"))).toBe(true);
      expect(await exists(join(batchDir, "Al/Purchase/Helper.Codeunit.al"))).toBe(true);
    });
  });

  /**
   * The reported failure, end to end at this layer: a resource named relative to the AL file that
   * declares it must sit where that declaration can still see it.
   */
  it("puts a controladdin's resources where the declaring file still resolves them (issue #8)", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      await write(
        projectDir,
        "src/Studio/Editor.ControlAddIn.al",
        "controladdin Editor { Scripts = './EditorAddin/editor.js'; }",
      );
      await write(projectDir, "src/Studio/EditorAddin/editor.js", "// script");

      await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");

      // Both at their original depth, so `./EditorAddin/editor.js` from the declaring file resolves.
      expect(await exists(join(batchDir, "src/Studio/Editor.ControlAddIn.al"))).toBe(true);
      expect(await exists(join(batchDir, "src/Studio/EditorAddin/editor.js"))).toBe(true);
    });
  });

  /**
   * Issue #8. A `controladdin` names its scripts relative to the file that declares them, and `alc`
   * resolves those at compile time. The `.al` file is flattened onto the batch root, so the
   * resource has to appear at the batch root too, under the same tail.
   *
   * The structure-preserving copy is kept as well and is not redundant: an `app.json`
   * `resourceFolders` entry is named relative to the PROJECT root, so it needs the original path.
   */
  it("rebases a resource onto the batch root so a flattened declaration resolves it (issue #8)", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      await write(
        projectDir,
        "src/Studio/Editor.ControlAddIn.al",
        "controladdin Editor { Scripts = './EditorAddin/editor.js'; }",
      );
      await write(projectDir, "src/Studio/EditorAddin/editor.js", "// script");

      await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");

      // Where the flattened declaration looks.
      expect(await exists(join(batchDir, "EditorAddin/editor.js"))).toBe(true);
      // And still where `resourceFolders` looks.
      expect(await exists(join(batchDir, "src/Studio/EditorAddin/editor.js"))).toBe(true);
    });
  });

  it("rebases onto the NEAREST enclosing AL directory, not a shallower one", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      await write(projectDir, "src/Root.Codeunit.al", "codeunit 1 R { }");
      await write(projectDir, "src/Studio/Editor.ControlAddIn.al", "controladdin E { }");
      await write(projectDir, "src/Studio/EditorAddin/editor.js", "// script");

      await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");

      expect(await exists(join(batchDir, "EditorAddin/editor.js"))).toBe(true);
      // `src` also holds AL files, but it is the shallower owner and must not also claim this.
      expect(await exists(join(batchDir, "Studio/EditorAddin/editor.js"))).toBe(false);
    });
  });

  /**
   * Flattening can make two resource trees collide once they are rebased. Refused loudly rather
   * than letting one silently overwrite the other, which would publish a wrong add-in.
   */
  it("refuses two resources that rebase onto the same path", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      // Distinct basenames: same-named .al files trip the flattening guard first, and this test
      // is about the RESOURCE collision, not that one.
      await write(projectDir, "src/A/AThing.Codeunit.al", "codeunit 1 A { }");
      await write(projectDir, "src/B/BThing.Codeunit.al", "codeunit 2 B { }");
      await write(projectDir, "src/A/Assets/x.js", "// A");
      await write(projectDir, "src/B/Assets/x.js", "// B");

      const err = await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0").then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(Error);
      const message = err instanceof Error ? err.message : "";
      expect(message).toContain(join("Assets", "x.js"));
    });
  });

  it("does not copy tool directories or built .app packages into the batch", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      await write(projectDir, "Al/Thing.Codeunit.al", "codeunit 1 T { }");
      await write(projectDir, ".alpackages/Microsoft_System.app", "SYMBOLS");
      await write(projectDir, ".vscode/settings.json", "{}");
      await write(projectDir, ".git/config", "[core]");
      await write(projectDir, "Publisher_App_1.0.0.0.app", "BUILT");

      await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");

      expect(await exists(join(batchDir, ".alpackages/Microsoft_System.app"))).toBe(false);
      expect(await exists(join(batchDir, ".vscode/settings.json"))).toBe(false);
      expect(await exists(join(batchDir, ".git/config"))).toBe(false);
      expect(await exists(join(batchDir, "Publisher_App_1.0.0.0.app"))).toBe(false);
    });
  });

  it("writes the STAMPED app.json rather than copying the project's own", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      await write(projectDir, "Al/Thing.Codeunit.al", "codeunit 1 T { }");

      await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");

      const written = JSON.parse(await readFile(join(batchDir, "app.json"), "utf8")) as {
        version: string;
      };
      expect(written.version).toBe("1.0.2.0");
    });
  });

  it("leaves an already-written instrumented file untouched", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      await write(projectDir, "Al/Thing.Codeunit.al", "codeunit 1 T { ORIGINAL }");
      // What `writeInstrumentedProject` would already have emitted for this file.
      await write(batchDir, "Thing.Codeunit.al", "codeunit 1 T { INSTRUMENTED }");

      await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");

      expect(await readFile(join(batchDir, "Thing.Codeunit.al"), "utf8")).toBe(
        "codeunit 1 T { INSTRUMENTED }",
      );
    });
  });
});
