// R614: the ONE preparation of the fixture `.alpackages` from the pinned symbol tar, shared by the
// update gate (`scripts/al-runner-v3-update.ts`) and `itest:alrunner-v3`. Temp dirs and a small
// fake tar only: never the real tar, the real gate worktree or /coord.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FIXTURE_SYMBOLS_TAR,
  FIXTURE_SYMBOLS_TAR_SHA256,
  FixtureSymbolsRefusedError,
  GATE_ALPACKAGES,
  SYMBOLS_MARKER,
  prepareFixtureSymbols,
} from "../itest/fixture-symbols";

const A = "fx/a/.alpackages";
const B = "fx/b/.alpackages";
const FOLDERS = [A, B] as const;
const FILES: Record<string, string> = {
  [`${A}/One.app`]: "one",
  [`${A}/Two.app`]: "two two",
  [`${B}/Three.app`]: "x".repeat(1500),
  // Outside the checked folders: extracted, never compared.
  "other/.alpackages/Four.app": "four",
};

/** A minimal ustar archive: a directory entry per folder, then each file. */
function ustar(files: Record<string, string>): Buffer {
  const header = (name: string, size: number, type: "0" | "5"): Buffer => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    h.write(type, 156, "latin1");
    h.write("ustar\0", 257, "latin1");
    return h;
  };
  const parts: Buffer[] = [];
  for (const dir of new Set(Object.keys(files).map((f) => dirname(f))))
    parts.push(header(`${dir}/`, 0, "5"));
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    parts.push(
      header(name, data.length, "0"),
      data,
      Buffer.alloc((512 - (data.length % 512)) % 512),
    );
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

let root = "";
let worktree = "";
let tar = "";
let pinned = "";
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
  root = "";
});
async function setup(files = FILES): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "lethal-r614-"));
  worktree = join(root, "wt");
  await mkdir(worktree);
  tar = join(root, "symbols.tar");
  const bytes = ustar(files);
  await writeFile(tar, bytes);
  pinned = createHash("sha256").update(bytes).digest("hex");
}
const prepare = (over: { pinnedSha256?: string; tar?: string } = {}) =>
  prepareFixtureSymbols({ worktree, tar, pinnedSha256: pinned, folders: FOLDERS, ...over });
const marker = () => join(worktree, SYMBOLS_MARKER);
async function placeFolders(files = FILES): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    if (!FOLDERS.some((f) => name.startsWith(`${f}/`))) continue;
    await mkdir(dirname(join(worktree, name)), { recursive: true });
    await writeFile(join(worktree, name), text);
  }
}
async function refusal(p: Promise<unknown>): Promise<FixtureSymbolsRefusedError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(FixtureSymbolsRefusedError);
  return err as FixtureSymbolsRefusedError;
}

describe("R614: prepareFixtureSymbols", () => {
  test("the real defaults: the gate's two folders and the pinned tar", () => {
    expect(GATE_ALPACKAGES).toEqual([
      "fixtures/sandbox-tests/.alpackages",
      "fixtures/sandbox-data-tests/.alpackages",
    ]);
    expect(FIXTURE_SYMBOLS_TAR).toBe("/work/lethal/.kraken-local/fixture-symbols.tar");
    expect(FIXTURE_SYMBOLS_TAR_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("folders absent: the tar is sha-checked, extracted, and the marker written", async () => {
    await setup();
    expect(await prepare()).toBe("extracted");
    for (const [name, text] of Object.entries(FILES))
      expect(await readFile(join(worktree, name), "utf8")).toBe(text);
    expect((await readFile(marker(), "utf8")).trim()).toBe(pinned);
  });

  test("folders absent and a stale marker: extracted, and the marker rewritten", async () => {
    await setup();
    await writeFile(marker(), `${"0".repeat(64)}\n`);
    expect(await prepare()).toBe("extracted");
    expect((await readFile(marker(), "utf8")).trim()).toBe(pinned);
  });

  test("folders present and the marker equals the pinned sha: used as they are, the tar not read", async () => {
    await setup();
    await placeFolders();
    await writeFile(marker(), `${pinned}\n`);
    // The tar is not needed (nor read) on this path.
    expect(await prepare({ tar: join(root, "absent.tar") })).toBe("verified");
  });

  test("folders present, no marker, contents equal the tar's: the marker is written, then go ahead", async () => {
    await setup();
    await placeFolders();
    expect(await prepare()).toBe("marked");
    expect((await readFile(marker(), "utf8")).trim()).toBe(pinned);
    // Nothing outside the checked folders was extracted on this path.
    expect(existsSync(join(worktree, "other"))).toBe(false);
  });

  test("folders present, no marker, contents differ: refused by name, nothing deleted, no marker", async () => {
    const cases: Array<[string, (w: string) => Promise<void>, RegExp]> = [
      ["a changed file", (w) => writeFile(join(w, A, "One.app"), "ONE"), /One\.app differs/],
      [
        "an extra file",
        (w) => writeFile(join(w, B, "Extra.app"), "e"),
        /Extra\.app is not in the tar/,
      ],
      ["a missing file", (w) => rm(join(w, A, "Two.app")), /Two\.app is missing/],
    ];
    for (const [, change, why] of cases) {
      await setup();
      await placeFolders();
      await change(worktree);
      const err = await refusal(prepare());
      expect(err.message).toMatch(/^al-runner-v3-gate-symbols-unverified: /);
      expect(err.message).toMatch(why);
      expect(err.message).toContain("(no marker)");
      expect(err.message).toContain(pinned);
      expect(err.message).toContain("one-time fix");
      expect(existsSync(join(worktree, A))).toBe(true);
      expect(existsSync(marker())).toBe(false);
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  test("folders present and a wrong marker: refused by name, naming the marker found and the sha expected", async () => {
    await setup();
    await placeFolders();
    await writeFile(marker(), `${"0".repeat(64)}\n`);
    const err = await refusal(prepare());
    expect(err.message).toMatch(/^al-runner-v3-gate-symbols-unverified: /);
    expect(err.message).toContain("0".repeat(64));
    expect(err.message).toContain(pinned);
    expect(err.message).toContain(`remove ${join(worktree, A)} and ${join(worktree, B)}`);
    expect((await readFile(marker(), "utf8")).trim()).toBe("0".repeat(64));
  });

  test("only some folders present: refused by name, even with a matching marker", async () => {
    for (const m of [undefined, "pinned"]) {
      await setup();
      await placeFolders();
      await rm(join(worktree, B), { recursive: true });
      if (m !== undefined) await writeFile(marker(), `${pinned}\n`);
      const err = await refusal(prepare());
      expect(err.message).toMatch(/^al-runner-v3-gate-symbols-unverified: .*only /);
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  test("the tar's sha256 is not the pinned one: refused by name, nothing extracted or marked", async () => {
    for (const present of [false, true]) {
      await setup();
      if (present) await placeFolders();
      const err = await refusal(prepare({ pinnedSha256: "1".repeat(64) }));
      expect(err.message).toMatch(/^al-runner-v3-gate-symbol-tar-mismatch: /);
      expect(err.message).toContain(pinned);
      expect(err.message).toContain("1".repeat(64));
      expect(existsSync(join(worktree, A))).toBe(present);
      expect(existsSync(marker())).toBe(false);
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  test("no tar: refused by name (unprepared when absent, unverified when present without a marker)", async () => {
    await setup();
    const absent = join(root, "absent.tar");
    expect((await refusal(prepare({ tar: absent }))).message).toMatch(
      /^al-runner-v3-gate-worktree-unprepared: /,
    );
    await placeFolders();
    expect((await refusal(prepare({ tar: absent }))).message).toMatch(
      /^al-runner-v3-gate-symbols-unverified: /,
    );
  });

  test("a tar member that escapes the worktree is refused, never written", async () => {
    // Four levels up from `wt/fx/a/.alpackages` is `root`, outside the worktree.
    await setup({ [`${A}/../../../../escape.app`]: "x" });
    await expect(prepare()).rejects.toThrow(/unsafe tar member/);
    expect(existsSync(join(root, "escape.app"))).toBe(false);
  });
});

// R614: both callers route through the one function (the itest runs at import, the update gate's
// runGate spawns git, so each is pinned by its source).
describe("R614: both callers use prepareFixtureSymbols", () => {
  const src = (p: string) => readFile(join(import.meta.dir, "..", "..", "..", p), "utf8");
  test("itest:alrunner-v3 prepares its own worktree before any leg", async () => {
    const s = await src("packages/runner/itest/al-runner-v3.itest.ts");
    const main = s.slice(s.indexOf("async function main()"));
    const call = main.indexOf("await prepareFixtureSymbols({ worktree: REPO })");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(main.indexOf("for (const leg of LEGS)"));
  });
  test("the update gate's runGate prepares the gate worktree before the itest", async () => {
    const s = await src("scripts/al-runner-v3-update.ts");
    const gate = s.slice(s.indexOf("runGate: async"));
    const call = gate.indexOf("await prepareFixtureSymbols({ worktree: GATE_WORKTREE })");
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(gate.indexOf('"itest:alrunner-v3"'));
    expect(s).not.toContain('"tar", "-xf"');
  });
});
