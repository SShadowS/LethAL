# PR-484: kraken-setup.sh reinstalls a sibling repo's dependencies when its lockfile changed — pre-commitment r1

lethal-code, 2026-11-27. Written before code.

## Why

- `kraken-setup.sh` ran `npm install` only when `node_modules` was MISSING.
- business-central-mcp moved to `@sshadows/bc-toolbox-envelope ^0.2.0` (1a65ba3), but the shared clone kept 0.1.0, so
  `npm run build` failed tsc (TS2322 in `src/mcp/error-envelope.ts`).
- Every agent's refresh failed in setup until the orchestrator ran `npm install` by hand (2026-11-27).

## r2 (the build review; overrides "The rule" below)

- **(BLOCK) Measured:** bc-dev-mcp and pi-mcp TRACK `bun.lock`. Their `package-lock.json` is UNTRACKED, left by an
  earlier `npm install`. A dependency bump never changes it, so a stamp keyed on it never moves.
- **The stamp** = sha256 of the TRACKED dependency files: `git ls-files -z package.json package-lock.json bun.lock`,
  concatenated. It is kept in `node_modules/.kraken-deps.sha256`.
- **The install,** when the stamp differs or is missing:
  - `npm ci` when `package-lock.json` is TRACKED;
  - else `npm install`, which updates an untracked lockfile.
- **No tracked dependency file at all:** as before (`npm install` only when node_modules is missing).
- **(SHOULD) Fail closed, readably:**
  - a hash that fails or is not 64 hex fails setup (never an empty-equals-empty match);
  - npm runs with `--loglevel=error`, and a failure prints "kraken-setup: npm ci|install failed in <dir>" and fails
    setup with no stamp written.
- **(SHOULD, stated):** `npm ci` deletes `node_modules` under MCP servers that other sessions run from these
  folders. The build already deletes `dist` today. It is accepted, not engineered around.
- **Tests add:**
  - an untracked `package-lock.json` with a changed `package.json` → `npm install` (not ci), and a new stamp;
  - a failing hash → setup fails, no install;
  - test 4 also asserts that the failing repo's build did not run and the next repo was not reached.

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
