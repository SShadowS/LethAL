import { describe, expect, test } from "bun:test";
import type { BcDevConfigSection } from "../../packages/runner/src/cli";
import { connFromBcdev, refuseLabel, targetFor } from "./drive-config";

const BCDEV = {
  mcpCommand: ["x"],
  server: "http://winbox",
  serverInstance: "BC",
  company: "CRONUS Test",
  username: "u",
  password: "pw-not-real",
  packageCachePath: "/p",
  controlSymbolPath: "/c",
} as BcDevConfigSection;

describe("refuseLabel", () => {
  test.each(["Cronus284", "cronus281", "Cronus282", "Cronus283"])("refuses %s", (l) => {
    expect(() => refuseLabel(l)).toThrow("CentralGauge");
  });
  test.each(["Cronus28", "bc1", "Cronus285"])("allows %s", (l) => {
    expect(() => refuseLabel(l)).not.toThrow();
  });
});

describe("connFromBcdev", () => {
  test("a container: dev 7049, OData 7048, API on the OData root", () => {
    const { c, odata, extra } = connFromBcdev(BCDEV, "Cronus28", "x.json");
    expect(c.urls).toEqual({
      dev: "http://winbox:7049/BC",
      api: "http://winbox:7048/BC/api",
      company: "CRONUS Test",
    });
    expect(odata.baseUrl).toBe("http://winbox:7048/BC");
    expect(c.authorization).toBe(`Basic ${btoa("u:pw-not-real")}`);
    expect(JSON.stringify(extra)).not.toContain("pw-not-real");
  });
  test("explicit port, baseUrl and apiBaseUrl win", () => {
    const { c, odata } = connFromBcdev(
      { ...BCDEV, port: 9, baseUrl: "http://h:1/BC", apiBaseUrl: "http://h:2/BC" },
      "L",
      "x.json",
    );
    expect(c.urls?.dev).toBe("http://winbox:9/BC");
    expect(c.urls?.api).toBe("http://h:2/BC/api");
    expect(odata.baseUrl).toBe("http://h:1/BC");
  });
  test("a tenant other than default is refused", () => {
    expect(() => connFromBcdev({ ...BCDEV, tenant: "t2" }, "L", "x.json")).toThrow("tenant");
  });
});

test("the target runs only 92910 and 92911, as run 1, into <label>-probe.json", () => {
  const t = targetFor(BCDEV, "Cronus28", "x.json");
  expect(t.cases.map((k) => k.codeunit)).toEqual([92910, 92911]);
  expect(t.run).toBe(1);
  expect(t.out.endsWith("docs/measurements/r639/cronus28-probe.json")).toBe(true);
  expect(t.evidence).toBe("/coord/handoff/R-639/cronus28");
});
