// PR-323 (R1172): the container's memory "used", by the ONE shared rule (`readCgroupMemory`:
// memory.current − (file − shmem)), for run-script watchdogs that must not do their own arithmetic.
// Prints bytes; `--mib` prints MiB. Exit 1 when no cgroup v2 reading is possible.
// LETHAL_HEAVY_CGROUP_DIR names the cgroup folder (default /sys/fs/cgroup), as the heavy-slot scripts read it.
import { readCgroupMemory } from "../packages/runner/src/al-runner-v3-baseline-check.ts";

export function cgroupUsedLine(
  argv: readonly string[],
  dir: string,
  read?: (p: string) => string,
): string | undefined {
  const s = read === undefined ? readCgroupMemory(undefined, dir) : readCgroupMemory(read, dir);
  if (s === undefined) return undefined;
  return argv.includes("--mib") ? String(Math.floor(s.usedBytes / 2 ** 20)) : String(s.usedBytes);
}

if (import.meta.main) {
  const line = cgroupUsedLine(
    process.argv.slice(2),
    process.env.LETHAL_HEAVY_CGROUP_DIR ?? "/sys/fs/cgroup",
  );
  if (line === undefined) {
    console.error("cgroup-used: no cgroup v2 memory.current to read");
    process.exit(1);
  }
  console.log(line);
}
