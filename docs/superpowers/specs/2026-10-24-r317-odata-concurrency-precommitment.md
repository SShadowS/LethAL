# R317 concurrency probe: pre-commitment (written before any run)

Probe: `/coord/handoff/R-317/probe/concurrency.ts`. Question: is there a per-user concurrency limit on
BC's OData V4 or dev endpoint, at or below 16 requests in flight? The only evidence so far is one
event 705 with `Requests running: 5` and `Requests waiting: 6`, and an earlier 705 with
`Max Active Request Count: 100` (nst-wedge incidents, sections 1 and 6). Neither is a measured limit.

## Method (fixed now)

- One server per run, `bc1`, `bc2` or `bc3`; the caller holds that server's coord lease for the whole
  run (the probe checks `kraken coord holder` and refuses otherwise). No gate runs on it, so the probe
  uses the config's own user and is the only client of that user.
- Phase A: `LethALControl_HarnessInfo` (OData POST, status read, lease peek only). N = 1, 2, 4, 6, 8,
  12, 16 concurrent; 5 rounds of N per level; 500 ms between rounds.
- Phase B: `dev/packages` GET for the control app (the read LethAL already makes). Same ramp.
- Per request: HTTP status, total time to the end of the body, body complete or not, `Retry-After`.
- Requests go through LethAL's own `bcFetch` (it refuses redirects; R433/R-496 showed a redirect to
  the unfiltered extensions list hung BC 28.4) inside `withDeadline`. The dev URL is LethAL's own
  `devPackagesUrl`, and its port must equal the server's dev port (7049, 7149, 7249).
- Stop rules: never more than 16 in flight; 30 s timeout per request (covers the body); 5 min in
  total plus at most one 30 s round. The FIRST timeout, incomplete body, 429 or 503, in any round,
  ends the run (any other failure does too). Every later phase is then skipped; the probe waits
  30 s, makes one HarnessInfo call (`post-stop-health`) and exits 3. A level where half or more
  requests fail is only a backstop.
- If run 1 hits any stop rule, run 2 needs the owner's OK and a healthy HarnessInfo first. Run 2 is
  at least 10 min after run 1, on the same server.
- Reading rules, set now: a request is a FAIL if it times out, errors, gets 4xx/5xx, or its body is
  incomplete. A latency step is a level whose p50 is at least 2 times the previous level's p50,
  where the previous level's ratio to the one before it was under 1.5. A smooth rise of any size is
  not a step. One level is not a finding: it must repeat on a second run.

## Predictions

Made before the run. I give the first one more weight than the others, but I have no measurement.

P1. No per-user limit up to 16 on OData: all requests answer 200 with complete bodies; p50 grows
    smoothly (the server is single-core-bound per request, so some queueing is expected), never a
    step. (Reason: the 100 in `Max Active Request Count` is much larger than 16.)
P2. Dev endpoint: a package download is larger and slower; it may show queueing earlier than
    HarnessInfo, but no failures.
P3. Phase C: no interference. The baseline on the other server stays within normal spread
    (its during-ramp p50 under 2 times its alone p50).

## What would show a per-user limit

Any of these, repeated on a second run, on one phase:

- From some N on, 429 or 503, or `Retry-After`, in that phase.
- At some N, the first timeout or incomplete body (headers arrive, body stalls: the shape in
  sections 1 and 6), while lower levels were clean; and a latency step (rule above) at the same N.
  Because the run stops at the first one, the threshold is the N where it stopped.
- The threshold N is stable across the two runs, within one ramp step.
- If the Application event log on the server (read by the owner, not by the probe) shows event 705
  during that level, that confirms throttling by BC rather than by the network. The probe does not
  read the event log.

Event 705 with `Requests running` equal to the threshold N would support the "5 per user" reading;
a different number would show the 5 was only the count at that moment.

## What would show none up to 16

All three of: zero FAIL in phase A and B at all levels, no latency step, and the same on the second
run. This says nothing about:

- N above 16, or other users at once;
- long-held calls (`RunMutant`) holding OData slots. There is no harmless long-held call, since every
  long call needs `AcquireLease`. That question stays with LethAL's real peak in flight. A code
  trace counted that peak as (not measured live) 3 per run session and 5 for `lethal doctor`:
  `/coord/handoff/R-317/concurrency-trace.md`.

## Phase C: cross-server interference

Needs two different servers, bcX (ramped) and bcY (watched), and the lease on BOTH held by the caller.
All three servers sit on the same host (see docs/gates/servers.md), so a shared host limit, a shared
disk or one shared user store could show up here but not in a single-server run.

- First 20 single requests (HarnessInfo, 250 ms apart) on bcY alone: the baseline.
- Then the same single request repeated on bcY while bcX runs HarnessInfo at N = 8 and N = 15 (15, so
  the total in flight stays at 16 or less).
- Interference is shown if, during the ramp, bcY's p50 is 2 or more times its baseline p50, or bcY
  gets any FAIL while its baseline had none, and it repeats on a second run. A single slow request
  is not interference.
- No interference: bcY's p50 within 2 times baseline and no FAIL.
- bcY slowing under bcX's load on the same host reads as "interference (shared host)", not as a
  per-user limit.
- Phase C stops too: a failed warm-up, baseline or watcher request on bcY, or the total time limit,
  skips the rest of phase C with a note.
- Caveat: bcX and bcY use the same login name, but each server has its own user store, so a
  "per-user" limit on bcX cannot be expected to reach bcY; interference would mean a shared resource.

## What each outcome means for LethAL

| outcome | LethAL action |
|---|---|
| None up to 16 (both phases), no interference | Document only: update R317 with the figures and the date, say the "5 per user" reading is not supported up to 16, close the question for LethAL's own peak (LethAL makes far fewer concurrent calls than 16). |
| Limit found on OData at N* | Compare N* with LethAL's real peak of concurrent calls per user (count it from a run's events first; not measured today). If peak is under N*: document the number and keep the probe rule (separate probe user). If peak can reach N*: a guard, a cap on in-flight control-app calls in the harness client, below N*, with a unit test and a red-check. |
| Limit only on the dev endpoint | Document; LethAL's dev calls are serial per run. A guard only if two runs on one user can overlap, which the lease already prevents. |
| Interference across servers | Document in docs/gates/servers.md that parallel gates on different servers share a resource, and re-check the "one gate per server in parallel" rule. A guard is for the owner to decide. |
| Mixed or unstable result | Not a finding. Repeat once; if still mixed, file what was seen and what was not, no rule. |

Each outcome is written into R317 with the run's output directory named (no credentials, no corpus
text; the samples hold only status codes, byte counts and times).
