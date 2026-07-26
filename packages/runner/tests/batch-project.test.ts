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

  it("still flattens .al files to their basename", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      await write(projectDir, "Al/Codeunit/Thing.Codeunit.al", "codeunit 1 T { }");

      await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");

      expect(await exists(join(batchDir, "Thing.Codeunit.al"))).toBe(true);
      expect(await exists(join(batchDir, "Al/Codeunit/Thing.Codeunit.al"))).toBe(false);
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

describe("prepareBatchProject — .al basename collisions are loud", () => {
  it("throws, naming both source paths, when two project .al files share a basename", async () => {
    // Flattening plus a silent `if (exists) continue` would drop the second file from the
    // artifact without a word — an object silently missing from the published app, which reads
    // downstream as a mutation-scoring problem rather than a lost source file.
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      await write(projectDir, "Sales/Helper.Codeunit.al", "codeunit 1 A { }");
      await write(projectDir, "Purchase/Helper.Codeunit.al", "codeunit 2 B { }");

      const err = await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0").then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(Error);
      const message = err instanceof Error ? err.message : "";
      expect(message).toContain("Helper.Codeunit.al");
      expect(message).toContain(join("Sales", "Helper.Codeunit.al"));
      expect(message).toContain(join("Purchase", "Helper.Codeunit.al"));
    });
  });

  it("does not mistake the instrumented copy of a file for a collision with its own original", async () => {
    await withDirs(async (projectDir, batchDir) => {
      await write(projectDir, "app.json", JSON.stringify(manifest));
      await write(projectDir, "Al/Thing.Codeunit.al", "codeunit 1 T { }");
      await write(batchDir, "Thing.Codeunit.al", "codeunit 1 T { INSTRUMENTED }");

      await prepareBatchProject(projectDir, batchDir, { ...manifest }, "1.0.2.0");

      expect(await exists(join(batchDir, "Thing.Codeunit.al"))).toBe(true);
    });
  });
});
