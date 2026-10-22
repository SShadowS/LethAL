import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printItestTarget } from "./config-path";
import {
  OutOfUseRootError,
  ServerOutOfUseError,
  markedServerFor,
  outOfUseDir,
  outOfUseRefusal,
} from "./out-of-use";

// R669. Every test plants its markers in its own temp dir: none reads the real /coord.
const MARKER =
  "# bc2 is OUT OF USE\n\n- **Reason:** SYNTH-REASON stranded op\n\n## How to clear it\n1. SYNTH-CLEAR restart\n";
/** The shape `openssl rand -hex 16` prints. */
const TOKEN = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const OTHER = "fedcba9876543210fedcba9876543210";

/** `<tmp>/machine/out-of-use`, holding `files`: the layout of a real coord root. */
function dirWith(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "out-of-use-")), "machine", "out-of-use");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

/** A marker dir whose `<root>/machine` does not exist: a wrong coord root. */
function wrongRoot(): string {
  return join(mkdtempSync(join(tmpdir(), "out-of-use-root-")), "x", "machine", "out-of-use");
}

function refusal(
  files: Record<string, string>,
  env: Record<string, string>,
  override: "clearing" | "owner",
) {
  const logged: string[] = [];
  const r = outOfUseRefusal("bc2", {
    dir: dirWith(files),
    env,
    override,
    log: (l) => logged.push(l),
  });
  return { r, logged: logged.join("\n") };
}

describe("outOfUseRefusal", () => {
  test("no marker: no refusal, nothing logged", () => {
    expect(refusal({ "bc3.md": MARKER }, {}, "owner")).toEqual({ r: undefined, logged: "" });
  });

  test("a marker: refused by name, with its reason and how to clear it", () => {
    const { r } = refusal({ "bc2.md": MARKER }, {}, "owner");
    expect(r).toContain("bc2 is OUT OF USE:");
    expect(r).toContain("bc2.md exists, so this run refuses before any lease or server call");
    expect(r).toContain("SYNTH-REASON stranded op");
    expect(r).toContain("SYNTH-CLEAR restart");
  });

  test("a missing <root>/machine throws by name; a missing out-of-use dir under it is no marker", () => {
    const root = mkdtempSync(join(tmpdir(), "out-of-use-root-"));
    const wrong = join(root, "not-coord", "machine", "out-of-use");
    expect(() => outOfUseRefusal("bc2", { dir: wrong, env: {}, override: "clearing" })).toThrow(
      OutOfUseRootError,
    );
    expect(() => outOfUseRefusal("bc2", { dir: wrong, env: {}, override: "owner" })).toThrow(
      `${join(root, "not-coord", "machine")} does not exist`,
    );
    mkdirSync(join(root, "coord", "machine"), { recursive: true });
    const empty = join(root, "coord", "machine", "out-of-use");
    expect(outOfUseRefusal("bc2", { dir: empty, env: {}, override: "owner" })).toBeUndefined();
  });

  test("clearing: the exact server passes, with the loud line naming the marker's reason", () => {
    const { r, logged } = refusal(
      { "bc2.md": MARKER },
      { LETHAL_OUT_OF_USE_CLEARING: "bc2" },
      "clearing",
    );
    expect(r).toBeUndefined();
    expect(logged).toContain("!!! bc2 has an out-of-use marker");
    expect(logged).toContain("overrides it for the clearing step");
    expect(logged).toContain("SYNTH-REASON stranded op");
  });

  test("clearing: a wrong, empty or bogus value refuses", () => {
    for (const v of ["bc3", "", "1", " bc2", "BC2", "all"]) {
      const { r, logged } = refusal(
        { "bc2.md": MARKER },
        { LETHAL_OUT_OF_USE_CLEARING: v },
        "clearing",
      );
      expect(r).toContain("bc2 is OUT OF USE");
      expect(logged).toBe("");
    }
  });

  test("owner: a marker with `owner: <token>` and the same token passes, loudly", () => {
    const { r, logged } = refusal(
      { "bc2.md": `${MARKER}owner: ${TOKEN}\n` },
      { LETHAL_OUT_OF_USE_OWNER: TOKEN },
      "owner",
    );
    expect(r).toBeUndefined();
    expect(logged).toContain("!!! bc2 has an out-of-use marker");
    expect(logged).toContain("owned by this run");
  });

  test("owner: a constant or non-hex-128 token refuses, even when the marker carries it", () => {
    for (const t of [
      "r658-hang-bc3",
      "r658-hang-abcdef12",
      TOKEN.toUpperCase(),
      TOKEN.slice(1),
      `${TOKEN}0`,
      `${TOKEN.slice(1)}g`,
    ]) {
      const { r, logged } = refusal(
        { "bc2.md": `${MARKER}owner: ${t}\n` },
        { LETHAL_OUT_OF_USE_OWNER: t },
        "owner",
      );
      expect({ t, refused: r?.includes("bc2 is OUT OF USE") }).toEqual({ t, refused: true });
      expect(logged).toBe("");
    }
  });

  test("owner: a missing owner line, another token, or the clearing var refuses", () => {
    const cases: [Record<string, string>, Record<string, string>][] = [
      [{ "bc2.md": MARKER }, { LETHAL_OUT_OF_USE_OWNER: TOKEN }],
      [{ "bc2.md": `${MARKER}owner: ${TOKEN}\n` }, { LETHAL_OUT_OF_USE_OWNER: OTHER }],
      [{ "bc2.md": `${MARKER}owner: \n` }, { LETHAL_OUT_OF_USE_OWNER: "" }],
      [{ "bc2.md": `${MARKER}owner: ${TOKEN}\n` }, { LETHAL_OUT_OF_USE_CLEARING: "bc2" }],
    ];
    for (const [files, env] of cases) {
      const { r, logged } = refusal(files, env, "owner");
      expect(r).toContain("bc2 is OUT OF USE");
      expect(logged).toBe("");
    }
  });

  test("owner: two or more owner lines refuse, even when one matches", () => {
    for (const extra of [`owner: ${TOKEN}\n`, `owner: ${OTHER}\n`, "owner:\n"]) {
      const { r, logged } = refusal(
        { "bc2.md": `${MARKER}owner: ${TOKEN}\n${extra}` },
        { LETHAL_OUT_OF_USE_OWNER: TOKEN },
        "owner",
      );
      expect(r).toContain("bc2 is OUT OF USE");
      expect(logged).toBe("");
    }
  });

  test("owner: a malformed owner line refuses, even when the env value equals its text", () => {
    const cases: [string, string][] = [
      ["owner:", TOKEN], // nothing after it
      ["owner: ", ""],
      ["owner: abc", "abc"], // too short
      ["owner: bad/token!", "bad/token!"], // outside the token shape
      [`owner: ${TOKEN} extra`, TOKEN],
      [`Owner: ${TOKEN}`, TOKEN],
    ];
    for (const [line, v] of cases) {
      const { r, logged } = refusal(
        { "bc2.md": `${MARKER}${line}\n` },
        { LETHAL_OUT_OF_USE_OWNER: v },
        "owner",
      );
      expect({ line, refused: r?.includes("bc2 is OUT OF USE") }).toEqual({ line, refused: true });
      expect(logged).toBe("");
    }
  });

  test("owner: a marker in use with `owner: T`, STOP-rewritten with no owner line, refuses T", () => {
    const inUse = `# bc2 is OUT OF USE\n\n- **Reason:** in use by an R-658 itest:hang run\nowner: ${TOKEN}\n`;
    expect(
      refusal({ "bc2.md": inUse }, { LETHAL_OUT_OF_USE_OWNER: TOKEN }, "owner").r,
    ).toBeUndefined();
    const stop =
      "# bc2 is OUT OF USE\n\n- **Reason:** STOP or hold: leg marker stop, gate exit 5. Do not trust a clean read.\n";
    const { r, logged } = refusal({ "bc2.md": stop }, { LETHAL_OUT_OF_USE_OWNER: TOKEN }, "owner");
    expect(r).toContain("bc2 is OUT OF USE");
    expect(r).toContain("STOP or hold: leg marker stop");
    expect(logged).toBe("");
  });
});

describe("markedServerFor: the dev port names the server, on the BC on Linux host only", () => {
  test("7049, 7149 and 7249 are bc1, bc2 and bc3", () => {
    expect(markedServerFor("192.168.2.157", 7049)).toBe("bc1");
    expect(markedServerFor("192.168.2.157", 7149)).toBe("bc2");
    expect(markedServerFor("192.168.2.157", 7249)).toBe("bc3");
  });

  test("an unknown port, or another host on a bc port, has no marker check", () => {
    expect(markedServerFor("192.168.2.157", 7349)).toBeUndefined(); // the talk's demo port
    expect(markedServerFor("cronus28", 7049)).toBeUndefined();
    expect(markedServerFor("10.0.0.1", 7249)).toBeUndefined();
  });
});

describe("outOfUseDir", () => {
  test("LETHAL_COORD_ROOT, else kraken's CG_COORD_ROOT, else the default root", () => {
    expect(outOfUseDir({ LETHAL_COORD_ROOT: "/r" })).toBe(join("/r", "machine", "out-of-use"));
    expect(outOfUseDir({ KRAKEN_PROJECT: "lethal", CG_COORD_ROOT: "/k" })).toBe(
      join("/k", "machine", "out-of-use"),
    );
    expect(
      outOfUseDir({ KRAKEN_PROJECT: "lethal", CG_COORD_ROOT: "/k", LETHAL_COORD_ROOT: "/k" }),
    ).toBe(join("/k", "machine", "out-of-use"));
    expect(outOfUseDir({ CG_COORD_ROOT: "/k" })).toBe(
      join(process.platform === "win32" ? "H:\\lethal-coord" : "/coord", "machine", "out-of-use"),
    );
  });

  test("inside kraken, a LETHAL_COORD_ROOT that differs from CG_COORD_ROOT throws, naming both", () => {
    expect(() =>
      outOfUseDir({ KRAKEN_PROJECT: "lethal", CG_COORD_ROOT: "/k", LETHAL_COORD_ROOT: "/r" }),
    ).toThrow("LETHAL_COORD_ROOT=/r differs from CG_COORD_ROOT=/k");
    expect(() => outOfUseDir({ KRAKEN_PROJECT: "lethal", LETHAL_COORD_ROOT: "/r" })).toThrow(
      OutOfUseRootError,
    );
  });
});

describe("printItestTarget refuses a marked server BEFORE it prints its target line", () => {
  function print(bcdev: object, dir: string, env: Record<string, string> = {}) {
    const cfg = join(mkdtempSync(join(tmpdir(), "out-of-use-cfg-")), "lethal.config.bc2.json");
    writeFileSync(cfg, JSON.stringify({ bcdev: { serverInstance: "BC", ...bcdev } }));
    const lines: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => lines.push(a.join(" "));
    console.error = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      printItestTarget(cfg, undefined, { dir, env });
      return { thrown: undefined as unknown, lines };
    } catch (e) {
      return { thrown: e, lines };
    } finally {
      console.log = log;
      console.error = err;
    }
  }
  const BC2 = { server: "http://192.168.2.157:7149", port: 7149 };
  const targetLines = (lines: string[]) => lines.filter((l) => l.includes("[itest target]"));

  test("no marker: no throw, and the target line is printed", () => {
    const { thrown, lines } = print(BC2, dirWith({ "bc3.md": MARKER }));
    expect(thrown).toBeUndefined();
    expect(targetLines(lines)).toHaveLength(1);
  });

  test("bc2 marked: ServerOutOfUseError by name, and NO target line to grep", () => {
    const { thrown, lines } = print(BC2, dirWith({ "bc2.md": MARKER }));
    expect(thrown).toBeInstanceOf(ServerOutOfUseError);
    expect((thrown as Error).message).toContain("bc2 is OUT OF USE");
    expect((thrown as Error).message).toContain("SYNTH-REASON stranded op");
    expect(targetLines(lines)).toEqual([]);
  });

  test("a config with no port at all is the default 7049, so bc1's marker refuses it", () => {
    const { thrown, lines } = print(
      { server: "http://192.168.2.157" },
      dirWith({ "bc1.md": MARKER }),
    );
    expect(thrown).toBeInstanceOf(ServerOutOfUseError);
    expect(targetLines(lines)).toEqual([]);
  });

  test("a wrong coord root (no <root>/machine) throws by name, with no target line", () => {
    const { thrown, lines } = print(BC2, wrongRoot());
    expect(thrown).toBeInstanceOf(OutOfUseRootError);
    expect(targetLines(lines)).toEqual([]);
  });

  test("a Cronus28 config is never checked, even with every bc marker or a wrong root", () => {
    const dir = dirWith({ "bc1.md": MARKER, "bc2.md": MARKER, "bc3.md": MARKER });
    expect(print({ server: "http://Cronus28" }, dir).thrown).toBeUndefined();
    expect(print({ server: "http://Cronus28" }, wrongRoot()).thrown).toBeUndefined();
  });

  test("the owner override: the loud line, THEN the target line; the clearing one does not pass", () => {
    const dir = dirWith({ "bc2.md": `${MARKER}owner: ${TOKEN}\n` });
    const ok = print(BC2, dir, { LETHAL_OUT_OF_USE_OWNER: TOKEN });
    expect(ok.thrown).toBeUndefined();
    const loud = ok.lines.findIndex((l) => l.includes("owned by this run"));
    const target = ok.lines.findIndex((l) => l.includes("[itest target]"));
    expect(loud).toBeGreaterThanOrEqual(0);
    expect(target).toBeGreaterThan(loud);
    const blocked = print(BC2, dir, { LETHAL_OUT_OF_USE_CLEARING: "bc2" });
    expect(blocked.thrown).toBeInstanceOf(ServerOutOfUseError);
    expect(targetLines(blocked.lines)).toEqual([]);
  });
});

describe("every BC itest reaches the check before anything reads its config", () => {
  const here = import.meta.dir;
  const itests = readdirSync(here).filter((f) => f.endsWith(".itest.ts"));

  test("the line after its config path is chosen is `printItestTarget(<path>);`, with the real marker dir", () => {
    const users = itests.filter((f) =>
      /itestConfigPath\(/.test(readFileSync(join(here, f), "utf8")),
    );
    const wrong = users.filter((f) => {
      const lines = readFileSync(join(here, f), "utf8").split("\n");
      const i = lines.findIndex((l) => /=\s*itestConfigPath\(/.test(l));
      return !/^\s*printItestTarget\(\w+\);\s*$/.test(lines[i + 1] ?? "");
    });
    expect(wrong).toEqual([]);
    expect(users.length).toBeGreaterThanOrEqual(14);
  });
});
