import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import type { MutantManifestEntry } from "@lethal/schemata";
import { readTargetSource } from "../src/baseline-snapshot";
import { DiscoveredPathError } from "../src/line-filter";
import { generateMutationSet, operatorTiers, planArtifacts } from "../src/orchestrator";
import { identityKeyOf, serializeKey } from "../src/selection";

/**
 * R421: discovered paths are normalised to `/` ONCE, at discovery, so a project gives the same
 * file order, mutant ids, batches and manifest on Windows as on Linux.
 *
 * Each case runs `generateMutationSet` twice over one source snapshot: keyed with `/` (as Linux's
 * readdir gives it), and keyed with `\` with `platform: "win32"`, which simulates Bun's readdir on
 * Windows. The platform is needed because off win32 a `\` in a file name is refused (Task 1a).
 * Snapshots only, so these run on every host.
 */

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "lethal-r421-"));
  dirs.push(d);
  return d;
}

/** Three mutants per file: `empty-block`, `conditional-boundary`, `return-value` (M-a1). */
const body = (kind: string, id: number, name: string): string => `${kind} ${id} "${name}"
{
    procedure Pick(Value: Integer): Integer
    begin
        if Value > 10 then
            exit(1);
        exit(0);
    end;
}
`;

const APP_JSON = JSON.stringify({
  id: "11111111-2222-3333-4444-555555555555",
  name: "p",
  publisher: "p",
  version: "1.0.0.0",
  idRanges: [{ from: 79000, to: 79199 }],
  runtime: "13.0",
});

const SELECTOR_IDS = { selectorId: 79849, controlId: 79848, tableId: 79847 };
const ARTIFACT_ID = "0123456789abcdef0123456789abcdef";

/** `files` keyed with `/`, plus `app.json`; `sep` "\\" re-keys every `.al` path with `\`. */
function snapshotOf(files: Record<string, string>, sep: "/" | "\\"): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  for (const [p, s] of Object.entries(files)) snap.set(p.replaceAll("/", sep), Buffer.from(s));
  snap.set("app.json", Buffer.from(APP_JSON));
  return snap;
}

/** Generates both forms over one empty project dir (the snapshot is the source). */
async function bothForms(files: Record<string, string>) {
  const projectDir = await tempDir();
  const slash = await generateMutationSet(projectDir, { source: snapshotOf(files, "/") });
  const back = await generateMutationSet(projectDir, {
    source: snapshotOf(files, "\\"),
    // Simulates Bun's readdir on Windows.
    platform: "win32",
  });
  return { slash, back };
}

async function manifestOf(
  files: Parameters<typeof writeInstrumentedProject>[0]["files"],
): Promise<Buffer> {
  const targetDir = await tempDir();
  await writeInstrumentedProject({
    targetDir,
    files,
    selectorIds: SELECTOR_IDS,
    artifactId: ARTIFACT_ID,
    targetAppId: "11111111-2222-3333-4444-555555555555",
    operatorTiers,
  });
  return readFile(join(targetDir, "mutant-manifest.json"));
}

const FOO_FOOBAR = {
  "src/Foo/A.Table.al": body("table", 79100, "Twin"),
  "src/FooBar.Codeunit.al": body("codeunit", 79100, "Twin"),
  "src/Zed.Codeunit.al": body("codeunit", 79101, "Zed"),
};

test("1. subfolder order is pinned: `src/Foo/A` before `src/FooBar` in both separator forms", async () => {
  const { slash, back } = await bothForms(FOO_FOOBAR);
  const expected = ["src/Foo/A.Table.al", "src/FooBar.Codeunit.al", "src/Zed.Codeunit.al"];
  for (const set of [slash, back]) {
    const paths = set.files.map((f) => f.path);
    expect(paths).toEqual(expected);
    expect(paths.some((p) => p.includes("\\"))).toBe(false);
  }
});

test("2. the manifest of the `\\` form uses `/`, numbers `src/Foo/A` first, and equals the `/` form byte for byte", async () => {
  const { slash, back } = await bothForms(FOO_FOOBAR);
  const backBytes = await manifestOf(back.files);
  const manifest = JSON.parse(backBytes.toString("utf8")) as {
    mutants: readonly MutantManifestEntry[];
  };
  expect(manifest.mutants.length).toBe(9);
  for (const m of manifest.mutants) expect(m.file.includes("\\")).toBe(false);
  const first = manifest.mutants
    .filter((m) => ["M0001", "M0002", "M0003"].includes(m.mutantId))
    .map((m) => m.file);
  expect(first).toEqual(["src/Foo/A.Table.al", "src/Foo/A.Table.al", "src/Foo/A.Table.al"]);
  const slashBytes = await manifestOf(slash.files);
  expect(backBytes.toString("utf8")).toBe(slashBytes.toString("utf8"));
});

test("3. batching keeps identity: the twin in `src/Foo0` shares a batch with `src/Foo/A` and gets ordinal 1 in both forms", async () => {
  const { slash, back } = await bothForms({
    "src/Foo/A.Table.al": body("table", 79100, "Twin"),
    "src/Foo0.Codeunit.al": body("codeunit", 79100, "Twin"),
    "src/FooBar.Codeunit.al": body("codeunit", 79101, "Other"),
  });
  const keysOf = async (files: typeof slash.files) => {
    const batches = planArtifacts(files, { maxGuardsPerBatch: 6 });
    expect(batches.map((b) => b.map((f) => f.path))).toEqual([
      ["src/Foo/A.Table.al", "src/Foo0.Codeunit.al"],
      ["src/FooBar.Codeunit.al"],
    ]);
    const rows: Array<{ file: string; ordinal: number; key: string }> = [];
    for (const batch of batches) {
      const manifest = JSON.parse((await manifestOf(batch)).toString("utf8")) as {
        mutants: readonly MutantManifestEntry[];
      };
      for (const m of manifest.mutants) {
        rows.push({
          file: m.file,
          ordinal: m.identityOrdinal ?? 0,
          key: serializeKey(identityKeyOf(m)),
        });
      }
    }
    return rows;
  };
  const slashRows = await keysOf(slash.files);
  const backRows = await keysOf(back.files);
  const foo0 = backRows.filter((r) => r.file === "src/Foo0.Codeunit.al");
  expect(foo0.map((r) => r.ordinal)).toEqual([1, 1, 1]);
  expect(backRows).toEqual(slashRows);
});

test("4. CONTROL, green before and after: orders that do not depend on the separator stay put in both forms", async () => {
  const a = await bothForms({
    "src/Foo/A.Table.al": body("table", 79100, "Twin"),
    "src/Foo.Codeunit.al": body("codeunit", 79100, "Twin"),
  });
  for (const set of [a.slash, a.back]) {
    expect(set.files.map((f) => f.path.replaceAll("\\", "/"))).toEqual([
      "src/Foo.Codeunit.al",
      "src/Foo/A.Table.al",
    ]);
  }
  const b = await bothForms({
    "src/foo/a.table.al": body("table", 79100, "Twin"),
    "src/foobar.codeunit.al": body("codeunit", 79100, "Twin"),
  });
  for (const set of [b.slash, b.back]) {
    expect(set.files.map((f) => f.path.replaceAll("\\", "/"))).toEqual([
      "src/foo/a.table.al",
      "src/foobar.codeunit.al",
    ]);
  }
});

test("5. sandbox-data's manifest is byte-identical from a `\\`-keyed snapshot and from the plain readdir", async () => {
  const fixtureDir = join(import.meta.dir, "../../../fixtures/sandbox-data");
  const snap = await readTargetSource(fixtureDir);
  const back = new Map<string, Buffer>();
  for (const [k, v] of snap) back.set(k.replaceAll("/", "\\"), v);
  const hashOf = async (set: Awaited<ReturnType<typeof generateMutationSet>>) => {
    const targetDir = await tempDir();
    await writeInstrumentedProject({
      targetDir,
      files: set.files,
      selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
      artifactId: ARTIFACT_ID,
      targetAppId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      operatorTiers,
    });
    const bytes = await readFile(join(targetDir, "mutant-manifest.json"));
    return createHash("sha256").update(bytes).digest("hex");
  };
  const pinned = "b754095f8aebddf35074c5d032bdac8692076e3e9c1b015d6810bc0ec0ff588e";
  expect(await hashOf(await generateMutationSet(fixtureDir, { emit: () => {} }))).toBe(pinned);
  expect(
    await hashOf(
      await generateMutationSet(fixtureDir, { source: back, platform: "win32", emit: () => {} }),
    ),
  ).toBe(pinned);
});

test("6. two discovered names that are one path once `\\` reads as `/` are refused by name", async () => {
  const projectDir = await tempDir();
  const source = new Map<string, Buffer>([
    ["src\\A.Codeunit.al", Buffer.from(body("codeunit", 79100, "A"))],
    ["src/A.Codeunit.al", Buffer.from(body("codeunit", 79100, "A"))],
    ["app.json", Buffer.from(APP_JSON)],
  ]);
  let err: unknown;
  try {
    await generateMutationSet(projectDir, { source, platform: "win32" });
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(DiscoveredPathError);
  if (!(err instanceof DiscoveredPathError)) return;
  expect(err.paths).toEqual(["src/A.Codeunit.al", "src\\A.Codeunit.al"]);
  expect(err.message).toBe(
    'two discovered files have the same path once "\\" is read as "/": "src/A.Codeunit.al" and "src\\A.Codeunit.al". Refusing rather than reading one of them and dropping the other.',
  );
});
