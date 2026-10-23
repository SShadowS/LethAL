// R614: the ONE preparation of the fixture `.alpackages` from the pinned symbol tar, shared by the
// update gate (`scripts/al-runner-v3-update.ts`) and `itest:alrunner-v3`. Temp dirs and a small
// fake tar only: never the real tar, the real gate worktree or /coord.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FIXTURE_SYMBOLS_MANIFEST,
  FIXTURE_SYMBOLS_TAR,
  FIXTURE_SYMBOLS_TAR_SHA256,
  type FixtureApp,
  FixtureSymbolsRefusedError,
  GATE_ALPACKAGES,
  SYMBOLS_MARKER,
  prepareFixtureSymbols,
  symbolTarDrift,
} from "../itest/fixture-symbols";

const A = "fx/a/.alpackages";
const B = "fx/b/.alpackages";
const FOLDERS = [A, B] as const;
const FILES: Record<string, string> = {
  [`${A}/One.app`]: "one",
  [`${A}/Two.app`]: "two two",
  // A nested subfolder: exercises the walk's parent paths.
  [`${A}/sub/Deep.app`]: "deep",
  [`${B}/Three.app`]: "x".repeat(1500),
  // Outside the checked folders: never extracted, never compared (I1).
  "other/.alpackages/Four.app": "four",
};
const inFolders = (name: string) => FOLDERS.some((f) => name.startsWith(`${f}/`));

interface Entry {
  readonly name: string;
  readonly text?: string;
  readonly type?: string;
  readonly prefix?: string;
  /** Bytes 257..265; default the POSIX `ustar\0` + `00`. */
  readonly magic?: string;
}
function entry(e: Entry): Buffer[] {
  const data = Buffer.from(e.text ?? "", "utf8");
  const h = Buffer.alloc(512);
  h.write(e.name, 0, 100, "utf8");
  h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  h.write(e.type ?? "0", 156, "latin1");
  h.write(e.magic ?? "ustar\u000000", 257, "latin1");
  if (e.prefix !== undefined) h.write(e.prefix, 345, 155, "utf8");
  return [h, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
}
const archive = (entries: readonly Entry[]): Buffer =>
  Buffer.concat([...entries.flatMap(entry), Buffer.alloc(1024)]);
/** A directory entry per folder, then each file. */
const ustar = (files: Record<string, string>): Buffer =>
  archive([
    ...[...new Set(Object.keys(files).map((f) => dirname(f)))].map((d) => ({
      name: `${d}/`,
      type: "5",
    })),
    ...Object.entries(files).map(([name, text]) => ({ name, text })),
  ]);

let root = "";
let worktree = "";
let tar = "";
let pinned = "";
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
  root = "";
});
async function setup(bytes = ustar(FILES)): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "lethal-r614-"));
  worktree = join(root, "wt");
  await mkdir(worktree);
  tar = join(root, "symbols.tar");
  await writeFile(tar, bytes);
  pinned = createHash("sha256").update(bytes).digest("hex");
}
const prepare = (over: { pinnedSha256?: string; tar?: string } = {}) =>
  prepareFixtureSymbols({ worktree, tar, pinnedSha256: pinned, folders: FOLDERS, ...over });
const marker = () => join(worktree, SYMBOLS_MARKER);
async function placeFolders(files = FILES): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    if (!inFolders(name)) continue;
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
async function fresh(): Promise<void> {
  await rm(root, { recursive: true, force: true });
  root = "";
}

describe("R614: prepareFixtureSymbols", () => {
  test("the real defaults: the gate's two folders and the pinned tar", () => {
    expect(GATE_ALPACKAGES).toEqual([
      "fixtures/sandbox-tests/.alpackages",
      "fixtures/sandbox-data-tests/.alpackages",
    ]);
    expect(FIXTURE_SYMBOLS_TAR_SHA256).toMatch(/^[0-9a-f]{64}$/);
    // R670: the file is named by its pin, so a re-pin never overwrites a tar another worktree pins.
    expect(FIXTURE_SYMBOLS_TAR).toBe(
      `/work/lethal/.kraken-local/fixture-symbols-${FIXTURE_SYMBOLS_TAR_SHA256.slice(0, 12)}.tar`,
    );
  });

  test("folders absent: the tar is sha-checked, ONLY the two folders extracted, and the marker written", async () => {
    await setup();
    expect(await prepare()).toBe("extracted");
    for (const [name, text] of Object.entries(FILES))
      if (inFolders(name)) expect(await readFile(join(worktree, name), "utf8")).toBe(text);
    // I1: a member in a third folder is skipped, never written.
    expect(existsSync(join(worktree, "other"))).toBe(false);
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

  test("folders present, no marker, contents equal the tar's (nested subfolder included): marked, go ahead", async () => {
    await setup();
    await placeFolders();
    expect(await prepare()).toBe("marked");
    expect((await readFile(marker(), "utf8")).trim()).toBe(pinned);
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
      [
        "a changed file in a nested subfolder",
        (w) => writeFile(join(w, A, "sub", "Deep.app"), "DEEP"),
        /sub\/Deep\.app differs/,
      ],
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
      await fresh();
    }
  });

  // A symlink needs a privilege on Windows; the walk's rule is the same there.
  test.skipIf(process.platform === "win32")(
    "a symlink inside a folder is a difference, even to a file with the right bytes: refused",
    async () => {
      await setup();
      await placeFolders();
      await writeFile(join(root, "same-bytes.app"), "one");
      await rm(join(worktree, A, "One.app"));
      await symlink(join(root, "same-bytes.app"), join(worktree, A, "One.app"));
      const err = await refusal(prepare());
      expect(err.message).toMatch(/One\.app is not a regular file/);
      expect(existsSync(marker())).toBe(false);
    },
  );

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
      await fresh();
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
      await fresh();
    }
  });

  test("no tar: unprepared when absent; when present, the fix is the tar or a hand-written marker, never a delete", async () => {
    await setup();
    const absent = join(root, "absent.tar");
    expect((await refusal(prepare({ tar: absent }))).message).toMatch(
      /^al-runner-v3-gate-worktree-unprepared: /,
    );
    await placeFolders();
    const msg = (await refusal(prepare({ tar: absent }))).message;
    expect(msg).toMatch(/^al-runner-v3-gate-symbols-unverified: /);
    expect(msg).toContain(`copy the pinned tar (sha256 ${pinned}) to ${absent}`);
    expect(msg).toContain(`write ${pinned} to ${marker()}`);
    expect(msg).not.toContain("remove");
  });

  test("a tar member that escapes the worktree is refused, never written", async () => {
    // Four levels up from `wt/fx/a/.alpackages` is `root`, outside the worktree.
    await setup(ustar({ [`${A}/../../../../escape.app`]: "x" }));
    await expect(prepare()).rejects.toThrow(/unsafe tar member/);
    expect(existsSync(join(root, "escape.app"))).toBe(false);
  });

  test("M4: a member that climbs with backslashes is refused too, never written", async () => {
    await setup(archive([{ name: `${A}\\..\\..\\..\\..\\escape.app`, text: "x" }]));
    await expect(prepare()).rejects.toThrow(/unsafe tar member/);
    expect(existsSync(join(root, "escape.app"))).toBe(false);
  });

  test("an absolute member path is refused", async () => {
    await setup(archive([{ name: "/abs.app", text: "x" }]));
    await expect(prepare()).rejects.toThrow(/unsafe tar member/);
  });

  test("an unsupported member type (a symlink entry) is refused, naming the re-pack", async () => {
    await setup(archive([{ name: `${A}/Link.app`, type: "2" }]));
    await expect(prepare()).rejects.toThrow(/unsupported tar member type '2'.*--format=ustar/);
  });

  test("M3: the prefix is read on the POSIX ustar magic only, never on GNU's", async () => {
    await setup(archive([{ name: "Pre.app", prefix: A, text: "p" }, { name: `${B}/B.app` }]));
    expect(await prepare()).toBe("extracted");
    expect(await readFile(join(worktree, A, "Pre.app"), "utf8")).toBe("p");
    await fresh();
    // GNU's `ustar  \0` keeps other fields at 345: never a prefix.
    await setup(
      archive([
        { name: `${A}/Gnu.app`, prefix: "zzz", magic: "ustar  \0", text: "g" },
        { name: `${B}/B.app` },
      ]),
    );
    expect(await prepare()).toBe("extracted");
    expect(await readFile(join(worktree, A, "Gnu.app"), "utf8")).toBe("g");
  });
});

// R614: both callers route through the one function (the itest runs at import, the update gate's
// runGate spawns git, so each is pinned by its source). M7: anchored at a line start, so a
// commented-out call does not match.
describe("R614: both callers use prepareFixtureSymbols", () => {
  const src = (p: string) => readFile(join(import.meta.dir, "..", "..", "..", p), "utf8");
  test("itest:alrunner-v3 prepares its own worktree before any leg", async () => {
    const s = await src("packages/runner/itest/al-runner-v3.itest.ts");
    const main = s.slice(s.indexOf("async function main()"));
    const call = main.search(
      /^\s*const prepared = await prepareFixtureSymbols\(\{ worktree: REPO \}\);$/m,
    );
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(main.indexOf("for (const leg of LEGS)"));
  });
  test("the update gate's runGate prepares the gate worktree, and logs how, before the itest", async () => {
    const s = await src("scripts/al-runner-v3-update.ts");
    const gate = s.slice(s.indexOf("runGate: async"));
    const call = gate.search(
      /^\s*const prepared = await prepareFixtureSymbols\(\{ worktree: GATE_WORKTREE \}\);$/m,
    );
    const logged = gate.search(/^\s*await log\(`fixture \.alpackages: \$\{prepared\}`\);$/m);
    expect(call).toBeGreaterThan(0);
    expect(logged).toBeGreaterThan(call);
    expect(logged).toBeLessThan(gate.indexOf('"itest:alrunner-v3"'));
    expect(s).not.toContain('"tar", "-xf"');
  });
});

// R670: the tar's LethAL app copies against the fixtures' app.json. The synthetic cases pin each
// rule; the repo case reads only the committed manifest, so it runs in CI without the tar.
describe("R670: symbolTarDrift", () => {
  const apps: FixtureApp[] = [
    { dir: "fixtures/t", name: "T", version: "1.0.0.5", lethalDeps: [] },
    { dir: "fixtures/t-tests", name: "T Tests", version: "1.0.0.1", lethalDeps: ["T"] },
  ];
  const ms = (...files: string[]) => [
    "fixtures/t/.alpackages/Microsoft_System_28.0.47067.0.app",
    "fixtures/t/.alpackages/System.app",
    "fixtures/t/.alpackages/lethal-control.app",
    "fixtures/t-tests/.alpackages/Microsoft_Base Application_28.0.46665.47126.app",
    ...files.map((f) => `fixtures/t-tests/.alpackages/${f}`),
  ];

  test("the dependency at its fixture's version, plus Microsoft symbols: no drift", () => {
    expect(symbolTarDrift(ms("LethAL_T_1.0.0.5.app"), apps)).toEqual([]);
  });
  test("the fixture is newer than the tar's copy: drift, naming both versions", () => {
    expect(symbolTarDrift(ms("LethAL_T_1.0.0.4.app"), apps)).toEqual([
      "fixtures/t-tests/.alpackages/LethAL_T_1.0.0.4.app: the tar holds T 1.0.0.4, but fixtures/t/app.json is 1.0.0.5; rebuild the tar (R670)",
    ]);
  });
  test("the tar's copy is newer than the fixture: drift too", () => {
    expect(symbolTarDrift(ms("LethAL_T_1.0.0.6.app"), apps)).toHaveLength(1);
  });
  test("a declared dependency with no copy, or two copies: drift", () => {
    expect(symbolTarDrift(ms(), apps)).toEqual([
      "fixtures/t-tests/.alpackages/: 0 copies of T, want exactly 1",
    ]);
    expect(symbolTarDrift(ms("LethAL_T_1.0.0.5.app", "LethAL_T_1.0.0.5.app"), apps)).toEqual([
      "fixtures/t-tests/.alpackages/: 2 copies of T, want exactly 1",
    ]);
  });
  test("a project's own app in its own folder (not a dependency): drift", () => {
    const self = [...ms("LethAL_T_1.0.0.5.app"), "fixtures/t/.alpackages/LethAL_T_1.0.0.5.app"];
    expect(symbolTarDrift(self, apps)).toEqual([
      "fixtures/t/.alpackages/LethAL_T_1.0.0.5.app: fixtures/t declares no dependency on a repo app named T",
    ]);
  });
  test("a copy whose name hides its version (target.app): drift", () => {
    expect(symbolTarDrift(ms("LethAL_T_1.0.0.5.app", "target.app"), apps)).toEqual([
      "fixtures/t-tests/.alpackages/target.app: not a Microsoft symbol, and a LethAL app copy must be named LethAL_<name>_<version>.app",
    ]);
  });
  test("a project the tar has no folder for is not checked", () => {
    expect(symbolTarDrift(["fixtures/t/.alpackages/System.app"], apps)).toEqual([]);
  });

  const repo = join(import.meta.dir, "..", "..", "..");
  const manifest = readFileSync(FIXTURE_SYMBOLS_MANIFEST, "utf8").split("\n");
  const members = manifest.filter((l) => l !== "" && !l.startsWith("#"));
  const repoApps = (): FixtureApp[] =>
    ["fixtures", "examples"].flatMap((root) =>
      readdirSync(join(repo, root))
        .filter((d) => existsSync(join(repo, root, d, "app.json")))
        .map((d) => {
          const j = JSON.parse(
            readFileSync(join(repo, root, d, "app.json"), "utf8").replace(/^﻿/, ""),
          ) as {
            name: string;
            version: string;
            dependencies?: { name: string; publisher: string }[];
          };
          return {
            dir: `${root}/${d}`,
            name: j.name,
            version: j.version,
            lethalDeps: (j.dependencies ?? [])
              .filter((x) => x.publisher === "LethAL")
              .map((x) => x.name),
          };
        }),
    );

  test("the committed manifest names the pinned tar's sha256", () => {
    expect(manifest).toContain(`# sha256 ${FIXTURE_SYMBOLS_TAR_SHA256}`);
  });
  test("the committed manifest's LethAL copies equal every fixture's app.json (CI, no tar)", () => {
    expect(members.length).toBeGreaterThan(100);
    expect(symbolTarDrift(members, repoApps())).toEqual([]);
  });
  test.skipIf(!existsSync(FIXTURE_SYMBOLS_TAR))(
    "the committed manifest equals the pinned tar's listing (only where the tar exists)",
    () => {
      const r = spawnSync("tar", ["-tf", FIXTURE_SYMBOLS_TAR], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout.split("\n").filter((l) => l !== "" && !l.endsWith("/"))).toEqual(members);
    },
  );
});
