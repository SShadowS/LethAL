import { afterEach, describe, expect, test } from "bun:test";
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
import { dirname, join } from "node:path";
import {
  CONTAINER_MAP,
  UnsupportedLauncherError,
  describeError,
  hasSymbols,
  hasWindowsPath,
  icaclsArgv,
  isSecretEntry,
  listingProblems,
  nonRegularEntries,
  rewrite,
  secretFiles,
  sweepSwapFolders,
  writeOutputs,
} from "./kraken-secrets.ts";

const SCRIPT = join(import.meta.dir, "kraken-secrets.ts");

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
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "kraken-secrets-"));
  temps.push(d);
  return d;
}

const ENTRY = "/home/dev/src/bc-dev-mcp/dist/index.js";
const map = CONTAINER_MAP(ENTRY);
const ALX = "/home/dev/.vscode/extensions/ms-dynamics-smb.al-18.0.2732683";

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
      alRunner: { alRunnerPath: "/opt/al-runner/c39ad5de/al-runner" },
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
    writeFileSync(join(repo, proj, ".alpackages", "sym.app"), "symbols");
  }
  const pkg = join(repo, "bcdev-package.json");
  writeFileSync(pkg, JSON.stringify({ bin: { "bc-dev-mcp": "dist/index.js" } }));
  return { repo, pkg };
}

function cli(repo: string, pkg: string, out: string): { code: number; text: string } {
  const r = Bun.spawnSync(["bun", SCRIPT, "--repo", repo, "--out", out, "--bcdev-package", pkg]);
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
      alRunner: { alRunnerPath: "/opt/al-runner/c39ad5de/al-runner" },
    });
    expect(readFileSync(join(out, "claude-settings.local.json"), "utf8")).toBe(
      readFileSync(join(repo, ".claude", "settings.local.json"), "utf8"),
    );
    const list = Bun.spawnSync(["tar", "-tf", "-"], {
      stdin: readFileSync(join(out, "fixture-symbols.tar")),
    });
    const entries = list.stdout
      .toString()
      .split("\n")
      .filter((e) => e !== "");
    expect(entries).toContain("fixtures/alpha/.alpackages/sym.app");
    expect(entries).toContain("examples/beta/.alpackages/sym.app");
    expect(entries).toContain("extensions/lethal-control/.alpackages/sym.app");
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

  test("the control app without symbols: refused by name, nothing written", () => {
    const { repo, pkg } = makeRepo();
    rmSync(join(repo, "extensions", "lethal-control", ".alpackages", "sym.app"));
    const out = temp();
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("no .alpackages: extensions/lethal-control");
    expect(readdirSync(out)).toEqual([]);
  });

  test("a fixture project without .alpackages: refused by name, nothing written", () => {
    const { repo, pkg } = makeRepo();
    mkdirSync(join(repo, "fixtures", "gamma"));
    writeFileSync(join(repo, "fixtures", "gamma", "app.json"), "{}");
    const out = temp();
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("no .alpackages: fixtures/gamma");
    expect(readdirSync(out)).toEqual([]);
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

  test("an empty .alpackages, or a FILE named .alpackages, counts as no symbols", () => {
    const { repo, pkg } = makeRepo();
    mkdirSync(join(repo, "fixtures", "empty", ".alpackages"), { recursive: true });
    writeFileSync(join(repo, "fixtures", "empty", "app.json"), "{}");
    mkdirSync(join(repo, "fixtures", "filed"));
    writeFileSync(join(repo, "fixtures", "filed", "app.json"), "{}");
    writeFileSync(join(repo, "fixtures", "filed", ".alpackages"), "not a folder");
    const out = temp();
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("no .alpackages: fixtures/empty, fixtures/filed");
    expect(readdirSync(out)).toEqual([]);
    expect(hasSymbols(join(repo, "fixtures", "alpha", ".alpackages"))).toBe(true);
  });

  test("a symlink inside a fixture's .alpackages is refused by path", () => {
    const { repo, pkg } = makeRepo();
    try {
      symlinkSync(join(repo, ".mcp.json"), join(repo, "fixtures", "alpha", ".alpackages", "x.app"));
    } catch {
      return; // creating a symlink needs privileges on this Windows host; the unit test covers it
    }
    const out = temp();
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("not a regular file or directory: fixtures/alpha/.alpackages/x.app");
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

describe("symbol folder checks", () => {
  const fake = (kinds: Record<string, "file" | "dir" | "link">) => (p: string) => {
    const k = kinds[p.replaceAll("\\", "/").split("/").pop() ?? ""] ?? "file";
    return { isFile: () => k === "file", isDirectory: () => k === "dir" };
  };

  test("nonRegularEntries names a symlink or junction, and walks into real directories", () => {
    const root = temp();
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.app"), "");
    writeFileSync(join(root, "sub", "j.app"), "");
    expect(nonRegularEntries(root)).toEqual([]);
    expect(nonRegularEntries(root, fake({ sub: "dir", "j.app": "link" }))).toEqual(["sub/j.app"]);
  });

  test("hasSymbols needs a directory with at least one .app", () => {
    const root = temp();
    expect(hasSymbols(join(root, "none"))).toBe(false);
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d", "readme.txt"), "");
    expect(hasSymbols(join(root, "d"))).toBe(false);
    writeFileSync(join(root, "d", "x.APP"), "");
    expect(hasSymbols(join(root, "d"))).toBe(true);
    expect(hasSymbols(join(root, "d"), fake({ d: "link" }))).toBe(false);
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

  test("the CLI sweeps before anything else, even on a refused run", () => {
    const { repo, pkg } = makeRepo({ "mcp.json": "{" });
    const parent = temp();
    const out = join(parent, "secrets");
    mkdirSync(join(parent, "secrets.old-abc123"));
    const r = cli(repo, pkg, out);
    expect(r.code).toBe(1);
    expect(r.text).toContain("removed leftover secrets.old-abc123");
    expect(readdirSync(parent)).toEqual([]);
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
