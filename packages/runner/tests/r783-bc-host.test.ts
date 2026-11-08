// R783: the BC on Linux host from one place. The consumers' own tests are in out-of-use.test.ts
// (the marker check and printItestTarget), bc-linux-setup.test.ts (HOST and the launch file) and
// r658-hang-gate.test.ts (the wrapper's WANT). Every test but the first names its host explicitly,
// so only the first one moves with a flip of the default.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  BC_HOSTS,
  BcHostError,
  BcHostMismatchError,
  DEFAULT_BC_HOST,
  bcHostMismatch,
  bcLinuxHost,
  refuseRetiredBcHost,
} from "../src/bc-host";

const ON_SERVER1 = { LETHAL_BC_HOST: `http://${BC_HOSTS.server1}` };
const ON_DOCKER1 = { LETHAL_BC_HOST: `http://${BC_HOSTS.docker1}` };

describe("R783: bcLinuxHost", () => {
  test("unset or empty is the committed default: server1 again since the owner's restart (R806, 2026-11-05)", () => {
    expect(DEFAULT_BC_HOST).toBe(BC_HOSTS.server1);
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

describe("R867: refuseRetiredBcHost", () => {
  const OURS = { LETHAL_COORD_ROOT: "/coord" };
  const RETIRED = [
    ["http://192.168.2.77:7049", "192.168.2.77"],
    ["http://docker1:7049", "192.168.2.77"],
    ["http://Cronus28:7049/BC", "cronus28"],
    ["http://Cronus28.:7049/BC", "cronus28"],
    ["http://cronus284", "cronus284"],
  ] as const;

  test("in our environment, docker1, Cronus28 and Cronus284 are each refused by name", () => {
    for (const [server, host] of RETIRED) {
      expect(() => refuseRetiredBcHost({ server }, OURS)).toThrow(BcHostMismatchError);
      expect(() => refuseRetiredBcHost({ server }, OURS)).toThrow(host);
    }
  });
  test("baseUrl and apiBaseUrl are refused too, each on its own", () => {
    const server = "http://192.168.2.157:7149";
    const old = "http://192.168.2.77:7148/BC";
    for (const urls of [{ baseUrl: old }, { apiBaseUrl: old }])
      expect(() => refuseRetiredBcHost({ server, ...urls }, OURS)).toThrow(BcHostMismatchError);
    expect(() => refuseRetiredBcHost({ server, baseUrl: server }, OURS)).not.toThrow();
  });
  test("the same hosts with no coord root pass: for a user they can be their own servers", () => {
    for (const [server] of RETIRED) {
      expect(() => refuseRetiredBcHost({ server }, {})).not.toThrow();
      expect(() => refuseRetiredBcHost({ server }, { LETHAL_COORD_ROOT: "" })).not.toThrow();
    }
  });
  test("in our environment, the host in use and a customer's host pass", () => {
    for (const server of [
      "http://192.168.2.157:7149/BC",
      "http://server1:7149",
      "https://bc.example.com/BC",
    ])
      expect(() => refuseRetiredBcHost({ server }, OURS)).not.toThrow();
  });
  test("LETHAL_BC_HOST flips which known host is refused", () => {
    const onDocker1 = { ...OURS, ...ON_DOCKER1 };
    expect(() =>
      refuseRetiredBcHost({ server: "http://192.168.2.77:7049" }, onDocker1),
    ).not.toThrow();
    expect(() => refuseRetiredBcHost({ server: "http://192.168.2.157:7049" }, onDocker1)).toThrow(
      BcHostMismatchError,
    );
  });
  test("no section, or a server that is no URL, is left to the config checks", () => {
    expect(() => refuseRetiredBcHost(undefined, OURS)).not.toThrow();
    expect(() => refuseRetiredBcHost({ server: "not a url" }, OURS)).not.toThrow();
  });
});
