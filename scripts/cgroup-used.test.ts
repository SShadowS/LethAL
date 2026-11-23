import { describe, expect, test } from "bun:test";
import { cgroupUsedLine } from "./cgroup-used.ts";

describe("PR-323: scripts/cgroup-used.ts prints the shared rule's value", () => {
  const G = 2 ** 30;
  const files = (o: Record<string, string>) => (p: string) => {
    const v = o[p];
    if (v === undefined) throw new Error("ENOENT");
    return v;
  };
  const cg = files({
    "/c/memory.current": `${20 * G}\n`,
    "/c/memory.stat": `file ${12 * G}\nshmem ${4 * G}\n`,
  });
  test("bytes by default, MiB with --mib", () => {
    expect(cgroupUsedLine([], "/c", cg)).toBe(String(12 * G));
    expect(cgroupUsedLine(["--mib"], "/c", cg)).toBe(String(12 * 1024));
  });
  test("no memory.current: no line", () => {
    expect(cgroupUsedLine([], "/c", files({}))).toBeUndefined();
  });
});
