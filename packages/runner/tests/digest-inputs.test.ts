import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AppDependency,
  DependencyUnreadableError,
  appInputsOfAppJson,
  appInputsOfManifest,
  dependencyFingerprint,
  readAppJsonInputs,
} from "../src/digest-inputs";
import { buildFakeAppWithEntries } from "./helpers/fake-app";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

const DEP = "22222222-2222-2222-2222-222222222222";
const SUB = "33333333-3333-3333-3333-333333333333";
const MS = "44444444-4444-4444-4444-444444444444";

const manifest = (id: string, name: string, publisher: string, deps = "") =>
  `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${id}" Name="${name}" Publisher="${publisher}" Version="1.0.0.0" /><Dependencies>${deps}</Dependencies></Package>`;
const depTag = (id: string, name: string, publisher: string) =>
  `<Dependency Id="${id}" Name="${name}" Publisher="${publisher}" MinVersion="1.0.0.0" />`;
/** A package of app `id`, whose bytes differ by `build` at an unchanged version. */
const pkg = (id: string, name: string, publisher: string, build: string, deps = "") =>
  new Uint8Array(
    buildFakeAppWithEntries({
      "NavxManifest.xml": manifest(id, name, publisher, deps),
      "src/X.al": `// build ${build}`,
    }),
  );

const root = (publisher: string, id = DEP) =>
  appInputsOfAppJson({ dependencies: [{ id, name: "Dep", publisher, version: "1.0.0.0" }] });

describe("R-371: digest-inputs", () => {
  test("a manifest and the app.json it was built from give equal build inputs", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="${DEP}" Name="T" Publisher="P" Version="1.0.0.0" Runtime="16.0" Target="Cloud" Application="27.0.0.0" Platform="27.0.0.0" /><Features><Feature>NOIMPLICITWITH</Feature><Feature>TRANSLATIONFILE</Feature></Features><PreprocessorSymbols><PreprocessorSymbol>CLEAN</PreprocessorSymbol></PreprocessorSymbols></Package>`;
    const json = {
      runtime: "16.0",
      application: "27.0.0.0",
      platform: "27.0.0.0",
      features: ["TranslationFile", "NoImplicitWith"],
      preprocessorSymbols: ["CLEAN"],
    };
    expect(appInputsOfManifest(xml).buildInputs).toBe(appInputsOfAppJson(json).buildInputs);
    // And it is not equal by being empty: another symbol set differs.
    expect(appInputsOfManifest(xml).buildInputs).not.toBe(
      appInputsOfAppJson({ ...json, preprocessorSymbols: [] }).buildInputs,
    );
  });

  test("a non-Microsoft dependency rebuilt at an UNCHANGED version changes the fingerprint", async () => {
    const at = (build: string) =>
      dependencyFingerprint(root("Other"), async () => [pkg(DEP, "Dep", "Other", build)]);
    expect(await at("one")).not.toBe(await at("two"));
    expect(await at("one")).toBe(await at("one"));
  });

  test("a transitive non-Microsoft dependency is read too", async () => {
    const at = (build: string) =>
      dependencyFingerprint(root("Other"), async (d: AppDependency) =>
        d.id === DEP
          ? [pkg(DEP, "Dep", "Other", "same", depTag(SUB, "Sub", "Other"))]
          : [pkg(SUB, "Sub", "Other", build)],
      );
    expect(await at("one")).not.toBe(await at("two"));
  });

  // The stated limit (filed on the roadmap): a Microsoft dependency is fingerprinted by id and
  // version only, so a rebuild at the same version is NOT seen.
  test("a Microsoft dependency rebuilt at an unchanged version does not change it (the stated limit)", async () => {
    let n = 0;
    const read = async () => [pkg(MS, "Lib", "Microsoft", String(++n))];
    const a = await dependencyFingerprint(root("Microsoft", MS), read);
    const b = await dependencyFingerprint(root("Microsoft", MS), read);
    expect(a).toBe(b);
    expect(n).toBe(0);
  });

  // Review r1 #4: a test project's app.json that cannot be read is never read as empty inputs.
  test("a missing or unparseable test-project app.json throws, never empty inputs", async () => {
    const missing = scratch("lethal-appjson-missing-");
    await expect(readAppJsonInputs(missing)).rejects.toBeInstanceOf(DependencyUnreadableError);
    const broken = scratch("lethal-appjson-broken-");
    writeFileSync(join(broken, "app.json"), '{"name": "T", ');
    await expect(readAppJsonInputs(broken)).rejects.toBeInstanceOf(DependencyUnreadableError);
    const ok = scratch("lethal-appjson-ok-");
    writeFileSync(join(ok, "app.json"), '{"runtime": "16.0"}');
    expect((await readAppJsonInputs(ok)).buildInputs).toBe(
      appInputsOfAppJson({ runtime: "16.0" }).buildInputs,
    );
  });

  test("an unreadable non-Microsoft dependency throws, never a partial fingerprint", async () => {
    await expect(dependencyFingerprint(root("Other"), async () => null)).rejects.toBeInstanceOf(
      DependencyUnreadableError,
    );
  });
});
