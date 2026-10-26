/**
 * R586c: per-build pins for the al-runner v3 update gate (design `/coord/handoff/R-586c/design.md`,
 * pre-commitment r18). A pin names, for ONE exact binary, the readings that differ from alpha.2's
 * expectations and are known and accepted. An entry passes only when the reading equals the pinned
 * one; nothing outside the table is covered; a build with no pin is judged as before.
 *
 * S5: a pin for a build that is or was `current` is never removed (a later `--regate` needs it).
 * Pure: no IO. The one value import is the hub text, bound by `r586c-pins.test.ts`.
 */
import { type V3ContractResult, v3MuteKey } from "./al-runner-v3-contract";
import { BC_HTTP_HUB_TEXT } from "./al-runner-v3-texts";

const REPO = "https://github.com/aldevtools/BusinessCentral.AL.Runner/issues";

/**
 * M2: the logged text byte for byte, every regex special character escaped, `{n}` a number and
 * (with `{ cut: true }`, sleep-is-noop alone) `{cut}` the rest of a cut message. Anchored, no flags.
 */
export function pinPattern(template: string, o: { readonly cut?: boolean } = {}): RegExp {
  const tokens = o.cut === true ? /(\{n\}|\{cut\})/ : /(\{n\})/;
  const body = template
    .split(tokens)
    .map((part) => {
      if (part === "{n}") return String.raw`\d+`;
      if (o.cut === true && part === "{cut}") return '[^"]*';
      return part.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${body}$`);
}

export interface LegCPin {
  readonly verdict: "gone" | "refused";
  readonly measured: RegExp;
  /** Only sleep-is-noop: the no-flag wall is under 1000 ms. */
  readonly extra?: (measured: string) => boolean;
  readonly bc: "matches" | "differs";
  readonly issue?: string;
  readonly evidence: string;
}

export interface TRowPin {
  readonly key: string;
  /**
   * The committed baseline's row this pin replaces, compared exactly. Absent: survived/null/null
   * (R586c S4, the only shape before edge-8078bcf49, whose rows move from no-coverage too).
   */
  readonly from?: {
    readonly verdict: string;
    readonly errorClass: string | null;
    readonly killingTest: string | null;
  };
  readonly verdict: "error" | "killed" | "survived" | "no-coverage";
  readonly errorClass: string | null;
  readonly killingTest: string | null;
  readonly issue: string;
}

export interface XbPin {
  readonly exitCode: 3;
  readonly passed: 0;
  readonly notRun: 0;
}

export interface V3BuildPin {
  readonly id: string;
  /** The exact `--version` line. */
  readonly version: string;
  readonly binarySha256: string;
  readonly legC: Readonly<Record<string, LegCPin>>;
  readonly legT: {
    readonly rows: readonly TRowPin[];
    readonly counts: {
      readonly killed: number;
      readonly survived: number;
      readonly noCoverage: number;
    };
    readonly total: number;
    /** The refused tests leg T must read; absent: 3 (alpha.5's). */
    readonly refusedTests?: number;
  };
  readonly xb: XbPin;
  /**
   * R782: #5798 is fixed upstream on this build: a serve test row carries `codeunit` and `method`
   * beside `name`, also for a dotted method. Only a pin with this flag lets serve-entries read the
   * row's own fields (`serveRowFieldsFor`); every other build keeps the name-only parse.
   */
  readonly serveRowFields?: {
    readonly issue: string;
    readonly evidence: string;
  };
  /**
   * R771 addendum 2: the WorkDate O1's CDO set reads on a build that runs Base Application's login
   * code (`LogInManagement.GetDefaultWorkDate`, the last G/L entry's date in the restored CRONUS demo
   * company of the CDO set's BC build). Every CDO Reader entry must read exactly it.
   */
  readonly o1?: {
    readonly cdoWorkDate: string;
    readonly issue: string;
    readonly evidence: string;
  };
}

const ROW = (cu: number, method: string) =>
  `{"codeunit":${cu},"method":"${method}","name":"Codeunit${cu}.${method}"`;

const noFlagUnderASecond = (measured: string): boolean => {
  const m = /; no flag: (\d+) ms$/.exec(measured);
  return m?.[1] !== undefined && Number(m[1]) < 1000;
};

const T_KEYS = [
  "a811b46c95a74b761966dc4d0fd260793ba4c503b9cc6c7efd6e554acb7563d8|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.remove-assignment|1",
  "c88702df06dca2c0edbdf144edf99c2682ad63278023dbd7e46f42c9875e0364|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.toggle-blank-string|1",
  "e75f9a0967677be80d3659fdc47e601d3764ac75077fb4d25c54b5f1322b2a8a|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.swap-modify-flag|1",
  "dd3aa023aa7fb2b7893efe181ccbf517d3ca97cbfacec07f3818c25c45c127dc|Data Key Probe|OnInsert|lethal.empty-block|1",
  "2d119c2ec73ab1ae52dbba9a46ff0f4bc4d1489684b7064c985ef4a94112ee7e|Data Key Probe|OnInsert|lethal.negate-conditional|1",
  "c88702df06dca2c0edbdf144edf99c2682ad63278023dbd7e46f42c9875e0364|Data Key Probe|OnInsert|lethal.toggle-blank-string|1",
  "0121538c88a9342b484d6597b43bf7bc9d138149790fb204378e0afae2086339|Data Key Probe|OnInsert|lethal.remove-assignment|1",
];

/**
 * The readings of alpha.5 (07342060e). The edge build `3.0.0-alpha.5+edge.20261024 (dcdf9e821)` was
 * measured IDENTICAL on every pinned reading (R756, evidence in /coord/handoff/R-756/), so both pins
 * share this one object and cannot drift. A later delta for either build must SPLIT this constant
 * into two first; never edit it in place (that would change the other build's pin).
 */
const ALPHA5_READINGS: Pick<V3BuildPin, "legC" | "legT" | "xb"> = {
  legC: {
    "none-selected-exit": {
      verdict: "gone",
      measured: pinPattern("exit 6, stdout 0 rows"),
      bc: "matches",
      evidence: "r7: the fix LethAL asked for in #5613 (a CLI shape, not a BC question)",
    },
    "quoted-name-unselectable": {
      verdict: "gone",
      measured: pinPattern("exit 0"),
      bc: "matches",
      evidence: "#5572 closed; LethAL selects by codeunit, never by name (design 2.1, S1)",
    },
    "refusal-cascade": {
      verdict: "gone",
      measured: pinPattern(
        `[${ROW(50654, "LaterFails")},"status":"fail","durationMs":{n},"message":"later","notRun":false}] exit 1`,
      ),
      bc: "matches",
      evidence: "#5610 closed: a plain Error() test fails with its own text, as BC does (r9 §4)",
    },
    "sleep-is-noop": {
      verdict: "gone",
      measured: pinPattern(
        `N=3: {n} ms [${ROW(50660, "ShortSleep")},"status":"pass","durationMs":{n},"notRun":false},${ROW(50660, "LongSleepA")},"status":"error","durationMs":{n},"message":"Test e{cut}; no flag: {n} ms`,
        { cut: true },
      ),
      extra: noFlagUnderASecond,
      bc: "matches",
      evidence:
        "verdict class only (r11 at 120 s); wall time and durationMs are not BC's (virtual clock; the backend guard keeps a virtual stop from being scored)",
    },
    "upstream-compile-errors": {
      verdict: "gone",
      measured: pinPattern("exit 3 null"),
      bc: "matches",
      evidence: "#5602 closed: BC never runs an app that does not compile (X (a), X (b))",
    },
    "refusal-row-shape": {
      verdict: "gone",
      measured: pinPattern(
        `[${ROW(50653, "HttpGet")},"status":"fail","durationMs":{n},"message":"${BC_HTTP_HUB_TEXT}","notRun":false}] exit 1`,
      ),
      bc: "matches",
      issue: `${REPO}/5700`,
      evidence: "R706 on bc1, owner ruling R712: the hub path is the oracle",
    },
    "duplicate-key-insert-raises": {
      verdict: "refused",
      measured: pinPattern(
        `[${ROW(50655, "DuplicateNamedKey")},"status":"error","durationMs":{n},"message":"NotRun: out-of-scope: the test ends while the error of a duplicate-key Insert into table Probe Row is deferred: whether the test runner raises it at the end of the test is not pinned","notRun":true}] exit 7`,
      ),
      bc: "differs",
      issue: `${REPO}/5788`,
      evidence:
        "BC fails the test at its end (r639 bc1 probe); v3 declines it: lost kills, never a wrong verdict",
    },
  },
  legT: {
    rows: T_KEYS.map((key) => ({
      key,
      verdict: "error" as const,
      errorClass: "runner-refused" as const,
      killingTest: null,
      issue: `${REPO}/5788`,
    })),
    counts: { killed: 290, survived: 50, noCoverage: 59 },
    total: 406,
  },
  xb: { exitCode: 3, passed: 0, notRun: 0 },
};

// R771 addendum 1: the a157b2d34 pin overrides this fact's measured text only.
const { "duplicate-key-insert-raises": ALPHA5_DUPLICATE_KEY } = ALPHA5_READINGS.legC;
if (ALPHA5_DUPLICATE_KEY === undefined)
  throw new Error("al-runner-v3-pins: ALPHA5_READINGS has no duplicate-key-insert-raises fact");

/**
 * edge-8078bcf49's leg T: the 48 known differences (`TABLES_KNOWN_DIFFERENCES`) that now read BC's verdict.
 * 41 Commit rows (#5607) leave no-coverage; 7 duplicate-key rows (#5603) leave survived. From the update
 * gate's receipt at 4aa6ca6d, 2026-10-26 08:05Z (`/work/tools/al-runner-v3/failed/edge-8078bcf49@4aa6ca6d…`).
 */
const T_ROWS_8078BCF49: readonly TRowPin[] = [
  {
    key: "0121538c88a9342b484d6597b43bf7bc9d138149790fb204378e0afae2086339|Data Key Probe|OnInsert|lethal.remove-assignment|1",
    from: { verdict: "survived", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "DoubleInsertWithoutKeyTriggerRaises",
    issue: `${REPO}/5603`,
  },
  {
    key: "1b3e248d3e7bc05c1fdde76d54b76a1e545569932aa0ab4c88fc7b712b46c56c|Data Commit Ops|CommitThenFail|lethal.toggle-blank-string|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "1b3e248d3e7bc05c1fdde76d54b76a1e545569932aa0ab4c88fc7b712b46c56c|Data Commit Ops|CommitThenRunValueForm|lethal.toggle-blank-string|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "1b3e248d3e7bc05c1fdde76d54b76a1e545569932aa0ab4c88fc7b712b46c56c|Data Commit Ops|CommitThenRun|lethal.toggle-blank-string|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "21b9d09e6b335a9ea96efe2e73caa285daff8086160ab3e20da1f26d24269d6f|Data Commit Ops|CommitThenFail|lethal.void-method-call|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "21b9d09e6b335a9ea96efe2e73caa285daff8086160ab3e20da1f26d24269d6f|Data Commit Ops|CommitThenRunValueForm|lethal.void-method-call|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "21b9d09e6b335a9ea96efe2e73caa285daff8086160ab3e20da1f26d24269d6f|Data Commit Ops|CommitThenRun|lethal.void-method-call|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "251dd6161cf958c3f6113c2cd5b026ef28eea56795fffeae72fb0e4012b6bffe|Data Commit Ops|CommitThenFail|lethal.remove-assignment|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "251dd6161cf958c3f6113c2cd5b026ef28eea56795fffeae72fb0e4012b6bffe|Data Commit Ops|CommitThenRunValueForm|lethal.remove-assignment|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "251dd6161cf958c3f6113c2cd5b026ef28eea56795fffeae72fb0e4012b6bffe|Data Commit Ops|CommitThenRun|lethal.remove-assignment|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "2c803bfacb04b831e6e6f26b4d200a42bad5b7cdb0014239df7d51bbeeb65aad|Data Commit Ops|CommitThenFail|lethal.remove-commit|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommittedWriteSurvivesFailure",
    issue: `${REPO}/5607`,
  },
  {
    key: "2c803bfacb04b831e6e6f26b4d200a42bad5b7cdb0014239df7d51bbeeb65aad|Data Commit Ops|CommitThenRunValueForm|lethal.remove-commit|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeValueFormCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "2c803bfacb04b831e6e6f26b4d200a42bad5b7cdb0014239df7d51bbeeb65aad|Data Commit Ops|CommitThenRun|lethal.remove-commit|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "2d119c2ec73ab1ae52dbba9a46ff0f4bc4d1489684b7064c985ef4a94112ee7e|Data Key Probe|OnInsert|lethal.negate-conditional|1",
    from: { verdict: "survived", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "DoubleInsertWithoutKeyTriggerRaises",
    issue: `${REPO}/5603`,
  },
  {
    key: "31c85a76e65c13426a668219969e39a8142b616aa307306f94a35e771add3abe|Data Commit Ops|CommitThenFail|lethal.flip-boolean-literal|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "31c85a76e65c13426a668219969e39a8142b616aa307306f94a35e771add3abe|Data Commit Ops|CommitThenRunValueForm|lethal.flip-boolean-literal|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "31c85a76e65c13426a668219969e39a8142b616aa307306f94a35e771add3abe|Data Commit Ops|CommitThenRun|lethal.flip-boolean-literal|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "31c85a76e65c13426a668219969e39a8142b616aa307306f94a35e771add3abe|Data Commit Target|OnRun|lethal.flip-boolean-literal|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "36aa6c656ce535d1f8e169d85419fcc897eec77e830ec1df81f4fe55b0704890|Data Commit Ops|CommitThenRunValueForm|lethal.remove-assignment|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeValueFormCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Data Commit Ops|CommitThenRunValueForm|lethal.return-value|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeValueFormCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "4361e50c375e40305819b2dc3eae9e1dc245b3115684696da23bf724133c00aa|Data Commit Ops|CommitThenRun|lethal.empty-block|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "51c6e78adf06c3aa8581ffef24239e94d80d1bba49338f443290f9c3c885d01c|Data Commit Ops|CommitThenRunValueForm|lethal.remove-assignment|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "62c04a6be11a180cf46d6c011b0700a891749b44dca1780ff2e501c6de19acb1|Data Commit Ops|CommitThenRun|lethal.remove-assignment|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "637aa2af14e55ecf9861ea851a23f1ede61feeb72f8de7759d4fe738d201f242|Data Commit Target|OnRun|lethal.flip-boolean-literal|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "68807988b56909e3568b38e2441cfed9a27441ece816cf15fd358ffb9231098e|Data Commit Ops|CommitThenRun|lethal.shift-integer|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "69ab2635d97b4a033d6979b89c9577ff9099ed31bfcdea22e425161990f85c56|Data Commit Ops|CommitThenFail|lethal.void-method-call|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommittedWriteSurvivesFailure",
    issue: `${REPO}/5607`,
  },
  {
    key: "69ab2635d97b4a033d6979b89c9577ff9099ed31bfcdea22e425161990f85c56|Data Commit Ops|CommitThenRunValueForm|lethal.void-method-call|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeValueFormCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "69ab2635d97b4a033d6979b89c9577ff9099ed31bfcdea22e425161990f85c56|Data Commit Ops|CommitThenRun|lethal.void-method-call|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "82190937ce0dbddcf71b05b35fd9eb0f09f2a141e69489fc6a34db4db510a3b7|Data Commit Ops|CommitThenRunValueForm|lethal.shift-integer|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "835565180cc5c8787adf0255e105ebb308eeb1338b48576812c5b5c9fdebb0d3|Data Commit Ops|CommitThenFail|lethal.remove-assignment|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommittedWriteSurvivesFailure",
    issue: `${REPO}/5607`,
  },
  {
    key: "84c847b650bf8648e34378707b482a1468e5cc8759ea3b61e0c8b3057312314d|Data Commit Ops|CommitThenRunValueForm|lethal.empty-block|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeValueFormCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "89a8f14203bc6c1a5b29130d054755d7cefe81df70216cb61972f009ff752f23|Data Commit Ops|CommitThenFail|lethal.void-method-call|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommittedWriteSurvivesFailure",
    issue: `${REPO}/5607`,
  },
  {
    key: "93bd96d69f211dd205aecc3b89564e852d93da1caa1d6eda69f4f3421b07c7a6|Data Commit Target|OnRun|lethal.empty-block|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "a811b46c95a74b761966dc4d0fd260793ba4c503b9cc6c7efd6e554acb7563d8|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.remove-assignment|1",
    from: { verdict: "survived", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "DoubleInsertWithoutKeyTriggerRaises",
    issue: `${REPO}/5603`,
  },
  {
    key: "b473f0f8762594047a5f52777f0ab590b94174b0b7816a51a572d18cad81f853|Data Commit Ops|CommitThenFail|lethal.empty-block|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommittedWriteSurvivesFailure",
    issue: `${REPO}/5607`,
  },
  {
    key: "b7639fc5337117f99a11c177444ce8ba186aec121acbabc26086c752caa4f696|Data Commit Ops|CommitThenFail|lethal.shift-integer|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "c26a0352dd867ea75f70b4b0bf99771e3bc838482b57fa9794099fafe15799ad|Data Commit Ops|CommitThenRunValueForm|lethal.remove-assignment|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeValueFormCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "c26a0352dd867ea75f70b4b0bf99771e3bc838482b57fa9794099fafe15799ad|Data Commit Ops|CommitThenRun|lethal.remove-assignment|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "c3ad0133a594bdcda453d6356d7f363351bede0c37c658750a3a22e227ba75fc|Data Commit Target|OnRun|lethal.void-method-call|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "c88702df06dca2c0edbdf144edf99c2682ad63278023dbd7e46f42c9875e0364|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.toggle-blank-string|1",
    from: { verdict: "survived", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "DoubleInsertWithoutKeyTriggerRaises",
    issue: `${REPO}/5603`,
  },
  {
    key: "c88702df06dca2c0edbdf144edf99c2682ad63278023dbd7e46f42c9875e0364|Data Key Probe|OnInsert|lethal.toggle-blank-string|1",
    from: { verdict: "survived", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "DoubleInsertWithoutKeyTriggerRaises",
    issue: `${REPO}/5603`,
  },
  {
    key: "ca03e7de5d868e018e122d4dac889646e338f75ed2cc3e073bed40be863c7bee|Data Commit Target|OnRun|lethal.remove-assignment|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "cc8317f3018759ab8d5178fa9aff18f1c4de59a37d62241236cb641c95e55eca|Data Commit Ops|CommitThenRun|lethal.void-method-call|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "d15e08235aa3c09dd4023cff2d05ecdf0ddfad254da6c0f01337975c78c26724|Data Commit Ops|CommitThenFail|lethal.remove-assignment|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "survived",
    errorClass: null,
    killingTest: null,
    issue: `${REPO}/5607`,
  },
  {
    key: "d36581a980ee091d62faf54b2a4512ee7cb1db33aea2a4f417a5edde7ef9d79f|Data Commit Target|CommitRunNo|lethal.empty-block|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "dd3aa023aa7fb2b7893efe181ccbf517d3ca97cbfacec07f3818c25c45c127dc|Data Key Probe|OnInsert|lethal.empty-block|1",
    from: { verdict: "survived", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "DoubleInsertWithoutKeyTriggerRaises",
    issue: `${REPO}/5603`,
  },
  {
    key: "e315168a52168bfbb4fcedaf685fb51f456c87a33eb1879f610f29a75cfaebed|Data Commit Target|OnRun|lethal.remove-not|1",
    from: { verdict: "no-coverage", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "CommitBeforeCodeunitRunSucceeds",
    issue: `${REPO}/5607`,
  },
  {
    key: "e75f9a0967677be80d3659fdc47e601d3764ac75077fb4d25c54b5f1322b2a8a|Data Flag Ops|InsertTwiceWithKeyTrigger|lethal.swap-modify-flag|1",
    from: { verdict: "survived", errorClass: null, killingTest: null },
    verdict: "killed",
    errorClass: null,
    killingTest: "DoubleInsertWithoutKeyTriggerRaises",
    issue: `${REPO}/5603`,
  },
];

/**
 * The readings of edge-8078bcf49 (R804). edge-db0296678 was measured IDENTICAL on every pinned reading, so both
 * pins share this one object and cannot drift. A later delta for either build must SPLIT it first.
 */
const READINGS_8078BCF49: Omit<V3BuildPin, "id" | "version" | "binarySha256"> = {
  legC: {
    ...ALPHA5_READINGS.legC,
    "duplicate-key-insert-raises": {
      verdict: "gone",
      measured: pinPattern(
        // BC_END_OF_TEST_TEXT (al-runner-v3-contract imports this module, so it is written out; a test binds the two).
        `[${ROW(50655, "DuplicateNamedKey")},"status":"fail","durationMs":{n},"message":"The record in table Probe Row already exists. Identification fields and values: Key='K1'","notRun":false}] exit 1`,
      ),
      bc: "matches",
      issue: `${REPO}/5788`,
      evidence:
        "the duplicate-key Insert fails the test with BC's own end-of-test text (r639 bc1 probe)",
    },
    "commit-under-test-isolation": {
      verdict: "gone",
      measured: pinPattern(
        `[${ROW(50657, "CommitCall")},"status":"pass","durationMs":{n},"notRun":false}] exit 0`,
      ),
      bc: "matches",
      issue: `${REPO}/5607`,
      evidence: "a Commit under TestIsolation passes, as on BC (#5607 fixed upstream)",
    },
  },
  legT: {
    rows: T_ROWS_8078BCF49,
    counts: { killed: 318, survived: 70, noCoverage: 18 },
    total: 406,
    refusedTests: 0,
  },
  xb: { exitCode: 3, passed: 0, notRun: 0 },
  serveRowFields: {
    issue: `${REPO}/5798`,
    evidence:
      "#5798 fixed upstream: the Dot.Step serve row carries codeunit 78850 and method Dot.Step (8078bcf49 receipt, leg N1E at 4aa6ca6d)",
  },
  o1: {
    cdoWorkDate: "2026-08-01",
    issue: `${REPO}/5743`,
    evidence:
      "O1's CDO set reads the login WorkDate 2026-08-01 in every Reader entry, as on a157b2d34 (8078bcf49 receipt at 4aa6ca6d)",
  },
};

export const V3_BUILD_PINS: readonly V3BuildPin[] = [
  {
    id: "alpha.5-07342060e",
    version: "al-runner 3.0.0-alpha.5 (07342060e)",
    binarySha256: "fd4d6d406a2f2170fccfe13413d51bbb1317b78b3ef5af3800ca9a6009b51db2",
    ...ALPHA5_READINGS,
  },
  {
    // Measured identical to alpha.5 on edge (R756). S5: a pin of a current build is never removed.
    id: "edge-dcdf9e821",
    version: "al-runner 3.0.0-alpha.5+edge.20261024 (dcdf9e821)",
    binarySha256: "0e3139359b37a7dd9c51377b64c0ae1acdcb208545f79075e4194571bbe03890",
    ...ALPHA5_READINGS,
  },
  {
    // Measured on the R-771 update gate at 55a1466b: alpha.5's readings plus N1E (#5798 fixed upstream).
    id: "edge-a157b2d34",
    version: "al-runner 3.0.0-alpha.5+edge.20261025 (a157b2d34)",
    binarySha256: "d9429e53a6938dbafb58108f61ce5408f65389bd9604ff94b4788ef26c8d17fb",
    ...ALPHA5_READINGS,
    // R771 addendum 1: a157b2d34 reads the same verdict with a new refusal message text.
    legC: {
      ...ALPHA5_READINGS.legC,
      "duplicate-key-insert-raises": {
        ...ALPHA5_DUPLICATE_KEY,
        measured: pinPattern(
          `[${ROW(50655, "DuplicateNamedKey")},"status":"error","durationMs":{n},"message":"NotRun: out-of-scope: the test ends while the error of a duplicate-key Insert into table Probe Row is deferred: whether the test runner raises it at the end of the test is measured only for TestIsolation = Codeunit and the default TransactionModel","notRun":true}] exit 7`,
        ),
      },
    },
    serveRowFields: {
      issue: `${REPO}/5798`,
      evidence:
        "#5798 fixed upstream: the Dot.Step serve row carries codeunit 78850 and method Dot.Step beside its name (R771 receipt, leg N1E on a157b2d34)",
    },
    o1: {
      cdoWorkDate: "2026-08-01",
      issue: `${REPO}/5743`,
      evidence:
        "upstream 5e1db1c7 runs LogInManagement.GetDefaultWorkDate at session open (as BC); BC 28.4.53241.53758's CRONUS demo company has 4178 G/L entries, the last on 2026-08-01 (R771 addendum 2 probe)",
    },
  },
  {
    // Measured on the update gate at 4aa6ca6d, 2026-10-26 08:05Z: every pinned defect fact reads gone
    // (duplicate-key as BC's end-of-test error, Commit under test isolation passes), and 48 of leg T's
    // known differences read BC's verdict. codeunit-runs-whole is still defect-present (as expected).
    id: "edge-8078bcf49",
    version: "al-runner 3.0.0-alpha.5+edge.20261026 (8078bcf49)",
    binarySha256: "614dc78c8513c6d5899fb402a121c2c6f910cbe255f56ab66a59f1a8f8d852d7",
    ...READINGS_8078BCF49,
  },
  {
    // Measured on the update gate at 242d770b, 2026-10-26 11:23Z: identical to edge-8078bcf49 on every
    // pinned reading (only the version line, timeout-is-cpu's text and O1's request count differ).
    id: "edge-db0296678",
    version: "al-runner 3.0.0-alpha.6+edge.20261026 (db0296678)",
    binarySha256: "4f9596510ececcfa5e5b235350e2b2658264abceb2d54d5fa01131e8ffab07db",
    ...READINGS_8078BCF49,
  },
  {
    // The v3.0.0-alpha.6 RELEASE (published 2026-10-26 10:36:50Z): the same commit as edge-db0296678, but another
    // binary (its own version line and sha256). Pinned on the same readings, as owner-ruled; its own update-gate
    // run is the measurement, and any reading off this table is a BLOCK (R804 addendum).
    id: "alpha.6-db0296678",
    version: "al-runner 3.0.0-alpha.6 (db0296678)",
    binarySha256: "92effe64d64dddcae98f80cc0e2e17a6429f977781ffe7b6b0f5eea6a231778d",
    ...READINGS_8078BCF49,
  },
];

/** The pin for this exact binary: the version line AND the sha256 must both be equal. */
export function findV3Pin(version: string, binarySha256: string): V3BuildPin | undefined {
  return V3_BUILD_PINS.find((p) => p.version === version && p.binarySha256 === binarySha256);
}

/**
 * R-762 B: is the §6 Sleep coverage rule retired for this session? True only when the build's pin
 * (`findV3Pin`: version line AND sha256) records `sleep-is-noop` as `gone` AND this session's own
 * probe reads it `gone` too. No pin, a pin that records anything else, a probe that did not run or
 * reads anything else: the rule stays.
 */
export function sleepRuleRetiredFor(
  contract: V3ContractResult | undefined,
  version: string,
  binarySha256: string,
): boolean {
  if (findV3Pin(version, binarySha256)?.legC["sleep-is-noop"]?.verdict !== "gone") return false;
  return contract?.facts.find((f) => f.fact === "sleep-is-noop")?.verdict === "gone";
}

/** R782: does this exact build's pin record #5798 as fixed (version line AND sha256)? */
export function serveRowFieldsFor(version: string, binarySha256: string): boolean {
  return findV3Pin(version, binarySha256)?.serveRowFields !== undefined;
}

/**
 * R779: the receipt line `status()` prints once per session, for the decision it made (`retired`,
 * from `sleepRuleRetiredFor`), with the reason. The word comes from `retired` itself, so the line
 * cannot disagree with the behaviour; only the reason is looked up here.
 */
export function sleepRuleLine(
  retired: boolean,
  contract: V3ContractResult | undefined,
  version: string,
  binarySha256: string,
): string {
  const pin = findV3Pin(version, binarySha256);
  const pinned = pin?.legC["sleep-is-noop"]?.verdict;
  const probed = contract?.facts.find((f) => f.fact === "sleep-is-noop")?.verdict;
  let why: string;
  if (pin === undefined) why = "no pin names this build";
  else if (pinned !== "gone") why = `pin ${pin.id} reads sleep-is-noop ${pinned ?? "unrecorded"}`;
  else if (probed !== "gone")
    why = `pin ${pin.id} reads sleep-is-noop gone, but this session's probe read it ${probed ?? "unmeasured"}`;
  else why = `pin ${pin.id} and this session's probe read sleep-is-noop gone`;
  return `[lethal] al-runner-v3 §6 Sleep rule ${retired ? "retired" : "applies"} (${why}) (R768, R779)`;
}

/**
 * Does a leg-C reading equal the pin's entry for its fact? The gate (`classifyLegC`) and the
 * session's mute (`pinnedDefectCoverage`) both use this one function, so they cannot drift: the fact
 * is an own property of the pin, the verdict equals the pinned one, and the measured text matches
 * the pinned pattern (and its extra check, if any).
 */
export function pinnedFactMatches(
  pin: V3BuildPin["legC"],
  f: { readonly fact: string; readonly verdict: string; readonly measured?: string },
): boolean {
  if (!Object.hasOwn(pin, f.fact)) return false;
  const p = pin[f.fact];
  return (
    p !== undefined &&
    f.verdict === p.verdict &&
    f.measured !== undefined &&
    p.measured.test(f.measured) &&
    (p.extra === undefined || p.extra(f.measured))
  );
}

/**
 * R719: which of a session's `gone` / `refused` defect facts the running build's pin already covers.
 * A fact is covered only when the pin matches the binary (`findV3Pin`: version line AND sha256), the
 * pin names that fact with that outcome AND that measured text (`pinnedFactMatches`). `undefined` when nothing is
 * covered. `line` is the one summary a pinned session prints instead of the warnings.
 */
export function pinnedDefectCoverage(
  r: V3ContractResult,
  version: string,
  binarySha256: string,
): { readonly muted: ReadonlySet<string>; readonly line: string } | undefined {
  const pin = findV3Pin(version, binarySha256);
  if (pin === undefined) return undefined;
  const muted = new Set<string>();
  const issues = new Set<string>();
  for (const f of r.facts) {
    if (f.kind !== "defect" || (f.verdict !== "gone" && f.verdict !== "refused")) continue;
    if (!pinnedFactMatches(pin.legC, f)) continue;
    muted.add(v3MuteKey(f));
    const n = pin.legC[f.fact]?.issue?.split("/").at(-1);
    if (n !== undefined) issues.add(`#${n}`);
  }
  if (muted.size === 0) return undefined;
  return {
    muted,
    line: `[lethal] al-runner-v3 pin ${pin.id} covers ${muted.size} facts (${[...[...issues].sort(), "R586c"].join(", ")})`,
  };
}

/** The shape `applyTPin` reads and returns (the gate's normalized mutant, structurally). */
interface TRow {
  readonly key: string;
  readonly verdict: string;
  readonly killingTest: string | null;
  readonly errorClass: string | null;
}

/**
 * Leg T's pinned expectation: the committed baseline's rows with exactly the pinned keys overridden.
 * `undefined` when a pinned key is absent, repeated, or its baseline row is not the pin's `from`
 * (default survived/null/null, S4).
 */
export function applyTPin<T extends TRow>(
  own: readonly T[],
  pin: V3BuildPin["legT"],
): T[] | undefined {
  const pinned = new Map(pin.rows.map((r) => [r.key, r]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of own) {
    const p = pinned.get(r.key);
    if (p === undefined) {
      out.push(r);
      continue;
    }
    if (seen.has(r.key)) return undefined;
    seen.add(r.key);
    const from = p.from ?? { verdict: "survived", errorClass: null, killingTest: null };
    if (
      r.verdict !== from.verdict ||
      r.killingTest !== from.killingTest ||
      r.errorClass !== from.errorClass
    )
      return undefined;
    out.push({
      ...r,
      verdict: p.verdict,
      errorClass: p.errorClass,
      killingTest: p.killingTest,
      // edge-8078bcf49: a row pinned out of no-coverage must not keep the flag the normalizer derives
      // from the verdict (mutant-equality.ts), or the pinned compare differs on it alone.
      ...("coverageFiltered" in r ? { coverageFiltered: p.verdict === "no-coverage" } : {}),
    });
  }
  return seen.size === pinned.size ? out : undefined;
}
