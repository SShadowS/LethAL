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
 * R926: the five `mutant-manifest.json` pins were re-recorded for the new `reachLine` field on
 * statement-grain entries (was 445fe1b9, 5621d39c, e0d56ec6, b1976c9f, 94d3a5fc). Every `.al` pin
 * is unchanged: the instrumented text did not move.
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
 * R828 O1 (2026-11-06): 15 `.al` pins re-pinned because a statement with its own mutants copies
 * itself plain and its nested mutants are their own components. No manifest moved. Old pins, first 8
 * hex: sandbox-app SandboxLogic f60c3c53; sandbox-data DataBandExt 42be1415, DataBlankOps 688ee8d2,
 * DataCaseOps 7df95074, DataFindOps 4caf98b9, DataKeyProbe 9da48241, DataMainListExt 325a3213,
 * DataReachOps 9ce8dbe1, DataScopeProbe.Table f5d07daf, DataSetOps bcd9d83f, DataShiftOps 77bfaa33;
 * sandbox-hang HangLogic 91301c66; sandbox-harden HardenLogic 94ff487e; sandbox-coverage-probe
 * CoverageCapabilityProbe 06f39e04, FrameAndResetProbe c0d079d6.
 * R855: new delete-additive/logical mutants and swap-call-arguments 1.1.0. sandbox-app, sandbox-data
 * and sandbox-coverage-probe re-pinned (manifest included). In sandbox-data the project-wide M-codes
 * of later mutants shift (DataBlankOps M0024 -> M0025), so files with no new mutant moved too.
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
        "81b6685fc63799431742bc4b4958b9a0b733695816339e9ae7f700a5882bfeb7",
      "SandboxPricing.Codeunit.al":
        "60b12340761b9a80841a842bfc2d1a3c5964be3997275895f469f2b7973671a5",
      // R984: shift-integer comparison operands gain `equivalenceRisk` (was 6edb3f7e...370e).
      "mutant-manifest.json": "6408068d3dcdf3196ece6d1f683cec2f6b44d1ec8fac3c07da0ab22c713248ff",
    },
  },
  "sandbox-data": {
    selectorIds: { selectorId: 79399, controlId: 79398, tableId: 79397 },
    hashes: {
      "DataAssertOps.Codeunit.al":
        "270006411e9d91dbbaa231b5f29da6d249295f2b688e4535facfcf90666e0faa",
      "DataBandExt.ReportExt.al":
        "818930dfb722b7a0d8f792149431cb95b88d7a21710888e244324e9532be2c7f",
      "DataBlankOps.Codeunit.al":
        "ec70e12f106efd215861b380b28e3f29ae403253427473b5d1db0432ba9d38b6",
      "DataBuilder.Codeunit.al": "da1f87d9bbf3b61f0235036f78f429a7b8360b1ba953441cd2e5d8f92eb245c2",
      "DataCaseOps.Codeunit.al": "5a9e3a2f04fe235b4637b1aca28d6383a488d4e45bafb9893fa2449dcd1ace16",
      "DataCommitOps.Codeunit.al":
        "fd1492d9ef115c081fff7055ddc86ea75ce58cd2884c040f4f4798f3f07a87e2",
      "DataCommitTarget.Codeunit.al":
        "0ad5e79eb2beaa4c4e69b9d2eff68702c34f1ccddf40a7b80a4a8f5c593a4b67",
      "DataFilterOps.Codeunit.al":
        "599874b7079f68ae1ecc9033a5b9d1515ed531660014f2a9350dbccb09d4cf4a",
      "DataFindOps.Codeunit.al": "b1c536704e638db1a24c8c2c69956168d44d317d13d7f570ec4fc176a3a01c4a",
      "DataFlagOps.Codeunit.al": "e661e06c76fcc41922e53434324db0501d92262181c63a3cd7d2bf0e89b650c3",
      "DataKeyProbe.Table.al": "0d1e8125a32af2d01e079ded965d265b7e619ed8831adb67ce8b1df33231ae5b",
      "DataLoader.Codeunit.al": "016b83ed32e15c116425d060a682c8f02c6769487de009d8d43d2ea79d4de901",
      "DataMain.Table.al": "f3cb8e593e56b65c8bf381e3602f7c7e15834e21aa539d5384541dab3c7c9708",
      "DataMainExt.TableExt.al": "bf59c859e776d6ed745e58cdfafce0fa958207136dd3ddce9c66cb253295f891",
      // R750: re-pinned (was c5e2fd4c...30acf, ruling orchestrator 2026-10-25): its header
      // comment, rewritten at the same length.
      "DataMainListExt.PageExt.al":
        "be0e1b5ad0e5b2adeff3fceb98bc68be9bd52d2a97ef45406389b4bd36abd4f9",
      "DataNoTrigger.Table.al": "3220d66ddfb3a811ca43674cc9ea6a87e7763b4319af792b3d1974c2db3808b4",
      "DataOps.Codeunit.al": "6d334f4de8b902dd0329972b1eb128bd15f7d49c9c1a08f38071ee4c646a8afe",
      "DataReachOps.Codeunit.al":
        "d8fc1149a6bcec913aea8ab51f615245cfb7b758ff07a831882eab9bf6924031",
      "DataScopeProbe.Page.al": "8ea6e5a4c036b46c79e3b448dd56afdc9e5a8145ecd6d0ddacf0eefed2d0e0cd",
      "DataScopeProbe.Table.al": "aabc3b1d88bfc2b17af45cd8e2efe48e26917820f2d3ff0a623af8a376171bfd",
      "DataSetOps.Codeunit.al": "3801138600ce3eac4e2da2c21cd428beff02dd2c60a8cb4cdbc1842a70194bfb",
      "DataShadow.Table.al": "f40b7126896f82bce96d193c226aef38decd5f8f0c617ac99a37538f62b6fba8",
      "DataShiftOps.Codeunit.al":
        "37761b180d9ce890d680e69f6dd130bcd35d428c573a2e30eeb69664147245f4",
      "DataSwapOps.Codeunit.al": "557893e879496f058906ee9edad3627e995c56f15412f22c7b71e419840566f9",
      // R985: the Date and DateTime stand-ins 17530101D -> 17530103D, the only change (was f40de380...e742).
      "DataTemporalOps.Codeunit.al":
        "3b668a7d067e3bfb58321d0f2570601def1359c380f0d1668efd0f88857112dd",
      "DataTriggerProbe.Table.al":
        "f722703a696d9c7341e35f4d89dd8d2b0d680f3fad61aaabb046b6917bb27cfc",
      "DataValidateOps.Codeunit.al":
        "4838404b4c599b5fbaad31758410e2b0a461d329012f552dfde0b31df4565327",
      "DataValidator.Codeunit.al":
        "fca3aa7639857eb53c18060023f855910835e5d3cdb694304e925479245cde2a",
      "DataValueCard.Page.al": "7d1b26be0d1be13acd6bcab8814e1c8e8f113c5d4f94f4dc44926ae39fa52842",
      "DataValueSource.Codeunit.al":
        "84a943a3ea15e1b96fd474070fa7fac98b0494d76c6ace948633801d92295969",
      "MutationRegister.Codeunit.al":
        "bcaa8ed28992b8e244a4174e2235c57575f3677c37de65fd7318c3b41b891830",
      "MutationSelector.Codeunit.al":
        "10f84b6c16637b24e3ab5ce39dad281d9ceeaef74f9033d9ec5872a34e135842",
      "MutationUpgrade.Codeunit.al":
        "eb4fb1455bd9f0a1bbc15dda24fd1c61669959332c36c8861d66a56daf44ebe8",
      // R983: comparison blank toggles gain `equivalenceRisk` (was 71d0df78...eaa3).
      // R984/R985: shift-integer comparison operands gain it; toggle-blank-temporal 2.0.0 and its
      // Date/DateTime stand-in 17530103D (was 93541eea...7a67).
      "mutant-manifest.json": "e4f5b67ac05e708be5fc4034a36f023a6d4850ffb64372b414adc53d521db2e6",
    },
  },
  "sandbox-hang": {
    selectorIds: { selectorId: 79449, controlId: 79448, tableId: 79447 },
    hashes: {
      "HangLogic.Codeunit.al": "88c3269458897e10c2102051e832b10b8e217db54c2fd3c5d0c78c6bc2e3a0d9",
      "MutationRegister.Codeunit.al":
        "5dc811a3a1661531502dd68b7da0849c7973a76bb2fb04486ccb595b0e7acbab",
      "MutationSelector.Codeunit.al":
        "03da5adb8c426958a6549fc03d174e5bbadba7aa150538881de3adecc8f6105f",
      "MutationUpgrade.Codeunit.al":
        "ecc6b99d40ce7e6bf92be1e73c0c8609cffa268684613158cb32e8513e317f59",
      "mutant-manifest.json": "46c8966f800d1fdbeb41a3500be81c37f5a4e10dcd2d969173d23ecc9ed327f6",
    },
  },
  "sandbox-harden": {
    selectorIds: { selectorId: 79549, controlId: 79548, tableId: 79547 },
    hashes: {
      "HardenEntry.Table.al": "2a8e9896486108a6b7844fdd30efbfb66d54bdec2e3f27ac3dc5d2b7e6834b0c",
      "HardenLogic.Codeunit.al": "bf5f852bfa8d231e99bcf3ba78460e5203b52268562c528cac2b005fe83044c7",
      "MutationRegister.Codeunit.al":
        "d5323d90636f04e1f396e0ee09abbda22c3f73f2b54c87d8486f84b1277d9a05",
      "MutationSelector.Codeunit.al":
        "761229a7c2c2edaa674509cd00a51e53118742a676a957645d3d33cb3f30966d",
      "MutationUpgrade.Codeunit.al":
        "4a52c84af5a27079132374f5737fb95f13d9721f616e70c2b62f83e6d90d7378",
      "mutant-manifest.json": "12bcdc9dba86a43e763a5a78f5f77cd32b539233b15c7568abdb144a612ee65f",
    },
  },
  "sandbox-coverage-probe": {
    selectorIds: { selectorId: 79329, controlId: 79328, tableId: 79327 },
    hashes: {
      "CoverageCapabilityProbe.Codeunit.al":
        "0b1167b0c34c11b16cb2f256834d32e3a4834c11d92c444cbc4dcd6044001634",
      "FrameAndResetProbe.Codeunit.al":
        "75d46e4bd14e28c5e726f7c2d201b41a139f55de6b14c84e5a842dae9f9f0d9b",
      "MutationRegister.Codeunit.al":
        "1aa4b2864eb595876331cc2243269bff718b4416cc6857a3a50f279d4f73b4d6",
      "MutationSelector.Codeunit.al":
        "92665291bf3ca3853f231cc5d821b0e70b422d8b6d3eb8a5637befdbde752879",
      "MutationUpgrade.Codeunit.al":
        "42b5f8d119d822359366db5b0c776be4c7c03690f9ab04ae8d5ebfa219370dd1",
      "TwoObjects.Codeunit.al": "23476d029bcd1039edc22e111202acbcad46bcd79257e5090faaf0189eedb8d0",
      // R983: comparison blank toggles gain `equivalenceRisk` (was 5693e720...c6af).
      // R984: shift-integer comparison operands gain it (was 86338b48...de4c).
      "mutant-manifest.json": "93e9f276cf3736b4cc455c9b52ccffca1d4f2fb06cc4f4481652e7435fc64e38",
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
