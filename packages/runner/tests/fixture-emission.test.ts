import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import { readTargetSource } from "../src/baseline-snapshot";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";
import { removeScratchDir } from "./helpers/scratch";

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
 * R830: sandbox-hang re-pinned because `OnAdvance()` replaced `Advance()`, so the gate's two hangs
 * stay unseen. Same 38 mutants, same lines. Old pins: HangLogic 2ccc5295...5746, manifest 40400e1a...5ba5.
 * R827 (2026-11-06): every `.al` pin re-pinned because a procedure body's `empty-block` mutant is now
 * one guard around the body (`if MutationSelector.Active(..) then begin .. end else begin BODY end`),
 * not a chain that repeats the body, and a loop mutant inside such a body is rooted at the outermost
 * loop. No manifest moved (all five unchanged), so no id, count or site moved. Old pins, first 8 hex:
 * sandbox-app SandboxLogic 07afac62, SandboxPricing 1e5744a5; sandbox-data DataAssertOps ab73e45d,
 * DataBandExt 025ae45e, DataBlankOps f533a3a7, DataBuilder b9de376e, DataCaseOps 3f030ad6,
 * DataCommitOps 99eb5191, DataCommitTarget 3d800d0e, DataFilterOps b7adf2fd, DataFindOps 0bc7e137,
 * DataFlagOps a7950aef, DataKeyProbe 1bd2c8d3, DataLoader 1df7ee23, DataMain 397e4ce9, DataMainExt
 * 36d5d31c, DataMainListExt f05ff067, DataNoTrigger e01beb62, DataOps 0092f7e5, DataReachOps
 * 86b232cc, DataScopeProbe.Page 63474c13, DataScopeProbe.Table 8537eac8, DataSetOps 2802bdbb,
 * DataShadow 1ac5a1a1, DataShiftOps aeeaa486, DataSwapOps 5967a188, DataTemporalOps a88dce47,
 * DataTriggerProbe afd58b9a, DataValidateOps 22735e25, DataValidator 3723407e, DataValueCard
 * 21636922, DataValueSource 409a0625; sandbox-hang HangLogic 20cbe37f; sandbox-harden HardenEntry
 * fd355c9c, HardenLogic 151acc80; sandbox-coverage-probe CoverageCapabilityProbe 1ad0b031,
 * FrameAndResetProbe 1bcb1b8a, TwoObjects 7f36f6c3.
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
        "f60c3c531c755e221f53b2fd675e1bd5bcf8492591217deed87f5e9fafec0625",
      "SandboxPricing.Codeunit.al":
        "1594daff22976e160993e51f0cd2e9595006c0f474d3dc96793eb4bcb15cac0b",
      "mutant-manifest.json": "4fd76b888e08ca727d7a72fe8ac5ada5c6f4ef3f6828502b8e31cf6aef705081",
    },
  },
  "sandbox-data": {
    selectorIds: { selectorId: 79399, controlId: 79398, tableId: 79397 },
    hashes: {
      "DataAssertOps.Codeunit.al":
        "270006411e9d91dbbaa231b5f29da6d249295f2b688e4535facfcf90666e0faa",
      "DataBandExt.ReportExt.al":
        "42be14151c35e9e50005a40821f31e76458d7e93cbaf609d11646c23b50d088a",
      "DataBlankOps.Codeunit.al":
        "688ee8d2ebb2bb83dd4d5ba4b779f165637584165566ed26d8864ceed3ec8f20",
      "DataBuilder.Codeunit.al": "278d59a40b6b962fdf7c835e64e288d50f3b9dcbcd3391dc7bd83be48c617c4f",
      "DataCaseOps.Codeunit.al": "7df950745b608834fdaded961a45420c3d17b9c956cf97af9f39bde4c6b41172",
      "DataCommitOps.Codeunit.al":
        "de2b88ee3be85e8e4f57f9749b34fe813602d7d0d151918dd6dfb835145b0061",
      "DataCommitTarget.Codeunit.al":
        "3442060ab3de457f1209fd7b4f0f88ead580e997232e8492676035e0a8a1d8c1",
      "DataFilterOps.Codeunit.al":
        "da346ea36c7e5845b1acf2322456160ba9fb034b9837f2c0dc3f3a87bcd7324b",
      "DataFindOps.Codeunit.al": "4caf98b986504a70fec364a132268e626ea55f1cf22949086070f3b0a89dd4e2",
      "DataFlagOps.Codeunit.al": "b55bc5088950d10d86a04a22a0b6612d647b416ea7adfd830823c84ce4f0607f",
      "DataKeyProbe.Table.al": "9da482410b26f55b46acb397ea89bf028c37279fede9da23ac3a99773d227822",
      "DataLoader.Codeunit.al": "d17b56c556c59239164f325aa1919a51f39d6e2ce3c50ed75ec984c9526e7a1b",
      "DataMain.Table.al": "56ad3a36d0331353ef81e8c1f43e6ad4d1a53d1d21e4d876ea8e68b1b17b8f86",
      "DataMainExt.TableExt.al": "0915223f80a9a479689f49298847c0d741957ed3b34fefcf926e12a4c6c5c35e",
      // R750: re-pinned (was c5e2fd4c...30acf, ruling orchestrator 2026-10-25): its header
      // comment, rewritten at the same length.
      "DataMainListExt.PageExt.al":
        "325a3213fde150dcf74163a10892532f16bcdb1675a3e484ae1a2179eb99d5b1",
      "DataNoTrigger.Table.al": "c7bc50e8f94ea85287843d177fb614300e69a016ef397a97100b27bcb9c0d53e",
      "DataOps.Codeunit.al": "e1eb3509a79f13462857029b4bad25e3091aa5eaca304a22dd6177fbad7ddc93",
      "DataReachOps.Codeunit.al":
        "9ce8dbe187cef495ee712bf4be5116cdd35c186e2c75db19749c96eabeb04883",
      "DataScopeProbe.Page.al": "8b9cfc8cfb83eb967de5515bc11f153c77bf963720491754596c9fc8a8f860ff",
      "DataScopeProbe.Table.al": "f5d07dafe8c3ea777090d519986247219efe486855c7c0841a0ab4ba2a4954b2",
      "DataSetOps.Codeunit.al": "bcd9d83f9ccf58b79cad1c9c6b68fbfd459c2479d09a5c883f6f9e0b39cd9084",
      "DataShadow.Table.al": "b88284780928b2171a5a11b3dd5b597aae40e59f28114837ffea9fd08defcd72",
      "DataShiftOps.Codeunit.al":
        "77bfaa33f1d9668976cfd39c245eb9306d76efe7ae3a0f39cab3302d08016111",
      "DataSwapOps.Codeunit.al": "8ad4f0f7ecd8a4e1d47389bd2b7caf2903d1098e9fd23960197afad628af617e",
      "DataTemporalOps.Codeunit.al":
        "8b03ab43e1f4cda29e5d34bc94d90e2aefbb66b7089be31c3a83e827fde8351e",
      "DataTriggerProbe.Table.al":
        "bed481b7c87ced717ec52112335bdff2c1cd6797c224c05a18e43d074030f236",
      "DataValidateOps.Codeunit.al":
        "36e7651f45293db2b96c21813bea2b658f7c6d70cb8ee43f61c245be9db6710c",
      "DataValidator.Codeunit.al":
        "f7f9428f9b4e4101a4197038ff9aa8052c41f875361b66f9ed908129971c3b6e",
      "DataValueCard.Page.al": "0dd2ac7ba88f0f664208eddb744751bee8f07b3137e6b29ba465304b9f605d48",
      "DataValueSource.Codeunit.al":
        "b5d1dd11eda90d367b36f2d082a7c6748a3c5ec8249e597a4c87e450d3898a8e",
      "MutationRegister.Codeunit.al":
        "bcaa8ed28992b8e244a4174e2235c57575f3677c37de65fd7318c3b41b891830",
      "MutationSelector.Codeunit.al":
        "10f84b6c16637b24e3ab5ce39dad281d9ceeaef74f9033d9ec5872a34e135842",
      "MutationUpgrade.Codeunit.al":
        "eb4fb1455bd9f0a1bbc15dda24fd1c61669959332c36c8861d66a56daf44ebe8",
      "mutant-manifest.json": "ba517a9f9c971e8c762ab2d617d181c7abb5a00efd6c2019576a52ecad5536d4",
    },
  },
  "sandbox-hang": {
    selectorIds: { selectorId: 79449, controlId: 79448, tableId: 79447 },
    hashes: {
      "HangLogic.Codeunit.al": "91301c66d76f8fa96fa441c47f3d46a2f64b22e2e132c3be70d0e4e792469bde",
      "MutationRegister.Codeunit.al":
        "5dc811a3a1661531502dd68b7da0849c7973a76bb2fb04486ccb595b0e7acbab",
      "MutationSelector.Codeunit.al":
        "03da5adb8c426958a6549fc03d174e5bbadba7aa150538881de3adecc8f6105f",
      "MutationUpgrade.Codeunit.al":
        "ecc6b99d40ce7e6bf92be1e73c0c8609cffa268684613158cb32e8513e317f59",
      "mutant-manifest.json": "e0d56ec6482ae91b33750d8aa2f9a49ad22a1a05d5396fbfb88ca8e3d08f2741",
    },
  },
  "sandbox-harden": {
    selectorIds: { selectorId: 79549, controlId: 79548, tableId: 79547 },
    hashes: {
      "HardenEntry.Table.al": "2a8e9896486108a6b7844fdd30efbfb66d54bdec2e3f27ac3dc5d2b7e6834b0c",
      "HardenLogic.Codeunit.al": "94ff487e79dc5a554b8cdb82cea39af00ac89dc5a26cad293c0302e8458e32dc",
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
        "06f39e043557e71125a17f83f10350a5c515af39b655a1b2e22a009bd9ee2696",
      "FrameAndResetProbe.Codeunit.al":
        "c0d079d69cf708ad5b8a22cdbae688a29777570b565205ca6525fb9f501a871f",
      "MutationRegister.Codeunit.al":
        "1aa4b2864eb595876331cc2243269bff718b4416cc6857a3a50f279d4f73b4d6",
      "MutationSelector.Codeunit.al":
        "92665291bf3ca3853f231cc5d821b0e70b422d8b6d3eb8a5637befdbde752879",
      "MutationUpgrade.Codeunit.al":
        "42b5f8d119d822359366db5b0c776be4c7c03690f9ab04ae8d5ebfa219370dd1",
      "TwoObjects.Codeunit.al": "4b023bcc20014c33fadf340e6363696aa02687d7e87b67340bfc70cb26f26b43",
      "mutant-manifest.json": "22fc823657a020d97521bed837e726f2c1c70f6bddb5fa8acdde31833742659a",
    },
  },
};

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) removeScratchDir(d);
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
