# R434: can a server's full installed-app list be read safely, from AL?

The probe ran on bc1, bc2 and bc3 on 2026-10-23, each server under its own coord lease and released after it.
- **Pre-commitment:** `docs/superpowers/specs/2026-10-23-r434-installed-apps-probe-precommitment.md` (master
  1b8a7973), plus delta 1 (master 2f4a8933).
- **Probe:** `scripts/r434-installed-probe/` at 7224e3b8 (tree 118ffd9b).
- **Readings:** `bc1.json`, `bc2.json`, `bc3.json`. Run 1 (before delta 1) is kept in `/coord/handoff/R-434/run1/`.

The source is AL's own `NAV App Installed App` table, read by a web-service codeunit (codeunit 92970). The automation
`extensions` list was never asked for (R433). The probe app was read absent before each publish and removed after
(uninstall 204, unpublish 204, 0 rows). Every server still answered HarnessInfo after the reads.

## Results (run 2)

| server | rows | Microsoft | LethAL | other | AL ms per read | HTTP ms per read |
|---|---|---|---|---|---|---|
| bc1 | 119 | 100 | 18 | ALDirectCompile 1 | 2, 3, 2 | 132, 64, 65 |
| bc2 | 117 | 100 | 16 | ALDirectCompile 1 | 2, 1, 1 | 136, 69, 61 |
| bc3 | 122 | 100 | 16 | ALDirectCompile 1, Continia Software 5 | 6, 1, 2 | 160, 75, 72 |

- **Fast:** a read of the whole list takes 1 to 6 ms in AL and 60 to 160 ms over HTTP, the first read the slowest.
- **Stable: every read on a server listed the same rows.** The fingerprints logged in `calls[]` and the `vsFirst`
  differences are NOT row changes. AL's `Format(Duration)` writes text ("2 milliseconds", "1 millisecond"). The
  driver's header pattern took only the digits, so that word leaked into the first row's id (SAF-T,
  `4ce93371-...`). Every `vsFirst` entry, on every server and in run 1, is that one word on that one row. With the
  word removed, the three reads on each server are identical. That is a driver artefact, not a server fact. The
  `installed` lists in the JSON keep the artefact on that one row.
- **The Microsoft set:** 100 apps at 28.4.53241.56590 on bc1, and the same 100 on bc2 and bc3 (at their builds).
- **An app outside every closure, on all three servers:** ALDirectCompile's "Test Runner Extension" 3.2.0.0. No test
  app declares it. This is exactly R434's class: an installed app that could change how tests run, which nothing
  reads today.

## The churn: LethAL's own publishes

Every gate that runs a fixture publishes its target INSTRUMENTED, under a minted version
(`<major>.<minor>.<days>.<halfSeconds>`, e.g. `1.0.20749.22369`).
- **bc1** holds 8 minted versions: Sandbox App, Data, Hang, Harden, Names and Wrapped, and the credit-limit demo.
- **bc2 and bc3** hold mostly their plain set-up versions, plus the last minted one (bc3: Sandbox Hang
  `1.0.20748.x`... `1.0.20749.13097`).

Each gate run changes at least one row. So a raw installed list folded into every digest would change on every run
of every project on the server. Verify would then see every test as new, which in practice switches verify off on a
shared server. Any useful fold has to leave out what LethAL itself publishes. That is not just the app under test:
it is every instrumented target, which the control app knows (its artifact registry).

## What it means for R434 part 1

A safe, fast source exists, and it is AL. Folding it into the digest needs:
- **A new LethAL Control procedure** (a control version bump), published to every gate server. Every gate is
  re-proved on every server (R604), and every user upgrades the control app.
- **Exclusions:** at least the app under test, its test app, and every LethAL-instrumented target (the artifact
  registry); otherwise the churn makes verify useless.
- **A rule for the coarse direction:** any install or upgrade of any other app re-runs every test.

The ruling is the orchestrator's (pre-commitment §6, second row).
