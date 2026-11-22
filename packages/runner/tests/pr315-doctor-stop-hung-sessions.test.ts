import { describe, expect, test } from "bun:test";
import { runDoctor } from "../src/doctor";

// PR-315 (GitHub #52): doctor says whether the stop is on. It never fails doctor.
async function checkFor(probe: { on: boolean; envTool: boolean }) {
  const r = await runDoctor(
    {},
    {
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
      stopHungSessions: async () => probe,
    },
  );
  const check = r.checks.find((c) => c.name === "stop-hung-sessions");
  return { r, check };
}

describe("doctor: stop-hung-sessions (PR-315)", () => {
  test("off: advisory, still ok, names the fix and #52", async () => {
    const { r, check } = await checkFor({ on: false, envTool: false });
    expect(check?.ok).toBe(true);
    expect(r.ok).toBe(true);
    expect(check?.detail).toContain("OFF");
    expect(check?.detail).toContain("--stop-hung-sessions");
    expect(check?.detail).toContain('"stopHungSessions": true');
    expect(check?.detail).toContain("#52");
  });

  test("on: ok and says so", async () => {
    const { check } = await checkFor({ on: true, envTool: false });
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("on");
    expect(check?.detail).not.toContain("OFF");
  });

  test("envTool config: says only the flag works", async () => {
    const { check } = await checkFor({ on: false, envTool: true });
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("This config uses an envTool");
    const plain = await checkFor({ on: false, envTool: false });
    expect(plain.check?.detail).not.toContain("This config uses an envTool");
  });
});
