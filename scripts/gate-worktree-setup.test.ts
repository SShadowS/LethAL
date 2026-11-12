import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_SYMBOLS_TAR_SHA256 } from "../packages/runner/itest/fixture-symbols.ts";
import { GATE_FIXTURES, configFileName, launchFileName } from "./bc-linux-setup.ts";
import {
  GateSetupError,
  NEEDS_SYMBOLS,
  type SetupDeps,
  copyAlpackages,
  needsSymbols,
  parserProblemViaSubprocess,
  preflight,
  setup,
} from "./gate-worktree-setup.ts";

let root = "";
let from = "";

const put = (base: string, rel: string, text = "x") => {
  mkdirSync(join(base, rel, ".."), { recursive: true });
  writeFileSync(join(base, rel), text);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gws-root-"));
  from = mkdtempSync(join(tmpdir(), "gws-from-"));
  mkdirSync(join(root, "fixtures"), { recursive: true });
  for (const d of needsSymbols("bc1")) put(from, `${d}/.alpackages/Microsoft_Base.app`);
  put(from, ".fixture-symbols.sha256", `${FIXTURE_SYMBOLS_TAR_SHA256}\n`);
});

/** A fake run that writes the configs the real setup script would, and counts its calls. */
function fakeDeps(over: Partial<SetupDeps> = {}, writeConfigs = true) {
  const calls: string[] = [];
  let built = false;
  const deps: SetupDeps = {
    run: (cmd) => {
      calls.push(cmd.join(" "));
      if (cmd[1] === "scripts/bc-linux-setup.ts" && writeConfigs)
        for (const f of GATE_FIXTURES) {
          put(root, `fixtures/${f.configDir}/${configFileName("bc1")}`);
          put(root, `fixtures/${f.configDir}/.vscode/${launchFileName("bc1")}`);
        }
      if (cmd[1] === "scripts/build-native-parser.ts") built = true;
      return 0;
    },
    parserProblem: () => (built ? undefined : "stale"),
    ...over,
  };
  return { deps, calls };
}

describe("copyAlpackages", () => {
  test("copies the .app files and the marker, and a second run copies nothing", () => {
    expect(copyAlpackages(root, from)).toBe(needsSymbols("bc1").length);
    expect(copyAlpackages(root, from)).toBe(0);
  });
  test("a symlinked target .alpackages is refused before anything is copied", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "gws-else-"));
    mkdirSync(join(root, "fixtures/sandbox-data-tests"), { recursive: true });
    symlinkSync(elsewhere, join(root, "fixtures/sandbox-data-tests/.alpackages"));
    expect(() => copyAlpackages(root, from)).toThrow(/symlink/);
    expect(existsSync(join(root, "fixtures/sandbox-tests/.alpackages"))).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
  test("a target that already holds an extra app is refused and left byte-identical", () => {
    const dir = join(root, "fixtures/sandbox-tests/.alpackages");
    put(root, "fixtures/sandbox-tests/.alpackages/Extra.app", "mine");
    expect(() => copyAlpackages(root, from)).toThrow(/Extra\.app/);
    expect(readdirSync(dir)).toEqual(["Extra.app"]);
    expect(readFileSync(join(dir, "Extra.app"), "utf8")).toBe("mine");
    expect(existsSync(join(root, ".fixture-symbols.sha256"))).toBe(false);
    expect(existsSync(join(root, "fixtures/sandbox-data-tests/.alpackages"))).toBe(false);
  });
  test("a same-name app with other bytes is not overwritten", () => {
    put(root, "fixtures/sandbox-tests/.alpackages/Microsoft_Base.app", "different");
    expect(() => copyAlpackages(root, from)).toThrow(/differs/);
    expect(
      readFileSync(join(root, "fixtures/sandbox-tests/.alpackages/Microsoft_Base.app"), "utf8"),
    ).toBe("different");
  });
  test("a different marker is refused by name", () => {
    put(root, ".fixture-symbols.sha256", "other\n");
    expect(() => copyAlpackages(root, from)).toThrow(/differs/);
  });
  test("the worktree as its own source is refused", () => {
    expect(() => copyAlpackages(root, root)).toThrow(GateSetupError);
  });
});

describe("setup", () => {
  test("server mode: configs first, then parser build, then a clean pre-flight; no other command", () => {
    const { deps, calls } = fakeDeps();
    setup({ root, server: "bc1", alpackagesFrom: from }, deps);
    expect(calls).toEqual([
      "bun scripts/bc-linux-setup.ts --server bc1 --write-config-only",
      "bun scripts/build-native-parser.ts",
    ]);
  });
  test("v3-only mode writes no config, needs none, and builds nothing when the parser is fresh", () => {
    const { deps, calls } = fakeDeps({ parserProblem: () => undefined });
    setup({ root, server: undefined, alpackagesFrom: from }, deps);
    expect(calls).toEqual([]);
  });
  test("a config script that wrote nothing is caught by the pre-flight, naming the first path", () => {
    const { deps } = fakeDeps({}, false);
    expect(() => setup({ root, server: "bc1", alpackagesFrom: from }, deps)).toThrow(
      /pre-flight: missing fixtures\/sandbox-app\/lethal\.config\.bc1\.json/,
    );
  });
  test("a failing config script stops before anything is copied", () => {
    const { deps } = fakeDeps({ run: () => 1 });
    expect(() => setup({ root, server: "bc1", alpackagesFrom: from }, deps)).toThrow(/failed/);
    expect(preflight({ root, server: undefined, alpackagesFrom: from }, deps)).toContain(
      "holds no .app symbols",
    );
  });
});

describe("preflight", () => {
  const ok = fakeDeps({ parserProblem: () => undefined }).deps;
  const opts = () => ({ root, server: undefined, alpackagesFrom: from });
  test("passes on a complete v3 layout", () => {
    copyAlpackages(root, from);
    expect(preflight(opts(), ok)).toBeUndefined();
  });
  test("an empty .alpackages of a tests project that needs symbols is named", () => {
    const bare = mkdtempSync(join(tmpdir(), "gws-bare-"));
    expect(preflight({ root: bare, server: undefined, alpackagesFrom: from }, ok)).toBe(
      `${NEEDS_SYMBOLS[0]}/.alpackages holds no .app symbols (copy them with --alpackages-from)`,
    );
  });
  test("a stale parser is named", () => {
    copyAlpackages(root, from);
    const stale = fakeDeps({ parserProblem: () => "stale build" }).deps;
    expect(preflight(opts(), stale)).toBe("native parser: stale build");
  });
  test("a marker that is not the current pin is the FIRST problem", () => {
    put(root, ".fixture-symbols.sha256", "oldpin\n");
    const first = preflight(opts(), ok);
    expect(first).toContain("names oldpin");
    expect(first).toContain(FIXTURE_SYMBOLS_TAR_SHA256);
  });
  test("sandbox-harden-tests symbols are required in server mode only", () => {
    const r = mkdtempSync(join(tmpdir(), "gws-v3-"));
    for (const d of NEEDS_SYMBOLS) put(r, `${d}/.alpackages/Microsoft_Base.app`);
    expect(preflight({ root: r, server: undefined, alpackagesFrom: from }, ok)).toBeUndefined();
    for (const f of GATE_FIXTURES) {
      put(r, `fixtures/${f.configDir}/${configFileName("bc1")}`);
      put(r, `fixtures/${f.configDir}/.vscode/${launchFileName("bc1")}`);
    }
    expect(preflight({ root: r, server: "bc1", alpackagesFrom: from }, ok)).toContain(
      "sandbox-harden-tests/.alpackages holds no .app symbols",
    );
  });
});

describe("parserProblemViaSubprocess", () => {
  test("asks a fresh process each time: exit 0 is fresh, a failure carries its stderr", () => {
    const seen: string[][] = [];
    const answers = [
      { status: 1, stderr: "stale\n" },
      { status: 0, stderr: "" },
    ];
    const spawn = (_c: string, args: string[]) => {
      seen.push(args);
      return answers.shift() ?? { status: 0 };
    };
    expect(parserProblemViaSubprocess(spawn)).toBe("stale");
    // after a rebuild the same check, in a new process, reads the new addon
    expect(parserProblemViaSubprocess(spawn)).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(seen.every((a) => a.includes("--check-parser"))).toBe(true);
  });
});
