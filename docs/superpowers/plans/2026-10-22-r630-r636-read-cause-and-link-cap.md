# R-630 plan: R630 (name the cause of an unread package) and R636 (link-scan cap)

Base: master d2b78db2. Measurement: `/coord/handoff/R-630/r636-measure.md`.
Test-first. Every fix gets a red check: revert that one change, its test goes red, restore.

---

## Part A. R630: carry the cause of an unread package

### A1. The value

One new type, in `packages/runner/src/backend.ts`, next to the interface:

```ts
/** R630: the server was ASKED and gave no package. `unread` names why, for the operator. */
export interface PackageUnread { readonly unread: string }
export type PublishedPackageRead = Uint8Array | PackageUnread | undefined;
export const isUnread = (r: PublishedPackageRead): r is PackageUnread =>
  r !== undefined && !(r instanceof Uint8Array);
```

`PackageUnread` REPLACES `null` everywhere. `undefined` keeps its meaning (never asked: no server or no
credentials). The method still never throws (except `UnfilteredExtensionsQueryError`, as today).

Why replace `null` and not add to it: a `null` left in the union would be a fourth state that only test
fakes produce. Replacing it makes `tsc` find every consumer and every fake. The cost is a mechanical
test diff (below).

`fetchPublishedAppPackage` in `bcdev-backend.ts` fills `unread`:

| answer | `unread` text |
|---|---|
| 404 | `HTTP 404: the server holds no such app (not resident)` |
| 401, 403 | `HTTP 401: the dev endpoint refused the credentials (BC_DEV_USER / BC_DEV_PASSWORD)` |
| other non-2xx | `HTTP 500 (a server error)` for 5xx; `HTTP <n>` otherwise |
| `BcAnswerUnreadError` kind `timeout` | `no answer within 15000 ms (timeout)` |
| any other throw | `the request failed: <message>`, plus `err.code` when present (a refused connection reads `ECONNREFUSED` / `ConnectionRefused`) |

One helper `unreadOf(res | err)` in bcdev-backend.ts. Every consumer message appends `(${cause})`.

### A2. Consumers (grep `fetchPublishedAppPackage`, `publishedPackageReader`, `readPublished`,
`readSystem`, `readControl` over packages/*/src): 7 sites in 6 files

The al-runner backends do NOT implement the method (it is optional), so they do not ripple.

| # | consumer | today on `null` | new message | stays fail-closed because |
|---|---|---|---|---|
| C1 | R139 check 2: `fetchPublishedTestApp` -> `reportPublishedTestApp` (orchestrator.ts), both reads (pre-lease and after the env-tool hook) | warning `published-test-app-unreadable` "could not read the published test app "X" from the server"; `sources = unavailable(UNREADABLE)`; no hash | `PublishedTestAppRead` `failed` gains `cause`; warning: `... from the server (HTTP 500 (a server error)), so ...`; `why` = `UNREADABLE + ": " + cause` | same warning code, `testAppHash` undefined, `sources.kind` `unavailable`, no identity, no digests |
| C2 | test-app hash guard: `batchTestAppReader` -> `testAppHashFor` (baseline-snapshot.ts) -> `assertNoTestAppDrift` (both sites, and the R462 re-read) | `undefined` hash -> `TestAppDriftedError` "it reads nothing (the read failed)" | `testAppHashFor` returns the `PackageUnread` instead of `undefined` on a failed read; the reader returns `string \| PackageUnread \| undefined`; `TestAppDriftedError` gets an optional 4th arg `unread` and prints `nothing (the read failed: HTTP 500 ...)` | same throw class, `.now` still `undefined`, identity cleared, nothing recorded. Normalise ONCE per site: `const hash = typeof r === "string" ? r : undefined`, used for reuse and `snapshotApplies` (whose type stays `string \| undefined`, so `tsc` refuses an un-normalised use) |
| C3a | `publishTestApp` pre-fence (test-app-publish.ts) | `TestAppError("resident-unreadable", "...check the dev-endpoint read credentials..., or that the app has ever been published")` | `the resident X package could not be read before publishing (HTTP 500 (a server error))`. Keep the credentials/never-published hint only for 401/403 and 404 | same reason `resident-unreadable` (terminal), thrown before the fence, no marker, no altool |
| C3b | `publishTestApp` read-back inside the fence | `verification unavailable`, detail "could not be read back after the publish" | detail appends `(cause)` | `afterBytes` undefined -> never `accepted`; `decideTestAppOutcome` unchanged |
| C4 | `publishedPackageReader` (digest-inputs.ts) -> `dependencyFingerprint`; used by orchestrator `testAppDependencies` and verify.ts `verifyDependencyFingerprint` | `DependencyUnreadableError` "the package of dependency "X" (...) could not be read" | `PackageReader` returns `ReadonlyArray<Uint8Array> \| PackageUnread`; message appends `(cause)`. `packageFolderReader` returns `{unread: "no package for it in the package folders"}`; verify's no-fetch fallback returns `{unread: "this backend cannot read published packages"}` | same `DependencyUnreadableError` -> `dependency-unreadable` / run without digests |
| C5 | bytes mode `readSystem` / `readControl` -> `openPackage` (digest-inputs.ts) | "the package of the platform package "System" could not be read" | `openPackage` takes the read; appends `(cause)` | same `DependencyUnreadableError` |
| C6 | `bcdevDependencyFingerprint`'s own test-app read (digest-inputs.ts; caller: `scripts/r371-reach-measure/dep-download.ts`) | "the published test app "X" could not be read" | appends `(cause)` | same throw |
| C7 | `proveReadBack`'s publishApps loop (orchestrator.ts) | `DependencyUnreadableError` "the package of "X" (id) could not be read back" -> `why` | appends `(cause)` | same `why`, run unproven, no identity |

Doc: `docs/using-lethal-from-an-agent.md`, the `test-app-resident-unreadable` and `dependency-unreadable`
rows: "the detail names the cause: HTTP 404 means not resident, 401/403 the credentials, 5xx the server".

### A3. Tests (write first; each must fail on master)

- `published-app-fetch.test.ts` (bcdev, fake fetch): 500 -> `{unread}` naming `HTTP 500`; 404 -> "not
  resident"; 401 -> "credentials"; timeout -> "timeout"; thrown refusal -> its code; 200 -> bytes. Its
  existing `toBeNull` assertions move to `isUnread`.
- One test per consumer, each with a 500 and a 404 fake read:
  C1 warning text; C2 `TestAppDriftedError.message`; C3a and C3b `TestAppError.detail`; C4 and C5
  `DependencyUnreadableError.message` (through `dependencyFingerprint`); C6 through
  `bcdevDependencyFingerprint`; C7 through a session with `afterLeaseAcquired` (extend the
  orchestrator test that already asserts "could not be read back").
  Each asserts `HTTP 500` for the 500 and `not resident` for the 404.
- Fail-closed pins, one per consumer, on the SAME 500 fake: C1 `sources.kind === "unavailable"` and no
  `testAppHash`; C2 throws `TestAppDriftedError` with `.now === undefined` and the store row's test-app
  hash cleared; C3a reason `resident-unreadable` and the publisher was never called; C3b reason is not
  accepted (`publish-indeterminate` when altool also failed); C4-C7 throw `DependencyUnreadableError`
  (C7: the run's identity is not recorded).

### A4. Red checks (one per consumer)

For each of C1, C2, C3a, C3b, C4, C5, C6, C7: delete the `(cause)` from that consumer's message only;
its 500/404 test goes red; restore. For bcdev: map 404 to the generic `HTTP <n>` text; the "not
resident" test goes red. For fail-closed: in C2, read a `PackageUnread` as a hash (`String(r)`); the
`TestAppDriftedError` pin goes red. (One fail-closed red check is enough there: the other pins guard
code this change does not touch.)

### A5. Ripple and how to keep it small

- Type `Promise<Uint8Array | null | undefined>` is spelled out 7 times in src (backend.ts,
  test-app-publish.ts `ReadPublished`, digest-inputs.ts x3 plus `MicrosoftMode`, baseline-snapshot.ts).
  Replace each with `Promise<PublishedPackageRead>`.
- Test fakes: about 66 `null` returns and 30 `Uint8Array | null` annotations in about 12 test files
  (orchestrator, resume, r403, helpers/proven-test-app, helpers/characterize, helpers/microsoft-mode,
  microsoft-mode, digest-inputs, doctor-issue-23, bcdev-backend, identity-refusals, published-app-fetch).
  Add one helper `UNREAD = { unread: "test: unread" }` in `tests/helpers/` and swap mechanically
  (Edit tool, never sed). `tsc` lists every site. The `resume.test.ts.snap` mentions the method name
  only; re-check it does not move.
- No `SessionReport` field changes: causes ride in existing message strings, so no schema ripple.

---

## Part B. R636: cap folders scanned, not depth

### B1. Measurement (r636-measure.md)

No corpus (dc, do, cdo, bch) and no fixture holds a single link: the longest chain the scan follows is
0 everywhere, and no node_modules or pnpm tree exists. Today a synthetic pnpm chain of 18+ links with
no `.al` refuses falsely; 17 passes. A no-`.al` cycle is ADMITTED today (correctly).

### B2. The change (walk.ts)

Depth is not the cost: the visited set already ends every cycle, and the scan uses an explicit stack, so
depth cannot overflow. The real risk the cap guards is a link to a BROAD foreign tree (a home folder, a
disk root). So cap the number of folders scanned per walk, and refuse at the cap as today.

- `REACH_DEPTH_CAP = 32` -> `REACH_FOLDER_CAP = 50_000`, a per-walk budget. Reason (put it in the doc
  comment): bch, the largest corpus, has 3198 folders in total; a pnpm `node_modules` can hold tens of
  thousands; 50 000 folders is a few seconds of `readdir`; beyond it a refusal names itself.
- Count with a per-walk counter in `Collector` (next to `reachSeen`), NOT `seen.size`, so the cap still
  ends the scan if the visited set is ever lost.
- Drop the per-entry depth from the stack (plain `string[]`).
- Tests lower the cap through an exported mutable `reachLimits = { maxFolders }`, the same pattern as
  `reachStats` (building 50 000 folders in a test is too slow).
- Message: `TOO_DEEP` -> `, and LethAL could not prove it reaches no .al file (it holds more than
  ${cap} folders)`.

N5 wording (`onLink`, walk.ts): under the `"project-cache"` policy, `root` is the PROJECT folder, but two
calls pass `what = "package cache"`, so the message reads "inside the package cache <project folder>".
Fix both (the linked-folder refusal and `refuseIfReachesAl("package cache")`) to `what = "project
folder"`, with `why` starting `, in its package cache`. The plain `"yield-files"` walk (root IS the
cache, e.g. `buildPackageCacheCopy`) keeps "package cache".

### B3. Tests (r631-links.test.ts, the "review r2 N3" block)

1. A 20-link pnpm chain with no `.al` (the shape of `tools/chain-probe.ts`) is admitted, default cap.
   Red on master (refused by the cap).
2. A 2-link cycle with no `.al` terminates, admitted, `reachStats.foldersScanned` delta 2; the same cycle
   with a `.al` in one folder refuses with "reaches a .al file".
3. Replace "a link deeper than the cap refuses": with `reachLimits.maxFolders = 10`, a linked tree of 12
   folders refuses with "could not prove"; one of 8 passes. Also: a 40-deep REAL folder chain is admitted
   at the default cap (it refuses today).
4. N5: a project-cache refusal (the existing `setPackageCacheDirs([src])` test) names "project folder
   <dir>" and does NOT contain `package cache ${dir}`.

### B4. Red checks

- Restore depth counting (cap at depth 32): tests 1 and 3b go red.
- Drop the visited set (`seen.has` check): test 2 goes red (it hits the folder cap and refuses, or its
  scan count is wrong).
- Drop the cap check: test 3a goes red (admitted).
- Restore the old N5 wording: test 4 goes red.

---

## Gates

- `itest:bcdev` on a bc server (bc1 proven) on the final head: required by the task; R630 changes the
  bcdev read every bcdev run makes (check 2, hash guard, dependency fingerprint).
- `itest:testapp` and `itest:verify` exercise `publishTestApp` and verify's fingerprint (C3, C4). They
  are not in the task; run them if a server slot is free, else say so in the submit note. A success path
  is byte-for-byte unchanged (only failure text moves), so bcdev is the one required.
- R636: the walk runs on every fixture, but no fixture holds a link, so `linkReachesAl` never runs in any
  gate. No gate figure can move; unit tests are the proof.
- No fixture `.al` changes: no `compile:fixtures`.

## Size

- src: about 150 lines over bcdev-backend.ts, backend.ts, orchestrator.ts, test-app-publish.ts,
  digest-inputs.ts, verify.ts, baseline-snapshot.ts, test-membership.ts, walk.ts.
- tests: about 200 new lines, plus the mechanical `null` -> `UNREAD` swap (about 100 sites, 12 files).
- docs: two rows in using-lethal-from-an-agent.md; R630 and R636 `status: done (<commit>)`.
- About one lane-day including verify, red checks and one itest:bcdev.

## Surprises

- The brief's "a link cycle is still refused" is wrong for a no-`.al` cycle: it is admitted today, by
  design. Test termination plus refusal of a `.al`-holding cycle instead.
- The existing cap test pins a 34-deep REAL tree as refused. Under B2 that tree is admitted; the test is
  rewritten, not kept.
- No real tree has a link, so R636 is unmeasurable in the field; the cap value is a stated cost bound.

## r2: plan-review fixes (2026-10-22). These override anything above.

From `review-opus-plan.md` (no blocker).
- **I1:** `testAppHashFor` (baseline-snapshot.ts) must handle `{unread}` EXPLICITLY before its fall-through to the
  source-tree hash. Do not trust tsc there: it accepts a leftover `=== null`. The drift and R462 messages must then
  say the read failed, with its cause, and never "it reads source:…". Red check: delete that branch, and the C2
  `.now === undefined` pin goes red.
- **I2:** a 404 is NOT proven to mean "not resident". Word it as: "HTTP 404 (no such app on the server, or the
  dev-endpoint path is wrong)". No probe is run, so no server time is spent on the wording.
- **I3:** an AbortError or TimeoutError (by `err.name`) is also a timeout, because `withDeadline` aborts the fetch
  before `bounded`'s guard fires. A test uses a fake fetch that HONOURS the abort signal.
- **I4:** the final-head gates are `itest:bcdev`, `itest:verify` and `itest:testapp`, all required, since the diff
  touches verify.ts and test-app-publish.ts. All three are proven on bc1. If bc1 is busy, take the server the proof
  table lists for that gate.
- **Minors:**
  - print the REAL status code (403 as 403; each 5xx as its own number);
  - name `BcRedirectRefusedError` as "a redirect was refused";
  - R636 test 3a is a FLAT tree of 12 sibling folders, so it goes red under depth counting;
  - restore `reachLimits` in a `finally`;
  - the N5 wording branches on the walk mode, so the cache-only walk keeps "package cache".
- **Kept:** the union `{ unread }` design and its ~100 fake edits (an out-parameter would lose the cause in
  `publishedPackageReader`), and the 50,000-folder cap (BC.History has 3,198 folders in all).
