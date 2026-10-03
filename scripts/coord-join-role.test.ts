import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { role } from "./coord-join-role.ts";

const K = { KRAKEN_PROJECT: "lethal" };

describe("host paths", () => {
  const cases: [string, string, string][] = [
    ["U:/Git/LethAL", "lethal-orchestrator", "orchestrator.md"],
    ["U:/Git/LethAL-wt/lane-code", "lethal-code", "lane.md"],
    ["U:/Git/LethAL-wt/lane-bugs", "lethal-bugs", "lane.md"],
    ["H:/LethAL-wt/lane-preproc", "lethal-preproc", "lane.md"],
  ];
  for (const [top, session, roleFile] of cases) {
    test(top, () => {
      expect(role(top, {})).toEqual({
        session,
        roleFile: roleFile as "lane.md",
        kraken: false,
        skipRename: false,
        loopFromStart: false,
      });
    });
  }
  test("unknown path", () => {
    expect(() => role("C:/elsewhere", {})).toThrow("no role for C:/elsewhere");
  });
  test("KRAKEN_AGENT alone does not switch to kraken mode", () => {
    expect(role("U:/Git/LethAL", { KRAKEN_AGENT: "lane-code" }).kraken).toBe(false);
  });
});

describe("kraken", () => {
  const cases: [string, string, string, string][] = [
    ["orchestrator", "/work/lethal", "lethal-orchestrator", "orchestrator.md"],
    ["lane-code", "/work/lethal-wt/lane-code", "lethal-code", "lane.md"],
    ["lane-bugs", "/work/lethal-wt/lane-bugs", "lethal-bugs", "lane.md"],
    ["lane-preproc", "/work/lethal-wt/lane-preproc", "lethal-preproc", "lane.md"],
  ];
  for (const [agent, top, session, roleFile] of cases) {
    test(agent, () => {
      expect(role(top, { ...K, KRAKEN_AGENT: agent })).toEqual({
        session,
        roleFile: roleFile as "lane.md",
        kraken: true,
        skipRename: true,
        loopFromStart: agent === "orchestrator",
      });
    });
  }
  test("another agent's worktree", () => {
    expect(() => role("/work/lethal-wt/lane-bugs", { ...K, KRAKEN_AGENT: "lane-code" })).toThrow(
      "KRAKEN_AGENT lane-code in /work/lethal-wt/lane-bugs: not its worktree",
    );
  });
  test("lane in the orchestrator's worktree", () => {
    expect(() => role("/work/lethal", { ...K, KRAKEN_AGENT: "lane-code" })).toThrow(
      "not its worktree",
    );
  });
  test("KRAKEN_AGENT unset", () => {
    expect(() => role("/work/lethal", K)).toThrow("KRAKEN_AGENT is not set");
  });
});

describe("coord-join.md order", () => {
  const text = readFileSync(
    join(import.meta.dir, "..", ".claude", "commands", "coord-join.md"),
    "utf8",
  );
  // Anchor on the step headings, not on wording inside them.
  const at = (heading: RegExp) => {
    const m = heading.exec(text);
    if (!m) throw new Error(`step heading missing: ${heading}`);
    return m.index;
  };
  const free = at(/^## \d+\. Check the role is free/m);
  const name = at(/^## \d+\. Get the name/m);
  const ack = at(/^## \d+\. Acknowledge/m);
  const start = at(/^## \d+\. Start the role/m);

  test("ack comes after the free check and the name check, before Start", () => {
    expect(free).toBeLessThan(name);
    expect(name).toBeLessThan(ack);
    expect(ack).toBeLessThan(start);
  });
  test("`kraken tentacle ack` appears only in the ack step", () => {
    const first = text.indexOf("kraken tentacle ack");
    expect(first).toBeGreaterThan(ack);
    expect(first).toBeLessThan(start);
    expect(text.lastIndexOf("kraken tentacle ack")).toBeLessThan(start);
  });
});
