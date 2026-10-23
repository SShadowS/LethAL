import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removeScratchDir } from "../packages/runner/tests/helpers/scratch";
import {
  CONTAINER_MAP,
  SwapRecoveryError,
  UnsupportedLauncherError,
  describeError,
  hasWindowsPath,
  icaclsArgv,
  isSecretEntry,
  listingProblems,
  pinnedSymbolTar,
  recoverInterruptedSwap,
  repoApps,
  rewrite,
  secretFiles,
  sweepSwapFolders,
  tarDrift,
  underTempDir,
  writeOutputs,
} from "./kraken-secrets.ts";

const SCRIPT = join(import.meta.dir, "kraken-secrets.ts");
// R670: a name the drift check accepts as a Microsoft symbol
const SYM = "Microsoft_Sym_28.0.0.0.app";

test("describeError names a file-system failure without any value", () => {
  let fsErr: unknown;
  try {
    readFileSync(join(tmpdir(), "kraken-secrets-no-such-file-hunter2"));
  } catch (e) {
    fsErr = e;
  }
  const d = describeError(fsErr);
  expect(d).toMatch(/^\w+ ENOENT open$/);
  expect(d).not.toContain("hunter2");
  // a code or syscall that is not errno-shaped (could carry data) is dropped
  const odd = Object.assign(new Error("password hunter2"), { code: "hunter2", syscall: "x y" });
  expect(describeError(odd)).toBe("Error");
  expect(describeError("hunter2")).toBe("error");
});
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) removeScratchDir(t);
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "kraken-secrets-"));
  temps.push(d);
  return d;
}

const ENTRY = "/home/dev/src/bc-dev-mcp/dist/index.js";
const map = CONTAINER_MAP(ENTRY);
const ALX = "/home/dev/.vscode/extensions/ms-dynamics-smb.al-current";

describe("rewrite", () => {
  test("a fixture config gets all four host-path fields replaced; credentials kept", () => {
    const { out, leftovers } = rewrite(
      {
        bcdev: {
          mcpCommand: ["node", "U:/Git/bc-dev-mcp/dist/index.js"],
          alcPath: "C:/Users/someone/.vscode/extensions/ms-dynamics-smb.al-1/bin/win32/alc.exe",
          altoolPath: "C:\\Users\\someone\\altool.exe",
          server: "http://cronus28",
          password: "synthetic",
        },
        alRunner: { alRunnerPath: "H:/al-runner-builds/c39ad5de/al-runner.exe" },
      },
      map,
    );
    expect(out).toEqual({
      bcdev: {
        mcpCommand: ["node", ENTRY],
        alcPath: `${ALX}/bin/linux/alc`,
        altoolPath: `${ALX}/bin/linux/altool`,
        server: "http://cronus28",
        password: "synthetic",
      },
      alRunner: { alRunnerPath: "/work/tools/al-runner/current/al-runner" },
    });
    expect(leftovers).toEqual([]);
  });

  test("an unknown field holding a host path is a leftover, named by its JSON path", () => {
    const { leftovers } = rewrite({ bcdev: { someDir: "H:/x" }, list: ["ok", "D:\\y"] }, map);
    expect(leftovers).toEqual(["$.bcdev.someDir", "$.list[1]"]);
  });

  test("a host path embedded in a longer string is a leftover; a URL and a UNC path are told apart", () => {
    const { leftovers } = rewrite(
      {
        a: "--file=H:\\x",
        b: "bun run x && cd C:/Users/y",
        c: "https://h:443/x",
        d: "\\\\server\\share",
      },
      map,
    );
    expect(leftovers).toEqual(["$.a", "$.b", "$.d"]);
  });

  test(".mcp.json: a sibling-repo arg is moved to /home/dev/src, bc-mcp to business-central-mcp", () => {
    const { out, leftovers } = rewrite(
      {
        mcpServers: {
          bc: { command: "node", args: ["U:/Git/bc-mcp/dist/index.js"] },
          dev: { command: "bun", args: ["U:\\Git\\bc-dev-mcp\\dist\\index.js"] },
        },
      },
      map,
    );
    expect(out).toEqual({
      mcpServers: {
        bc: { command: "node", args: ["/home/dev/src/business-central-mcp/dist/index.js"] },
        dev: { command: "bun", args: ["/home/dev/src/bc-dev-mcp/dist/index.js"] },
      },
    });
    expect(leftovers).toEqual([]);
  });

  test("a repo with no container clone, or a LethAL worktree, is not guessed at: it stays a leftover", () => {
    const { leftovers } = rewrite(
      {
        mcpServers: { x: { command: "node", args: ["U:/Git/other/x.js"] } },
        bcdev: { packageCachePath: "U:/Git/LethAL-wt/kraken-move/fixtures/a/.alpackages" },
        alRunner: { packagesDir: "U:\\Git\\LethAL-wt\\x" },
      },
      map,
    );
    expect(leftovers).toEqual([
      "$.mcpServers.x.args[0]",
      "$.bcdev.packageCachePath",
      "$.alRunner.packagesDir",
    ]);
  });

  test("the main checkout U:/Git/LethAL maps to /work/lethal, any slash style or case", () => {
    const { out, leftovers } = rewrite(
      {
        bcdev: { packageCachePath: "U:/Git/LethAL/fixtures/sandbox-app/.alpackages" },
        alRunner: { packagesDir: "U:\\Git\\LethAL\\fixtures\\sandbox-app\\.alpackages" },
        other: "u:/git/lethal/x",
      },
      map,
    );
    expect(out).toEqual({
      bcdev: { packageCachePath: "/work/lethal/fixtures/sandbox-app/.alpackages" },
      alRunner: { packagesDir: "/work/lethal/fixtures/sandbox-app/.alpackages" },
      other: "/work/lethal/x",
    });
    expect(leftovers).toEqual([]);
  });

  test("bcdev.controlSymbolPath is always the control app in the main checkout", () => {
    for (const host of ["U:/Git/LethAL-wt/x/lethal-control.app", "H:/elsewhere.app", "x"]) {
      const { out, leftovers } = rewrite({ bcdev: { controlSymbolPath: host } }, map);
      expect(out).toEqual({
        bcdev: { controlSymbolPath: "/work/lethal/extensions/lethal-control/lethal-control.app" },
      });
      expect(leftovers).toEqual([]);
    }
  });

  test.each(["run.cmd", "C:/tools/x.exe", "cmd", "powershell", "pwsh", "s.ps1"])(
    "a Windows launcher (%s) is refused",
    (command) => {
      expect(() => rewrite({ mcpServers: { x: { command, args: ["/c", "y"] } } }, map)).toThrow(
        UnsupportedLauncherError,
      );
    },
  );
});

/** A synthetic repo holding a valid config for every `secret_files` entry, plus two fixtures. */
function makeRepo(override: Record<string, string> = {}): { repo: string; pkg: string } {
  const repo = temp();
  for (const f of secretFiles()) {
    if (f.from.endsWith(".tar")) continue;
    const p = join(repo, f.to);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      override[f.from] ?? JSON.stringify({ bcdev: { server: "http://bc", password: "pw-ok" } }),
    );
  }
  for (const proj of ["fixtures/alpha", "examples/beta", "extensions/lethal-control"]) {
    mkdirSync(join(repo, proj, ".alpackages"), { recursive: true });
    writeFileSync(join(repo, proj, "app.json"), "{}");
    writeFileSync(join(repo, proj, ".alpackages", SYM), "symbols");
  }
  const pkg = join(repo, "bcdev-package.json");
  writeFileSync(pkg, JSON.stringify({ bin: { "bc-dev-mcp": "dist/index.js" } }));
  return { repo, pkg };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A tar of every `<root>/<project>/.alpackages` the synthetic repo has, as the owner's would be. */
function tarOf(repo: string): Uint8Array {
  const dirs = ["examples", "extensions", "fixtures"].flatMap((root) =>
    existsSync(join(repo, root))
      ? readdirSync(join(repo, root))
          .map((d) => `${root}/${d}/.alpackages`)
          .filter((d) => existsSync(join(repo, d)))
      : [],
  );
  const r = Bun.spawnSync(["tar", "-cf", "-", ...dirs], { cwd: repo });
  expect(r.exitCode).toBe(0);
  return r.stdout;
}

/**
 * Runs the CLI. With no `extra`, it passes `--symbol-tar` with a tar of the repo's `.alpackages`
 * and pins THAT tar through the test seam `KRAKEN_SECRETS_TEST_PIN`, since a synthetic tar cannot
 * have the real pin's sha256. With `extra`, exactly those arguments and the real pin.
 */
function cli(
  repo: string,
  pkg: string,
  out: string,
  extra?: string[],
): { code: number; text: string } {
  let args = extra ?? [];
  let env: Record<string, string | undefined> = { ...process.env };
  if (extra === undefined) {
    const bytes = tarOf(repo);
    const tar = join(temp(), "symbols.tar");
    writeFileSync(tar, bytes);
    args = ["--symbol-tar", tar];
    env = { ...env, KRAKEN_SECRETS_TEST_PIN: sha256(bytes) };
  }
  const r = Bun.spawnSync(
    ["bun", SCRIPT, "--repo", repo, "--out", out, "--bcdev-package", pkg, ...args],
    { env },
  );
  return { code: r.exitCode, text: r.stdout.toString() + r.stderr.toString() };
}

describe("CLI", () => {
  test("all inputs valid: every from-name is written, and the tar holds relative .alpackages entries", () => {
    const { repo, pkg } = makeRepo({
      "sandbox-app.local.json": JSON.stringify({
        alRunner: { alRunnerPath: "H:/a/al-runner.exe" },
      }),
    });
    const out = join(temp(), "secrets");
    const r = cli(repo, pkg, out);
    expect(r.text).not.toContain("pw-ok");
    expect(r.code).toBe(0);
    expect(readdirSync(out).sort()).toEqual(
      secretFiles()
        .map((f) => f.from)
        .sort(),
    );
    expect(JSON.parse(readFileSync(join(out, "sandbox-app.local.json"), "utf8"))).toEqual({
      alRunner: { alRunnerPath: "/work/tools/al-runner/current/al-runner" },
    });
    expect(readFileSync(join(out, "claude-settings.local.json"), "utf8")).toBe(
      readFileSync(join(repo, ".claude", "settings.local.json"), "utf8"),
    );
    const list = Bun.spawnSync(["tar", "-tf", "-"], {
      stdin: readFileSync(join(out, "fixture-symbols.tar")),
    });
    const entries = list.stdout
      .toString()
      .split(/\r?\n/) // R415: Windows' bsdtar ends each name with \r\n
      .filter((e) => e !== "");
    expect(entries).toContain(`fixtures/alpha/.alpackages/${SYM}`);
    expect(entries).toContain(`examples/beta/.alpackages/${SYM}`);
    expect(entries).toContain(`extensions/lethal-control/.alpackages/${SYM}`);
    for (const e of entries) {
      expect(e.startsWith("/") || /^[A-Za-z]:/.test(e) || e.split("/").includes("..")).toBe(false);
    }
  });

  test("a MALFORMED file with a password: refused, output never quotes it, nothing written", () => {
    // Bun's own message for this input is `Unexpected identifier "hunter2"`: it quotes the value
    const bad = '{"password": hunter2}';
    expect(() => JSON.parse(bad)).toThrow("hunter2");
    const { repo, pkg } = makeRepo({ "sandbox-data.local.json": bad });
    const out = join(temp(), "secrets");
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).not.toContain("hunter2");
    expect(r.text).toContain("sandbox-data.local.json: malformed JSON");
    expect(existsSync(out)).toBe(false);
  });

  test("one leftover in one file: refused with its JSON path, no value printed, nothing written", () => {
    const { repo, pkg } = makeRepo({
      "gift-card.local.json": JSON.stringify({
        bcdev: { password: "s3cret-H:/p", extra: "--file=H:\\x" },
      }),
    });
    const out = temp();
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("gift-card.local.json: leftover host path at $.bcdev.extra");
    expect(r.text).not.toContain("H:\\x");
    expect(r.text).not.toContain("s3cret");
    expect(readdirSync(out)).toEqual([]);
  });

  test("a Windows launcher in .mcp.json: refused by class name, nothing written", () => {
    const { repo, pkg } = makeRepo({
      "mcp.json": JSON.stringify({ mcpServers: { x: { command: "C:/t/run.cmd", args: [] } } }),
    });
    const out = temp();
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("mcp.json: UnsupportedLauncherError at $.mcpServers.x.command");
    expect(r.text).not.toContain("run.cmd");
    expect(readdirSync(out)).toEqual([]);
  });

  test("R670: KRAKEN_SECRETS_TEST_PIN with an --out outside the temp dir: refused by name, nothing written", () => {
    const { repo, pkg } = makeRepo();
    const out = resolve("/nonexistent-r670", "secrets"); // outside the temp dir, never created
    expect(underTempDir(out)).toBe(false);
    const r = cli(repo, pkg, out); // the default cli() sets the test pin
    expect(r.code).toBe(1);
    expect(r.text).toContain("KRAKEN_SECRETS_TEST_PIN is test-only: --out must be a temp dir");
    expect(existsSync(out)).toBe(false);
    expect(underTempDir(join(temp(), "not-yet", "secrets"))).toBe(true);
  });

  test("R670: no --symbol-tar: refused by name, never packed from the host folders, nothing written", () => {
    const { repo, pkg } = makeRepo();
    const out = temp();
    const r = cli(repo, pkg, out, []);
    expect(r.code).toBe(1);
    expect(r.text).toContain("fixture-symbols.tar: use --symbol-tar <pinned tar>");
    expect(readdirSync(out)).toEqual([]);
  });

  test("R670: a pinned tar that holds no file (or cannot be listed): refused, nothing written", () => {
    const { repo, pkg } = makeRepo();
    const out = temp();
    for (const bytes of [Buffer.alloc(1024), Buffer.from("not a tar at all")]) {
      const tar = join(temp(), "empty.tar");
      writeFileSync(tar, bytes);
      const r = Bun.spawnSync(
        ["bun", SCRIPT, "--repo", repo, "--out", out, "--bcdev-package", pkg, "--symbol-tar", tar],
        { env: { ...process.env, KRAKEN_SECRETS_TEST_PIN: sha256(bytes) } },
      );
      const text = r.stdout.toString() + r.stderr.toString();
      expect(r.exitCode).toBe(1);
      expect(text).toMatch(/fixture-symbols\.tar: (the tar holds no file|tar listing failed)/);
      expect(readdirSync(out)).toEqual([]);
    }
  });

  test("a missing input file: refused by name, nothing written", () => {
    const { repo, pkg } = makeRepo();
    rmSync(join(repo, ".mcp.json"));
    const out = temp();
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("mcp.json: missing");
    expect(readdirSync(out)).toEqual([]);
  });

  test("a symlink inside the pinned tar is refused", () => {
    const { repo, pkg } = makeRepo();
    try {
      symlinkSync(join(repo, ".mcp.json"), join(repo, "fixtures", "alpha", ".alpackages", "x.app"));
    } catch {
      return; // creating a symlink needs privileges on this Windows host; the unit test covers it
    }
    const out = temp();
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("fixture-symbols.tar: 1 entry(ies) not a regular file or directory");
    expect(readdirSync(out)).toEqual([]);
  });

  test("a successful run replaces the output folder whole: a stale file from before is gone", () => {
    const { repo, pkg } = makeRepo();
    const out = join(temp(), "secrets");
    mkdirSync(out);
    writeFileSync(join(out, "stale.local.json"), "old");
    expect(cli(repo, pkg, out).code).toBe(0);
    expect(existsSync(join(out, "stale.local.json"))).toBe(false);
    expect(readdirSync(dirname(out))).toEqual(["secrets"]);
  });
});

describe("writeOutputs", () => {
  test("a failure on file 3 leaves the previous folder exactly as it was, and no temp folder", () => {
    const parent = temp();
    const out = join(parent, "secrets");
    mkdirSync(out);
    writeFileSync(join(out, "a.json"), "previous-a");
    writeFileSync(join(out, "b.json"), "previous-b");
    let n = 0;
    const outputs = ["a.json", "b.json", "c.json", "d.json"].map((name) => ({
      name,
      bytes: "new",
    }));
    expect(() =>
      writeOutputs(out, outputs, {
        restrict: () => {},
        write: (p, b) => {
          n += 1;
          if (n === 3) throw new Error("injected");
          writeFileSync(p, b);
        },
      }),
    ).toThrow("injected");
    expect(readdirSync(parent)).toEqual(["secrets"]);
    expect(readdirSync(out).sort()).toEqual(["a.json", "b.json"]);
    expect(readFileSync(join(out, "a.json"), "utf8")).toBe("previous-a");
    expect(readFileSync(join(out, "b.json"), "utf8")).toBe("previous-b");
  });

  test("a failed owner-only restriction writes nothing and leaves no temp folder", () => {
    const parent = temp();
    const out = join(parent, "secrets");
    expect(() =>
      writeOutputs(out, [{ name: "a.json", bytes: "x" }], {
        write: writeFileSync,
        restrict: () => {
          throw new Error("icacls");
        },
      }),
    ).toThrow("icacls");
    expect(readdirSync(parent)).toEqual([]);
  });

  test("the owner-only command removes inheritance and grants the user alone", () => {
    expect(icaclsArgv("U:/k/secrets.tmp-1", "owner")).toEqual([
      "icacls",
      "U:/k/secrets.tmp-1",
      "/inheritance:r",
      "/grant:r",
      "owner:(OI)(CI)F",
    ]);
  });
});

describe("hasWindowsPath", () => {
  test.each([
    "/c/Users/x",
    "--file=/u/Git/x",
    'run "/h/al"',
    "//server/share/x",
    "file://server/share",
    "C:",
    "cd C: && x",
    "1C:/x",
    "H:\\x",
    "\\\\srv\\s",
    "/usr/bin:/c/tools/bin",
    "//server",
    "C:x",
    "run C:al.exe",
  ])("%s is a leftover", (s) => {
    expect(hasWindowsPath(s)).toBe(true);
  });

  test.each([
    "http://cronus28/BC",
    "https://h:443/x",
    "/home/dev/src/x",
    "/opt/al-runner/c39ad5de/al-runner",
    "file:///home/dev/x",
    "12:30",
    "CRONUS Danmark A/S",
    "http://bc:8080/a/b",
    "/usr/bin:/opt/x/bin",
  ])("%s is not", (s) => {
    expect(hasWindowsPath(s)).toBe(false);
  });
});

describe("tar listing check", () => {
  test("only the symlink line is reported; relative regular entries pass", () => {
    const names = [
      "fixtures/a/.alpackages/",
      "fixtures/a/.alpackages/x.app",
      "fixtures/a/.alpackages/l.app",
      "",
    ];
    const long = [
      "drwxr-xr-x dev/dev 0 2026-10-03 10:00 fixtures/a/.alpackages/",
      "-rw-r--r-- dev/dev 7 2026-10-03 10:00 fixtures/a/.alpackages/x.app",
      "lrwxrwxrwx dev/dev 0 2026-10-03 10:00 fixtures/a/.alpackages/l.app -> /etc/passwd",
      "",
    ];
    expect(listingProblems(names, long)).toEqual(["1 entry(ies) not a regular file or directory"]);
    expect(
      listingProblems(
        names,
        long.filter((l) => !l.startsWith("l")),
      ),
    ).toEqual([]);
  });

  test("an absolute or .. entry name is reported", () => {
    expect(listingProblems(["/etc/x", "a/../../b", "C:/x", "ok/x"], [])).toEqual([
      "unsafe entry /etc/x",
      "unsafe entry a/../../b",
      "unsafe entry C:/x",
    ]);
  });
});

describe("sweepSwapFolders", () => {
  test("removes <out>.old-* and <out>.tmp-* siblings (credential copies after a crash), nothing else", () => {
    const parent = temp();
    const out = join(parent, "lethal");
    for (const d of [
      "lethal",
      "lethal.old-0a1b",
      "lethal.tmp-ff00",
      "lethal.old-notes",
      "other.tmp-0a1b",
    ]) {
      mkdirSync(join(parent, d));
    }
    writeFileSync(join(parent, "lethal.old-0a1b", "sandbox-app.local.json"), "copy");
    expect(sweepSwapFolders(out).sort()).toEqual(["lethal.old-0a1b", "lethal.tmp-ff00"]);
    expect(readdirSync(parent).sort()).toEqual(["lethal", "lethal.old-notes", "other.tmp-0a1b"]);
  });

  test("with <out> present the CLI sweeps leftovers first, even on a refused run", () => {
    const { repo, pkg } = makeRepo({ "mcp.json": "{" });
    const parent = temp();
    const out = join(parent, "secrets");
    mkdirSync(out);
    writeFileSync(join(out, "a.json"), "previous");
    mkdirSync(join(parent, "secrets.old-abc123"));
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("removed leftover secrets.old-abc123");
    expect(readdirSync(parent)).toEqual(["secrets"]);
    expect(readFileSync(join(out, "a.json"), "utf8")).toBe("previous");
  });

  test("an interrupted swap (no <out>, one .old-*) then an INVALID run: the previous output survives", () => {
    const { repo, pkg } = makeRepo({ "mcp.json": "{" });
    const parent = temp();
    const out = join(parent, "secrets");
    // the state a process death leaves between "move <out> aside" and "publish the new folder"
    mkdirSync(join(parent, "secrets.old-abc123"));
    writeFileSync(join(parent, "secrets.old-abc123", "a.json"), "previous");
    mkdirSync(join(parent, "secrets.tmp-abc123"));
    writeFileSync(join(parent, "secrets.tmp-abc123", "a.json"), "half-written");
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("restored secrets.old-abc123");
    expect(r.text).toContain("removed leftover secrets.tmp-abc123");
    expect(readdirSync(parent)).toEqual(["secrets"]);
    expect(readFileSync(join(out, "a.json"), "utf8")).toBe("previous");
  });

  test("no <out> and two .old-* candidates: refused, nothing touched", () => {
    const parent = temp();
    const out = join(parent, "secrets");
    mkdirSync(join(parent, "secrets.old-aa"));
    mkdirSync(join(parent, "secrets.old-bb"));
    expect(() => recoverInterruptedSwap(out)).toThrow(SwapRecoveryError);
    expect(readdirSync(parent).sort()).toEqual(["secrets.old-aa", "secrets.old-bb"]);
    expect(recoverInterruptedSwap(join(temp(), "fresh"))).toBeUndefined();
  });

  test("an old folder that will not delete after a good swap is returned (warned), new outputs in place", () => {
    const parent = temp();
    const out = join(parent, "secrets");
    mkdirSync(out);
    writeFileSync(join(out, "a.json"), "old");
    const stuck = writeOutputs(out, [{ name: "a.json", bytes: "new" }], {
      write: writeFileSync,
      restrict: () => {},
      remove: () => {
        throw new Error("busy");
      },
    });
    expect(stuck).toMatch(/secrets\.old-[0-9a-f]+$/);
    expect(readFileSync(join(out, "a.json"), "utf8")).toBe("new");
    expect(sweepSwapFolders(out)).toHaveLength(1);
    expect(readdirSync(parent)).toEqual(["secrets"]);
  });
});

describe("secret_files entries", () => {
  test.each([
    [{ from: "a.json", to: "fixtures/a/x.json" }, true],
    [{ from: "a/b.json", to: "x.json" }, false],
    [{ from: "a\\b.json", to: "x.json" }, false],
    [{ from: "..", to: "x.json" }, false],
    [{ from: ".", to: "x.json" }, false],
    [{ from: "a.json", to: "../x.json" }, false],
    [{ from: "a.json", to: "fixtures/../../x.json" }, false],
    [{ from: "a.json", to: "/etc/x.json" }, false],
    [{ from: "a.json", to: "C:/x.json" }, false],
  ])("%j -> %p", (e, ok) => {
    expect(isSecretEntry(e)).toBe(ok);
  });
});

// R670: the symbol tar is refused where it is made when a LethAL copy disagrees with app.json.
describe("R670: drift guard on fixture-symbols.tar", () => {
  /** `fixtures/gamma` (G 1.0.0.2) and `fixtures/gamma-tests`, which depends on G, holding `copy`. */
  function addGamma(repo: string, copy: string): void {
    mkdirSync(join(repo, "fixtures", "gamma", ".alpackages"), { recursive: true });
    writeFileSync(
      join(repo, "fixtures", "gamma", "app.json"),
      JSON.stringify({ name: "G", version: "1.0.0.2" }),
    );
    writeFileSync(join(repo, "fixtures", "gamma", ".alpackages", SYM), "symbols");
    mkdirSync(join(repo, "fixtures", "gamma-tests", ".alpackages"), { recursive: true });
    writeFileSync(
      join(repo, "fixtures", "gamma-tests", "app.json"),
      JSON.stringify({
        name: "GT",
        version: "1.0.0.1",
        dependencies: [{ name: "G", publisher: "LethAL" }],
      }),
    );
    writeFileSync(join(repo, "fixtures", "gamma-tests", ".alpackages", copy), "app");
  }
  test("tarDrift on a synthetic listing: directories skipped, a stale copy named with both versions", () => {
    const repo = temp();
    addGamma(repo, "LethAL_G_1.0.0.2.app");
    const apps = repoApps(repo);
    const names = ["fixtures/gamma/.alpackages/", `fixtures/gamma/.alpackages/${SYM}`, ""];
    expect(
      tarDrift([...names, "fixtures/gamma-tests/.alpackages/LethAL_G_1.0.0.2.app"], apps),
    ).toEqual([]);
    expect(
      tarDrift([...names, "fixtures/gamma-tests/.alpackages/LethAL_G_1.0.0.1.app"], apps),
    ).toEqual([
      "fixture-symbols.tar: drift: fixtures/gamma-tests/.alpackages/LethAL_G_1.0.0.1.app: the tar holds G 1.0.0.1, but fixtures/gamma/app.json is 1.0.0.2; rebuild the tar (R670)",
    ]);
  });

  test("a pinned tar with a stale copy: refused by name, nothing written", () => {
    const { repo, pkg } = makeRepo();
    addGamma(repo, "LethAL_G_1.0.0.1.app");
    const out = temp();
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("drift: fixtures/gamma-tests/.alpackages/LethAL_G_1.0.0.1.app");
    expect(readdirSync(out)).toEqual([]);
  });

  test("--symbol-tar with another sha256 than the pin: refused, nothing written", () => {
    const { repo, pkg } = makeRepo();
    const given = join(temp(), "given.tar");
    writeFileSync(given, "not the pinned tar");
    const out = temp();
    const r = cli(repo, pkg, out, ["--symbol-tar", given]);
    expect(r.code).toBe(1);
    expect(r.text).toContain("--symbol-tar has sha256");
    expect(readdirSync(out)).toEqual([]);
  });

  test("pinnedSymbolTar: the pinned bytes ship verbatim; pinned but drifting is still refused", () => {
    const { repo } = makeRepo();
    addGamma(repo, "LethAL_G_1.0.0.2.app");
    const good = tarOf(repo);
    const goodPath = join(temp(), "good.tar");
    writeFileSync(goodPath, good);
    const errors: string[] = [];
    expect(pinnedSymbolTar(goodPath, repo, errors, sha256(good))).toEqual(Buffer.from(good));
    expect(errors).toEqual([]);

    writeFileSync(
      join(repo, "fixtures", "gamma", "app.json"),
      JSON.stringify({ name: "G", version: "1.0.0.3" }),
    );
    expect(pinnedSymbolTar(goodPath, repo, errors, sha256(good))).toBeUndefined();
    expect(errors.join("\n")).toContain("but fixtures/gamma/app.json is 1.0.0.3");
  });
});
