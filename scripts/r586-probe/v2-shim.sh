#!/usr/bin/env bash
# R586 measurement shim: lets LethAL's UNCHANGED al-runner (v2) backend drive al-runtime-rs (v3),
# so the fixtures run through LethAL's real pipeline. Each translation below is one LethAL change
# a real backend would need; the shim exists to MEASURE, never to ship.
#   1. `--version`: LethAL refuses anything not matching /\bv2\.\d/ (al-runner-backend.ts).
#   2. one-shot argv gets the `test` subcommand in front; `--server` becomes `serve`.
#   3. exit 7 / 8 (some tests not run) become 1, so LethAL reads the rows; the not-run rows carry
#      `NotRun: out-of-scope: ...`, which RUNNER_REFUSAL already scores as neither killed nor
#      survived. Every other exit is passed through unchanged.
# Every call is logged to $R586_SHIM_LOG (when set) with its argv and real exit code.
set -u
R="${R586_ALRUNNER:?set R586_ALRUNNER to the alrunner binary}"
log() { [ -n "${R586_SHIM_LOG:-}" ] && printf '%s\t%s\n' "$1" "$2" >> "$R586_SHIM_LOG"; return 0; }
case "${1:-}" in
  --version)
    printf 'al-runner v2.99.0-r586shim (%s)\n' "$("$R" --version)"
    exit 0 ;;
  --server)
    shift
    log "serve" "$*"
    # R-606 measurement-only tap (scratch worktree only): requests in, summary/error lines out,
    # beside the shim log (<tag>.serve-in.ndjson, <tag>.serve-out.ndjson). exec keeps the pid.
    if [ -n "${R586_SHIM_LOG:-}" ]; then
      T="${R586_SHIM_LOG%.shim.tsv}"
      exec "$R" serve "$@" < <(tee -a "$T.serve-in.ndjson") \
        > >(tee >(grep --line-buffered -E '"type": ?"summary"|^\{"error"' >> "$T.serve-out.ndjson"))
    fi
    exec "$R" serve "$@" ;;
esac
# Optional (measurement only): R586_ISOLATION replaces the mode LethAL sends after `--isolation`.
args=("$@")
if [ -n "${R586_ISOLATION:-}" ]; then
  for i in "${!args[@]}"; do
    if [ "${args[$i]}" = "--isolation" ]; then args[$((i + 1))]="$R586_ISOLATION"; fi
  done
fi
"$R" test "${args[@]}"
rc=$?
log "exit=$rc" "$*"
case $rc in
  7|8) exit 1 ;;
  *) exit $rc ;;
esac
