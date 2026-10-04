import { describe, expect, it } from "bun:test";
import { type BcDevDeployment, BcDevMcpBackend } from "../src/bcdev-backend";
import { DependencyUnreadableError } from "../src/digest-inputs";

/**
 * R-385 T3: the bcdev backend's Microsoft mode reads `System` and the `LethAL Control` package
 * from the server (`fetchPublishedAppPackage`) and the installed versions and the running control
 * version through the deployment's harness verifier. With no verifier it throws, so no caller can
 * fall back to declared versions by accident.
 */

const CFG = {
  mcpCommand: ["bun", "x", "bc-dev-mcp"],
  project: "/project",
  server: "http://Cronus284",
  serverInstance: "BC",
  packageCachePath: "/cache",
  controlSymbolPath: "/control.app",
};

describe("BcDevMcpBackend.microsoftMode (R-385 T3)", () => {
  it("is wired to fetchPublishedAppPackage and the deployment's harness verifier", async () => {
    const calls: string[] = [];
    const harnessVerifier = {
      fetchInstalledVersions: async (id: string) => {
        calls.push(`installed ${id}`);
        return ["28.4.1.0"];
      },
      fetchControlVersion: async () => {
        calls.push("controlVersion");
        return "1.0.0.20";
      },
    };
    const backend = new BcDevMcpBackend(CFG, undefined, {
      harnessVerifier,
    } as unknown as BcDevDeployment);
    const sys = new Uint8Array([1]);
    const ctl = new Uint8Array([2]);
    backend.fetchPublishedAppPackage = async (app) => {
      calls.push(`package ${app.publisher}/${app.name}`);
      return app.name === "System" ? sys : ctl;
    };
    const mode = backend.microsoftMode();
    if (mode.kind !== "bytes") throw new Error("expected bytes mode");
    expect(await mode.readSystem()).toBe(sys);
    expect(await mode.readControl()).toBe(ctl);
    expect(await mode.controlVersion()).toBe("1.0.0.20");
    expect(await mode.installed("dd0be2ea-f733-4d65-bb34-a28f4624fb14")).toEqual(["28.4.1.0"]);
    expect(calls).toEqual([
      "package Microsoft/System",
      "package LethAL/LethAL Control",
      "controlVersion",
      "installed dd0be2ea-f733-4d65-bb34-a28f4624fb14",
    ]);
  });

  it("throws DependencyUnreadableError when the backend has no harness verifier", () => {
    expect(() => new BcDevMcpBackend(CFG).microsoftMode()).toThrow(DependencyUnreadableError);
  });
});
