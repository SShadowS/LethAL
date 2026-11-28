// PR-479: builds the bcdev-client sidecar (packages/runner/client-driver, net8.0) into packages/runner/client-driver/out.
// The client library and the WCF set are NOT in the repo. Name them with --bc-client <dir> and --wcf <dir>, or with
// LETHAL_BC_CLIENT_DIR and LETHAL_WCF_DIR. The build refuses by name when either is missing.
// Usage: bun scripts/build-client-driver.ts --bc-client <dir> --wcf <dir>
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export class ClientDriverBuildError extends Error {
  constructor(
    readonly reason:
      | "client-library-missing"
      | "wcf-facade-missing"
      | "dotnet-missing"
      | "build-failed",
    message: string,
  ) {
    super(`${reason}: ${message}`);
    this.name = "ClientDriverBuildError";
  }
}

export const CLIENT_LIBRARY_DLL = "Microsoft.Dynamics.Framework.UI.Client.dll";
export const WCF_FACADE = join("net6.0", "System.ServiceModel.dll");

/** Checks both inputs by file; throws a named error. Pure apart from the file checks. */
export function checkClientDriverInputs(
  bcClient: string | undefined,
  wcf: string | undefined,
): void {
  if (bcClient === undefined || !existsSync(join(bcClient, CLIENT_LIBRARY_DLL))) {
    throw new ClientDriverBuildError(
      "client-library-missing",
      `${CLIENT_LIBRARY_DLL} not found in ${JSON.stringify(bcClient)} (--bc-client or LETHAL_BC_CLIENT_DIR)`,
    );
  }
  if (wcf === undefined || !existsSync(join(wcf, WCF_FACADE))) {
    throw new ClientDriverBuildError(
      "wcf-facade-missing",
      `${WCF_FACADE} not found in ${JSON.stringify(wcf)} (--wcf or LETHAL_WCF_DIR; the System.ServiceModel 4.10.3 set)`,
    );
  }
}

function findDotnet(): string {
  for (const c of ["/opt/dotnet/dotnet"]) if (existsSync(c)) return c;
  if (Bun.which("dotnet") !== null) return "dotnet";
  throw new ClientDriverBuildError("dotnet-missing", "no /opt/dotnet/dotnet and no dotnet on PATH");
}

export function buildClientDriver(bcClient: string | undefined, wcf: string | undefined): string {
  checkClientDriverInputs(bcClient, wcf);
  const project = resolve(import.meta.dir, "..", "packages", "runner", "client-driver");
  const out = join(project, "out");
  const r = Bun.spawnSync(
    [
      findDotnet(),
      "build",
      join(project, "client-driver.csproj"),
      "-c",
      "Release",
      "-o",
      out,
      `-p:BcClient=${resolve(bcClient ?? "")}`,
      `-p:Wcf=${resolve(wcf ?? "")}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (r.exitCode !== 0)
    throw new ClientDriverBuildError("build-failed", `dotnet build exited ${r.exitCode}`);
  return join(out, "client-driver.dll");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { "bc-client": { type: "string" }, wcf: { type: "string" } },
  });
  try {
    console.log(
      `built ${buildClientDriver(values["bc-client"] ?? process.env.LETHAL_BC_CLIENT_DIR, values.wcf ?? process.env.LETHAL_WCF_DIR)}`,
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
