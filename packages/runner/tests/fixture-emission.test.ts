import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";

/**
 * R-297 review r1 (minor): the fixture byte-identity claim was a scratch comparison. This pins it
 * for ONE fixture, `fixtures/sandbox-app`: every emitted file except `app.json`, by sha256, with a
 * fixed artifact id and selector ids. The hashes are the R-297 Task 0 BEFORE capture (base
 * `2ab111a`), so a change to instrumentation that moves this fixture's emission fails here.
 *
 * A deliberate emission change (a new operator finding a site here, say) re-pins these values in
 * the same commit, and says so.
 */
const PINNED: Record<string, string> = {
  "MutationRegister.Codeunit.al":
    "f53090ac30665fb4a555c7908a59480b27edd7c2de5b4211567611ef83c821bd",
  "MutationSelector.Codeunit.al":
    "10d1c6b17cf465a4a272e4f8a795d408dceb950d160fd37c90f49671eecfffbb",
  "MutationUpgrade.Codeunit.al": "185c89c06210c95fd6b0d5cd920f7b4fcf48f39e8877477ebb69a6ead72a9482",
  "SandboxLogic.Codeunit.al": "07afac62dc7a9cdd4958bd31b2688e4e021d6c98cb72cab958620cbc877a2e00",
  "SandboxPricing.Codeunit.al": "1e5744a518bf3df186ba3ce9495745bfe0d68efde8f6eac615c235c1567083cc",
  "mutant-manifest.json": "5db0c7e3d16b31f2c66a9bdfc042a9acda228ee93bd79923d4db5a529e179b78",
};

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test("sandbox-app's emitted files are byte-identical to the R-297 BEFORE capture", async () => {
  const targetDir = await mkdtemp(join(tmpdir(), "lethal-fixture-emission-"));
  dirs.push(targetDir);
  const set = await generateMutationSet(join(import.meta.dir, "../../../fixtures/sandbox-app"));
  await writeInstrumentedProject({
    targetDir,
    files: set.files,
    selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: "00000000-0000-0000-0000-000000000000",
    operatorTiers,
  });
  const got: Record<string, string> = {};
  for (const name of (await readdir(targetDir, { recursive: true })).map(String).sort()) {
    if (name === "app.json") continue;
    got[name.split("\\").join("/")] = createHash("sha256")
      .update(await readFile(join(targetDir, name)))
      .digest("hex");
  }
  expect(got).toEqual(PINNED);
});
