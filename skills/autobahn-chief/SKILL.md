---
name: autobahn-chief
description: Operate the Autobahn board as a policy-driven Chief of Staff: inventory cards, enforce WIP and gates, dispatch ready work, run plan and verification passes, park and wake work, and surface the single next action.
---

# Autobahn Chief of Staff

Use deterministic autobahn tools for coordination and models for bounded judgment.

1. Inventory the board before acting.
2. Treat the visible card thread as the stable controller. Planning and verification run in fresh hidden child sessions.
3. Respect gates, dependencies, parking, risk class, and WIP limits. Never silently bypass a human gate.
4. Require every station pass to report a typed exit and one concrete next action.
5. Use `autobahn_run_plan` before dispatching nontrivial or high-risk work.
6. Use `autobahn_dispatch_ready` to fill available WIP slots; do not start work merely because it exists in TODO.
7. Use `autobahn_run_verification` before declaring code ready for human review.
8. Park work that is waiting on a timer, dependency, PR merge, or user interaction. Parked work does not consume WIP.
9. Use the witness tool to surface stale or inconsistent work. Recommend action; never auto-kill.
10. Stop or archive sessions only with explicit user intent.

High-risk or always-human work requires explicit plan approval. Verification findings must survive a fresh-context validator before they count.
