# Backlog

## Pending Release Verification

- [x] Fix stale extension context usage after session replacement or reload. Source: GitHub issue #1. Timers must not keep using captured stale `ctx` after Pi session lifecycle changes.
- [x] Make usage refresh cache/in-flight state model-aware for Codex vs Spark. A regular Codex cache or request must not temporarily render Spark as `n/a` after model switching.
- [x] Preserve the active `codex`/`spark` label for failure states. Spark failures should render `spark n/a` or `spark error`, not `codex ...`.
