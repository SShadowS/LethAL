import { describe, expect, test } from "bun:test";
import { ReadinessProbe } from "./readiness-probe";

describe("ReadinessProbe", () => {
  test("passes only when BOTH planes answer, using non-mutating reads", async () => {
    const calls: string[] = [];
    const probe = new ReadinessProbe({
      odataRead: async () => {
        calls.push("odata");
      },
      testPlaneHandshake: async () => {
        calls.push("test");
      },
    });
    const r = await probe.probe();
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["odata", "test"]);
  });

  test("fails if either plane throws", async () => {
    const probe = new ReadinessProbe({
      odataRead: async () => {
        throw new Error("7048 wedged");
      },
      testPlaneHandshake: async () => {},
    });
    const r = await probe.probe();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("7048 wedged");
  });
});
