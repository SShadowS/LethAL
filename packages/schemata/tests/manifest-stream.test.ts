import { afterAll, expect, it } from "bun:test";
import { mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { writeManifestJson } from "../src/project";

/**
 * R311: `writeManifestJson` streams mutant-manifest.json row by row and must write exactly the
 * bytes of `${JSON.stringify(manifest, null, 2)}\n`. The five real fixture manifests are pinned by
 * sha256 in packages/runner/tests/fixture-emission.test.ts; these cases cover edge values.
 */
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const selectorIds = { selectorId: 79399, controlId: 79398, tableId: 79397 };
const cases: Record<string, unknown[]> = {
  empty: [],
  one: [
    {
      mutantId: 1,
      file: "a.al",
      text: 'x "q" \\ \n é',
      nested: { a: [1, 2], b: null },
      skip: undefined,
    },
  ],
  many: Array.from({ length: 2500 }, (_, i) => ({
    mutantId: i + 1,
    file: `f${i % 7}.al`,
    parts: [i, `t${i}`],
  })),
  edges: [
    {
      control: "\u0000\u0001\u001f\t\r\n\b\f\u007f",
      unicode: "æøå 日本 😀 \u2028\u2029 \ud800 lone",
      numbers: [0, -0, 1.5, -1e-7, 1e21, 2 ** 53, Number.MAX_VALUE],
      empties: { a: [], o: {}, s: "", n: [[], [{}]] },
      deep: { x: { y: { z: [{ w: ["a\nb"] }] } } },
      bools: [true, false, null],
    },
    { mutantId: "M0002", onlyKey: 1 },
    {},
  ],
};

for (const [name, mutants] of Object.entries(cases)) {
  it(`streams byte-identically to JSON.stringify: ${name}`, async () => {
    const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
    dirs.push(d);
    const m = { selectorIds, artifactId: "0".repeat(32), mutants } as never;
    await writeManifestJson(join(d, "m.json"), m);
    expect(await readFile(join(d, "m.json"), "utf8")).toBe(`${JSON.stringify(m, null, 2)}\n`);
    expect(await readdir(d)).toEqual(["m.json"]);
  });
}

// A write that fails halfway must not leave a file that looks like a whole manifest.
it("a failed write leaves no manifest and no partial file, and rethrows", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const mutants = [...(cases.many ?? []), { mutantId: 9999, bad: 1n }]; // BigInt: stringify throws late
  const m = { selectorIds, artifactId: "0".repeat(32), mutants } as never;
  await expect(writeManifestJson(join(d, "m.json"), m)).rejects.toThrow();
  expect(await readdir(d)).toEqual([]);
});

// A short write need not throw. A handle that writes at most `limit` bytes per call must still give
// a byte-identical file; one that makes no progress must throw and leave nothing.
const shortOpen = (limit: number): typeof open =>
  (async (...args: Parameters<typeof open>) => {
    const fh = await open(...args);
    const write = fh.write.bind(fh) as (
      b: Uint8Array,
      o: number,
      l: number,
    ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;
    return Object.assign(Object.create(fh), {
      write: (b: Uint8Array | string, o = 0, l?: number) => {
        const buf = typeof b === "string" ? Buffer.from(b) : b;
        const len = Math.min(limit, l ?? buf.length - o);
        return len === 0 ? Promise.resolve({ bytesWritten: 0, buffer: buf }) : write(buf, o, len);
      },
      close: () => fh.close(),
    });
  }) as typeof open;

it("short writes are completed, byte-identically", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const m = { selectorIds, artifactId: "0".repeat(32), mutants: cases.many ?? [] } as never;
  await writeManifestJson(join(d, "m.json"), m, { open: shortOpen(7), rename });
  expect(await readFile(join(d, "m.json"), "utf8")).toBe(`${JSON.stringify(m, null, 2)}\n`);
});

it("a write that makes no progress throws and leaves nothing", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const m = { selectorIds, artifactId: "0".repeat(32), mutants: cases.one ?? [] } as never;
  await expect(
    writeManifestJson(join(d, "m.json"), m, { open: shortOpen(0), rename }),
  ).rejects.toThrow(/no progress/);
  expect(await readdir(d)).toEqual([]);
});

it("a failed rename removes the partial file and rethrows", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const m = { selectorIds, artifactId: "0".repeat(32), mutants: cases.one ?? [] } as never;
  const failRename = (async () => {
    throw new Error("rename refused");
  }) as typeof rename;
  await expect(
    writeManifestJson(join(d, "m.json"), m, { open, rename: failRename }),
  ).rejects.toThrow("rename refused");
  expect(await readdir(d)).toEqual([]);
});

// The final name appears only by renaming a whole file onto it, so a crash mid-write (which no
// in-process test can simulate) can leave at most a `.partial`, never a truncated m.json.
it("the manifest name appears only by renaming a whole file onto it", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const m = { selectorIds, artifactId: "0".repeat(32), mutants: cases.many ?? [] } as never;
  const target = join(d, "m.json");
  const seen: string[] = [];
  const spyRename = (async (from: string, to: string) => {
    expect(String(to)).toBe(target);
    expect(String(from)).not.toBe(target);
    expect(await readdir(d)).toEqual([basename(String(from))]);
    expect(await readFile(from, "utf8")).toBe(`${JSON.stringify(m, null, 2)}\n`);
    seen.push(String(from));
    return rename(from, to);
  }) as typeof rename;
  await writeManifestJson(target, m, { open, rename: spyRename });
  expect(seen.length).toBe(1);
  expect(await readdir(d)).toEqual(["m.json"]);
});

// A close that throws must still remove the .partial, and must not mask a write's own error.
const closeFailOpen = (async (...args: Parameters<typeof open>) => {
  const fh = await open(...args);
  return Object.assign(Object.create(fh), {
    write: fh.write.bind(fh),
    close: async () => {
      await fh.close();
      throw new Error("close refused");
    },
  });
}) as typeof open;

it("a failing close after a whole write rethrows it and leaves nothing", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const m = { selectorIds, artifactId: "0".repeat(32), mutants: cases.one ?? [] } as never;
  await expect(
    writeManifestJson(join(d, "m.json"), m, { open: closeFailOpen, rename }),
  ).rejects.toThrow("close refused");
  expect(await readdir(d)).toEqual([]);
});

it("a failing close after a failed write keeps the write's error and leaves nothing", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const m = {
    selectorIds,
    artifactId: "0".repeat(32),
    mutants: [{ mutantId: 1, bad: 1n }],
  } as never;
  await expect(
    writeManifestJson(join(d, "m.json"), m, { open: closeFailOpen, rename }),
  ).rejects.toThrow(/BigInt/);
  expect(await readdir(d)).toEqual([]);
});
