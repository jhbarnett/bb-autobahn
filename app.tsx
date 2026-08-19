import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ThreadChat,
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type PluginPendingInteractionProps,
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

const BOARD_STATUSES = ["TODO", "WIP", "R4R", "DONE"] as const;
type Lane = BoardResult["lanes"][number];
type Card = Lane["cards"][number];
type BoardStatus = (typeof BOARD_STATUSES)[number];

const STATUS_LABELS: Record<BoardStatus, string> = {
  TODO: "Todo",
  WIP: "Work in progress",
  R4R: "Ready for review",
  DONE: "Done",
};

const STATUS_DOT: Record<BoardStatus, string> = {
  TODO: "bg-muted-foreground/60",
  WIP: "bg-primary",
  R4R: "bg-foreground",
  DONE: "bg-primary/70",
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

function AutobahnCard({
  card,
  moving,
}: {
  card: Card;
  moving: boolean;
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
        "group flex w-60 shrink-0 cursor-grab flex-col rounded-lg border border-border bg-card shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing",
        moving && "pointer-events-none opacity-60",
      )}
    >
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
          <span
            className={cn(
              "mt-1 size-1.5 shrink-0 rounded-full",
              card.runtimeStatus === "error"
                ? "bg-destructive"
                : card.runtimeStatus === "active"
                  ? "bg-primary"
                  : "bg-muted-foreground/50",
            )}
            title={card.runtimeStatus}
            aria-label={`Thread status: ${card.runtimeStatus}`}
          />
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

function LaneSection({
  lane,
  movingThreadId,
  onMove,
}: {
  lane: Lane;
  movingThreadId: string | null;
  onMove: (threadId: string, status: BoardStatus) => void;
}) {
  const [dragOver, setDragOver] = useState(false);

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
        <span className={cn("size-2 rounded-full", STATUS_DOT[lane.status])} />
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
      </div>

      <div className="flex min-h-24 gap-2 overflow-x-auto px-1 py-2">
        {lane.cards.length === 0 ? (
          <div className="flex min-h-20 w-full items-center justify-center rounded-lg border border-dashed border-border text-[11px] text-muted-foreground">
            Drop a thread here
          </div>
        ) : (
          lane.cards.map((card) => (
            <AutobahnCard
              key={card.id}
              card={card}
              moving={movingThreadId === card.id}
            />
          ))
        )}
      </div>
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
        <NeedsYouStrip
          count={board?.needsYouCount ?? 0}
          active={needsYouOnly}
          reasons={attentionReasons}
          onActiveChange={setNeedsYouOnly}
        />
        {error ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Refresh failed: {error}
          </div>
        ) : null}
        {visibleLanes.map((lane) => (
          <LaneSection
            key={lane.status}
            lane={lane}
            movingThreadId={movingThreadId}
            onMove={moveCard}
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

function ChiefOfStaffPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);

  const loadChief = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await rpc.call("getChiefOfStaff");
      setThreadId(result.threadId);
      setFocusRequest((current) => current + 1);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not open the Chief of Staff",
      );
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    if (open && !threadId && !loading && !error) {
      void loadChief();
    } else if (open && threadId) {
      setFocusRequest((current) => current + 1);
    }
  }, [error, loadChief, loading, open, threadId]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Open Autobahn Chief of Staff"
          className="px-2"
        >
          <Icon name="UserRound" className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Chief of Staff</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="flex w-[min(94vw,44rem)] max-w-none flex-col gap-0 p-0 sm:max-w-[44rem]"
      >
        <SheetHeader className="shrink-0 border-b border-border px-4 py-3 pr-12">
          <SheetTitle className="text-sm">Autobahn Chief of Staff</SheetTitle>
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
                onClick={() => void loadChief()}
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

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: "plan-approval",
    component: PlanApprovalInteraction,
  });
  app.slots.navPanel({
    id: "autobahn-board",
    title: "Autobahn",
    icon: "Car",
    path: "board",
    component: AutobahnBoard,
    headerContent: ChiefOfStaffPanel,
  });
});
