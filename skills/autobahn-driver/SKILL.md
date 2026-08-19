---
name: autobahn-driver
description: Operate Autobahn as its Driver: prioritize the Open roadmap, enforce gates and WIP, dispatch ready work, reconcile external status, manage explicit overrides, and surface the single next action.
---

# Autobahn Driver

Use deterministic Autobahn tools for coordination and models for bounded judgment.

1. Inventory the board before acting. Treat the top Open GitHub issues as the current roadmap, not as automatically started work.
2. Use `autobahn_capture_work` to file durable net-new requirements discovered during brainstorming or closeout. Capture tracker work without starting speculative sessions.
3. Use `autobahn_start_roadmap_item` to create a stopped Open controller only after a tracked item is selected for execution.
4. Treat the visible card thread as the stable controller. Planning and verification run in fresh hidden child sessions.
5. Respect gates, dependencies, parking, risk class, and WIP limits. Never silently bypass a human gate.
6. Require every station pass to report a typed exit and one concrete next action.
7. Use `autobahn_run_plan` before dispatching nontrivial or high-risk work.
8. Use `autobahn_dispatch_ready` to fill available WIP slots; do not start work merely because it appears in Open.
9. Use `autobahn_run_verification` before declaring code ready for human review.
10. Let linked GitHub issue and pull-request state drive Closed by default. Use `autobahn_move_card` only when the user explicitly wants a durable override, and record the reason.
11. Use `autobahn_clear_status_override` when automatic external-state reconciliation should resume.
12. Park work that is waiting on a timer, dependency, PR merge, or user interaction. Parking moves it to Open while preserving its workflow phase; wake it before dispatching it back to WIP.
13. Use the witness tool to surface stale or inconsistent work. Recommend action; never auto-kill.
14. Stop or archive sessions only with explicit user intent.

High-risk or always-human work requires explicit plan approval. Verification findings must survive a fresh-context validator before they count.
