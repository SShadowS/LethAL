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
 * R470: `DataBandExt.ReportExt.al` re-pinned because its selector var is now
 * `MutationSelector79341` (its own object id), declared and called; its only change (it was
 * 758b11c9...74cb). The manifest is unchanged.
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
      "DataBandExt.ReportExt.al":
        "2b82077f0c0403a3785e7c2e0a3cba5eb364681fc70dcd5aafec9ed43b8dbab7",
      "DataBlankOps.Codeunit.al":
        "ce3170f1504ede010a162a31fbb39d3951c62e9c4eedcfda2e3a9c75621f9654",
      "DataBuilder.Codeunit.al": "ddb5175a823eaee47cca8ce55b9c725851c4ade9dca086fcd37b20c897a29b88",
      "DataCaseOps.Codeunit.al": "7dd90fbbbc824ed0460b2ba269e2ff6368ffcc136ff6cb9409a1fe23d3ca9f12",
      "DataCommitOps.Codeunit.al":
        "561c34b0d088c0a7be33e7ebea9234f6df051ece70a492da9257fc711d691625",
      "DataCommitTarget.Codeunit.al":
        "60ded8763f1bd23aec222dde5c2c8ccf5f3450b2cbbc8866a283298687a77943",
      "DataFilterOps.Codeunit.al":
        "cb2830f50870b3194d61c4d7c81ae87c56e3e39afe99ae44d79c15a1d8ad31f2",
      "DataFindOps.Codeunit.al": "fc4c3ec6afc5815746e21d08686294436f29c5ce71ea7bfe6744ebc877a59eb2",
      "DataFlagOps.Codeunit.al": "d7e07b2daf04ca8f5e044e670e258077321eb6033075b42f6e5522fd7ffd8d28",
      "DataKeyProbe.Table.al": "bc3094c8025138a91078fd40ccc61db79bd9aed902d18579ff05aae7c6273bea",
      "DataLoader.Codeunit.al": "1c10abbbfc02603d846b29a564dca8f7c6a8c5acb422cd37c1995e5e3d1dba36",
      "DataMain.Table.al": "63198d2227bb93407be8365d12ccea2b984d96834241625534e2515f1522abf6",
      "DataMainExt.TableExt.al": "85d18f756b30fcf51ba91e7a2270014a407519b64e501f6c84b9ca44e2e5ed2d",
      "DataMainListExt.PageExt.al":
        "5e1dfcdfc2333e504d92a413a46311c19f3a6d93caa889b79e9addee5ca78b5f",
      "DataNoTrigger.Table.al": "26f155efdfb7bce6d0b860160c65a10c60a72adf96695088fdcbb93a94230162",
      "DataOps.Codeunit.al": "35095c29940b067fdde79e228778cdf82932be740cfef9c74e2a0ace1d019b40",
      "DataReachOps.Codeunit.al":
        "dda14cf5c81daea8754b921a55cb0c342260c0535ec537c432db86e1f66f0d00",
      "DataScopeProbe.Page.al": "df59eb9c79f1e8e423fad0e8a2baea672ff8ccf0c2a68b6c0b61ac7e242ad3bd",
      "DataScopeProbe.Table.al": "1f69862c13b6793847407ef276a8aa65ebf87ac582f82cf57f33a98a62952ce0",
      "DataSetOps.Codeunit.al": "bfc7099e3881ebc4ac9fad649ffd70e69d296d7f90991c0ce388e54f3d44515a",
      "DataShadow.Table.al": "1dfab812d695fe460aaecec1f35183db8f5af0f4a6f96f6cdbdff0c12d9cbbd7",
      "DataShiftOps.Codeunit.al":
        "9ec2277f1d5e939a9c030218646971bcba9580833f959a88f4e8ad4be3874f1b",
      "DataSwapOps.Codeunit.al": "7d0047ec24b6dce06fa0ff6324da4ac9b195bfac170833f85ba2f66221f5bea9",
      "DataTemporalOps.Codeunit.al":
        "bca26a659700e89315f98dd40b11d6dbe6ae973ea10d68b850a522cdc3760ce1",
      "DataTriggerProbe.Table.al":
        "f8592636efcaa4c6841369490f41e34cc39295ce40971067dca8d833df2e7c90",
      "DataValidateOps.Codeunit.al":
        "276886dcfbee16c2ac56066f34d624550959741cfb7fc06cfe0ac47fa2e44005",
      "DataValidator.Codeunit.al":
        "d87d3036a015385e05f864dd73a72e1ae5c99108f5a430b070d755847336b4b6",
      "DataValueCard.Page.al": "41d469aae497927a40830bf5f23830e749c9462782ecd3664e5fc3d39b715375",
      "DataValueSource.Codeunit.al":
        "25b9ec1c1a7b1d1bf6b009e28456fcca9e1462fea5aba6d102f057a921be3af7",
      "MutationRegister.Codeunit.al":
        "bcaa8ed28992b8e244a4174e2235c57575f3677c37de65fd7318c3b41b891830",
      "MutationSelector.Codeunit.al":
        "10f84b6c16637b24e3ab5ce39dad281d9ceeaef74f9033d9ec5872a34e135842",
      "MutationUpgrade.Codeunit.al":
        "eb4fb1455bd9f0a1bbc15dda24fd1c61669959332c36c8861d66a56daf44ebe8",
      "mutant-manifest.json": "eda8a3244f0b83b5ba85123b052c154bc104da676530206aca0860bf125e7379",
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
      "mutant-manifest.json": "cdfb8da1c27398281faa615f9665812eca960ab4d5eaae74047b0f54669cdd3b",
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
