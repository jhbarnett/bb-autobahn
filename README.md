# bb-plugin-autobahn

A compact, policy-driven board where visible bb threads are stable controller
cards and fresh hidden child threads perform bounded planning and verification
passes.

## Board

The board uses bb thread sections as its coarse state:

1. `TODO`
2. `WIP`
3. `R4R`
4. `DONE`

Workflow metadata is orthogonal to those columns. Cards show phase, gate, risk,
priority, evidence and concern counts, one required `Next:` action, native bb
or PR attention, project, harness, model, context usage, and external links.
The Needs You filter isolates blocked, approval, review, runtime, staleness, and
consistency signals. WIP and R4R limits are soft settings: the UI warns and the
Chief dispatches only into available capacity.

## Workflow

- A visible card thread is the stable controller and human conversation.
- Planning spawns an isolated planner child with a read-only contract followed
  by a fresh adversarial reviewer, with at most two revision rounds. Review
  children use disposable managed worktrees and receive no Autobahn mutation
  tools, so they cannot alter the controller worktree.
- High and critical risk plans require explicit human approval.
- Every station exits through `autobahn_report_exit` with
  `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`, evidence, concerns,
  and one next action.
- Verification fans out fresh-context lenses, then starts a fresh validator for
  every finding. Rejected findings are dropped.
- Successful build work advances to verification, not directly to DONE.
- Parking supports timers, dependencies, pending interactions, PR merges, and
  check completion. Parked cards do not consume WIP.
- A scheduled wake pass surfaces satisfied conditions. A witness pass reports
  stale or inconsistent work and never kills it.
- Current workflow state and an append-only event ledger live in the plugin
  database; bb threads, environments, and PR state remain authoritative for
  execution.

## Chief of Staff

The board header opens a persistent Chief thread in a right-side panel. It can
inventory, create, assign, contract, plan, approve, verify, dispatch, move,
park, wake, witness, stop, archive, and unarchive sessions. Its hidden runtime
is released whenever idle and resumes on the next message.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
bb plugin install .
```

After source edits:

```sh
bb plugin reload autobahn
```

The plugin targets bb `>=0.38` and plugin SDK `>=0.4.6`.
