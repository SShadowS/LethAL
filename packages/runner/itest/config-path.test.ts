import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ITEST_CONFIG,
  ItestConfigNameError,
  itestConfigName,
  itestConfigPath,
} from "./config-path";

describe("the default is unchanged", () => {
  test("an unset variable gives the name every itest used before", () => {
    expect(itestConfigName({})).toBe(DEFAULT_ITEST_CONFIG);
    expect(itestConfigName({ LETHAL_ITEST_CONFIG: "" })).toBe(DEFAULT_ITEST_CONFIG);
  });

  test("the path is joined onto the fixture directory the caller chose", () => {
    const p = itestConfigPath("U:/Git/LethAL/fixtures/sandbox-data", {});
    expect(p.replace(/\\/g, "/")).toBe(
      "U:/Git/LethAL/fixtures/sandbox-data/lethal.config.local.json",
    );
  });
});

describe("selecting the agent config", () => {
  test("a sibling config name is honoured", () => {
    const p = itestConfigPath("U:/Git/LethAL/fixtures/sandbox-data", {
      LETHAL_ITEST_CONFIG: "lethal.config.agent.json",
    });
    expect(p.replace(/\\/g, "/")).toBe(
      "U:/Git/LethAL/fixtures/sandbox-data/lethal.config.agent.json",
    );
  });
});

describe("the value is a basename, never a path", () => {
  // A live itest publishes to whatever server its config names, so this value decides which
  // machine gets written to. An env var must not be able to aim that outside the fixture.
  const bad = [
    "../sandbox-app/lethal.config.local.json",
    "..\\sandbox-app\\lethal.config.local.json",
    "/etc/lethal.config.x.json",
    "C:/tmp/lethal.config.x.json",
    "lethal.config.a/b.json",
    "lethal.config.json",
    "config.json",
    "lethal.config.agent.json.bak",
    "LETHAL.CONFIG.AGENT.JSON",
    " lethal.config.agent.json",
  ];

  for (const v of bad) {
    test(`refuses ${JSON.stringify(v)}`, () => {
      expect(() => itestConfigName({ LETHAL_ITEST_CONFIG: v })).toThrow(ItestConfigNameError);
    });
  }

  test("a refusal names the variable and what was expected, and does not fall back", () => {
    // Falling back to the default on a malformed value is the dangerous behaviour: the run would
    // quietly use the owner's containers while its report said it was the agent's.
    try {
      itestConfigName({ LETHAL_ITEST_CONFIG: "../elsewhere.json" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ItestConfigNameError);
      expect((e as Error).message).toContain("LETHAL_ITEST_CONFIG");
      expect((e as Error).message).toContain("lethal.config.agent.json");
    }
  });
});
