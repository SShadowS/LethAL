import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import { readTargetSource } from "../src/baseline-snapshot";
import { generateMutationSet, operatorTiers } from "../src/orchestrator";

/**
 * R-297 review r1 (minor): the fixture byte-identity claim was a scratch comparison. RUST-03 S1.5
 * extends it to all five fixtures: every emitted file except `app.json`, by sha256, with a fixed
 * artifact id and per-fixture selector ids (the top three ids of that fixture's own `idRanges`, so
 * the emitted output is what a real run could produce). sandbox-app's hashes are the R-297 Task 0
 * BEFORE capture (base `2ab111a`), unchanged. The other four were captured under WASM at
 * `98876ffa`; the native switch (RUST-03 S3) must leave every value unchanged (pre-commitment Q3).
 *
 * R421: the five `mutant-manifest.json` pins were re-recorded in the one `/` form every platform
 * now writes for a discovered path (they were the Windows `\` form: 5db0c7e3, 0ae3b2f7, 3d4d0238,
 * 3c3f0bde and a6d004e2 for the five fixtures in the order below). No other pin moved, and the
 * R411 shim that rewrote `/` to `\` on other hosts is gone. Each fixture is also emitted from a
 * `\`-keyed snapshot (the shape a Windows read gives) and must give the same hashes.
 *
 * A deliberate emission change (a new operator finding a site here, say) re-pins these values in
 * the same commit, and says so.
 */
const PINNED: Record<
  string,
  {
    selectorIds: { selectorId: number; controlId: number; tableId: number };
    hashes: Record<string, string>;
  }
> = {
  "sandbox-app": {
    selectorIds: { selectorId: 79199, controlId: 79198, tableId: 79197 },
    hashes: {
      "MutationRegister.Codeunit.al":
        "f53090ac30665fb4a555c7908a59480b27edd7c2de5b4211567611ef83c821bd",
      "MutationSelector.Codeunit.al":
        "10d1c6b17cf465a4a272e4f8a795d408dceb950d160fd37c90f49671eecfffbb",
      "MutationUpgrade.Codeunit.al":
        "185c89c06210c95fd6b0d5cd920f7b4fcf48f39e8877477ebb69a6ead72a9482",
      "SandboxLogic.Codeunit.al":
        "07afac62dc7a9cdd4958bd31b2688e4e021d6c98cb72cab958620cbc877a2e00",
      "SandboxPricing.Codeunit.al":
        "1e5744a518bf3df186ba3ce9495745bfe0d68efde8f6eac615c235c1567083cc",
      "mutant-manifest.json": "24960578e7b86f7ee0d6009295ec27c714ad429e6c82c717d2f1a36bf1be5641",
    },
  },
  "sandbox-data": {
    selectorIds: { selectorId: 79399, controlId: 79398, tableId: 79397 },
    hashes: {
      "DataAssertOps.Codeunit.al":
        "ab73e45da78c6edd02e17cf89592632809f5de666029cdb79dbe96f91c41c217",
      "DataBlankOps.Codeunit.al":
        "51f10bf158b11aa07bb4ffc8166aaacfe8af8e71d726ae153f3e2dfd8b493203",
      "DataBuilder.Codeunit.al": "f7b80bfbbbed9c401333d8d6a6c86f2165f9e3d3811ac70096285e64241075b0",
      "DataCaseOps.Codeunit.al": "719a5b369982cec7e88124279702aeb80eb33e6f13da798318c2d2f483926dbd",
      "DataCommitOps.Codeunit.al":
        "042a1761904971746cca2afdf7bf195e237f5b96217fef905dc076643ac3a56a",
      "DataCommitTarget.Codeunit.al":
        "8262d3168ee7150da470195d4a3266bab96c07189409eb0ae57f0ce1239ff705",
      "DataFilterOps.Codeunit.al":
        "71f4efefb12ceb2b5f7557cf5f5b5f9dddb25b54af6065443fc4a2833f3ff47f",
      "DataFindOps.Codeunit.al": "6c6eba6213b0744e1c83233d8db35cf94493d282fc11c501c435cb10e795855b",
      "DataFlagOps.Codeunit.al": "da78ee0608b8e8ccb2d3cd8e0d47d713ec246d68cdbf5804f0f1e846d83ba1f7",
      "DataKeyProbe.Table.al": "394b9ed4c3462dbf39f03ad0701d283ab764147d3ffd41226d40e01695f722fa",
      "DataLoader.Codeunit.al": "d4c21aef679dbf6e7cda3c7e203f1d77caae9b60c85011a30d2d42b57f53b20d",
      "DataMain.Table.al": "72a06305ed7a6c4803f638c1e4e22ae3358cdae9ade15d63cb9aeaddf985da18",
      "DataMainExt.TableExt.al": "e5e91ce2188b9e320e43a4102f20911d3d6a7265f4b4d318460e41915b98c088",
      "DataMainListExt.PageExt.al":
        "c1c60d413b41a6f39cee1dbb1186c9a2a7bb80040e3cc45118a4a1b8892f7646",
      "DataNoTrigger.Table.al": "15cb9fe58160e5ccc31794cad09bcb95cccabe9d3a3897f64d60dfa60b509a96",
      "DataOps.Codeunit.al": "49237ed804de3ac3c336092a91de0b3bf26918207cffc5d69535d2e94056fac3",
      "DataReachOps.Codeunit.al":
        "4fd2e5671c136fe64fcc4a728a641a7d8d9531dd5b94c4d83ee27ae09a84f0f6",
      "DataScopeProbe.Page.al": "764bf3e2b31c5f50554fbd9a9e362a62cc9868c85c2e322c20a623fb8dc11b9f",
      "DataScopeProbe.Table.al": "4d6333f185e87aaa8bd7d4a54866293fe7bea0b174a44399d6b699936ea82fa2",
      "DataSetOps.Codeunit.al": "281216eeae2058508d488875ad938f576730bb587cec83c177c2e8df436f2dfb",
      "DataShadow.Table.al": "257f7ef65dccf54d695b06b244d1a0b0a80cfb59aad04d91c2f49bb88ca7767b",
      "DataShiftOps.Codeunit.al":
        "b9874effb8aa3b4d9874fe9e42a3d44e68bf17b5eff4dbea96702ba4fc6ca8dc",
      "DataSwapOps.Codeunit.al": "db494f1dbe8e6a75712165ee3700139e81fa2f7da4ac08ff5f1c769751d7929c",
      "DataTemporalOps.Codeunit.al":
        "b2c61d54a8e7c743bd701f5490072981c289d7a3a4534f9912ed226193d52b98",
      "DataTriggerProbe.Table.al":
        "822936cbef436467d2968f7ad742bfee5bfce6abccad033ff33a62e86e5b10b5",
      "DataValidateOps.Codeunit.al":
        "9bffd1b34774090e8ebec8541fd2bc415e5539935524039e03bd6a2b868d70ab",
      "DataValidator.Codeunit.al":
        "03fae50678a777875624c9b4cbfd98b5b44b792b03012aa846d8315e3b201751",
      "DataValueCard.Page.al": "efab3edeb832a3ba4998de8e64e4f5a129e4c246381cb4b9e190c7b379ba6017",
      "DataValueSource.Codeunit.al":
        "f6ec5508b511228dac6e7322fe25517a0415dab998659d33d99d59c0ae6bcec6",
      "MutationRegister.Codeunit.al":
        "bcaa8ed28992b8e244a4174e2235c57575f3677c37de65fd7318c3b41b891830",
      "MutationSelector.Codeunit.al":
        "10f84b6c16637b24e3ab5ce39dad281d9ceeaef74f9033d9ec5872a34e135842",
      "MutationUpgrade.Codeunit.al":
        "eb4fb1455bd9f0a1bbc15dda24fd1c61669959332c36c8861d66a56daf44ebe8",
      "mutant-manifest.json": "90fa82e468b6c90a88a73bb74bf9e55c0c19cd56a07bcccdc8cbce976ca317ba",
    },
  },
  "sandbox-hang": {
    selectorIds: { selectorId: 79449, controlId: 79448, tableId: 79447 },
    hashes: {
      "HangLogic.Codeunit.al": "977eb7bb07ca49400fda1c94d8bb021579f0032217e15a4d145f5cae97e9ef67",
      "MutationRegister.Codeunit.al":
        "5dc811a3a1661531502dd68b7da0849c7973a76bb2fb04486ccb595b0e7acbab",
      "MutationSelector.Codeunit.al":
        "03da5adb8c426958a6549fc03d174e5bbadba7aa150538881de3adecc8f6105f",
      "MutationUpgrade.Codeunit.al":
        "ecc6b99d40ce7e6bf92be1e73c0c8609cffa268684613158cb32e8513e317f59",
      "mutant-manifest.json": "f7b49d85171168e3a2403e55ad69b077fc1ab6645ecf44492b7d9de2de1f86e6",
    },
  },
  "sandbox-harden": {
    selectorIds: { selectorId: 79549, controlId: 79548, tableId: 79547 },
    hashes: {
      "HardenEntry.Table.al": "fd355c9c7b54d6dfb4de6d1c357f90a89e787c90ff2614fb5d3e11bf9b57fccc",
      "HardenLogic.Codeunit.al": "151acc8080b530f374d26846f91e575723510608015a51371421ad101b30a43e",
      "MutationRegister.Codeunit.al":
        "d5323d90636f04e1f396e0ee09abbda22c3f73f2b54c87d8486f84b1277d9a05",
      "MutationSelector.Codeunit.al":
        "761229a7c2c2edaa674509cd00a51e53118742a676a957645d3d33cb3f30966d",
      "MutationUpgrade.Codeunit.al":
        "4a52c84af5a27079132374f5737fb95f13d9721f616e70c2b62f83e6d90d7378",
      "mutant-manifest.json": "71fe65be7ce4ae7a5e342f67b084fa48c92d7d241fcddb74ab18fa18b40094b4",
    },
  },
  "sandbox-coverage-probe": {
    selectorIds: { selectorId: 79329, controlId: 79328, tableId: 79327 },
    hashes: {
      "CoverageCapabilityProbe.Codeunit.al":
        "1ad0b031fab68a3618d27ccdf856821ef7bb6f4f646761500f0465eb3c19535a",
      "FrameAndResetProbe.Codeunit.al":
        "1bcb1b8a2a9f1a2cfc3fe8cd516c1c738b7db815378fc5a14e874820942e8b69",
      "MutationRegister.Codeunit.al":
        "1aa4b2864eb595876331cc2243269bff718b4416cc6857a3a50f279d4f73b4d6",
      "MutationSelector.Codeunit.al":
        "92665291bf3ca3853f231cc5d821b0e70b422d8b6d3eb8a5637befdbde752879",
      "MutationUpgrade.Codeunit.al":
        "42b5f8d119d822359366db5b0c776be4c7c03690f9ab04ae8d5ebfa219370dd1",
      "TwoObjects.Codeunit.al": "7f36f6c33258728c6dfdec37e742730e48627e4f0e92cd325184a1c444b2f740",
      "mutant-manifest.json": "da594088aba11817ac3a5d78f17c931d82f1f30b506b17588cc7365e40cc63cc",
    },
  },
};

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

for (const [fixture, { selectorIds, hashes }] of Object.entries(PINNED)) {
  test(`${fixture}'s emitted files are byte-identical to the WASM capture, and its ids lie inside its idRanges`, async () => {
    const fixtureDir = join(import.meta.dir, "../../../fixtures", fixture);
    const appJson = JSON.parse(await readFile(join(fixtureDir, "app.json"), "utf8")) as {
      idRanges: ReadonlyArray<{ from: number; to: number }>;
    };
    for (const id of [selectorIds.selectorId, selectorIds.controlId, selectorIds.tableId]) {
      expect(appJson.idRanges.some((r) => id >= r.from && id <= r.to)).toBe(true);
    }

    const emitHashes = async (
      options?: Parameters<typeof generateMutationSet>[1],
    ): Promise<Record<string, string>> => {
      const targetDir = await mkdtemp(join(tmpdir(), "lethal-fixture-emission-"));
      dirs.push(targetDir);
      const set = await generateMutationSet(fixtureDir, options);
      await writeInstrumentedProject({
        targetDir,
        files: set.files,
        selectorIds,
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: "00000000-0000-0000-0000-000000000000",
        operatorTiers,
      });
      const got: Record<string, string> = {};
      for (const name of (await readdir(targetDir, { recursive: true })).map(String).sort()) {
        if (name === "app.json") continue;
        const bytes = await readFile(join(targetDir, name));
        got[name.split("\\").join("/")] = createHash("sha256").update(bytes).digest("hex");
      }
      return got;
    };

    expect(await emitHashes()).toEqual(hashes);

    // R421: the same files read the way Windows reads them (every key written with `\`) must
    // give the same bytes, so one expected value holds for both input forms on any host.
    const winSource = new Map<string, Buffer>();
    for (const [k, v] of await readTargetSource(fixtureDir)) {
      winSource.set(k.split("/").join("\\"), v);
    }
    expect(await emitHashes({ source: winSource, platform: "win32" })).toEqual(hashes);
  });
}
