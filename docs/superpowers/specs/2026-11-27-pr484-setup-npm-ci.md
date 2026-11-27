# PR-484: kraken-setup.sh reinstalls a sibling repo's dependencies when its lockfile changed — pre-commitment r1

lethal-code, 2026-11-27. Written before code.

## Why

- `kraken-setup.sh` ran `npm install` only when `node_modules` was MISSING.
- business-central-mcp moved to `@sshadows/bc-toolbox-envelope ^0.2.0` (1a65ba3), but the shared clone kept 0.1.0, so
  `npm run build` failed tsc (TS2322 in `src/mcp/error-envelope.ts`).
- Every agent's refresh failed in setup until the orchestrator ran `npm install` by hand (2026-11-27).

## The rule

- **A repo WITH `package-lock.json`:**
  - setup compares the lockfile's sha256 with a stamp `node_modules/.kraken-lock.sha256`;
  - when `node_modules` is missing, the stamp is missing, or it differs: `npm ci`, then write the stamp;
  - otherwise nothing is installed.
- **A failed `npm ci`** fails setup (`set -e`) and writes no stamp, so the next run tries again.
- **First run after this change:** every existing `node_modules` has no stamp, so each repo gets one clean `npm ci`.
  That is the safe direction, and it is stated.
- **A repo WITHOUT a lockfile:** unchanged (`npm install` only when `node_modules` is missing).
- `npm run --if-present build` follows as today.

## Tests (scripts/kraken-setup.test.ts, a fake npm that logs calls; `ci` recreates node_modules)

1. A lockfile plus `node_modules` with a MATCHING stamp → no `npm ci`, no `npm install`.
2. The lockfile changed (the stamp differs) → exactly one `npm ci`, and the stamp now equals the new lockfile's sha256.
3. `node_modules` present but no stamp → `npm ci` once; a second run → none.
4. A failing `npm ci` → setup fails and writes no stamp.
5. No lockfile: `node_modules` missing → `npm install`; present → nothing.

- **Red checks:**
  - the stamp compare removed (always skip) → test 2 red;
  - always `npm ci` → test 1 red.
