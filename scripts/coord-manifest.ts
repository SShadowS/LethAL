/**
 * A manifest of a coord root, to compare a copy against its source.
 *
 *   bun scripts/coord-manifest.ts <root>
 *
 * Prints JSON `{ files: [{ path, size, sha256 }] }`: paths relative to the root with `/`
 * separators, sorted, never file contents. Each file is hashed as a stream, one at a time, so a
 * large root (about 100 MB) is never held in memory.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface ManifestEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

async function listFiles(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const p = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listFiles(root, p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export async function manifest(root: string): Promise<{ files: ManifestEntry[] }> {
  const files: ManifestEntry[] = [];
  for (const path of (await listFiles(root)).sort()) {
    const file = join(root, path);
    files.push({ path, size: (await stat(file)).size, sha256: await sha256File(file) });
  }
  return { files };
}

if (import.meta.main) {
  const root = process.argv[2];
  if (root === undefined) {
    console.error("usage: bun scripts/coord-manifest.ts <root>");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await manifest(root), null, 2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
