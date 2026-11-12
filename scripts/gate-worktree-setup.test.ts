import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATE_FIXTURES, configFileName, launchFileName } from "./bc-linux-setup.ts";
import {
  GateSetupError,
  NEEDS_SYMBOLS,
  type SetupDeps,
  copyAlpackages,
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
  for (const d of NEEDS_SYMBOLS) put(from, `${d}/.alpackages/Microsoft_Base.app`);
  put(from, ".fixture-symbols.sha256", "abc\n");
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
    expect(copyAlpackages(root, from)).toBe(NEEDS_SYMBOLS.length);
    expect(copyAlpackages(root, from)).toBe(0);
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
});
