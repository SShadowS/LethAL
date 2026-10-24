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
  readonly verdict: "error";
  readonly errorClass: "runner-refused";
  readonly killingTest: null;
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
  };
  readonly xb: XbPin;
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

export const V3_BUILD_PINS: readonly V3BuildPin[] = [
  {
    id: "alpha.5-07342060e",
    version: "al-runner 3.0.0-alpha.5 (07342060e)",
    binarySha256: "fd4d6d406a2f2170fccfe13413d51bbb1317b78b3ef5af3800ca9a6009b51db2",
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
  },
];

/** The pin for this exact binary: the version line AND the sha256 must both be equal. */
export function findV3Pin(version: string, binarySha256: string): V3BuildPin | undefined {
  return V3_BUILD_PINS.find((p) => p.version === version && p.binarySha256 === binarySha256);
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
 * `undefined` when a pinned key is absent, repeated, or its baseline row is not survived/null/null (S4).
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
    if (r.verdict !== "survived" || r.killingTest !== null || r.errorClass !== null)
      return undefined;
    out.push({ ...r, verdict: p.verdict, errorClass: p.errorClass, killingTest: p.killingTest });
  }
  return seen.size === pinned.size ? out : undefined;
}
