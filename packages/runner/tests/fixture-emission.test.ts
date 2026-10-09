import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import { readTargetSource } from "../src/baseline-snapshot";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";

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
 * the same commit, and says so. R196: sandbox-hang's `HangLogic.Codeunit.al` and manifest were
 * re-pinned because its line-104 `remove-assignment` and `shift-integer` sites are now refused as
 * hang-capable (they were 977eb7bb...ef67 and f7b49d85...86e6). R281: sandbox-data's manifest was
 * re-pinned because `Data Flag Ops.DeleteWithTrigger`'s `Delete(true)` mutant now carries
 * `platformKillMechanism: run-trigger-skipped-delete`, its only change (it was 90fa82e4...17ba).
 * R-457: sandbox-data's manifest re-pinned because seven mutants (M0034, M0045, M0056, M0065,
 * M0186, M0223, M0362) gained `run-trigger-forced`, its only change (it was 65d75386...e4ea).
 * R254: sandbox-data's `DataBandExt.ReportExt.al` (a reportextension) is instrumented, 15 mutants
 * as M0005..M0019, so every file after `DataAssertOps` and the manifest re-pinned (ids +15; the
 * manifest was 245847db...a603).
 * R459: sandbox-data's manifest re-pinned for provenance only: its 13 `flip-boolean-literal`
 * entries carry operatorVersion 1.1.0 (it was eda8a324...7379). No site, tag or id moved.
 * R470: `DataBandExt.ReportExt.al` re-pinned because its selector var is now
 * `MutationSelector79341` (its own object id), declared and called; its only change (it was
 * 758b11c9...74cb). The manifest is unchanged by R470.
 * R474: all five manifests re-pinned because every entry gains `memberHash`, the only change:
 * each manifest with that key removed hashes to its old pin (sandbox-app 24960578...5641,
 * sandbox-data 257d5dde...752e, sandbox-hang cdfb8da1...dd3b, sandbox-harden 71fe65be...94b4,
 * sandbox-coverage-probe da594088...3cc). No `.al` file moved.
 * R477: sandbox-data's and sandbox-harden's manifests re-pinned for provenance only: their
 * `validate-to-assign` entries carry operatorVersion 1.2.0 (at 1.1.0 both hash to their old pins,
 * e01e5bc8...c9c0 and 523f3eec...9e3e). No site, tag or id moved.
 * R276: all five manifests re-pinned because a gap's id now hashes its LINE span and LF-normalised
 * text instead of its byte offsets and raw text (one id across a CRLF and an LF checkout). Only
 * `gapId` values moved: with each id replaced by its first-seen index the old and new manifests are
 * byte-identical for all five (same gap partition). No `.al` file moved; gap ids are not in the AL.
 * Old pins: sandbox-app f763eb7d...8ee3, sandbox-data 12c9b7f0...5a41, sandbox-hang
 * 26cc971e...c469, sandbox-harden d3a1c187...0a7a, sandbox-coverage-probe 7056d12b...172b.
 * R-463: sandbox-data re-recorded for R-463's DataBandExt arm, ruling orchestrator 2026-10-09.
 * DataBandExt gains 4 mutants; ids +4 after DataBandExt, proven in id-shift-proof.txt
 * (/coord/handoff/R-463/): every later file and every later manifest entry is byte-equal after
 * shifting its ids by 4. Old pins: DataBandExt 2b82077f...b7, manifest e746b230...c0.
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
      "mutant-manifest.json": "4fd76b888e08ca727d7a72fe8ac5ada5c6f4ef3f6828502b8e31cf6aef705081",
    },
  },
  "sandbox-data": {
    selectorIds: { selectorId: 79399, controlId: 79398, tableId: 79397 },
    hashes: {
      "DataAssertOps.Codeunit.al":
        "ab73e45da78c6edd02e17cf89592632809f5de666029cdb79dbe96f91c41c217",
      "DataBandExt.ReportExt.al":
        "025ae45e93d9bd19de05614e51d22fd03f6822e7c9ccbf52a51ff7a910b5e166",
      "DataBlankOps.Codeunit.al":
        "f533a3a7d6c6c49ee847a914fdeecfa84817e76c84bb0331662e613308a2b15e",
      "DataBuilder.Codeunit.al": "b9de376ea22f3316010fbe00a6cc140e6a789ec186a86de02d9e871dbaf9abd9",
      "DataCaseOps.Codeunit.al": "3f030ad65c2eee0e94cdaf8573afb666b536428cba9d224d4a10bd6d8041f434",
      "DataCommitOps.Codeunit.al":
        "99eb519102a70fa4df2b88543fdc45d5374ac8e4415fded7e906eee8a47ac735",
      "DataCommitTarget.Codeunit.al":
        "3d800d0ea5c6c4cfd364f638bcb8debfcc9d6e3fa8c0c41c0d70e202034ee3ba",
      "DataFilterOps.Codeunit.al":
        "b7adf2fd0ec894003c99661cde5d365059d1a1a67458ed215e23e381ed9ab61c",
      "DataFindOps.Codeunit.al": "0bc7e137a8df3e5b5c66d50afe461bdfa515ff740b61c2b7c368b0183f57f12f",
      "DataFlagOps.Codeunit.al": "a7950aef0aaeae6ae7359af6dcc00a9083ebfe9d0640ae043862a398dd08ab7c",
      "DataKeyProbe.Table.al": "1bd2c8d3e5f21ab8b2bf0c563381e20dfe62fd9718ce35ac06dd02b6b55e589f",
      "DataLoader.Codeunit.al": "1df7ee23504f75e9f58cc2b2c2413d0809d352148264c4a8ef9b7db00462d34d",
      "DataMain.Table.al": "397e4ce9557e060287efc322c53bcf8db5986f7a2d0c4a7fed59034fe2da1fc4",
      "DataMainExt.TableExt.al": "36d5d31c3912e9beb94492bf6cf5bf97f70f19a4128d148533cfd331dbe09659",
      "DataMainListExt.PageExt.al":
        "c5e2fd4c0d9b4d13a8ab21be34f1a2e6d2ef4121e2723e6af9be222537230acf",
      "DataNoTrigger.Table.al": "e01beb62030b536feb44b8042dce37412838e09091c3cfaff71d75034cbdfd21",
      "DataOps.Codeunit.al": "0092f7e5e289c9ce1c8e41a409e2f53dd4919c880074f86f010402ba57447f74",
      "DataReachOps.Codeunit.al":
        "86b232cc9dad38098224806fb6592ad17d3200432b929ef770f762df11a39ac7",
      "DataScopeProbe.Page.al": "63474c133fccfb8121ea89a5de732b6b887312ae7b4e8a2d41d13b45a6e32ec9",
      "DataScopeProbe.Table.al": "8537eac84c8b74ec864762261b208fc946f9474803365e3eff54f22e85487567",
      "DataSetOps.Codeunit.al": "2802bdbbb1c4371cf6c5aba5c88027f6b072ce41b87c3feb8db8185807bdccb7",
      "DataShadow.Table.al": "1ac5a1a11a3b793e23630ccab3862e0d26c41f73b48e136db9cb099cef2fa228",
      "DataShiftOps.Codeunit.al":
        "aeeaa486324108d25b1ddabd189c40ee245cdde67512aba450ceeda75bf8f3b4",
      "DataSwapOps.Codeunit.al": "5967a1880408edbc51ed12858adf5aac5171736d64fe8e20231edd200ce22f10",
      "DataTemporalOps.Codeunit.al":
        "a88dce47dd64c0d66d5cb4ff3afd907f65c573b9b82078b4facc85a206b93ca6",
      "DataTriggerProbe.Table.al":
        "afd58b9a08650f72ab656bade14f01492a323d62d0856b9fb5fc68d82fbb097c",
      "DataValidateOps.Codeunit.al":
        "22735e25ce515e22d8f0803a4618fdba52e77a2875afbb9dd9eadc33d8d7782f",
      "DataValidator.Codeunit.al":
        "3723407e8566011d4e35eec053cc3e12d24cf6776589677d4b5e05544b8dae93",
      "DataValueCard.Page.al": "216369229b40331eeef106fb632482e36e8da70522bf5d6e7b457d5109c46dbf",
      "DataValueSource.Codeunit.al":
        "409a062599381475e301d96601d74f7861b5e8f426339a9d191167ea3fcc96ef",
      "MutationRegister.Codeunit.al":
        "bcaa8ed28992b8e244a4174e2235c57575f3677c37de65fd7318c3b41b891830",
      "MutationSelector.Codeunit.al":
        "10f84b6c16637b24e3ab5ce39dad281d9ceeaef74f9033d9ec5872a34e135842",
      "MutationUpgrade.Codeunit.al":
        "eb4fb1455bd9f0a1bbc15dda24fd1c61669959332c36c8861d66a56daf44ebe8",
      "mutant-manifest.json": "dc32843f70fcc49e08d9305d7d6939a09bd241e3107d99a1d1026b41ae19c66c",
    },
  },
  "sandbox-hang": {
    selectorIds: { selectorId: 79449, controlId: 79448, tableId: 79447 },
    hashes: {
      "HangLogic.Codeunit.al": "2ccc529539ddd590aab5be08e801c316d3dcf67882ec1843953c340c5d9e5746",
      "MutationRegister.Codeunit.al":
        "5dc811a3a1661531502dd68b7da0849c7973a76bb2fb04486ccb595b0e7acbab",
      "MutationSelector.Codeunit.al":
        "03da5adb8c426958a6549fc03d174e5bbadba7aa150538881de3adecc8f6105f",
      "MutationUpgrade.Codeunit.al":
        "ecc6b99d40ce7e6bf92be1e73c0c8609cffa268684613158cb32e8513e317f59",
      "mutant-manifest.json": "40400e1aa18bd547daf5fe58136212f229e49afa329be1bf18bdaf5ea3825ba5",
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
      "mutant-manifest.json": "b1976c9ff371f7f7592374c1cb5eb3dce85504aec2bc52112ccfa2439fc7a53e",
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
      "mutant-manifest.json": "e7816e87aa6bad303e16e3dcba6fe81e369e12a104c3153b2dee05ea648e5e77",
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
        identityOrdinals: identityOrdinalsOf(set),
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
