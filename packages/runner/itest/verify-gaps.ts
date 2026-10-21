/**
 * C02-09: explain's gaps on `itest:verify`'s step-1 report, measured offline before the run (see the
 * gap pre-commitment). Full identity keys from bcdev.baseline.json.
 *
 * R-595: this lives apart from `verify.itest.ts` so a unit test can import it without running the
 * gate (R186). `gap-pins.test.ts` emits sandbox-app's manifest and checks every id and member set
 * here, so a change to `gapIdOf` or to the fixture fails the unit suite, not only the live gate.
 * The ids were re-pinned for R276's `gapIdOf` (line span, LF-normalised text); the members are
 * unchanged (docs/superpowers/specs/2026-10-21-r595-verify-gap-repin-precommitment.md).
 */
export const CLAMP_GAP = {
  name: "ClampPercent body",
  gapId: "G82da08c0d8a7",
  keys: [
    "b03dba085d6a4498f41e5e223ecb64c66e6eee1d2d2ef7ab55f84fa7c63835d7|Sandbox Logic|ClampPercent|lethal.empty-block|1",
    "241fff269e9c9b9a336099e4588ad85b0198a155d98dccc6e48adf1e551f6341|Sandbox Logic|ClampPercent|lethal.negate-conditional|1",
    "fc15ec3036dca5e21a2e79675b48f28e5815811f32dff4eb3426e0ff803575bb|Sandbox Logic|ClampPercent|lethal.conditional-boundary|1",
    "58ade303c82ea175e1cabd4e46b8cd818e3a59a66b60578ef4d85077548d40e9|Sandbox Logic|ClampPercent|lethal.conditional-boundary|1",
    "40277aa121cd95030531672f906db4dc1f238ef3179b8c58d7815e6a8fe957f5|Sandbox Logic|ClampPercent|lethal.return-value|1",
  ],
};
export const APPLY_GAP = {
  name: "ApplyAudit body",
  gapId: "G5d4266eab9d8",
  keys: [
    "2b34811c1b253fde93b24824f30d18d933316b7f64723b67d413a3b0d16956a6|Sandbox Logic|ApplyAudit|lethal.empty-block|1",
    "9b4f290c51c1ef232af4a294bb9a0a4c404064f20bac6e893fab28b45cdf7785|Sandbox Logic|ApplyAudit|lethal.void-method-call|1",
  ],
};
export const LOG_BODY_GAP = {
  name: "LogAudit body",
  gapId: "G557208bb5476",
  keys: [
    "63c4f230d49983a82f9a54edf57f787ba2196df2de23c5374a9921c523fc408f|Sandbox Logic|LogAudit|lethal.empty-block|1",
    "5cba655a6ac203ce40d31b0b4974a7b2f308cfec342a35d8e1a4f8d8c09c5c03|Sandbox Logic|LogAudit|lethal.negate-conditional|1",
    "63b9fa65d3452236af3d725f80a805268813f9012185c0296fe552908eae1d6d|Sandbox Logic|LogAudit|lethal.shift-integer|1",
  ],
};
export const LOG_THEN_GAP = {
  name: "LogAudit then-block",
  gapId: "G16ce59f7aad7",
  keys: [
    "77ee7e3d0adfcd76e1ae34e9067dcebc5c466f1172a857c730b0d43f7085d15c|Sandbox Logic|LogAudit|lethal.empty-block|1",
    "d8f839f87361f4d85b7ccd435b318285a82e1e3610237d66488e17b8bdd61de3|Sandbox Logic|LogAudit|lethal.remove-assignment|1",
  ],
};
export const PREDICTED_GAPS = [CLAMP_GAP, APPLY_GAP, LOG_BODY_GAP, LOG_THEN_GAP];
