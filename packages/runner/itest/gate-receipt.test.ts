import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GateChallengeError, readChallenge, writeReceipt } from "./gate-receipt";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lethal-receipt-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    LETHAL_GATE_NONCE: "n".repeat(32),
    LETHAL_GATE_SHA: "1234567890abcdef1234567890abcdef12345678",
    LETHAL_GATE_GENERATION: "7",
    LETHAL_GATE_RECEIPT: join(dir, "receipt.json"),
    ...over,
  };
}

describe("an unchallenged run behaves exactly as before", () => {
  test("no variables means no challenge", () => {
    expect(readChallenge({})).toBeUndefined();
  });

  test("empty strings count as absent, so an exported-but-empty var is not a half challenge", () => {
    expect(
      readChallenge({
        LETHAL_GATE_NONCE: "",
        LETHAL_GATE_SHA: "",
        LETHAL_GATE_GENERATION: "",
        LETHAL_GATE_RECEIPT: "",
      }),
    ).toBeUndefined();
  });
});

describe("a half-set challenge throws rather than falling back", () => {
  // Falling back would hand the caller the exit-code-only result the receipt exists to replace,
  // which is the failure this whole module is about.
  for (const missing of [
    "LETHAL_GATE_NONCE",
    "LETHAL_GATE_SHA",
    "LETHAL_GATE_GENERATION",
    "LETHAL_GATE_RECEIPT",
  ]) {
    test(`missing ${missing}`, () => {
      const e = env();
      delete e[missing];
      expect(() => readChallenge(e)).toThrow(GateChallengeError);
    });
  }

  test("the message names what was set and what was missing", () => {
    const e = env();
    e.LETHAL_GATE_RECEIPT = undefined;
    try {
      readChallenge(e);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("LETHAL_GATE_RECEIPT");
      expect((err as Error).message).toContain("LETHAL_GATE_NONCE");
    }
  });

  test("a non-integer generation throws", () => {
    expect(() => readChallenge(env({ LETHAL_GATE_GENERATION: "seven" }))).toThrow(
      GateChallengeError,
    );
    expect(() => readChallenge(env({ LETHAL_GATE_GENERATION: "7.5" }))).toThrow(GateChallengeError);
  });
});

describe("a complete challenge parses", () => {
  test("every field arrives", () => {
    const c = readChallenge(env());
    expect(c).toBeDefined();
    if (c === undefined) throw new Error("unreachable");
    expect(c.nonce).toBe("n".repeat(32));
    expect(c.containerGeneration).toBe(7);
    expect(c.receiptPath).toBe(join(dir, "receipt.json"));
  });
});

describe("the written receipt", () => {
  test("echoes the challenge and records the sublegs", async () => {
    const c = readChallenge(env());
    if (c === undefined) throw new Error("unreachable");
    await writeReceipt(c, "alrunner", {
      status: "passed",
      sublegs: ["one-shot", "server", "resource", "platform-pin"],
      artifacts: { reported: true, ids: { target: "sha:1" } },
    });

    const r = JSON.parse(await readFile(c.receiptPath, "utf8"));
    expect(r.leg).toBe("alrunner");
    expect(r.nonce).toBe("n".repeat(32));
    expect(r.containerGeneration).toBe(7);
    expect(r.status).toBe("passed");
    expect(r.sublegs).toHaveLength(4);
    expect(r.observedArtifacts).toEqual({ target: "sha:1" });
    expect(r.artifactsReported).toBe(true);
  });

  test("an unreported artifact set says so instead of writing an empty map that reads as proof", async () => {
    // `{}` would read as "nothing was published", which is a different claim and the one that
    // hides a stale build.
    const c = readChallenge(env());
    if (c === undefined) throw new Error("unreachable");
    await writeReceipt(c, "hang", {
      status: "passed",
      sublegs: ["on", "off"],
      artifacts: { reported: false },
    });
    const r = JSON.parse(await readFile(c.receiptPath, "utf8"));
    expect(r.artifactsReported).toBe(false);
    expect(r.observedArtifacts).toEqual({});
  });

  test("a skip carries its reason", async () => {
    const c = readChallenge(env());
    if (c === undefined) throw new Error("unreachable");
    await writeReceipt(c, "tables", {
      status: "skipped",
      sublegs: [],
      artifacts: { reported: false },
      reason: "LETHAL_ITEST_TABLES unset",
    });
    const r = JSON.parse(await readFile(c.receiptPath, "utf8"));
    expect(r.status).toBe("skipped");
    expect(r.reason).toContain("LETHAL_ITEST_TABLES");
  });

  test("it is written atomically, leaving no temp file behind", async () => {
    // A receipt half-written by a killed process must not be one that parses.
    const c = readChallenge(env());
    if (c === undefined) throw new Error("unreachable");
    await writeReceipt(c, "bcdev", {
      status: "passed",
      sublegs: ["bcdev"],
      artifacts: { reported: false },
    });
    expect((await readdir(dir)).sort()).toEqual(["receipt.json"]);
  });

  test("a second write replaces the first rather than appending", async () => {
    const c = readChallenge(env());
    if (c === undefined) throw new Error("unreachable");
    await writeReceipt(c, "bcdev", {
      status: "failed",
      sublegs: [],
      artifacts: { reported: false },
      reason: "first",
    });
    await writeReceipt(c, "bcdev", {
      status: "passed",
      sublegs: ["bcdev"],
      artifacts: { reported: false },
    });
    const r = JSON.parse(await readFile(c.receiptPath, "utf8"));
    expect(r.status).toBe("passed");
    expect(r.reason).toBeUndefined();
  });
});

describe("the exit code, which is the other half of R223", () => {
  // These spawn the real gate script, because the exit code is the thing under test and no
  // in-process assertion can observe it. They are fast: the itest skips immediately.
  const REPO = join(import.meta.dir, "..", "..", "..");

  async function runTables(extra: Record<string, string>): Promise<number> {
    const proc = Bun.spawn(["bun", "run", "itest:tables"], {
      cwd: REPO,
      env: { ...process.env, ...extra },
      stdout: "ignore",
      stderr: "ignore",
    });
    return await proc.exited;
  }

  test("an unchallenged skip still exits 0, so the human workflow is untouched", async () => {
    const code = await runTables({
      LETHAL_GATE_NONCE: "",
      LETHAL_GATE_SHA: "",
      LETHAL_GATE_GENERATION: "",
      LETHAL_GATE_RECEIPT: "",
    });
    expect(code).toBe(0);
  });

  test("a CHALLENGED skip exits non-zero, so a caller reading $? is told too", async () => {
    // The failure R223 describes: before this, a skipped gate and a passed gate were the same exit
    // code, so one misspelled env var satisfied "every required leg exited 0".
    const code = await runTables({
      LETHAL_GATE_NONCE: "e".repeat(32),
      LETHAL_GATE_SHA: "5".repeat(40),
      LETHAL_GATE_GENERATION: "1",
      LETHAL_GATE_RECEIPT: join(dir, "exit-code.json"),
    });
    expect(code).not.toBe(0);

    // And it left the positive statement behind, not merely a bad exit code.
    const r = JSON.parse(await readFile(join(dir, "exit-code.json"), "utf8"));
    expect(r.status).toBe("skipped");
  });
});
