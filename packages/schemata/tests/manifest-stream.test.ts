import { afterAll, expect, it } from "bun:test";
import { mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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

// RUST-03 S4a review M1: `many` above (2,500 short rows) never reaches the writer's flush
// threshold (`chunk.length > 1 << 20`, 1 MiB), so no existing case compares bytes across a
// mid-array flush, the path a BaseApp-sized manifest actually uses. Pad each row past 1 KB so the
// chunk crosses the threshold more than twice well before the end of the array.
it("streams byte-identically to JSON.stringify across multiple 1 MiB flushes", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const mutants = Array.from({ length: 3000 }, (_, i) => ({
    mutantId: i + 1,
    file: `f${i % 7}.al`,
    pad: "x".repeat(1000),
  }));
  const m = { selectorIds, artifactId: "0".repeat(32), mutants } as never;
  const expected = `${JSON.stringify(m, null, 2)}\n`;
  expect(expected.length).toBeGreaterThan(2 * (1 << 20));
  await writeManifestJson(join(d, "m.json"), m);
  expect(await readFile(join(d, "m.json"), "utf8")).toBe(expected);
});

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

// R439: 30 s, not bun's 5 s default. Seven-byte writes of a 2,500-mutant manifest are about
// 70,000 calls: measured 3.9 to 6.9 s on the kraken container, alone and beside a full verify.
it("short writes are completed, byte-identically", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const m = { selectorIds, artifactId: "0".repeat(32), mutants: cases.many ?? [] } as never;
  await writeManifestJson(join(d, "m.json"), m, { open: shortOpen(7), rename });
  expect(await readFile(join(d, "m.json"), "utf8")).toBe(`${JSON.stringify(m, null, 2)}\n`);
}, 30_000);

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

// RUST-03 S4a review I1: writeInstrumentedProject does not require an empty target directory, so a
// directory reused after a failed rewrite could still hold the OLD real-name manifest, looking
// complete. A failed rewrite must remove it, not just the .partial.
it("a failed write removes an existing manifest already at the real name", async () => {
  const d = await mkdtemp(join(tmpdir(), "lethal-manifest-"));
  dirs.push(d);
  const target = join(d, "m.json");
  await writeFile(target, "stale manifest from a previous run");
  const m = {
    selectorIds,
    artifactId: "0".repeat(32),
    mutants: [{ mutantId: 1, bad: 1n }], // BigInt: stringify throws late
  } as never;
  await expect(writeManifestJson(target, m)).rejects.toThrow();
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
