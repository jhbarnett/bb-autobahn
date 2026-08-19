import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export type WorkflowGate =
  | "none"
  | "needs-input"
  | "plan-approval"
  | "blocked"
  | "checks-failed"
  | "changes-requested"
  | "review-requested"
  | "runtime-error"
  | "stale"
  | "context-high"
  | "wip-overflow"
  | "done-with-open-pr";

export type WorkflowRisk = "low" | "medium" | "high" | "critical";
export type WorkflowPriority = "low" | "normal" | "high" | "urgent";
export type WorkflowPhase =
  | "intake"
  | "plan"
  | "build"
  | "verify"
  | "egress"
  | "complete";

export interface WorkflowAttentionSummary {
  gate: Exclude<WorkflowGate, "none">;
  count: number;
}

const GATE_PRESENTATION: Record<
  Exclude<WorkflowGate, "none">,
  { short: string; label: string; tone: string }
> = {
  "needs-input": {
    short: "Input",
    label: "Needs input",
    tone: "border-primary/30 bg-primary/10 text-primary",
  },
  "plan-approval": {
    short: "Plan",
    label: "Plan approval needed",
    tone: "border-primary/30 bg-primary/10 text-primary",
  },
  blocked: {
    short: "Blocked",
    label: "Blocked",
    tone: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  "checks-failed": {
    short: "Checks",
    label: "Checks failed",
    tone: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  "changes-requested": {
    short: "Changes",
    label: "Changes requested",
    tone: "border-border bg-muted text-foreground",
  },
  "review-requested": {
    short: "Review",
    label: "Review requested",
    tone: "border-border bg-muted text-foreground",
  },
  "runtime-error": {
    short: "Error",
    label: "Runtime error",
    tone: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  stale: {
    short: "Stale",
    label: "Stale work",
    tone: "border-border bg-muted text-foreground",
  },
  "context-high": {
    short: "Context",
    label: "High context without handoff",
    tone: "border-primary/30 bg-primary/10 text-primary",
  },
  "wip-overflow": {
    short: "WIP",
    label: "WIP limit exceeded",
    tone: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  "done-with-open-pr": {
    short: "PR open",
    label: "Done with open pull request",
    tone: "border-destructive/30 bg-destructive/10 text-destructive",
  },
};

const RISK_SHORT: Record<WorkflowRisk, string> = {
  low: "R1",
  medium: "R2",
  high: "R3",
  critical: "R4",
};

const PRIORITY_SHORT: Record<WorkflowPriority, string> = {
  low: "P3",
  normal: "P2",
  high: "P1",
  urgent: "P0",
};

function titleCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

export function WorkflowGateBadge({
  gate,
  className,
}: {
  gate: WorkflowGate | null | undefined;
  className?: string;
}) {
  if (!gate || gate === "none") return null;
  const presentation = GATE_PRESENTATION[gate];

  return (
    <span
      className={cn(
        "inline-flex h-4 max-w-full items-center gap-1 rounded border px-1 text-[9px] font-semibold leading-none",
        presentation.tone,
        className,
      )}
      title={presentation.label}
      aria-label={`Attention: ${presentation.label}`}
    >
      {gate === "blocked" || gate === "checks-failed" ? (
        <Icon name="AlertTriangle" className="size-2.5" aria-hidden="true" />
      ) : null}
      <span className="truncate">{presentation.short}</span>
    </span>
  );
}

export function WorkflowMetadata({
  risk,
  priority,
  phase,
  className,
}: {
  risk?: WorkflowRisk | null;
  priority?: WorkflowPriority | null;
  phase?: WorkflowPhase | null;
  className?: string;
}) {
  if (!risk && !priority && !phase) return null;

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 text-[9px] font-medium text-muted-foreground",
        className,
      )}
      aria-label="Workflow metadata"
    >
      {phase ? (
        <span
          className="max-w-16 truncate rounded bg-muted px-1 py-0.5 text-foreground"
          title={`Phase: ${titleCase(phase)}`}
          aria-label={`Phase: ${titleCase(phase)}`}
        >
          {phase}
        </span>
      ) : null}
      {priority ? (
        <span
          className={cn(
            "rounded px-1 py-0.5 tabular-nums",
            priority === "urgent"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted",
          )}
          title={`Priority: ${titleCase(priority)}`}
          aria-label={`Priority: ${titleCase(priority)}`}
        >
          {PRIORITY_SHORT[priority]}
        </span>
      ) : null}
      {risk ? (
        <span
          className={cn(
            "rounded px-1 py-0.5 tabular-nums",
            risk === "critical" || risk === "high"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted",
          )}
          title={`Risk: ${titleCase(risk)}`}
          aria-label={`Risk: ${titleCase(risk)}`}
        >
          {RISK_SHORT[risk]}
        </span>
      ) : null}
    </div>
  );
}

export function NextAction({
  action,
  className,
}: {
  action: string | null | undefined;
  className?: string;
}) {
  const normalized = action?.trim();
  if (!normalized) return null;

  return (
    <p
      className={cn(
        "flex min-w-0 items-baseline gap-1 text-[10px] leading-4",
        className,
      )}
      title={`Next: ${normalized}`}
      aria-label={`Next action: ${normalized}`}
    >
      <span className="shrink-0 font-semibold text-foreground">Next:</span>
      <span className="truncate text-muted-foreground">{normalized}</span>
    </p>
  );
}

export function EvidenceConcernsIndicator({
  evidenceCount = 0,
  concernsCount = 0,
  className,
}: {
  evidenceCount?: number;
  concernsCount?: number;
  className?: string;
}) {
  const evidence = Math.max(0, evidenceCount);
  const concerns = Math.max(0, concernsCount);
  if (evidence === 0 && concerns === 0) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[9px] font-medium tabular-nums text-muted-foreground",
        className,
      )}
      aria-label={`${evidence} evidence item${evidence === 1 ? "" : "s"}; ${concerns} concern${concerns === 1 ? "" : "s"}`}
    >
      {evidence > 0 ? (
        <span
          className="inline-flex items-center gap-0.5"
          title={`${evidence} evidence item${evidence === 1 ? "" : "s"}`}
        >
          <Icon name="ExternalLink" className="size-2.5" aria-hidden="true" />
          {evidence}
        </span>
      ) : null}
      {concerns > 0 ? (
        <span
          className="inline-flex items-center gap-0.5 text-destructive"
          title={`${concerns} concern${concerns === 1 ? "" : "s"}`}
        >
          <Icon name="AlertTriangle" className="size-2.5" aria-hidden="true" />
          {concerns}
        </span>
      ) : null}
    </span>
  );
}

export function NeedsYouStrip({
  count,
  active,
  reasons = [],
  onActiveChange,
  className,
}: {
  count: number;
  active: boolean;
  reasons?: readonly WorkflowAttentionSummary[];
  onActiveChange: (active: boolean) => void;
  className?: string;
}) {
  const normalizedCount = Math.max(0, count);
  const reasonSummary = reasons
    .filter((reason) => reason.count > 0)
    .map(
      (reason) =>
        `${GATE_PRESENTATION[reason.gate].label}: ${reason.count}`,
    )
    .join("; ");
  const label = `Needs you: ${normalizedCount}${reasonSummary ? `. ${reasonSummary}` : ""}`;

  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`${active ? "Clear" : "Show"} Needs you filter. ${label}`}
      title={reasonSummary || label}
      disabled={normalizedCount === 0 && !active}
      onClick={() => onActiveChange(!active)}
      className={cn(
        "flex min-h-8 w-full items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        active && "border-primary bg-primary/10 text-primary",
        className,
      )}
    >
      <Icon
        name={normalizedCount > 0 ? "AlertCircle" : "CircleCheck"}
        className="size-3.5 shrink-0"
        aria-hidden="true"
      />
      <span className="font-semibold">Needs you</span>
      <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground">
        {normalizedCount}
      </span>
      {reasonSummary ? (
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          {reasonSummary}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          No attention needed
        </span>
      )}
    </button>
  );
}

export function LaneCapacity({
  count,
  limit,
  laneLabel = "Lane",
  className,
}: {
  count: number;
  limit?: number | null;
  laneLabel?: string;
  className?: string;
}) {
  const normalizedCount = Math.max(0, count);
  const normalizedLimit = limit != null && limit > 0 ? limit : null;
  const overflow =
    normalizedLimit === null ? 0 : Math.max(0, normalizedCount - normalizedLimit);
  const label =
    normalizedLimit === null
      ? `${laneLabel}: ${normalizedCount} cards`
      : overflow > 0
        ? `${laneLabel}: ${normalizedCount} of ${normalizedLimit}; soft limit exceeded by ${overflow}`
        : `${laneLabel}: ${normalizedCount} of ${normalizedLimit}`;

  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full bg-muted px-2 text-[10px] font-semibold tabular-nums text-muted-foreground",
        overflow > 0 && "bg-destructive/10 text-destructive",
        className,
      )}
      title={label}
      aria-label={label}
    >
      {overflow > 0 ? (
        <Icon name="AlertTriangle" className="size-2.5" aria-hidden="true" />
      ) : null}
      {normalizedLimit === null
        ? normalizedCount
        : `${normalizedCount}/${normalizedLimit}`}
    </span>
  );
}
