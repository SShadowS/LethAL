import type { MicrosoftMode } from "../../src/digest-inputs";
import { CONTROL_APP_ID } from "../../src/harness";
import { buildFakeAppWithEntries } from "./fake-app";

/**
 * R-385: a server for the dependency fingerprint's bytes mode. It holds a `System` package and a
 * `LethAL Control` package (version 1.0.0.20, no dependency) that the running control app also
 * reports, and every Microsoft app is installed at `installed` (default 1.0.0.0, the version
 * test packages are built at).
 */
const NS = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';
const pkgOf = (id: string, name: string, publisher: string, version: string) =>
  new Uint8Array(
    buildFakeAppWithEntries({
      "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package ${NS}><App Id="${id}" Name="${name}" Publisher="${publisher}" Version="${version}" /></Package>`,
      "src/X.al": `// ${name}`,
    }),
  );
const SYSTEM = pkgOf("8874ed3a-0643-4247-9ced-7a7002f7135d", "System", "Microsoft", "28.0.0.0");
const CONTROL = pkgOf(CONTROL_APP_ID, "LethAL Control", "LethAL", "1.0.0.20");

export function fakeMicrosoftMode(installed = "1.0.0.0"): MicrosoftMode {
  return {
    kind: "bytes",
    readSystem: async () => SYSTEM,
    readControl: async () => CONTROL,
    controlVersion: async () => "1.0.0.20",
    installed: async () => [installed],
  };
}
