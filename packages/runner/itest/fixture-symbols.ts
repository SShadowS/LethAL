/**
 * R614: the ONE preparation of the fixture `.alpackages` that `itest:alrunner-v3` compiles
 * against, from the pinned symbol tar. Shared by the update gate (`scripts/al-runner-v3-update.ts`,
 * its `runGate`) and the itest's own startup, so a manual run in a fresh worktree extracts the
 * folders itself, sha-checked (R-637 run 1 and lethal-code's R-612 leg C hit that gap).
 *
 * - Folders absent: the tar's sha256 must equal the pin; then ONLY the members under `folders`
 *   are extracted (no other fixture folder is written) and the pin is written to `SYMBOLS_MARKER`
 *   at the worktree root (gitignored, outside fixtures/ and packages/, so the receipt's dirty
 *   check ignores it). The marker means "these folders equal the tar's", whichever way it was
 *   written.
 * - All folders present and the marker equals the pin: used as they are.
 * - All folders present and NO marker (folders placed before R614): re-verified against the tar,
 *   file set and every file's sha256. Equal: the marker is written. Any difference: refused.
 * - Anything else (a wrong marker, only some folders): refused by name. Nothing is ever deleted:
 *   the refusal names the one-time fix.
 *
 * The reader takes plain ustar only: regular files and directories, octal sizes, names of up to
 * 255 bytes (POSIX prefix). GNU long names, pax headers and links are refused; re-pack such a tar
 * with `tar --format=ustar`.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { type FileHandle, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * Where the symbol tar lives (gitignored, never committed). R670: named by its sha256's first 12
 * hex digits, so a rebuilt tar sits beside the one older worktrees still pin and never replaces it.
 */
export const FIXTURE_SYMBOLS_TAR = "/work/lethal/.kraken-local/fixture-symbols-2279aee3857b.tar";

/**
 * F5: the tar, pinned by sha256 (R673 rebuild, 2026-10-24, 2,103,091,200 bytes: the R670 tar,
 * `26f680ae…`, plus `.alpackages` for sandbox-names, -names-tests, -wrapped, -wrapped-tests,
 * -codefree and -codefree-tests; that replaced `fixture-symbols.tar`, `bdf460e2…`). A different tar is refused by name; changing it is a
 * deliberate edit here and in `FIXTURE_SYMBOLS_MANIFEST`, then a `--regate`. A re-pin refuses
 * EVERY worktree whose two folders came from the old tar, the gate worktree included (its marker
 * names the old pin, `al-runner-v3-gate-symbols-unverified`), and a FRESH worktree on any machine
 * that lacks the sha-named tar, until the owner's secret swap delivers it. The one-line fix, per
 * worktree, by hand: `bun scripts/fixture-symbols-reset.ts <worktree>` deletes the two folders and
 * its `SYMBOLS_MARKER`, and the next run extracts them from the new tar.
 */
export const FIXTURE_SYMBOLS_TAR_SHA256 =
  "2279aee3857bc2f123f602bb9dc265b1be783a782486d9982ddd37fd50d46359";

/**
 * R670: the pinned tar's files in archive order (`tar -tf`, directories left out), committed, with
 * the tar's sha256 on its `# sha256` line. CI has no tar, so `symbolTarDrift` checks this list
 * against the fixtures' `app.json` instead; a test that runs only where the tar exists checks
 * the list against the tar.
 */
export const FIXTURE_SYMBOLS_MANIFEST = join(import.meta.dir, "fixture-symbols.manifest");

/** R670: one AL project of the repo, as its `app.json` declares it. */
export interface FixtureApp {
  /** Relative to the repo root, `/`-separated: `fixtures/sandbox-data-tests`. */
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  /** The names of its dependencies published by `LethAL`. */
  readonly lethalDeps: readonly string[];
}

const LETHAL_COPY = /^LethAL_(.+)_(\d+\.\d+\.\d+\.\d+)\.app$/;
const OTHER_SYMBOL = /^(Microsoft_[^/]+\.app|System\.app|lethal-control\.app)$/;

/**
 * R670: each way the tar's LethAL app copies disagree with the fixtures, for every project the tar
 * has an `.alpackages` for. A copy is named `LethAL_<name>_<version>.app`, and it must be a declared
 * LethAL dependency of that project at its fixture's `app.json` version: older AND newer both fail,
 * so a fixture bump without a tar refresh fails CI. Each such dependency needs exactly one copy.
 * Any other file must be `Microsoft_*.app`, `System.app` or an R552 `lethal-control.app` leftover
 * (never compiled against); anything else, a `target.app` included, hides its version and is
 * refused. A project the tar has no folder for is not checked (`compile:fixtures` skips it).
 */
export function symbolTarDrift(members: readonly string[], apps: readonly FixtureApp[]): string[] {
  const byName = new Map(apps.map((a) => [a.name, a]));
  const out: string[] = [];
  for (const app of apps) {
    const prefix = `${app.dir}/.alpackages/`;
    const files = members.filter((m) => m.startsWith(prefix)).map((m) => m.slice(prefix.length));
    if (files.length === 0) continue;
    const copies = new Map<string, number>();
    for (const file of files) {
      const [, name, version] = LETHAL_COPY.exec(file) ?? [];
      if (name === undefined || version === undefined) {
        if (!OTHER_SYMBOL.test(file))
          out.push(
            `${prefix}${file}: not a Microsoft symbol, and a LethAL app copy must be named LethAL_<name>_<version>.app`,
          );
        continue;
      }
      const dep = byName.get(name);
      if (dep === undefined || !app.lethalDeps.includes(name)) {
        out.push(`${prefix}${file}: ${app.dir} declares no dependency on a repo app named ${name}`);
        continue;
      }
      copies.set(name, (copies.get(name) ?? 0) + 1);
      if (version !== dep.version)
        out.push(
          `${prefix}${file}: the tar holds ${name} ${version}, but ${dep.dir}/app.json is ${dep.version}; rebuild the tar (R670)`,
        );
    }
    for (const d of app.lethalDeps)
      if (byName.has(d) && copies.get(d) !== 1)
        out.push(`${prefix}: ${copies.get(d) ?? 0} copies of ${d}, want exactly 1`);
  }
  return out;
}

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

/**
 * R787: every `fixtures/<dir>/.alpackages` and `examples/<dir>/.alpackages` under `root` that is a
 * symlink, or whose real path leaves `root` (a linked `<dir>` or `fixtures`), relative to `root`.
 * Such a link (a `cp -r` of another worktree's link copies the link) points into another lane's
 * worktree, so a gate that fills or rewrites symbols writes THERE, and git does not ignore it
 * unless `.gitignore` matches non-directories too.
 */
export function symlinkedAlpackages(root: string): string[] {
  const out: string[] = [];
  const realRoot = realpathSync(root);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
  for (const top of ["fixtures", "examples"]) {
    let dirs: string[];
    try {
      dirs = readdirSync(join(root, top));
    } catch {
      continue; // no such folder in this root
    }
    for (const d of dirs.sort()) {
      const rel = join(top, d, ".alpackages");
      try {
        const p = join(root, rel);
        if (lstatSync(p).isSymbolicLink() || !inside(realpathSync(p))) out.push(rel);
      } catch {} // no .alpackages there
    }
  }
  return out;
}

/** R787: the refusal text for `symlinkedAlpackages`' list, with the fix; `undefined` when empty. */
export function symlinkedAlpackagesRefusal(
  root: string,
  links: readonly string[],
): string | undefined {
  if (links.length === 0) return undefined;
  return `fixture-alpackages-symlink: ${links.join(", ")} under ${root} ${links.length === 1 ? "is a symlink or lies under one" : "are symlinks or lie under one"}. A link points into another worktree, so a gate writing symbols would change that worktree's files, and git does not ignore a link. Replace each link with a real copy: \`t=$(readlink -f <link>) && rm <link> && cp -r "$t" <link>\` (R787).`;
}

/** R787: a BC gate refuses a symlinked fixture `.alpackages` by name before any lease or call. */
export class SymlinkedAlpackagesError extends Error {
  override readonly name = "SymlinkedAlpackagesError";
}

export async function prepareFixtureSymbols(s: {
  readonly worktree: string;
  readonly tar?: string;
  readonly pinnedSha256?: string;
  readonly folders?: readonly string[];
}): Promise<"extracted" | "verified" | "marked"> {
  // R787: before anything is extracted or read, so nothing is written through a link.
  const links = symlinkedAlpackages(s.worktree);
  const linked = symlinkedAlpackagesRefusal(s.worktree, links);
  if (linked !== undefined) throw new FixtureSymbolsRefusedError(`al-runner-v3-gate-${linked}`);
  const tar = s.tar ?? FIXTURE_SYMBOLS_TAR;
  const pinned = s.pinnedSha256 ?? FIXTURE_SYMBOLS_TAR_SHA256;
  const folders = s.folders ?? GATE_ALPACKAGES;
  const markerFile = join(s.worktree, SYMBOLS_MARKER);
  const found = existsSync(markerFile) ? (await readFile(markerFile, "utf8")).trim() : undefined;
  const present = folders.filter((f) => existsSync(join(s.worktree, f)));
  const unverified = (
    why: string,
    fix = `remove ${folders.map((f) => join(s.worktree, f)).join(" and ")} and ${markerFile}, then run again to extract them from ${tar}`,
  ) =>
    new FixtureSymbolsRefusedError(
      `al-runner-v3-gate-symbols-unverified: ${s.worktree}: ${why}; its ${SYMBOLS_MARKER} reads ${found ?? "(no marker)"}, expected ${pinned}; one-time fix: ${fix}`,
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
      : unverified(
          `no ${tar} to verify the folders against`,
          `copy the pinned tar (sha256 ${pinned}) to ${tar}, or, only after checking the folders against that tar yourself, write ${pinned} to ${markerFile}`,
        );
  const tarSha = await sha256OfStream(tar);
  if (tarSha !== pinned)
    throw new FixtureSymbolsRefusedError(
      `al-runner-v3-gate-symbol-tar-mismatch: ${tar} has sha256 ${tarSha}, pinned ${pinned}`,
    );

  if (present.length === 0) {
    await extractTar(tar, s.worktree, folders);
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

/** A tar member path is one of the checked folders' (the same test for extract and compare). */
const under = (folders: readonly string[], p: string) => folders.some((f) => p.startsWith(`${f}/`));

interface TarMember {
  readonly name: string;
  readonly kind: "file" | "dir";
  readonly size: number;
  readonly offset: number;
}

/**
 * The members of a plain ustar archive, in order, all parsed before anything is written. Only
 * regular files and directories are accepted (the pinned tar holds nothing else); any other type,
 * a non-octal size, or a member whose path is absolute or lands outside `into` once joined (a
 * backslash counts as a separator, as on Windows) throws.
 */
async function tarMembers(fh: FileHandle, tar: string, into: string): Promise<TarMember[]> {
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
    // M3: the prefix field exists only in POSIX ustar (`ustar\0` + `00`); GNU keeps times there.
    const prefix = h.toString("latin1", 257, 265) === "ustar\u000000" ? field(345, 155) : "";
    const raw = prefix !== "" ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const name = raw.replace(/^\.\//, "").replace(/\/$/, "");
    if (type !== "0" && type !== "" && type !== "5")
      throw new Error(
        `${tar}: unsupported tar member type '${type}' for ${raw}; re-pack the tar with \`tar --format=ustar\` (regular files and directories only)`,
      );
    if (name !== "") {
      const rel = relative(into, join(into, name.replaceAll("\\", "/")));
      if (
        isAbsolute(name) ||
        /^[A-Za-z]:/.test(name) ||
        rel === "" ||
        rel === ".." ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel)
      )
        throw new Error(`${tar}: unsafe tar member path ${raw}`);
      members.push({ name, kind: type === "5" ? "dir" : "file", size, offset: pos + 512 });
    }
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

/** I1: only the members under `folders`; every other member is skipped, never written. */
async function extractTar(tar: string, into: string, folders: readonly string[]): Promise<void> {
  const fh = await open(tar, "r");
  try {
    for (const m of await tarMembers(fh, tar, into)) {
      if (!under(folders, m.name)) continue;
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
  const want = new Map<string, string>();
  const fh = await open(tar, "r");
  try {
    for (const m of await tarMembers(fh, tar, worktree)) {
      if (m.kind !== "file" || !under(folders, m.name)) continue;
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
