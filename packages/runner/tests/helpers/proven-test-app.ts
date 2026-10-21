import {
  type MicrosoftMode,
  appInputsOfPackage,
  dependencyFingerprint,
  publishedPackageReader,
  targetOf,
} from "../../src/digest-inputs";
import { readAppIdentity } from "../../src/published-test-app";
import { buildFakeAppWithEntries } from "./fake-app";
import { fakeMicrosoftMode } from "./microsoft-mode";

/**
 * R495: what a real bcdev backend gives a session and the in-memory fakes lacked: the SERVED
 * test-app package and the server's installed versions. With both, the run's test-app identity is
 * proven (exactly one installed row at the package's own version) and resume, history and the R192
 * snapshot may use it. A fake without them records no identity and lends nothing, as it should.
 */
export const TEST_APP = {
  id: "5b1f0c3e-7a2d-4e6b-9c8f-1d2e3f4a5b6c",
  name: "Sandbox Tests",
  publisher: "LethAL",
} as const;

/** The test project's own `app.json`, which names the package the session asks the server for. */
export function testAppJson(version = "1.0.0.0"): string {
  return JSON.stringify({ ...TEST_APP, version });
}

/** A served test-app package: a manifest at `version`, no source and no SymbolReference.json (so
 *  no compiled membership and no published digests: the same suite and evidence as no read). */
export function testAppPackage(version = "1.0.0.0", tag = ""): Uint8Array {
  const NS = 'xmlns="http://schemas.microsoft.com/navx/2015/manifest"';
  return new Uint8Array(
    buildFakeAppWithEntries({
      "NavxManifest.xml": `<?xml version="1.0" encoding="utf-8"?><Package ${NS}><App Id="${TEST_APP.id}" Name="${TEST_APP.name}" Publisher="${TEST_APP.publisher}" Version="${version}" />${tag}</Package>`,
    }),
  );
}

/** The two members a fake bcdev backend needs for a proven identity: it serves `pkg`, installed
 *  at its own version. Spread into a fake (`Object.assign`) or delegated to by its class. */
export function servesTestApp(pkg: Uint8Array | null = testAppPackage()): {
  fetchPublishedAppPackage: () => Promise<Uint8Array | null>;
  microsoftMode: () => MicrosoftMode;
} {
  return {
    fetchPublishedAppPackage: async () => pkg,
    microsoftMode: () => servedIsInstalled(() => pkg),
  };
}

/** R496: the dependency fingerprint a session against `servesTestApp(pkg)` records for the target
 *  project in `projectDir`, for a seeded row that must match it. */
export async function servedTestAppDeps(
  projectDir: string,
  pkg: Uint8Array = testAppPackage(),
): Promise<string> {
  return dependencyFingerprint(
    appInputsOfPackage(pkg),
    publishedPackageReader(async () => pkg),
    servedIsInstalled(() => pkg),
    await targetOf(projectDir),
  );
}

/** A server whose one installed row of the test app is at the version of the package it serves
 *  now (`served()`), as after an ordinary publish. A failed read (`null`) installs nothing. */
export function servedIsInstalled(served: () => Uint8Array | null): MicrosoftMode {
  const base = fakeMicrosoftMode();
  if (base.kind !== "bytes") throw new Error("fakeMicrosoftMode is not bytes mode");
  return {
    ...base,
    installed: async (id) => {
      if (id !== TEST_APP.id) return base.installed(id);
      const pkg = served();
      return pkg === null ? [] : [readAppIdentity(Buffer.from(pkg)).version];
    },
  };
}
