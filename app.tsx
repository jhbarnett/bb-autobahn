import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ThreadChat,
  definePluginApp,
  experimental_useSidebarThreadActions,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type PluginPendingInteractionProps,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { BoardResult, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  EvidenceConcernsIndicator,
  LaneCapacity,
  NeedsYouStrip,
  NextAction,
  WorkflowGateBadge,
  WorkflowMetadata,
  type WorkflowAttentionSummary,
  type WorkflowPriority,
} from "@/components/workflow-meta";
import { cn } from "@/lib/utils";

const BOARD_STATUSES = ["OPEN", "WIP", "R4R", "CLOSED"] as const;
type Lane = BoardResult["lanes"][number];
type Card = Lane["cards"][number];
type RoadmapItem = BoardResult["roadmapItems"][number];
type BoardStatus = (typeof BOARD_STATUSES)[number];

const STATUS_LABELS: Record<BoardStatus, string> = {
  OPEN: "Open",
  WIP: "Work in progress",
  R4R: "Ready for review",
  CLOSED: "Closed",
};

function contextPercent(card: Card) {
  if (!card.context) return null;
  const percent = Math.min(
    100,
    Math.round(
      (card.context.usedTokens / card.context.modelContextWindow) * 100,
    ),
  );
  return `${percent}%${card.context.estimated ? "~" : ""}`;
}

function harnessLogo(harness: string): IconName {
  const normalized = harness.toLowerCase();
  if (normalized.includes("codex") || normalized.includes("openai")) {
    return "ChatGPT";
  }
  if (normalized.includes("claude") || normalized.includes("anthropic")) {
    return "Claude";
  }
  if (normalized.includes("copilot")) return "Copilot";
  if (normalized.includes("gemini")) return "Gemini";
  if (normalized === "pi" || normalized.includes("pi-agent")) return "Pi";
  return "Terminal";
}

function workflowPriority(priority: number): WorkflowPriority {
  if (priority <= 0) return "urgent";
  if (priority === 1) return "high";
  if (priority === 2) return "normal";
  return "low";
}

function compactLinkLabel(card: Card, label: string) {
  if (card.links.length > 1) return label.replace(/^(PR|Issue) /, "");
  return label;
}

type CardState =
  | "idle"
  | "active"
  | "parked"
  | "attention"
  | "blocked"
  | "complete";

const CARD_STATE: Record<
  CardState,
  { label: string; borderClass: string; swatchClass: string }
> = {
  idle: {
    label: "Idle or queued",
    borderClass: "border-muted-foreground/50",
    swatchClass: "bg-muted-foreground/50",
  },
  active: {
    label: "Agent active",
    borderClass: "border-primary",
    swatchClass: "bg-primary",
  },
  parked: {
    label: "Parked or waiting",
    borderClass: "border-[var(--warning)]",
    swatchClass: "bg-[var(--warning)]",
  },
  attention: {
    label: "Needs human attention",
    borderClass: "border-[var(--attention)]",
    swatchClass: "bg-[var(--attention)]",
  },
  blocked: {
    label: "Blocked or failed",
    borderClass: "border-destructive",
    swatchClass: "bg-destructive",
  },
  complete: {
    label: "Complete",
    borderClass: "border-[var(--success)]",
    swatchClass: "bg-[var(--success)]",
  },
};

function cardState(card: Card): CardState {
  if (
    card.runtimeStatus === "error" ||
    card.workflow.exitStatus === "BLOCKED" ||
    ["blocked", "checks-failed", "changes-requested"].includes(
      card.workflow.gate,
    )
  ) {
    return "blocked";
  }
  if (card.workflow.parkedWake) return "parked";
  if (
    card.status === "R4R" ||
    ["needs-input", "plan-approval", "review-requested"].includes(
      card.workflow.gate,
    )
  ) {
    return "attention";
  }
  if (["active", "starting"].includes(card.runtimeStatus)) return "active";
  if (card.status === "CLOSED" || card.workflow.phase === "complete") {
    return "complete";
  }
  return "idle";
}

function CardStateTick({ state }: { state: CardState }) {
  const presentation = CARD_STATE[state];
  return (
    <span
      role="img"
      aria-label={`Card state: ${presentation.label}`}
      title={presentation.label}
      className={cn(
        "pointer-events-none absolute right-0 top-0 size-4 rounded-tr-lg border-r-[3px] border-t-[3px]",
        presentation.borderClass,
      )}
    />
  );
}

function StateLegend() {
  return (
    <div
      aria-label="Card state colors"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-muted-foreground"
    >
      {(Object.entries(CARD_STATE) as Array<[CardState, (typeof CARD_STATE)[CardState]]>).map(
        ([state, presentation]) => (
          <span key={state} className="inline-flex items-center gap-1">
            <span
              className={cn("size-2 rounded-sm", presentation.swatchClass)}
              aria-hidden="true"
            />
            {presentation.label}
          </span>
        ),
      )}
    </div>
  );
}

function AutobahnCard({
  card,
  moving,
  clearingOverride,
  onClearOverride,
}: {
  card: Card;
  moving: boolean;
  clearingOverride: boolean;
  onClearOverride: (threadId: string) => void;
}) {
  const navigate = useBbNavigate();
  const context = contextPercent(card);

  return (
    <article
      draggable={!moving}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", card.id);
      }}
      className={cn(
        "group relative flex w-60 shrink-0 cursor-grab flex-col rounded-lg border border-border bg-card shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing",
        moving && "pointer-events-none opacity-60",
      )}
    >
      <CardStateTick state={cardState(card)} />
      <header className="px-2.5 py-2">
        <div className="flex items-start gap-1.5">
          <button
            type="button"
            onClick={() => navigate.toThread(card.id)}
            className="line-clamp-2 min-w-0 flex-1 text-left text-xs font-semibold leading-4 text-card-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {card.title}
          </button>
          <WorkflowGateBadge gate={card.workflow.gate} />
          <Icon
            name="DragDropVertical"
            className="size-3.5 shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground"
            aria-label="Drag card"
          />
        </div>

        <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
          <span title={`Coding harness: ${card.harness}`}>
            <Icon
              name={harnessLogo(card.harness)}
              className="size-3.5"
              aria-label={`${card.harness} coding harness`}
            />
          </span>
          <span
            className="min-w-0 truncate"
            title={`Model: ${card.model ?? "unknown"}; effort: ${card.effort ?? "unknown"}`}
          >
            {card.model ?? "—"}
            {card.effort ? ` · ${card.effort}` : ""}
          </span>
          {context ? (
            <span
              className="ml-auto shrink-0 tabular-nums"
              title={`${card.context?.usedTokens.toLocaleString()} / ${card.context?.modelContextWindow.toLocaleString()} context tokens`}
            >
              {context}
            </span>
          ) : null}
        </div>
        <div className="mt-1.5 flex min-w-0 items-center justify-between gap-1.5">
          <WorkflowMetadata
            phase={card.workflow.phase}
            priority={workflowPriority(card.workflow.priority)}
            risk={card.workflow.riskClass}
          />
          {card.workflow.statusOverride ? (
            <button
              type="button"
              disabled={clearingOverride}
              onClick={(event) => {
                event.stopPropagation();
                onClearOverride(card.id);
              }}
              className="inline-flex shrink-0 items-center gap-0.5 rounded border border-border px-1 py-0.5 text-[9px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              title={card.workflow.statusOverrideReason ?? "Manual board status"}
            >
              <Icon
                name={clearingOverride ? "Spinner" : "RotateCcw"}
                className={cn("size-2.5", clearingOverride && "animate-spin")}
                aria-hidden="true"
              />
              Auto
            </button>
          ) : null}
          <EvidenceConcernsIndicator
            evidenceCount={card.workflow.evidence.length}
            concernsCount={card.workflow.concerns.length}
          />
        </div>
        <NextAction action={card.workflow.nextAction} className="mt-1" />
      </header>

      {!card.workflow.nextAction && card.summary ? (
        <button
          type="button"
          onClick={() => navigate.toThread(card.id)}
          className="border-t border-border px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <p className="line-clamp-2 text-[10px] leading-4 text-muted-foreground">
            {card.summary}
          </p>
        </button>
      ) : null}

      <footer className="flex min-h-7 items-center justify-between gap-1.5 border-t border-border px-2.5 py-1 text-[10px]">
        <span
          className="min-w-0 truncate font-medium text-muted-foreground"
          title={card.branchName ?? card.projectName}
        >
          {card.projectName}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {card.links.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex items-center gap-0.5 font-medium text-foreground hover:underline"
              title={link.state ? `${link.label} · ${link.state}` : link.label}
            >
              <Icon
                name={
                  link.kind === "pull-request"
                    ? "GitPullRequest"
                    : "ExternalLink"
                }
                className="size-3"
                aria-hidden="true"
              />
              {compactLinkLabel(card, link.label)}
            </a>
          ))}
        </span>
      </footer>
    </article>
  );
}

function RoadmapCard({
  item,
  snoozing,
  onSnooze,
}: {
  item: RoadmapItem;
  snoozing: boolean;
  onSnooze: (itemKey: string, wakeAt: number) => void;
}) {
  const navigate = useBbNavigate();
  const [showSnooze, setShowSnooze] = useState(false);
  const [customWake, setCustomWake] = useState("");
  const priority = item.priority <= 3 ? `P${item.priority}` : null;
  const snoozeFor = (durationMs: number) => {
    setShowSnooze(false);
    onSnooze(item.id, Date.now() + durationMs);
  };
  const title = (
    <span className="line-clamp-2 text-left text-xs font-semibold leading-4 text-card-foreground">
      {item.title}
    </span>
  );

  return (
    <article className="relative flex w-60 shrink-0 flex-col rounded-lg border border-dashed border-border bg-muted/30 px-2.5 py-2 shadow-sm">
      <CardStateTick state="idle" />
      <div className="flex items-start gap-1.5">
        {item.linkedThreadId ? (
          <button
            type="button"
            onClick={() => navigate.toThread(item.linkedThreadId!)}
            className="min-w-0 flex-1 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </button>
        ) : (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 flex-1 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {title}
          </a>
        )}
        <button
          type="button"
          disabled={snoozing}
          aria-label={`Snooze ${item.title}`}
          onClick={() => setShowSnooze((current) => !current)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <Icon
            name={snoozing ? "Spinner" : "Clock"}
            className={cn("size-3.5", snoozing && "animate-spin")}
            aria-hidden="true"
          />
        </button>
        <Icon name="Github" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        {item.captured ? (
          <span className="rounded bg-primary px-1 py-0.5 font-semibold text-primary-foreground">
            Captured
          </span>
        ) : priority ? (
          <span className="rounded bg-foreground px-1 py-0.5 font-semibold text-background">
            {priority}
          </span>
        ) : null}
        <a href={item.url} target="_blank" rel="noreferrer" className="truncate hover:underline">
          {item.repo}#{item.number}
        </a>
        {item.linkedThreadId ? <span className="ml-auto">Thread linked</span> : null}
      </div>
      {showSnooze ? (
        <div className="mt-2 space-y-1.5 border-t border-border pt-1.5 text-[10px]">
          <div className="flex gap-1">
            <Button size="sm" variant="outline" className="h-6 px-1.5 text-[10px]" onClick={() => snoozeFor(24 * 60 * 60 * 1_000)}>
              1 day
            </Button>
            <Button size="sm" variant="outline" className="h-6 px-1.5 text-[10px]" onClick={() => snoozeFor(3 * 24 * 60 * 60 * 1_000)}>
              3 days
            </Button>
            <Button size="sm" variant="outline" className="h-6 px-1.5 text-[10px]" onClick={() => snoozeFor(7 * 24 * 60 * 60 * 1_000)}>
              1 week
            </Button>
          </div>
          <div className="flex gap-1">
            <input
              type="datetime-local"
              value={customWake}
              aria-label={`Custom wake time for ${item.title}`}
              onChange={(event) => setCustomWake(event.target.value)}
              className="min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 text-[10px]"
            />
            <Button
              size="sm"
              className="h-6 px-1.5 text-[10px]"
              disabled={!customWake}
              onClick={() => {
                const wakeAt = new Date(customWake).getTime();
                if (Number.isFinite(wakeAt)) {
                  setShowSnooze(false);
                  onSnooze(item.id, wakeAt);
                }
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function LaneSection({
  lane,
  roadmapItems,
  movingThreadId,
  clearingOverrideId,
  snoozingItemId,
  snoozedCount,
  clearingClosed,
  onMove,
  onClearOverride,
  onSnoozeRoadmap,
  onClearClosed,
}: {
  lane: Lane;
  roadmapItems: RoadmapItem[];
  movingThreadId: string | null;
  clearingOverrideId: string | null;
  snoozingItemId: string | null;
  snoozedCount: number;
  clearingClosed: boolean;
  onMove: (threadId: string, status: BoardStatus) => void;
  onClearOverride: (threadId: string) => void;
  onSnoozeRoadmap: (itemKey: string, wakeAt: number) => void;
  onClearClosed: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [roadmapExpanded, setRoadmapExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(lane.status === "CLOSED");

  return (
    <section
      onDragEnter={() => setDragOver(true)}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragOver(false);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        const threadId = event.dataTransfer.getData("text/plain");
        if (threadId) onMove(threadId, lane.status);
      }}
      className={cn(
        "rounded-xl border border-transparent transition-colors",
        dragOver && "border-ring bg-accent/30",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border px-1 pb-2">
        <h2 className="text-xs font-bold tracking-[0.16em] text-foreground">
          {lane.status}
        </h2>
        <LaneCapacity
          count={lane.capacityCount}
          limit={lane.softLimit}
          laneLabel={lane.status}
        />
        <span className="text-[11px] text-muted-foreground">
          {STATUS_LABELS[lane.status]}
        </span>
        {lane.status === "OPEN" && snoozedCount > 0 ? (
          <span className="text-[10px] text-muted-foreground">
            {snoozedCount} snoozed
          </span>
        ) : null}
        {lane.status === "OPEN" && roadmapItems.length ? (
          <button
            type="button"
            aria-expanded={roadmapExpanded}
            aria-label={
              roadmapExpanded
                ? "Collapse Open roadmap"
                : "Expand Open roadmap"
            }
            onClick={() => setRoadmapExpanded((current) => !current)}
            className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {roadmapExpanded ? "1 row" : "3 rows"}
            <Icon
              name={roadmapExpanded ? "ChevronUp" : "ChevronDown"}
              className="size-3"
              aria-hidden="true"
            />
          </button>
        ) : null}
        {lane.status === "CLOSED" ? (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              disabled={clearingClosed || lane.cards.length === 0}
              aria-label="Clear Closed cards"
              onClick={onClearClosed}
              className="inline-flex items-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <Icon
                name={clearingClosed ? "Spinner" : "Clean"}
                className={cn("size-3.5", clearingClosed && "animate-spin")}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand Closed lane" : "Collapse Closed lane"}
              onClick={() => setCollapsed((current) => !current)}
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {collapsed ? "Show" : "Hide"}
              <Icon
                name={collapsed ? "ChevronDown" : "ChevronUp"}
                className="size-3"
                aria-hidden="true"
              />
            </button>
          </div>
        ) : null}
      </div>

      {!collapsed ? (
        <div className="space-y-2 px-1 py-2">
          {roadmapItems.length ? (
            <div
              className={cn(
                "grid auto-cols-[15rem] grid-flow-col gap-2 overflow-x-auto",
                roadmapExpanded ? "grid-rows-3" : "grid-rows-1",
              )}
            >
              {roadmapItems.map((item) => (
                <RoadmapCard
                  key={item.id}
                  item={item}
                  snoozing={snoozingItemId === item.id}
                  onSnooze={onSnoozeRoadmap}
                />
              ))}
            </div>
          ) : null}
          {lane.cards.length > 0 || roadmapItems.length === 0 ? (
            <div className="flex min-h-24 gap-2 overflow-x-auto">
              {lane.cards.map((card) => (
                <AutobahnCard
                  key={card.id}
                  card={card}
                  moving={movingThreadId === card.id}
                  clearingOverride={clearingOverrideId === card.id}
                  onClearOverride={onClearOverride}
                />
              ))}
              {lane.cards.length === 0 ? (
                <div className="flex min-h-20 w-full items-center justify-center rounded-lg border border-dashed border-border text-[11px] text-muted-foreground">
                  Drop a thread here
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AutobahnBoard() {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [board, setBoard] = useState<BoardResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [movingThreadId, setMovingThreadId] = useState<string | null>(null);
  const [clearingOverrideId, setClearingOverrideId] = useState<string | null>(null);
  const [snoozingItemId, setSnoozingItemId] = useState<string | null>(null);
  const [clearingClosed, setClearingClosed] = useState(false);
  const [needsYouOnly, setNeedsYouOnly] = useState(false);
  const mounted = useRef(true);
  const previousConnection = useRef(connectionState);

  const loadBoard = useCallback(
    async (quiet = false) => {
      if (!quiet) setIsRefreshing(true);
      try {
        const next = await rpc.call("listBoard", {});
        if (!mounted.current) return;
        setBoard(next);
        setError(null);
      } catch (caught) {
        if (!mounted.current) return;
        setError(
          caught instanceof Error ? caught.message : "Could not load board",
        );
      } finally {
        if (mounted.current && !quiet) setIsRefreshing(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    mounted.current = true;
    void loadBoard();
    const interval = window.setInterval(() => void loadBoard(true), 30_000);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
    };
  }, [loadBoard]);

  useRealtime("board-changed", () => {
    void loadBoard(true);
  });

  useEffect(() => {
    if (
      connectionState === "connected" &&
      previousConnection.current !== "connected"
    ) {
      void loadBoard(true);
    }
    previousConnection.current = connectionState;
  }, [connectionState, loadBoard]);

  const cardStatuses = useMemo(() => {
    const result = new Map<string, BoardStatus>();
    for (const lane of board?.lanes ?? []) {
      for (const card of lane.cards) result.set(card.id, card.status);
    }
    return result;
  }, [board]);

  const moveCard = useCallback(
    async (threadId: string, status: BoardStatus) => {
      if (movingThreadId || cardStatuses.get(threadId) === status) return;
      setMovingThreadId(threadId);
      try {
        const result = await rpc.call("moveThread", { threadId, status });
        if (result.warning) toast.warning(result.warning);
        await loadBoard(true);
      } catch (caught) {
        toast.error(
          caught instanceof Error ? caught.message : "Could not move thread",
        );
      } finally {
        if (mounted.current) setMovingThreadId(null);
      }
    },
    [cardStatuses, loadBoard, movingThreadId, rpc],
  );

  const clearOverride = useCallback(
    async (threadId: string) => {
      if (clearingOverrideId) return;
      setClearingOverrideId(threadId);
      try {
        await rpc.call("clearStatusOverride", { threadId });
        toast.success("Automatic external status restored");
        await loadBoard(true);
      } catch (caught) {
        toast.error(
          caught instanceof Error
            ? caught.message
            : "Could not restore automatic status",
        );
      } finally {
        if (mounted.current) setClearingOverrideId(null);
      }
    },
    [clearingOverrideId, loadBoard, rpc],
  );

  const snoozeRoadmap = useCallback(
    async (itemKey: string, wakeAt: number) => {
      if (snoozingItemId) return;
      setSnoozingItemId(itemKey);
      try {
        await rpc.call("snoozeRoadmapItem", { itemKey, wakeAt });
        toast.success("Roadmap item snoozed");
        await loadBoard(true);
      } catch (caught) {
        toast.error(
          caught instanceof Error ? caught.message : "Could not snooze item",
        );
      } finally {
        if (mounted.current) setSnoozingItemId(null);
      }
    },
    [loadBoard, rpc, snoozingItemId],
  );

  const clearClosed = useCallback(async () => {
    if (clearingClosed) return;
    setClearingClosed(true);
    try {
      const result = await rpc.call("clearClosedCards", {});
      toast.success(
        result.cleared === 1
          ? "Cleared 1 Closed card"
          : `Cleared ${result.cleared} Closed cards`,
      );
      await loadBoard(true);
    } catch (caught) {
      toast.error(
        caught instanceof Error ? caught.message : "Could not clear Closed cards",
      );
    } finally {
      if (mounted.current) setClearingClosed(false);
    }
  }, [clearingClosed, loadBoard, rpc]);

  const attentionReasons = useMemo<WorkflowAttentionSummary[]>(() => {
    const counts = new Map<string, number>();
    for (const lane of board?.lanes ?? []) {
      for (const card of lane.cards) {
        for (const attention of card.attention) {
          counts.set(attention, (counts.get(attention) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()].map(([gate, count]) => ({
      gate: gate as WorkflowAttentionSummary["gate"],
      count,
    }));
  }, [board]);

  const visibleLanes = useMemo(
    () =>
      (board?.lanes ?? []).map((lane) =>
        needsYouOnly
          ? {
              ...lane,
              cards: lane.cards.filter((card) => card.attention.length > 0),
            }
          : lane,
      ),
    [board, needsYouOnly],
  );

  if (!board && isRefreshing) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Icon
          name="Spinner"
          className="mr-2 size-4 animate-spin"
          aria-hidden="true"
        />
        Loading board…
      </div>
    );
  }

  if (!board && error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <Icon
          name="CircleX"
          className="size-8 text-destructive"
          aria-hidden="true"
        />
        <div>
          <p className="font-medium text-foreground">
            Could not load the board
          </p>
          <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadBoard()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <main className="h-full overflow-y-auto bg-background p-3 md:p-4">
      <div className="mx-auto w-full max-w-[96rem] space-y-4">
        <div className="space-y-2">
          <NeedsYouStrip
            count={board?.needsYouCount ?? 0}
            active={needsYouOnly}
            reasons={attentionReasons}
            onActiveChange={setNeedsYouOnly}
          />
          <StateLegend />
        </div>
        {error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Refresh failed: {error}
          </div>
        ) : null}
        {visibleLanes.map((lane) => (
          <LaneSection
            key={lane.status}
            lane={lane}
            roadmapItems={
              lane.status === "OPEN" && !needsYouOnly
                ? (board?.roadmapItems ?? [])
                : []
            }
            movingThreadId={movingThreadId}
            clearingOverrideId={clearingOverrideId}
            snoozingItemId={snoozingItemId}
            snoozedCount={lane.status === "OPEN" ? (board?.snoozedCount ?? 0) : 0}
            clearingClosed={clearingClosed}
            onMove={moveCard}
            onClearOverride={clearOverride}
            onSnoozeRoadmap={snoozeRoadmap}
            onClearClosed={clearClosed}
          />
        ))}
      </div>
    </main>
  );
}

function PlanApprovalInteraction({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const payload =
    interaction.payload &&
    typeof interaction.payload === "object" &&
    !Array.isArray(interaction.payload)
      ? interaction.payload
      : {};
  const cardThreadId =
    "cardThreadId" in payload && typeof payload.cardThreadId === "string"
      ? payload.cardThreadId
      : "unknown card";
  const objective =
    "objective" in payload && typeof payload.objective === "string"
      ? payload.objective
      : "No objective supplied";
  const recommendation =
    "recommendation" in payload && typeof payload.recommendation === "string"
      ? payload.recommendation
      : "";
  const [note, setNote] = useState("");

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div>
        <p className="text-xs font-semibold text-foreground">
          Approve plan for {cardThreadId}?
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{objective}</p>
        {recommendation ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Recommendation: {recommendation}
          </p>
        ) : null}
      </div>
      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Optional approval note or required changes"
        aria-label="Plan decision note"
        className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void cancel()}>
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void submit({
              approved: false,
              note: note.trim() || "Plan revision requested",
            })
          }
        >
          Request changes
        </Button>
        <Button
          size="sm"
          onClick={() =>
            void submit({
              approved: true,
              note: note.trim(),
            })
          }
        >
          Approve plan
        </Button>
      </div>
    </div>
  );
}

function WorkCaptureApprovalInteraction({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const payload =
    interaction.payload &&
    typeof interaction.payload === "object" &&
    !Array.isArray(interaction.payload)
      ? interaction.payload
      : {};
  const title =
    "title" in payload && typeof payload.title === "string"
      ? payload.title
      : "Untitled work item";
  const description =
    "description" in payload && typeof payload.description === "string"
      ? payload.description
      : "";
  const projectId =
    "projectId" in payload && typeof payload.projectId === "string"
      ? payload.projectId
      : "current project";
  const acceptanceCriteria =
    "acceptanceCriteria" in payload &&
    Array.isArray(payload.acceptanceCriteria)
      ? payload.acceptanceCriteria.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
  const labels =
    "labels" in payload && Array.isArray(payload.labels)
      ? payload.labels.filter((item): item is string => typeof item === "string")
      : [];

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div>
        <p className="text-xs font-semibold text-foreground">
          Capture this work in the issue tracker?
        </p>
        <p className="mt-1 text-xs font-medium text-foreground">{title}</p>
        {description ? (
          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className="space-y-1 text-[11px] text-muted-foreground">
        <p>Project: {projectId}</p>
        {acceptanceCriteria.length ? (
          <div>
            <p className="font-medium text-foreground">Acceptance criteria</p>
            <ul className="list-disc pl-4">
              {acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {labels.length ? <p>Labels: {labels.join(", ")}</p> : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void cancel()}>
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void submit({ approved: false })}
        >
          Not now
        </Button>
        <Button
          size="sm"
          onClick={() => void submit({ approved: true })}
        >
          Capture work
        </Button>
      </div>
    </div>
  );
}

function GateDecisionInteraction({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const payload =
    interaction.payload &&
    typeof interaction.payload === "object" &&
    !Array.isArray(interaction.payload)
      ? interaction.payload
      : {};
  const cardThreadId =
    "cardThreadId" in payload && typeof payload.cardThreadId === "string"
      ? payload.cardThreadId
      : "unknown card";
  const cardTitle =
    "cardTitle" in payload && typeof payload.cardTitle === "string"
      ? payload.cardTitle
      : cardThreadId;
  const objective =
    "objective" in payload && typeof payload.objective === "string"
      ? payload.objective
      : "";
  const reason =
    "reason" in payload && typeof payload.reason === "string"
      ? payload.reason
      : "";
  const evidence =
    "evidence" in payload && Array.isArray(payload.evidence)
      ? payload.evidence.filter(
          (item): item is { label: string; url?: string; path?: string } =>
            !!item &&
            typeof item === "object" &&
            "label" in item &&
            typeof item.label === "string",
        )
      : [];
  const concerns =
    "concerns" in payload && Array.isArray(payload.concerns)
      ? payload.concerns.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
  const [note, setNote] = useState("");

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3">
      <div>
        <p className="text-xs font-semibold text-foreground">
          Approve DONE for {cardTitle}?
        </p>
        {objective ? (
          <p className="mt-1 text-xs text-muted-foreground">{objective}</p>
        ) : null}
        {reason ? (
          <p className="mt-1 text-xs text-muted-foreground">{reason}</p>
        ) : null}
      </div>
      <div className="space-y-1 text-[11px] text-muted-foreground">
        {evidence.length ? (
          <div>
            <p className="font-medium text-foreground">Evidence</p>
            <ul className="list-disc pl-4">
              {evidence.map((item) => (
                <li key={item.label}>
                  {item.url ? (
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {item.label}
                    </a>
                  ) : (
                    item.label
                  )}
                  {item.path ? ` (${item.path})` : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {concerns.length ? (
          <div>
            <p className="font-medium text-foreground">Concerns</p>
            <ul className="list-disc pl-4">
              {concerns.map((concern) => (
                <li key={concern}>{concern}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Optional note, or the gaps to send back"
        aria-label="Gate decision note"
        className="min-h-20 w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void cancel()}>
          Cancel
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            void submit({
              decision: "snooze",
              note: note.trim(),
              snoozeUntilEpochMs: Date.now() + 24 * 60 * 60 * 1_000,
            })
          }
        >
          Snooze 1 day
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void submit({
              decision: "send-back",
              note: note.trim() || "Gaps identified at the egress gate",
            })
          }
        >
          Send back with gaps
        </Button>
        <Button
          size="sm"
          onClick={() =>
            void submit({
              decision: "approve",
              note: note.trim(),
            })
          }
        >
          Approve DONE
        </Button>
      </div>
    </div>
  );
}

function DriverPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);

  const loadDriver = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("getDriver");
      setThreadId(result.threadId);
      setFocusRequest((current) => current + 1);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not open the Driver",
      );
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    if (open && !threadId && !loading && !error) {
      void loadDriver();
    } else if (open && threadId) {
      setFocusRequest((current) => current + 1);
    }
  }, [error, loadDriver, loading, open, threadId]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Open Autobahn Driver"
          className="px-2"
        >
          <Icon name="SteeringWheel" className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Driver</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-[min(94vw,44rem)] max-w-none flex-col gap-0 p-0 sm:max-w-[44rem]"
      >
        <SheetHeader className="shrink-0 border-b border-border px-4 py-3 pr-12">
          <SheetTitle className="text-sm">Autobahn Driver</SheetTitle>
          <SheetDescription className="text-xs">
            Plan, dispatch, verify, gate, park, and witness coding sessions.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Icon
                name="Spinner"
                className="mr-2 size-4 animate-spin"
                aria-hidden="true"
              />
              Opening…
            </div>
          ) : error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-destructive">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadDriver()}
              >
                Try again
              </Button>
            </div>
          ) : threadId ? (
            <ThreadChat
              threadId={threadId}
              variant="compact"
              layout="contained"
              focusRequest={focusRequest}
              permissionPolicy="inherit"
              className="h-full"
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const SIDEBAR_LANE_ORDER: BoardStatus[] = ["WIP", "R4R", "OPEN", "CLOSED"];

function threadTitle(thread: PluginSidebarThread) {
  return thread.title ?? thread.titleFallback ?? thread.id;
}

function threadAgentCount(thread: PluginSidebarThread | undefined) {
  if (!thread) return 0;
  const { workflows, backgroundAgents, backgroundCommands, planMode, goals } =
    thread.activity;
  return workflows + backgroundAgents + backgroundCommands + planMode + goals;
}

function SidebarThreadRow({
  threadId,
  title,
  active,
  attention,
  agentCount,
  indicatorLabel,
  onOpen,
}: {
  threadId: string;
  title: string;
  active: boolean;
  attention: readonly string[];
  agentCount: number;
  indicatorLabel: string | null;
  onOpen: (threadId: string) => void;
}) {
  return (
    <button
      type="button"
      data-sidebar-thread-shortcut-target=""
      data-sidebar-thread-id={threadId}
      aria-current={active ? "true" : undefined}
      onClick={() => onOpen(threadId)}
      className={cn(
        "flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "bg-accent",
      )}
    >
      <span
        className="min-w-0 flex-1 truncate text-xs text-foreground"
        title={title}
      >
        {title}
      </span>
      {agentCount > 0 ? (
        <span
          className="shrink-0 rounded bg-primary/10 px-1 text-[9px] font-semibold tabular-nums text-primary"
          title={`${agentCount} running agents`}
          aria-label={`${agentCount} running agents`}
        >
          {agentCount}
        </span>
      ) : null}
      {attention.map((gate) => (
        <WorkflowGateBadge
          key={gate}
          gate={gate as WorkflowAttentionSummary["gate"]}
          className="shrink-0"
        />
      ))}
      {indicatorLabel ? (
        <span
          role="img"
          aria-label={indicatorLabel}
          title={indicatorLabel}
          className="size-1.5 shrink-0 rounded-full bg-primary"
        />
      ) : null}
    </button>
  );
}

function BoardSidebarThreadList({
  activeThreadId,
  onNavigate,
  searchQuery,
}: PluginThreadListProps) {
  const settings = useSettings();
  const rpc = useRpc<typeof rpcContract>();
  const sidebar = experimental_useSidebarThreads();
  const actions = experimental_useSidebarThreadActions();
  const [board, setBoard] = useState<BoardResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const enabled = settings.values?.boardSidebar === true;

  const loadBoard = useCallback(async () => {
    try {
      const next = await rpc.call("listBoard", {});
      if (!mounted.current) return;
      setBoard(next);
      setError(null);
    } catch (caught) {
      if (!mounted.current) return;
      setError(
        caught instanceof Error ? caught.message : "Could not load board",
      );
    }
  }, [rpc]);

  useEffect(() => {
    mounted.current = true;
    if (enabled) void loadBoard();
    return () => {
      mounted.current = false;
    };
  }, [enabled, loadBoard]);

  useRealtime("board-changed", () => {
    if (enabled) void loadBoard();
  });

  const openThread = useCallback(
    (threadId: string) => {
      actions.open(threadId);
      onNavigate();
    },
    [actions, onNavigate],
  );

  const threadsById = useMemo(() => {
    const result = new Map<string, PluginSidebarThread>();
    for (const thread of sidebar.threads) result.set(thread.id, thread);
    return result;
  }, [sidebar.threads]);

  const query = searchQuery.trim().toLowerCase();
  const matches = useCallback(
    (title: string) => !query || title.toLowerCase().includes(query),
    [query],
  );

  const lanes = useMemo(() => {
    const byStatus = new Map(
      (board?.lanes ?? []).map((lane) => [lane.status, lane] as const),
    );
    return SIDEBAR_LANE_ORDER.flatMap((status) => {
      const lane = byStatus.get(status);
      return lane ? [lane] : [];
    });
  }, [board]);

  const boardThreadIds = useMemo(
    () => new Set(lanes.flatMap((lane) => lane.cards.map((card) => card.id))),
    [lanes],
  );

  const needsYouCards = useMemo(
    () =>
      lanes
        .flatMap((lane) => lane.cards)
        .filter((card) => card.attention.length > 0 && matches(card.title)),
    [lanes, matches],
  );

  const otherThreads = useMemo(
    () =>
      sidebar.threads
        .filter(
          (thread) =>
            !thread.isArchived &&
            !boardThreadIds.has(thread.id) &&
            matches(threadTitle(thread)),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [boardThreadIds, matches, sidebar.threads],
  );

  // Rendered while the host is still resolving settings; the host keeps its
  // own chrome, so a momentarily empty scroll area is fine.
  if (settings.isLoading) return null;
  if (!enabled) {
    // The slot registration is static (setup runs without settings), so the
    // plugin-level gate lives here: throwing makes bb fall back to its
    // built-in thread list instead of leaving the sidebar empty.
    throw new Error(
      'The Autobahn board sidebar is turned off. Enable the "Board sidebar" setting in the Autobahn plugin, or pick another sidebar under Settings → Appearance.',
    );
  }

  return (
    <nav aria-label="Autobahn board sidebar" className="space-y-3 p-2">
      {error ? (
        <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
          Board refresh failed: {error}
        </p>
      ) : null}
      {needsYouCards.length > 0 ? (
        <section aria-label="Needs you">
          <h2 className="px-2 pb-1 text-[10px] font-bold tracking-[0.16em] text-[var(--attention)]">
            NEEDS YOU · {needsYouCards.length}
          </h2>
          {needsYouCards.map((card) => (
            <SidebarThreadRow
              key={`needs-you-${card.id}`}
              threadId={card.id}
              title={card.title}
              active={card.id === activeThreadId}
              attention={card.attention}
              agentCount={threadAgentCount(threadsById.get(card.id))}
              indicatorLabel={null}
              onOpen={openThread}
            />
          ))}
        </section>
      ) : null}
      {lanes.map((lane) => {
        const cards = lane.cards.filter((card) => matches(card.title));
        if (query && cards.length === 0) return null;
        const agentCount = lane.cards.reduce(
          (total, card) => total + threadAgentCount(threadsById.get(card.id)),
          0,
        );
        return (
          <section key={lane.status} aria-label={STATUS_LABELS[lane.status]}>
            <h2 className="flex items-center gap-1.5 px-2 pb-1 text-[10px] font-bold tracking-[0.16em] text-muted-foreground">
              {lane.status}
              <span className="font-normal tabular-nums">
                {lane.capacityCount}
                {lane.softLimit ? `/${lane.softLimit}` : ""}
              </span>
              {agentCount > 0 ? (
                <span className="ml-auto font-normal">
                  {agentCount} agents
                </span>
              ) : null}
            </h2>
            {cards.map((card) => (
              <SidebarThreadRow
                key={card.id}
                threadId={card.id}
                title={card.title}
                active={card.id === activeThreadId}
                attention={card.attention}
                agentCount={threadAgentCount(threadsById.get(card.id))}
                indicatorLabel={threadsById.get(card.id)?.indicatorLabel ?? null}
                onOpen={openThread}
              />
            ))}
            {cards.length === 0 ? (
              <p className="px-2 text-[10px] text-muted-foreground">Empty</p>
            ) : null}
          </section>
        );
      })}
      {otherThreads.length > 0 ? (
        <section aria-label="Other threads">
          <h2 className="px-2 pb-1 text-[10px] font-bold tracking-[0.16em] text-muted-foreground">
            OTHER THREADS
          </h2>
          {otherThreads.map((thread) => (
            <SidebarThreadRow
              key={thread.id}
              threadId={thread.id}
              title={threadTitle(thread)}
              active={thread.id === activeThreadId}
              attention={[]}
              agentCount={threadAgentCount(thread)}
              indicatorLabel={thread.indicatorLabel}
              onOpen={openThread}
            />
          ))}
        </section>
      ) : null}
    </nav>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: "plan-approval",
    component: PlanApprovalInteraction,
  });
  app.slots.pendingInteraction({
    id: "work-capture-approval",
    component: WorkCaptureApprovalInteraction,
  });
  app.slots.pendingInteraction({
    id: "gate-decision",
    component: GateDecisionInteraction,
  });
  app.slots.experimental_threadList({
    id: "autobahn-board-sidebar",
    title: "Autobahn board",
    description:
      'Board lanes with attention chips instead of the flat thread list. Requires the Autobahn "Board sidebar" setting.',
    component: BoardSidebarThreadList,
  });
  app.slots.navPanel({
    id: "autobahn-board",
    title: "Autobahn",
    icon: "Car",
    path: "board",
    component: AutobahnBoard,
    headerContent: DriverPanel,
  });
});
