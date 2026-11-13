# R-956 pre-commitment: no gate figure moves

Committed before any gate ran on the change, 2026-11-13. Coord task R-956. Build: lethal/r-956 at 57e5cfe8 (R958 8a4fa0c9 + 778af59c,
R959 message 78205c8c, master merged 29e954db, review fixes 57e5cfe8). Gates selected: bcdev, lease, tables, chunked, alrunner-v3 (on
the gated `current`).

- **R958** (stop checks in the isolated-baseline fill and the speculative baseline) acts only when a stop handle is set and spent; no gate
  leg stops a run in its baseline.
- **R960** (default transport: a whole-batch warm-up refusal at the session's FIRST warm-up falls back to one-shot, named
  `al-runner-v3-serve-default-fallback-warmup`) — no itest sets `transportSource`; the one leg that builds through `cli.ts` (K) uses the
  default transport but runs `runSession` directly and never meets `entries-batch-refused` (its sandbox-app serves cleanly); no
  `gate-expected.ts`/`gate-warnings.ts` entry expects that refusal or the fallback code (Opus review of the diff, 2026-11-13).
- **R959** changes only the text of `ServerGenerationChangedError`; no leg reads it.

Prediction: every selected leg passes with figures, warning sets and per-mutant tables unchanged. Any difference is a BLOCK.
