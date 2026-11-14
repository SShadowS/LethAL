import { describe, expect, test } from "bun:test";
import type { BcDevConfigSection } from "../packages/runner/src/cli";
import { probeOdataCfg } from "./probe-r58-differential";

// R986: the coverage-differential probe reaches the server its config names, as the bcdev itests do.
const plain: BcDevConfigSection = {
  mcpCommand: ["bcdev"],
  server: "http://192.0.2.10:7249",
  serverInstance: "BC",
  company: "CRONUS",
  username: "u",
  password: "p",
  packageCachePath: "/tmp/pkgs",
  controlSymbolPath: "/tmp/control.app",
};

describe("R986: probe-r58-differential's OData root", () => {
  test("follows the config's baseUrl (bc3's 7248), never a derived 7048", () => {
    const cfg = probeOdataCfg({
      ...plain,
      baseUrl: "http://192.0.2.10:7248/BC",
      apiBaseUrl: "http://192.0.2.10:7252/BC",
    });
    expect(cfg.baseUrl).toBe("http://192.0.2.10:7248/BC");
    expect(cfg.apiBaseUrl).toBe("http://192.0.2.10:7252/BC");
    expect([cfg.company, cfg.username]).toEqual(["CRONUS", "u"]);
  });
  test("with no baseUrl, the 7048 derivation stands (a config written before R589)", () => {
    expect(probeOdataCfg(plain).baseUrl).toBe("http://192.0.2.10:7048/BC");
  });
});
