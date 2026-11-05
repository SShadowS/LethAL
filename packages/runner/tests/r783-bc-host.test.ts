// R783: the BC on Linux host from one place. The consumers' own tests are in out-of-use.test.ts
// (the marker check and printItestTarget), bc-linux-setup.test.ts (HOST and the launch file) and
// r658-hang-gate.test.ts (the wrapper's WANT). Every test but the first names its host explicitly,
// so only the first one moves with a flip of the default.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  BC_HOSTS,
  BcHostError,
  DEFAULT_BC_HOST,
  bcHostMismatch,
  bcLinuxHost,
} from "../src/bc-host";

const ON_SERVER1 = { LETHAL_BC_HOST: `http://${BC_HOSTS.server1}` };
const ON_DOCKER1 = { LETHAL_BC_HOST: `http://${BC_HOSTS.docker1}` };

describe("R783: bcLinuxHost", () => {
  test("unset or empty is the committed default: docker1 since the switch (owner ruling, 2026-10-25)", () => {
    expect(DEFAULT_BC_HOST).toBe(BC_HOSTS.docker1);
    expect(bcLinuxHost({})).toBe(DEFAULT_BC_HOST);
    expect(bcLinuxHost({ LETHAL_BC_HOST: "" })).toBe(DEFAULT_BC_HOST);
  });
  test("LETHAL_BC_HOST=http://<host> names the host, lower case", () => {
    expect(bcLinuxHost(ON_DOCKER1)).toBe("192.168.2.77");
    expect(bcLinuxHost(ON_SERVER1)).toBe("192.168.2.157");
    expect(bcLinuxHost({ LETHAL_BC_HOST: "http://Docker1" })).toBe("docker1");
  });
  test("a port, a path, no scheme or https is refused by name", () => {
    for (const bad of [
      "http://192.168.2.77:7049",
      "http://192.168.2.77/",
      "192.168.2.77",
      "https://x",
    ])
      expect(() => bcLinuxHost({ LETHAL_BC_HOST: bad })).toThrow(BcHostError);
  });
  test("run as a script it prints the host (what r658-hang-gate.sh reads)", () => {
    const run = (env: Record<string, string>) =>
      Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/bc-host.ts")], {
        env: { PATH: process.env.PATH ?? "", ...env },
      });
    expect(run({}).stdout.toString().trim()).toBe(DEFAULT_BC_HOST);
    expect(run(ON_SERVER1).stdout.toString().trim()).toBe("192.168.2.157");
    expect(run(ON_DOCKER1).stdout.toString().trim()).toBe("192.168.2.77");
    expect(run({ LETHAL_BC_HOST: "http://x:1" }).exitCode).not.toBe(0);
  });
});

describe("R783: bcHostMismatch", () => {
  test("the other known host is refused, in each direction", () => {
    expect(bcHostMismatch("192.168.2.157", ON_DOCKER1)).toContain(
      "the host in use is 192.168.2.77",
    );
    expect(bcHostMismatch("192.168.2.77", ON_SERVER1)).toContain(
      "the host in use is 192.168.2.157",
    );
  });
  test("the host in use, and any unknown host, pass", () => {
    expect(bcHostMismatch("192.168.2.77", ON_DOCKER1)).toBeUndefined();
    expect(bcHostMismatch("192.168.2.157", ON_SERVER1)).toBeUndefined();
    expect(bcHostMismatch("cronus28", ON_DOCKER1)).toBeUndefined();
    expect(bcHostMismatch("10.0.0.1", ON_SERVER1)).toBeUndefined();
  });
});
