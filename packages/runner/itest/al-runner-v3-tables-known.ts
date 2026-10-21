/**
 * R586 leg T (review M5): the 52 known differences between v3 alpha.2's own tables baseline and
 * BC's `tables.baseline.json`, pinned by KEY and by TRANSITION (BC verdict and killing test -> v3
 * verdict and killing test), as pre-committed in `/coord/handoff/R-586/precommitment-tables-52.txt`
 * (r2; dcdd1489 cites it): 41 Commit (#5607), 7 duplicate key (#5603), 4 TestPage.
 * Keys and test names only, no source text. A count of 52 that is not THESE 52 is a gate-fail.
 */

/** [key, BC verdict, v3 verdict, BC killing test, v3 killing test]. */
export type KnownDifference = readonly [string, string, string, string | null, string | null];

export const TABLES_KNOWN_DIFFERENCES: readonly KnownDifference[] = [
  ["0121538c88a9342b484d6597b43bf7bc9d138149790fb204378e0afae2086339|Data Key Probe|OnInsert|lethal.remove-assignment|1", "killed", "survived", "DoubleInsertWithoutKeyTriggerRaises", null],
  ["09ff97d93f42f97e455749d5569a45d6915c6c97429e86e2a519ac315ea17f9b|Data Value Card|OnAction|lethal.remove-assignment|1", "no-coverage", "killed", null, "PageActionComputesNonZero"],
  ["1b3e248d3e7bc05c1fdde76d54b76a1e545569932aa0ab4c88fc7b712b46c56c|Data Commit Ops|CommitThenFail|lethal.toggle-blank-string|1", "survived", "no-coverage", null, null],
  ["1b3e248d3e7bc05c1fdde76d54b76a1e545569932aa0ab4c88fc7b712b46c56c|Data Commit Ops|CommitThenRunValueForm|lethal.toggle-blank-string|1", "survived", "no-coverage", null, null],
  ["1b3e248d3e7bc05c1fdde76d54b76a1e545569932aa0ab4c88fc7b712b46c56c|Data Commit Ops|CommitThenRun|lethal.toggle-blank-string|1", "survived", "no-coverage", null, null],
  ["20aee8f9773c9ea9a8e7b90bd1b338ea9a6c871e10f9b4ec8af5b0204f201da4|Data Value Source|GetValue|lethal.return-value|1", "no-coverage", "killed", null, "PageActionComputesNonZero"],
  ["21b9d09e6b335a9ea96efe2e73caa285daff8086160ab3e20da1f26d24269d6f|Data Commit Ops|CommitThenFail|lethal.void-method-call|1", "survived", "no-coverage", null, null],
  ["21b9d09e6b335a9ea96efe2e73caa285daff8086160ab3e20da1f26d24269d6f|Data Commit Ops|CommitThenRunValueForm|lethal.void-method-call|1", "survived", "no-coverage", null, null],
  ["21b9d09e6b335a9ea96efe2e73caa285daff8086160ab3e20da1f26d24269d6f|Data Commit Ops|CommitThenRun|lethal.void-method-call|1", "survived", "no-coverage", null, null],
  ["251dd6161cf958c3f6113c2cd5b026ef28eea56795fffeae72fb0e4012b6bffe|Data Commit Ops|CommitThenFail|lethal.remove-assignment|1", "survived", "no-coverage", null, null],
  ["251dd6161cf958c3f6113c2cd5b026ef28eea56795fffeae72fb0e4012b6bffe|Data Commit Ops|CommitThenRunValueForm|lethal.remove-assignment|1", "survived", "no-coverage", null, null],
  ["251dd6161cf958c3f6113c2cd5b026ef28eea56795fffeae72fb0e4012b6bffe|Data Commit Ops|CommitThenRun|lethal.remove-assignment|1", "survived", "no-coverage", null, null],
  ["2c803bfacb04b831e6e6f26b4d200a42bad5b7cdb0014239df7d51bbeeb65aad|Data Commit Ops|CommitThenFail|lethal.remove-commit|1", "killed", "no-coverage", "CommittedWriteSurvivesFailure", null],
  ["2c803bfacb04b831e6e6f26b4d200a42bad5b7cdb0014239df7d51bbeeb65aad|Data Commit Ops|CommitThenRunValueForm|lethal.remove-commit|1", "killed", "no-coverage", "CommitBeforeValueFormCodeunitRunSucceeds", null],
  ["2c803bfacb04b831e6e6f26b4d200a42bad5b7cdb0014239df7d51bbeeb65aad|Data Commit Ops|CommitThenRun|lethal.remove-commit|1", "survived", "no-coverage", null, null],
  ["2d119c2ec73ab1ae52dbba9a46ff0f4bc4d1489684b7064c985ef4a94112ee7e|Data Key Probe|OnInsert|lethal.negate-conditional|1", "killed", "survived", "DoubleInsertWithoutKeyTriggerRaises", null],
  ["31c85a76e65c13426a668219969e39a8142b616aa307306f94a35e771add3abe|Data Commit Ops|CommitThenFail|lethal.flip-boolean-literal|1", "survived", "no-coverage", null, null],
  ["31c85a76e65c13426a668219969e39a8142b616aa307306f94a35e771add3abe|Data Commit Ops|CommitThenRunValueForm|lethal.flip-boolean-literal|1", "survived", "no-coverage", null, null],
  ["31c85a76e65c13426a668219969e39a8142b616aa307306f94a35e771add3abe|Data Commit Ops|CommitThenRun|lethal.flip-boolean-literal|1", "survived", "no-coverage", null, null],
  ["31c85a76e65c13426a668219969e39a8142b616aa307306f94a35e771add3abe|Data Commit Target|OnRun|lethal.flip-boolean-literal|1", "survived", "no-coverage", null, null],
  ["36aa6c656ce535d1f8e169d85419fcc897eec77e830ec1df81f4fe55b0704890|Data Commit Ops|CommitThenRunValueForm|lethal.remove-assignment|1", "killed", "no-coverage", "CommitBeforeValueFormCodeunitRunSucceeds", null],
  ["40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Data Commit Ops|CommitThenRunValueForm|lethal.return-value|1", "killed", "no-coverage", "CommitBeforeValueFormCodeunitRunSucceeds", null],
  ["4361e50c375e40305819b2dc3eae9e1dc245b3115684696da23bf724133c00aa|Data Commit Ops|CommitThenRun|lethal.empty-block|1", "killed", "no-coverage", "CommitBeforeCodeunitRunSucceeds", null],
  ["51c6e78adf06c3aa8581ffef24239e94d80d1bba49338f443290f9c3c885d01c|Data Commit Ops|CommitThenRunValueForm|lethal.remove-assignment|1", "survived", "no-coverage", null, null],
  ["62c04a6be11a180cf46d6c011b0700a891749b44dca1780ff2e501c6de19acb1|Data Commit Ops|CommitThenRun|lethal.remove-assignment|1", "survived", "no-coverage", null, null],
  ["637aa2af14e55ecf9861ea851a23f1ede61feeb72f8de7759d4fe738d201f242|Data Commit Target|OnRun|lethal.flip-boolean-literal|1", "killed", "no-coverage", "CommitBeforeCodeunitRunSucceeds", null],
  ["68807988b56909e3568b38e2441cfed9a27441ece816cf15fd358ffb9231098e|Data Commit Ops|CommitThenRun|lethal.shift-integer|1", "survived", "no-coverage", null, null],
  ["69ab2635d97b4a033d6979b89c9577ff9099ed31bfcdea22e425161990f85c56|Data Commit Ops|CommitThenFail|lethal.void-method-call|1", "killed", "no-coverage", "CommittedWriteSurvivesFailure", null],
  ["69ab2635d97b4a033d6979b89c9577ff9099ed31bfcdea22e425161990f85c56|Data Commit Ops|CommitThenRunValueForm|lethal.void-method-call|1", "killed", "no-coverage", "CommitBeforeValueFormCodeunitRunSucceeds", null],
  ["69ab2635d97b4a033d6979b89c9577ff9099ed31bfcdea22e425161990f85c56|Data Commit Ops|CommitThenRun|lethal.void-method-call|1", "killed", "no-coverage", "CommitBeforeCodeunitRunSucceeds", null],
  ["82190937ce0dbddcf71b05b35fd9eb0f09f2a141e69489fc6a34db4db510a3b7|Data Commit Ops|CommitThenRunValueForm|lethal.shift-integer|1", "survived", "no-coverage", null, null],
  ["835565180cc5c8787adf0255e105ebb308eeb1338b48576812c5b5c9fdebb0d3|Data Commit Ops|CommitThenFail|lethal.remove-assignment|1", "killed", "no-coverage", "CommittedWriteSurvivesFailure", null],
  ["84c847b650bf8648e34378707b482a1468e5cc8759ea3b61e0c8b3057312314d|Data Commit Ops|CommitThenRunValueForm|lethal.empty-block|1", "killed", "no-coverage", "CommitBeforeValueFormCodeunitRunSucceeds", null],
  ["89a8f14203bc6c1a5b29130d054755d7cefe81df70216cb61972f009ff752f23|Data Commit Ops|CommitThenFail|lethal.void-method-call|1", "killed", "no-coverage", "CommittedWriteSurvivesFailure", null],
  ["93bd96d69f211dd205aecc3b89564e852d93da1caa1d6eda69f4f3421b07c7a6|Data Commit Target|OnRun|lethal.empty-block|1", "killed", "no-coverage", "CommitBeforeCodeunitRunSucceeds", null],
  ["a811b46c95a74b761966dc4d0fd260793ba4c503b9cc6c7efd6e554acb7563d8|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.remove-assignment|1", "killed", "survived", "DoubleInsertWithoutKeyTriggerRaises", null],
  ["b473f0f8762594047a5f52777f0ab590b94174b0b7816a51a572d18cad81f853|Data Commit Ops|CommitThenFail|lethal.empty-block|1", "killed", "no-coverage", "CommittedWriteSurvivesFailure", null],
  ["b7639fc5337117f99a11c177444ce8ba186aec121acbabc26086c752caa4f696|Data Commit Ops|CommitThenFail|lethal.shift-integer|1", "survived", "no-coverage", null, null],
  ["c26a0352dd867ea75f70b4b0bf99771e3bc838482b57fa9794099fafe15799ad|Data Commit Ops|CommitThenRunValueForm|lethal.remove-assignment|1", "killed", "no-coverage", "CommitBeforeValueFormCodeunitRunSucceeds", null],
  ["c26a0352dd867ea75f70b4b0bf99771e3bc838482b57fa9794099fafe15799ad|Data Commit Ops|CommitThenRun|lethal.remove-assignment|1", "killed", "no-coverage", "CommitBeforeCodeunitRunSucceeds", null],
  ["c3ad0133a594bdcda453d6356d7f363351bede0c37c658750a3a22e227ba75fc|Data Commit Target|OnRun|lethal.void-method-call|1", "killed", "no-coverage", "CommitBeforeCodeunitRunSucceeds", null],
  ["c418f4efb9e88904a396ba326ed4e788592cd0b41c807f2df0eda67c887d28b3|Data Value Source|GetValue|lethal.empty-block|1", "no-coverage", "killed", null, "PageActionComputesNonZero"],
  ["c88702df06dca2c0edbdf144edf99c2682ad63278023dbd7e46f42c9875e0364|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.toggle-blank-string|1", "killed", "survived", "DoubleInsertWithoutKeyTriggerRaises", null],
  ["c88702df06dca2c0edbdf144edf99c2682ad63278023dbd7e46f42c9875e0364|Data Key Probe|OnInsert|lethal.toggle-blank-string|1", "killed", "survived", "DoubleInsertWithoutKeyTriggerRaises", null],
  ["ca03e7de5d868e018e122d4dac889646e338f75ed2cc3e073bed40be863c7bee|Data Commit Target|OnRun|lethal.remove-assignment|1", "killed", "no-coverage", "CommitBeforeCodeunitRunSucceeds", null],
  ["cc8317f3018759ab8d5178fa9aff18f1c4de59a37d62241236cb641c95e55eca|Data Commit Ops|CommitThenRun|lethal.void-method-call|1", "killed", "no-coverage", "CommitBeforeCodeunitRunSucceeds", null],
  ["d15e08235aa3c09dd4023cff2d05ecdf0ddfad254da6c0f01337975c78c26724|Data Commit Ops|CommitThenFail|lethal.remove-assignment|1", "survived", "no-coverage", null, null],
  ["d36581a980ee091d62faf54b2a4512ee7cb1db33aea2a4f417a5edde7ef9d79f|Data Commit Target|CommitRunNo|lethal.empty-block|1", "killed", "no-coverage", "CommitBeforeCodeunitRunSucceeds", null],
  ["dc163959e27f18f7fac841fc750f3aca67d4c1c66de23fd6555791c827d092c2|Data Value Card|OnAction|lethal.empty-block|1", "no-coverage", "killed", null, "PageActionComputesNonZero"],
  ["dd3aa023aa7fb2b7893efe181ccbf517d3ca97cbfacec07f3818c25c45c127dc|Data Key Probe|OnInsert|lethal.empty-block|1", "killed", "survived", "DoubleInsertWithoutKeyTriggerRaises", null],
  ["e315168a52168bfbb4fcedaf685fb51f456c87a33eb1879f610f29a75cfaebed|Data Commit Target|OnRun|lethal.remove-not|1", "killed", "no-coverage", "CommitBeforeCodeunitRunSucceeds", null],
  ["e75f9a0967677be80d3659fdc47e601d3764ac75077fb4d25c54b5f1322b2a8a|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.swap-modify-flag|1", "killed", "survived", "DoubleInsertWithoutKeyTriggerRaises", null],
];
