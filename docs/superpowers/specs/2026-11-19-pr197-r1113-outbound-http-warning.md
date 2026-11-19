# PR-197 design and pre-commitment: warn before a run about test codeunits that can make real outbound HTTP calls (R1113 fix 2)

Coord PR-197 (lethal-code, 2026-11-19). Roadmap: R1113, fix 2. Evidence: `/coord/handoff/PR-197/`.

**Revised before any build** after the spec-adversary review (2026-11-19). The first version (master a1511e10) proposed a
procedure-level reach over every dependency's source. The review found it costly: about 11,500 `.al` files in bc4's cache,
8,135 of them Base Application. It also found that it could print nothing where it should warn: any reach is partial, and a
dependency source can fail to load. This version ships the fact that cannot be missed, the policy each selected test codeunit
sets, and files the reach-based ranking as its own item.

## 1. The problem
- **One test that waits on the network can quarantine a whole bcdev baseline** (R1113: three DO hangs on bc4). Two of them were
  in Azure test codeunits (`CDO Azure Blob Folder Tests`, `CDO ABS Auth Settings Tests`).
- **BC's default `TestHttpRequestPolicy` lets the request out** (PR-176, bc3): with no policy set, the call goes out exactly as
  under `AllowAllOutboundRequests`. `BlockOutboundRequests`, and `AllowOutboundFromHandler` with NO handler, error before sending.
- **DO's test app sets the policy in 0 of its 113 test codeunits.**
- **Nothing tells the user before the run.**

## 2. What was measured before designing (a regex prototype, `/coord/handoff/PR-197/proto-do2.tsv`)
- **Object-level reach** (a test codeunit, then every codeunit it names, ending at a codeunit that declares `HttpClient`), over
  DO's test app, DO, and the source shipped inside every dependency `.app` in bc4's package cache:
  - it flags **83 of 113**;
  - it finds both Azure codeunits, through `CDO Azure Blob Storage`, then `CTS-SYS Azure Blob`, then `CTS-SYS Http`;
  - most hits pass through hub codeunits, which makes it too noisy to act on (owner principle 34).
- **Matching dependency codeunits by name** (Http, Azure, Blob) flagged 88, through `Temp Blob`, a memory buffer. Dropped.
- **Procedure-level reach** would be more precise, but it costs a parse of up to about 11,500 dependency files per run, and it
  is still partial: no events, interfaces or triggers. It is filed as its own item, to rank the list below, never to decide
  whether anything prints.

## 3. The change
1. **What is checked (a new module, `packages/runner/src/http-policy.ts`):** the `TestHttpRequestPolicy` property of each test
   codeunit in the run's FINAL test list.
   - That list is the orchestrator's `tests` after `--tests-only`, the `#if` arm filter, `--exclude-test` and the recheck's
     `keepOnlyTests`: exactly what the baseline runs. **`--only` narrows mutants, not tests, so it narrows nothing here.**
   - The property is read from each test file's source, inside that codeunit's own object text, with comments ignored.
   - **The classes:**
     - `block` (`BlockOutboundRequests`): no outbound call is possible. Not listed.
     - `handler` (`AllowOutboundFromHandler`): listed separately. Whether a handler can still let a call out is not measured,
       since PR-176 measured only the no-handler case. So it is never treated as safe.
     - `open` (no property, or `AllowAllOutboundRequests`, or any other value, named): listed.
     - `unread` (the file could not be read, or no object of that name was found in it): listed and counted, never treated as
       safe.
   - A failure inside the check never stops the run: it is caught and printed as "outbound HTTP check failed: <reason>".
   - The recheck's nested session (`keepOnlyTests`) does not repeat it.
2. **Where the fact goes:**
   - an optional field `httpPolicy` on the `tests-discovered` event: `{ codeunits, open[], handler[], unread[] }`, where each
     entry is `{ codeunit, file, policy }`;
   - the progress renderer prints it to stderr;
   - **no `warning` event:** the gates pin their warning codes (R736), and every fixture's test codeunits set no policy. The
     report is unchanged.
3. **What it prints, always, once per run:**
   - `outbound HTTP: N of M selected test codeunit(s) set no TestHttpRequestPolicy that blocks outbound calls (K more use
     AllowOutboundFromHandler; whether a handler lets a call out is not measured).`
   - `On BC, and in al-runner, a call made from them can go out to the network; a slow or unreachable host can stall the baseline
     (R1113).`
   - `Set TestHttpRequestPolicy = BlockOutboundRequests on test codeunits that should not call out, or leave a test out with
     --exclude-test / --tests-only.`
   - Then up to 10 names with their files, and `... and X more (the events file lists all)`.
   - **When nothing is listed:** `outbound HTTP: all M selected test codeunit(s) block outbound calls`.
   - **When there are unread files:** a line `unread: U`.
4. **The dry run:** `lethal run --dry-run --tests <dir>` prints the same lines over the whole suite it discovers. It cannot apply
   `--tests-only` or `--exclude-test`, and it says so. With no `--tests`, it prints `outbound HTTP: not checked (no test
   project)`.
5. **Tests** (invented AL sources):
   - each policy value maps to its class;
   - a commented-out property is ignored;
   - two objects in one file each get their own property;
   - an unread file is `unread`;
   - only the final test list counts: an `--exclude-test`d codeunit's only test drops it, and `--only` does not;
   - the nested recheck session does not emit it;
   - a thrown read leaves the run going;
   - the renderer's lines, including the all-blocked line;
   - the dry run's lines;
   - red checks in both directions: a `block` codeunit listed, and an `open` one not listed.

## 4. Predictions (offline, over DO's test app at `/coord/handoff/PR-67/do-test-new`)
- **P1:** the dry run over DO lists 113 of 113 test codeunits as `open` (0 `block`, 0 `handler`, 0 `unread`), including
  `CDO Azure Blob Folder Tests` and `CDO ABS Auth Settings Tests`.
- **P2:** over a fixture whose test codeunit sets `BlockOutboundRequests`, the line says `all M ... block`. This is a unit test
  over invented sources; no fixture is changed.
- **P3:** the gate fixtures print the line, with no warning code added and no figure moved. The fixtures set no policy, so it
  lists their test codeunits. It is printed to stderr only, and no gate reads stderr text.

## 5. Gates
- A stderr line and an optional event field.
- **The al-runner-v3 gate and `itest:bcdev` run on the final head:** their pinned warning sets and figures must be unchanged
  (P3).
- No control-app change.

## 6. Filed alongside
- **The ranking:** an item for procedure-level reach, which orders the `open` list by whether a call path to `HttpClient` is
  found, with the prototype's data and the cost figures above.
