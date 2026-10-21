import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LeaseDeps,
  NotIgnoredError,
  SecretFileError,
  buildConfig,
  describeLogin,
  gitIgnores,
  parseSecretEnv,
  readSecretFile,
  withLease,
  writeConfig,
} from "./bc-linux-setup.ts";

// A made-up value: the tests check it never appears in an error.
const SECRET = "Tr0ub4dor=&3!";
const GOOD = `BC_DEV_USER=BCRUNNER\nBC_DEV_PASSWORD=${SECRET}\n`;

function refusal(text: string): string {
  try {
    parseSecretEnv(text);
  } catch (err) {
    expect(err).toBeInstanceOf(SecretFileError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("parseSecretEnv", () => {
  test("reads both keys and keeps a value ending in ! (and holding =) intact", () => {
    expect(parseSecretEnv(GOOD)).toEqual({ user: "BCRUNNER", password: SECRET });
    expect(parseSecretEnv(GOOD.replace(/\n/g, "\r\n")).password).toBe(SECRET);
  });

  test("a missing file is refused by name", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bc-linux-")), "bc-linux.env");
    expect(() => readSecretFile(path)).toThrow(SecretFileError);
    expect(() => readSecretFile(path)).toThrow(path);
  });

  test("a missing key is refused by name", () => {
    expect(refusal("BC_DEV_USER=BCRUNNER\n")).toContain("BC_DEV_PASSWORD is missing");
  });

  test("an extra key is refused by name, without its value", () => {
    const m = refusal(`${GOOD}EXTRA=${SECRET}\n`);
    expect(m).toContain('unexpected key "EXTRA"');
    expect(m).not.toContain(SECRET);
  });

  test("an empty value is refused by name", () => {
    expect(refusal("BC_DEV_USER=BCRUNNER\nBC_DEV_PASSWORD=\n")).toContain(
      "BC_DEV_PASSWORD is empty",
    );
  });

  test("no refusal echoes a value, or part of one", () => {
    const [head] = SECRET.split("=");
    // A bare password line, with and without an `=` in it.
    expect(refusal(`BC_DEV_USER=BCRUNNER\n${SECRET}\n`)).not.toContain(head);
    expect(refusal("BC_DEV_USER=BCRUNNER\nhunter2!\n")).not.toContain("hunter2");
    for (const text of [
      `${GOOD}BC_DEV_PASSWORD=${SECRET}\n`,
      `BC_DEV_USER=BCRUNNER\nBC_DEV_PASSWORD =${SECRET}\nX=${SECRET}\n`,
    ]) {
      expect(refusal(text)).not.toContain(SECRET);
    }
    expect(describeLogin(parseSecretEnv(GOOD))).not.toContain(SECRET);
    expect(describeLogin(parseSecretEnv(GOOD))).toContain(`(${SECRET.length} chars)`);
  });
});

describe("config writer", () => {
  const login = { user: "BCRUNNER", password: SECRET };
  const paths = {
    mcpCommand: ["node", "/x/bc-dev-mcp/dist/index.js"],
    controlSymbolPath: "/x/control.app",
    packageCachePath: "/x/symbols",
  };

  test("bc2's config names bc2's three ports and the W1 company", () => {
    expect(buildConfig("bc2", login, paths)).toEqual({
      bcdev: {
        mcpCommand: paths.mcpCommand,
        server: "http://192.168.2.157:7149",
        serverInstance: "BC",
        tenant: "default",
        port: 7149,
        baseUrl: "http://192.168.2.157:7148/BC",
        apiBaseUrl: "http://192.168.2.157:7152/BC",
        company: "CRONUS International Ltd.",
        username: "BCRUNNER",
        password: SECRET,
        packageCachePath: "/x/symbols",
        controlSymbolPath: "/x/control.app",
        env: { BC_DEV_USER: "BCRUNNER", BC_DEV_PASSWORD: SECRET, BC_DEV_API_PORT: "7152" },
      },
    });
  });

  test("a path git does not ignore is refused and nothing is written", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bc-linux-")), "lethal.config.bc1.json");
    expect(() => writeConfig(path, {}, () => false)).toThrow(NotIgnoredError);
    expect(existsSync(path)).toBe(false);
    writeConfig(path, { a: 1 }, () => true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
  });

  test("the repo's .gitignore ignores the per-server configs and not app.json", () => {
    expect(gitIgnores("fixtures/sandbox-app/lethal.config.bc1.json")).toBe(true);
    expect(gitIgnores("fixtures/sandbox-harden/lethal.config.bc3.json")).toBe(true);
    expect(gitIgnores("fixtures/sandbox-app/app.json")).toBe(false);
  });
});

describe("withLease", () => {
  function fakeLease(calls: string[], recordThrows = false): LeaseDeps {
    return {
      take: async () => {
        calls.push("take");
        return "tok";
      },
      recordToken: (_s, t) => {
        calls.push(`record:${t}`);
        if (recordThrows) throw new Error("disk full");
      },
      heartbeat: async () => {
        calls.push("heartbeat");
      },
      release: async (_s, t) => {
        calls.push(`release:${t}`);
      },
    };
  }

  test("records the token before the body runs, and releases after", async () => {
    const calls: string[] = [];
    await withLease("bc1", fakeLease(calls), async () => {
      calls.push("body");
    });
    expect(calls).toEqual(["take", "record:tok", "body", "release:tok"]);
  });

  test("releases when the body throws", async () => {
    const calls: string[] = [];
    await expect(
      withLease("bc1", fakeLease(calls), async () => {
        throw new Error("publish failed");
      }),
    ).rejects.toThrow("publish failed");
    expect(calls).toEqual(["take", "record:tok", "release:tok"]);
  });

  test("releases when recording the token fails, and never runs the body", async () => {
    const calls: string[] = [];
    await expect(
      withLease("bc1", fakeLease(calls, true), async () => {
        calls.push("body");
      }),
    ).rejects.toThrow("disk full");
    expect(calls).toEqual(["take", "record:tok", "release:tok"]);
  });

  test("heartbeats while the body runs", async () => {
    const calls: string[] = [];
    await withLease(
      "bc1",
      fakeLease(calls),
      async () => {
        await new Promise((r) => setTimeout(r, 35));
      },
      10,
    );
    expect(calls.filter((c) => c === "heartbeat").length).toBeGreaterThan(0);
    expect(calls.at(-1)).toBe("release:tok");
  });
});
