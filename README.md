# Autobahn

Autobahn is an opinionated, automated Kanban flywheel for [bb](https://github.com/get-bb/bb). Work is pulled, not pushed: captured items queue on the Open roadmap, the Driver dispatches ready work into WIP as capacity frees, finished builds roll into fresh-context verification, verified work stops for exactly one human decision, and what closes feeds the next round of capture. Each visible card is a stable controller thread; fresh hidden agents perform bounded planning and verification passes in isolated worktrees.

Policy is a feature, not the foundation. Gates, WIP limits, plan contracts, and typed exits are tunable guardrails that keep the flywheel honest — the automation is what keeps it spinning.

## Install

```sh
bb plugin install https://github.com/jhbarnett/bb-autobahn
```

Autobahn requires bb `>=0.38` and plugin SDK `>=0.4.6`. The official bb GitHub plugin is optional, but required for roadmap mirroring, tracker-backed work capture, and issue or pull-request status automation.

## Board model

The board uses bb thread sections as coarse ownership state:

1. **Open** — queued, forthcoming, or parked work
2. **WIP** — work allocated to an agent
3. **R4R** — verified work awaiting a human decision
4. **Closed** — accepted or externally completed work

A theme-aware corner tick carries the live operational state independently of the lane: idle or queued, agent active, parked, needs human attention, blocked or failed, or complete.

Open combines controller threads with unstarted GitHub issues. Captured work is always front-of-line, regardless of ranking mode. The roadmap is expandable from one to three rows. Individual roadmap issues can be snoozed for one day, three days, one week, or a custom time; they return automatically and the Open header keeps a visible snoozed count.

Closed is collapsed by default and can be expanded from its lane header. Its broom action clears cards from the Autobahn display only—it never archives threads. Threads archived elsewhere disappear automatically because the board reads only active threads and refreshes on archive events.

### Roadmap ranking

`roadmapRanking` controls which unstarted issues appear first:

- `balanced` (default) — treats unlabeled issues as medium priority and rotates across repositories
- `priority` — strict P0 through P3 ordering, then recency
- `recency` — newest update first

Common P0–P3 and priority labels are recognized. Captured items form a tier ahead of P0 in every mode. `roadmapLimit` controls the maximum displayed issue count.

## Workflow

- A visible card thread remains the human conversation and stable controller.
- Nontrivial or high-risk work receives an evidence-checkable plan contract and adversarial plan review.
- High and critical risk plans require a native human approval interaction.
- Successful build exits advance to fresh-context verification, never directly to Closed.
- Verification runs bounded parallel lenses and independently validates every proposed finding.
- Parking moves work to Open without discarding its workflow phase. Timer, dependency, interaction, PR, and checks-based wake conditions are supported.
- Linked issue and PR state reconciles Closed automatically. Reopened verified work returns to R4R; other reopened work returns to Open.
- User or Driver moves create durable overrides. The card’s **Auto** control restores external-state reconciliation.

Workflow state and an append-only event ledger live in the plugin SQLite database. bb remains authoritative for threads and environments; the issue tracker remains authoritative for roadmap work.

## Capture future work

Controller agents and the Driver can call `autobahn_capture_work` when brainstorming or closeout reveals a durable future requirement. The tool contract is tracker-neutral:

```ts
{
  projectId?: string,
  title: string,
  description: string,
  acceptanceCriteria?: string[],
  labels?: string[]
}
```

Today the adapter targets GitHub. It infers the project repository, reuses an exact-title open issue when possible, records source-thread provenance, and never starts an agent session. Every model-initiated tracker write requires explicit human confirmation. A future tracker adapter such as Linear can be selected behind the same public tool contract.

## Driver

The steering-wheel button opens a persistent Driver thread in a right-side panel. The Driver can inventory, capture, create, assign, plan, approve, verify, dispatch, move, park, wake, witness, stop, archive, and unarchive sessions. Its hidden runtime is released whenever idle and resumes with the next message.

## Configuration

| Setting | Default | Purpose |
| --- | ---: | --- |
| `wipLimit` | `3` | Soft per-project WIP capacity |
| `reviewLimit` | `6` | Soft R4R capacity |
| `staleHours` | `24` | Staleness attention threshold |
| `contextWarningPercent` | `85` | Context exhaustion warning |
| `roadmapLimit` | `5` | Maximum unstarted roadmap issues |
| `roadmapRanking` | `balanced` | `balanced`, `priority`, or `recency` |

Configure values through **Extensions → Plugins → Autobahn** or `bb plugin config autobahn set <key> <value>`.

## Security

Autobahn is a full-trust bb plugin. Install only source you trust. Fresh planning and verification agents use branch-backed disposable managed worktrees, `accept-edits`, bounded concurrency and timeouts, strict structured-output validation, and no Autobahn mutation tools. Provider-standard capabilities remain governed by bb’s machine and permission policies; worktree isolation is not a confidentiality sandbox for hostile repositories.

Tracker writes require a blocking human confirmation. Autobahn never handles GitHub credentials directly; it calls the official GitHub plugin through schema-validated RPCs. See [SECURITY.md](SECURITY.md) for private reporting and the complete trust model.

## Development

```sh
git clone https://github.com/jhbarnett/bb-autobahn.git
cd bb-autobahn
npm ci
npm run check
bb plugin install .
```

After source edits:

```sh
bb plugin reload autobahn
```

`npm run check` runs TypeScript checks, all Vitest suites, and a production plugin build.
