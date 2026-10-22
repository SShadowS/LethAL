/**
 * R614: the ONE preparation of the fixture `.alpackages` that `itest:alrunner-v3` compiles
 * against, from the pinned symbol tar. Shared by the update gate (`scripts/al-runner-v3-update.ts`,
 * its `runGate`) and the itest's own startup, so a manual run in a fresh worktree extracts the
 * folders itself, sha-checked (R-637 run 1 and lethal-code's R-612 leg C hit that gap).
 *
 * - Folders absent: the tar's sha256 must equal the pin; then every member is extracted and the
 *   pin written to `SYMBOLS_MARKER` at the worktree root (untracked, outside fixtures/ and
 *   packages/, so the receipt's dirty check ignores it).
 * - All folders present and the marker equals the pin: used as they are.
 * - All folders present and NO marker (folders placed before R614): re-verified against the tar,
 *   file set and every file's sha256. Equal: the marker is written. Any difference: refused.
 * - Anything else (a wrong marker, only some folders): refused by name. Nothing is ever deleted:
 *   the refusal names the one-time fix.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { type FileHandle, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** Where kraken keeps the symbol tar (gitignored, never committed). */
export const FIXTURE_SYMBOLS_TAR = "/work/lethal/.kraken-local/fixture-symbols.tar";

/**
 * F5: the tar, pinned by sha256 (measured 2026-10-21, 1,705,707,520 bytes). A different tar is
 * refused by name; changing it is a deliberate edit here, then a `--regate`.
 */
export const FIXTURE_SYMBOLS_TAR_SHA256 =
  "bdf460e292f005f1c02cc7b45e83ede1d5c5df280070dc97231f9b314d4f175e";

/** Fixture symbol folders the gate's legs compile against (gitignored, from the tar). */
export const GATE_ALPACKAGES = [
  "fixtures/sandbox-tests/.alpackages",
  "fixtures/sandbox-data-tests/.alpackages",
] as const;

/** At the worktree root: the sha256 of the tar the folders came from (or were verified against). */
export const SYMBOLS_MARKER = ".fixture-symbols.sha256";

/** The folders cannot be used, by name (`al-runner-v3-gate-*`). An infra-fail, never a verdict. */
export class FixtureSymbolsRefusedError extends Error {
  override readonly name = "FixtureSymbolsRefusedError";
}

export async function prepareFixtureSymbols(s: {
  readonly worktree: string;
  readonly tar?: string;
  readonly pinnedSha256?: string;
  readonly folders?: readonly string[];
}): Promise<"extracted" | "verified" | "marked"> {
  const tar = s.tar ?? FIXTURE_SYMBOLS_TAR;
  const pinned = s.pinnedSha256 ?? FIXTURE_SYMBOLS_TAR_SHA256;
  const folders = s.folders ?? GATE_ALPACKAGES;
  const markerFile = join(s.worktree, SYMBOLS_MARKER);
  const found = existsSync(markerFile) ? (await readFile(markerFile, "utf8")).trim() : undefined;
  const present = folders.filter((f) => existsSync(join(s.worktree, f)));
  const unverified = (why: string) =>
    new FixtureSymbolsRefusedError(
      `al-runner-v3-gate-symbols-unverified: ${s.worktree}: ${why}; its ${SYMBOLS_MARKER} reads ${found ?? "(no marker)"}, expected ${pinned}; one-time fix: remove ${folders.map((f) => join(s.worktree, f)).join(" and ")} and ${markerFile}, then run again to extract them from ${tar}`,
    );

  if (present.length === folders.length && found === pinned) return "verified";
  if (present.length > 0 && present.length < folders.length)
    throw unverified(`only ${present.join(", ")} of ${folders.join(", ")} present`);
  if (present.length > 0 && found !== undefined) throw unverified("the marker names another tar");
  if (!existsSync(tar))
    throw present.length === 0
      ? new FixtureSymbolsRefusedError(
          `al-runner-v3-gate-worktree-unprepared: ${s.worktree} has no fixture .alpackages (${folders.join(", ")}) and there is no ${tar} to extract them from`,
        )
      : unverified(`no ${tar} to verify the folders against`);
  const tarSha = await sha256OfStream(tar);
  if (tarSha !== pinned)
    throw new FixtureSymbolsRefusedError(
      `al-runner-v3-gate-symbol-tar-mismatch: ${tar} has sha256 ${tarSha}, pinned ${pinned}`,
    );

  if (present.length === 0) {
    await extractTar(tar, s.worktree);
    await writeFile(markerFile, `${pinned}\n`);
    return "extracted";
  }
  const diffs = await differencesFromTar(tar, s.worktree, folders);
  if (diffs.length > 0)
    throw unverified(
      `the folders differ from the tar: ${diffs.slice(0, 5).join("; ")}${diffs.length > 5 ? ` (and ${diffs.length - 5} more)` : ""}`,
    );
  await writeFile(markerFile, `${pinned}\n`);
  return "marked";
}

/** Streamed, so the 1.7 GB tar is never held in memory. */
async function sha256OfStream(p: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer);
  return h.digest("hex");
}

interface TarMember {
  readonly name: string;
  readonly kind: "file" | "dir";
  readonly size: number;
  readonly offset: number;
}

/**
 * The members of a plain ustar archive, in order. Only regular files and directories are
 * accepted (the pinned tar holds nothing else); any other type, a non-octal size, or a member
 * whose path is absolute or climbs with `..` throws.
 */
async function tarMembers(fh: FileHandle, tar: string): Promise<TarMember[]> {
  const members: TarMember[] = [];
  const h = Buffer.alloc(512);
  for (let pos = 0; ; ) {
    const { bytesRead } = await fh.read(h, 0, 512, pos);
    if (bytesRead < 512) throw new Error(`${tar}: truncated tar header at byte ${pos}`);
    if (h.every((b) => b === 0)) return members;
    const field = (at: number, len: number) =>
      h.toString("utf8", at, at + len).replace(/\0.*$/s, "");
    const sizeText = field(124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error(`${tar}: unreadable tar size at byte ${pos}`);
    const size = Number.parseInt(sizeText, 8);
    const type = field(156, 1);
    const prefix = h.toString("latin1", 257, 262) === "ustar" ? field(345, 155) : "";
    const raw = prefix !== "" ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const name = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (type !== "0" && type !== "" && type !== "5")
      throw new Error(`${tar}: unsupported tar member type '${type}' for ${raw}`);
    if (isAbsolute(name) || name.split("/").includes(".."))
      throw new Error(`${tar}: unsafe tar member path ${raw}`);
    if (name !== "")
      members.push({ name, kind: type === "5" ? "dir" : "file", size, offset: pos + 512 });
    pos += 512 + Math.ceil(size / 512) * 512;
  }
}

/** Calls `sink` with the member's bytes, in order. */
async function readMember(
  fh: FileHandle,
  m: TarMember,
  sink: (chunk: Buffer) => Promise<void> | void,
): Promise<void> {
  const buf = Buffer.alloc(1 << 20);
  for (let done = 0; done < m.size; ) {
    const { bytesRead } = await fh.read(
      buf,
      0,
      Math.min(buf.length, m.size - done),
      m.offset + done,
    );
    if (bytesRead === 0) throw new Error(`tar member ${m.name} is truncated`);
    await sink(buf.subarray(0, bytesRead));
    done += bytesRead;
  }
}

async function extractTar(tar: string, into: string): Promise<void> {
  const fh = await open(tar, "r");
  try {
    for (const m of await tarMembers(fh, tar)) {
      const target = join(into, m.name);
      if (m.kind === "dir") {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      const out = await open(target, "w");
      try {
        await readMember(fh, m, async (c) => {
          await out.write(c);
        });
      } finally {
        await out.close();
      }
    }
  } finally {
    await fh.close();
  }
}

/** Each way the files under `folders` differ from the tar's members there (set and sha256). */
async function differencesFromTar(
  tar: string,
  worktree: string,
  folders: readonly string[],
): Promise<string[]> {
  const under = (p: string) => folders.some((f) => p.startsWith(`${f}/`));
  const want = new Map<string, string>();
  const fh = await open(tar, "r");
  try {
    for (const m of await tarMembers(fh, tar)) {
      if (m.kind !== "file" || !under(m.name)) continue;
      const h = createHash("sha256");
      await readMember(fh, m, (c) => {
        h.update(c);
      });
      want.set(m.name, h.digest("hex"));
    }
  } finally {
    await fh.close();
  }
  const diffs: string[] = [];
  const have = new Set<string>();
  for (const f of folders)
    for (const e of await readdir(join(worktree, f), { withFileTypes: true, recursive: true })) {
      if (e.isDirectory()) continue;
      const rel = relative(worktree, join(e.parentPath, e.name)).split(sep).join("/");
      if (!e.isFile()) {
        diffs.push(`${rel} is not a regular file`);
        continue;
      }
      have.add(rel);
      const sha = want.get(rel);
      if (sha === undefined) diffs.push(`${rel} is not in the tar`);
      else if ((await sha256OfStream(join(worktree, rel))) !== sha) diffs.push(`${rel} differs`);
    }
  for (const name of want.keys()) if (!have.has(name)) diffs.push(`${name} is missing`);
  return diffs.sort();
}
