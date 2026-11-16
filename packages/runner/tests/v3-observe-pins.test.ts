// PR-88: the v3 gate's observe switch for serve pins (pure half).
import { describe, expect, test } from "bun:test";
import { judgeServePins } from "../itest/al-runner-v3-gate";

const say = (k: string, g: unknown, v: number) => `${k} ${g}, pinned ${v}`;

describe("PR-88: judgeServePins", () => {
  const pins = { boundChecks: 10, entriesSent: 100 };

  test("enforced: a pin difference is a failure, an equal pin is not", () => {
    const j = judgeServePins("N1S", { boundChecks: 10, entriesSent: 120 }, pins, false, say);
    expect(j.failures).toEqual(["entriesSent 120, pinned 100"]);
    expect(j.lines).toEqual([]);
  });

  test("observe: every pin prints actual beside pinned, a moved one is marked, nothing fails", () => {
    const j = judgeServePins("N1S", { boundChecks: 10, entriesSent: 120 }, pins, true, say);
    expect(j.failures).toEqual([]);
    expect(j.lines).toEqual([
      "  N1S: pin boundChecks: actual 10, pinned 10",
      "  N1S: pin entriesSent: actual 120, pinned 100  MOVED",
    ]);
  });
});
