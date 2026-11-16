# PR-55: a kill measured on a test run ALONE is confirmed alone (R1067), spec and pre-commitment

Written 2026-11-16, before any code for this task. Revised the same day after the spec-adversary review (Opus; S1-S7 name its
findings) and its delta review (B1-B3).

## The problem (R1067)
On al-runner-v3, a covering test B can be run ALONE under the mutant (`aloneCall`): after its codeunit's call was cut at an
earlier test A's timeout (B has no row in the cut call, or `cutElsewhere`), or after a stop on one-shot (R897 `aloneAfterStop`,
also one-shot codeunits inside serve, R937). This happens under the DEFAULT isolation ("test", whose requests run whole
codeunits) and under per-test isolation alike (S1, S2: `cutElsewhere` does not check `perTest`). If B fails, the cold confirm
sends R653's kill pair `{NONE:[X]}`/`{M:[X]}` and reads B's unmutated row from the WHOLE codeunit X run in context, after A and
the others. So a test that fails only when run alone passes that confirm and the kill stands, although nothing compared
B-alone with B-alone. The same holds for a timeout measured alone. PR-51 confirms alone only for a fail LATER in a held walk.

## The rule
A kill (a `fail`, or a `timeout` that goes on to the timeout path) whose mutated row came from an alone request
(`TestVerdict.selection === "alone"`, set by PR-51 wherever v3's `runRow` runs alone) is confirmed and reproduced the way it
was measured, WHATEVER the isolation mode:
- its unmutated confirm runs exactly that test alone under NONE, and its R577 reproduction runs it alone under the mutant
  (`RunOpts.alone`), on serve through `aloneCall` and on one-shot through `callCodeunit` with a one-test selection;
- no R653 kill pair is sent for it;
- this is PR-51's `aloneKill` with the condition "a timeout is held" removed, extended to a timeout measured alone (its cold
  confirm alone, and its reproduction alone);
- an alone confirm's time is NOT fed to `noteMeasured` (S5): on one-shot (the only mode where `noteMeasured` acts) master's
  whole-codeunit NONE confirm could raise the test's R515 budget from a process wall; an alone confirm no longer raises it.
  Safe (budgets only rise, every timeout is still confirmed), but later mutants of that test can get a lower budget than on
  master on one-shot; serve is unaffected. The measured diff runs on serve, so one-shot is NOT measured by it (stated);
- the note of a kill this confirm turns into an error names the cause (S4), cause unchanged (`unstable`, so the counts rules
  hold): `fails (or hangs) when run alone with no mutant: it ran alone under the mutant after a cut in its codeunit, and tests
  of a codeunit share state in order, so the failure is not attributable to the mutant`;
- a step marked alone at group position > 1 is a caller-contract violation and throws (v3 has no `runMany` today, so none
  exists; S7).

Rejected: re-measuring the kill in context before it scores. In context the call is cut at A's timeout again before B runs.

Not changed: a kill whose verdict is not marked alone keeps its path, whatever the isolation (all of bcdev, which never sets
`selection` and throws on `opts.alone`; every v3 kill read from a codeunit call or a per-test call that was not routed alone);
R197's order; the walk.

## Which verdicts it can move, in BOTH directions (S3)
- **Away from a kill:** a test measured alone that fails (or hangs, or runs slower than half the stop) alone with no mutant:
  today `killed`/`timeout-killed` through the in-context confirm, then `error` (`unstable`, or today's timeout errors).
- **Towards a kill:** a test measured alone that passes alone but fails in context with no mutant: today `error`/`unstable`
  (the pair's NONE entry runs in context), then `killed`; a timeout measured alone whose in-context confirm was too slow
  (`timeout-unconfirmed`): then possibly `timeout-killed`. Neither is a false kill (alone is compared with alone).
- **Reproductions** run alone where they read the pair's M entry in context before.
Only mutants with an alone-marked kill or timeout can move.

**Stored runs, counted before building** (`/coord/handoff/PR-55/`; it cannot classify stored runs exactly, because no field
records an alone request):
- `candidates.ts` over the 40 stored v3 streams with a timeout cut: a cut followed by a `mutant-scored`. Over-counts (a
  prefetch cut is credited to the next scored mutant) AND under-counts (a cut mutant scored after the window's first is missed;
  one-shot R897 alone runs emit no daemon close). 76 kill scores, 25 sites, 6 killing tests; DO's t1-t7: 0 kills after a cut.
- The 5 BC.History killing tests pass alone unmutated (`iso/`, one-shot isolated baselines, one test file per app, v3
  edge-5a58a0f16). So none of those kills would move away. This does not cover the timeout candidates or the other
  directions.
- So the count is a hint, not the pre-commitment. **The pre-commitment is a measured diff** after the build: the candidate apps
  whole (Password, Filter Tokens, SMTP, Guided Experience, and the timeout-candidate apps Microsoft Graph, SAF-T, Email), same
  v3 binary, fix off (master) and fix on, per mutant, on serve. **Prediction:**
  - verdicts move only on mutants with an alone-marked kill or timeout in the fix-on run, in either direction; each is listed
    with its alone run and confirm;
  - R197 ripple (B1): a moved kill changes the kill ledger, so LATER mutants of the same procedure walk in another order:
    `killingTest`-only moves there are accepted (R197's class); a verdict move there is explained and attributed to the ledger
    change, never passed silently;
  - load (B2): cuts depend on timeouts, which depend on load, and master logs no alone event. A mutant that moved with no
    alone event, or whose cut set differs between the legs, is re-run once on both legs before it counts; a move that
    persists with no alone event and no R197 ripple is a BLOCK.
  The fix-on build emits one `alone-confirm` warning event per alone confirm, naming mutant and test (deliberately per mutant,
  not latched once per session like the `alrunner-*` warnings: it is the diff's attribution, and it is rare, only after a
  cut). No gate leg has an alone confirm, so no gate warning set moves.

## Cost (S6)
Cheaper than today per alone-measured kill: today the pair's M entry runs the whole codeunit again and hangs at A again (a full
stop, a daemon kill and restart) before the reproduction still runs B alone; now two short alone requests and no hang.

## Predictions (pre-committed)
- **The measured diff above.**
- **`itest:alrunner-v3`:** no figure moves (no gate baseline holds a `timeout-killed` or an `error`, so no cut and nothing is
  marked alone; the ISO leg included).
- **`itest:hang`** (bcdev): unchanged; run once on the final head because the cold-confirm block every timeout passes is edited.
- **Unit tests** (red both ways):
  - a FIRST fail marked alone (default isolation "test") is confirmed alone and reproduced alone, no pair sent;
  - a first fail marked alone whose test fails alone unmutated is `error` with the named note (text pinned);
  - a first fail marked alone that passes alone but whose in-context run would fail: `killed`;
  - a first TIMEOUT marked alone gets an alone cold confirm and no `noteMeasured`;
  - a fail NOT marked alone keeps the pair and the in-context confirm;
  - a per-test isolated ("method") kill marked alone after a cut keeps its verdict (same one-test request);
  - a one-shot (R897) kill marked alone is confirmed by a one-test `callCodeunit` under NONE;
  - a PR-51 held timeout measured alone, on replay, gets an alone confirm (the cut restore does not change it);
  - bcdev never receives `opts.alone` for any kill or timeout; a step marked alone at group position > 1 throws.

## Not in scope
Recording `selection` in the store (R1067's first "to close" step): the warning event per alone confirm makes the diff
attributable without a schema change.
