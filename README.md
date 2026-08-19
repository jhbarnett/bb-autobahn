# bb-plugin-autobahn

A compact, policy-driven board where visible bb threads are stable controller
cards and fresh hidden child threads perform bounded planning and verification
passes.

## Board

The board uses bb thread sections as its coarse state:

1. `OPEN`
2. `WIP`
3. `R4R`
4. `CLOSED`

The lanes describe ownership rather than every operational detail: Open is queued,
forthcoming, or parked work; WIP is work allocated to an agent; R4R is verified
work awaiting a human decision; Closed is accepted or externally completed work.
Autobahn reads open issues from the installed GitHub plugin, ranks common P0
through P3 labels ahead of unlabeled work, and shows the configured top five
issues by default.
Open controller threads render as ordinary cards; the compact roadmap cards are
reserved for unstarted issues, link to GitHub, and can be turned into stopped
Open sessions by the Driver.

Controller agents can call `autobahn_capture_work` when brainstorming or
closeout reveals durable future work. The tracker-neutral tool takes a title,
description, optional acceptance criteria, and optional labels. Today a small
GitHub adapter infers the current project repository, reuses an exact-title open
issue when possible, creates the issue otherwise, records source-thread
provenance, refreshes the roadmap, and never starts an agent session. The public
tool contract can remain unchanged when another tracker adapter is added.

Closed follows external work state. A linked issue or pull request closing or
merging moves its card to Closed. If external work reopens, an unverified card
returns to Open and a verified card returns to R4R. Autobahn checks this on board
loads and every five minutes.

A user drag or Driver move is an explicit, durable status override, so a closed
PR never has to mean the thread is finished. The small `Auto` control on an
overridden card, or the Driver clear-override tool, restores external automation
and immediately reconciles the current GitHub state.

Workflow metadata is orthogonal to those sections. A color-coded corner tick
shows the live operational state: muted for idle or queued, primary for an active
agent, warning for parked, attention-color for human attention, destructive for blocked
or failed, and success for complete. Cards also show phase, gate, risk, priority,
evidence and concern counts, one required `Next:` action, native bb or PR
attention, project, harness logo, model, context usage, and external links.
The Needs You filter isolates blocked, approval, review, runtime, staleness, and
consistency signals. WIP and R4R limits are soft settings: the UI warns and the
Driver dispatches only into available capacity.

## Workflow

- A visible card thread is the stable controller and human conversation.
- Newly discovered future work is captured in the issue tracker before it becomes
  an execution session; ordinary controller agents and the Driver share this tool.
- Planning spawns an isolated planner child with a read-only contract followed
  by a fresh adversarial reviewer, with at most two revision rounds. Review
  children use disposable managed worktrees and receive no Autobahn mutation
  tools, so they cannot alter the controller worktree.
- High and critical risk plans require explicit human approval.
- Every station exits through `autobahn_report_exit` with the internal typed
  result `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`, evidence,
  concerns, and one next action. These results are separate from the Closed lane.
- Verification fans out fresh-context lenses, then starts a fresh validator for
  every finding. Rejected findings are dropped.
- Successful build work advances to verification, not directly to Closed.
- Parking supports timers, dependencies, pending interactions, PR merges, and
  check completion. Parking moves the card to Open without discarding its workflow
  phase, and it can be dispatched back to WIP after waking.
- A scheduled wake pass surfaces satisfied conditions. A witness pass reports
  stale or inconsistent work and never kills it.
- Current workflow state, manual status provenance, and an append-only event
  ledger live in the plugin database; bb threads, environments, and GitHub state
  remain authoritative for execution.

## Driver

The steering-wheel button in the board header opens a persistent Driver thread
in a right-side panel. It can inventory, create, assign, contract, plan, approve,
verify, dispatch, move, park, wake, witness, stop, archive, and unarchive sessions.
It can also capture tracker work, start prioritized roadmap issues, and set or
clear explicit status overrides. Its hidden runtime is released whenever idle and
resumes on the next message.

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
