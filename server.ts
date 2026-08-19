import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  EXIT_STATUSES,
  RISK_CLASSES,
  STATUS_OVERRIDES,
  WORKFLOW_GATES,
  WORKFLOW_PHASES,
  WORKFLOW_STATE_MIGRATIONS,
  createRoadmapSnoozeStore,
  createWorkflowStateStore,
  type CardWorkflowState,
  type JsonObject,
  type PlanContract,
  type WorkflowEvidence,
} from "./workflow-state";
import {
  runPlanWorkflow,
  runVerificationWorkflow,
  type ChildSessionAdapter,
  type VerificationLens,
} from "./orchestration";

export const BOARD_STATUSES = ["OPEN", "WIP", "R4R", "CLOSED"] as const;

export const ROADMAP_RANKINGS = ["balanced", "priority", "recency"] as const;
export type RoadmapRanking = (typeof ROADMAP_RANKINGS)[number];

export function rankRoadmapItems<
  Item extends {
    repo: string;
    priority: number;
    updatedAt: string;
    captured?: boolean;
  },
>(items: Item[], limit: number, ranking: RoadmapRanking): Item[] {
  const candidates = [...items];
  const newestFirst = (left: Item, right: Item) =>
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  const captured = candidates.filter((item) => item.captured);
  const ordinary = candidates.filter((item) => !item.captured);

  if (ranking === "recency") {
    return [
      ...captured.sort(newestFirst),
      ...ordinary.sort(newestFirst),
    ].slice(0, limit);
  }
  if (ranking === "priority") {
    const byPriority = (left: Item, right: Item) =>
      left.priority - right.priority || newestFirst(left, right);
    return [
      ...captured.sort(byPriority),
      ...ordinary.sort(byPriority),
    ].slice(0, limit);
  }

  const capturedFront = captured.sort(newestFirst);
  const remainingLimit = Math.max(0, limit - capturedFront.length);
  if (remainingLimit === 0) return capturedFront.slice(0, limit);

  const tier = (item: Item) =>
    item.priority === 4 ? 2 : item.priority;
  ordinary.sort(
    (left, right) => tier(left) - tier(right) || newestFirst(left, right),
  );
  const queueByRepo = new Map<string, Item[]>();
  for (const item of ordinary) {
    const queue = queueByRepo.get(item.repo);
    if (queue) queue.push(item);
    else queueByRepo.set(item.repo, [item]);
  }
  const queues = [...queueByRepo.values()];
  const picked: Item[] = [];
  while (
    picked.length < remainingLimit &&
    queues.some((queue) => queue.length > 0)
  ) {
    for (const queue of queues) {
      const item = queue.shift();
      if (item) picked.push(item);
      if (picked.length >= remainingLimit) break;
    }
  }
  return [...capturedFront, ...picked].slice(0, limit);
}

const DRIVER_TITLE = "Autobahn Driver";
const DRIVER_THREAD_KEY = "autobahn-driver-thread-id";
const WITNESS_FINGERPRINT_KEY = "witness-last-fingerprint";
const WITNESS_PROBE_TITLE = "Autobahn witness probe";
const LEGACY_ROADMAP_SNOOZES_KEY = "roadmap-snoozes";
const CLOSED_DISMISSALS_KEY = "closed-card-dismissals";
const MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1_000;
const GATE_DECISION_RENDERER = "gate-decision";
const GATE_DECISION_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_GATE_SNOOZE_MS = 24 * 60 * 60 * 1_000;
const HAND_RAISE_LABELS = new Set([
  "blocked",
  "needs-input",
  "needs input",
  "question",
  "blocking-question",
  "blocking question",
  "failed",
  "failing",
  "checks-failed",
  "attention",
]);
const DRIVER_OPERATING_RULE =
  "The Driver drives agents, not PRs. Route every incoming request through the Driver to sub-agents: if no card exists for the request or work item, capture the work, create its card, and dispatch it; if a card exists, message the request into that card's agent thread instead of doing the work directly. The Driver never writes feature code or opens pull requests. Its hands-on work is limited to board operations, contracts, gates, witness findings, and review or merge decisions.";
const DRIVER_PROMPT =
  `You are the Driver of this Autobahn board, an opinionated, automated Kanban flywheel. Briefly introduce yourself and offer to keep the flywheel turning: inventory and prioritize the roadmap, dispatch ready work as capacity frees, run fresh-context planning and verification, park or wake work, and surface witness findings. ${DRIVER_OPERATING_RULE} Gates, WIP limits, and plan contracts are guardrail features you apply along the way. Inspect the board before making claims. Never bypass a human gate, stop, or archive a session unless the user asks.`;

const boardStatusSchema = z.enum(BOARD_STATUSES);
const reasoningLevelSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
]);
const runtimeStatusSchema = z.enum([
  "error",
  "stopping",
  "idle",
  "starting",
  "active",
]);
const workflowPhaseSchema = z.enum(WORKFLOW_PHASES);
const workflowGateSchema = z.enum(WORKFLOW_GATES);
const riskClassSchema = z.enum(RISK_CLASSES);
const exitStatusSchema = z.enum(EXIT_STATUSES);
const attentionSchema = z.enum([
  "needs-input",
  "plan-approval",
  "blocked",
  "checks-failed",
  "changes-requested",
  "review-requested",
  "runtime-error",
  "stale",
  "context-high",
  "wip-overflow",
  "done-with-open-pr",
]);
const workflowEvidenceSchema = z.object({
  label: z.string(),
  url: z.string().optional(),
  path: z.string().optional(),
});
const planContractSchema = z.object({
  objective: z.string(),
  scope: z.array(z.string()),
  outOfScope: z.array(z.string()),
  expectedFiles: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  verificationCommands: z.array(z.string()),
});
const gateDecisionSchema = z
  .object({
    decision: z.enum(["approve", "send-back", "snooze"]),
    note: z.string().max(10_000),
    snoozeUntilEpochMs: z.number().int().positive().optional(),
  })
  .strict();
const statusOverrideSchema = z.enum(STATUS_OVERRIDES);
const workflowStateSchema = z.object({
  phase: workflowPhaseSchema,
  gate: workflowGateSchema,
  riskClass: riskClassSchema,
  priority: z.number().int().min(0),
  attempt: z.number().int().min(0),
  exitStatus: exitStatusSchema.nullable(),
  nextAction: z.string().nullable(),
  concerns: z.array(z.string()),
  evidence: z.array(workflowEvidenceSchema),
  planContract: planContractSchema.nullable(),
  blockedBy: z.array(z.string()),
  parkedWake: z
    .object({
      kind: z.string(),
      ref: z.string().nullable(),
      until: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  phaseStartedAt: z.number(),
  statusOverride: statusOverrideSchema.nullable(),
  statusOverrideReason: z.string().nullable(),
  statusOverrideAt: z.number().int().nonnegative().nullable(),
});

const githubItemSchema = z
  .object({
    repo: z.string(),
    number: z.number().int().positive(),
    kind: z.enum(["issue", "pr"]),
    title: z.string(),
    state: z.string(),
    author: z.string(),
    labels: z.array(z.string()),
    assignees: z.array(z.string()),
    url: z.string(),
    body: z.string(),
    updatedAt: z.string(),
  })
  .strict();
const githubItemsOutputSchema = z
  .object({ items: z.array(githubItemSchema) })
  .strict();
const githubLinkSchema = z
  .object({
    kind: z.enum(["issue", "pr"]),
    repo: z.string(),
    number: z.number().int().positive(),
    threadId: z.string(),
    createdAt: z.string(),
  })
  .strict();
const githubLinksOutputSchema = z
  .object({ links: z.record(z.string(), z.array(githubLinkSchema)) })
  .strict();
const githubStatusOutputSchema = z
  .object({
    ghOk: z.boolean(),
    ghState: z
      .enum(["ready", "needs_configuration", "unavailable"])
      .optional(),
    ghError: z.string().nullable(),
    repos: z.array(
      z
        .object({
          repo: z.string(),
          projectId: z.string().nullable(),
        })
        .strict(),
    ),
    lastSyncedAt: z.string().nullable(),
  })
  .strict();
const githubStartWorkOutputSchema = z
  .object({ threadId: z.string().min(1) })
  .strict();
const githubCreateIssueOutputSchema = z
  .object({ number: z.number().int().positive().nullable(), url: z.string() })
  .strict();
const githubSetLabelsOutputSchema = z
  .object({ ok: z.literal(true), labels: z.array(z.string().min(1)) })
  .strict();
const githubRefreshOutputSchema = z
  .object({
    repos: z.number().int().nonnegative(),
    items: z.number().int().nonnegative(),
  })
  .strict();

const roadmapItemKeySchema = z
  .string()
  .regex(/^issue:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/);

const roadmapItemSchema = z.object({
  id: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  labels: z.array(z.string()),
  priority: z.number().int().min(0),
  updatedAt: z.string(),
  projectId: z.string().nullable(),
  linkedThreadId: z.string().nullable(),
  captured: z.boolean(),
});

const externalLinkSchema = z.object({
  kind: z.enum(["pull-request", "issue", "external"]),
  label: z.string(),
  url: z.string().url(),
  state: z.string().nullable(),
});

const cardSchema = z.object({
  id: z.string(),
  title: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  status: boardStatusSchema,
  runtimeStatus: runtimeStatusSchema,
  harness: z.string(),
  model: z.string().nullable(),
  effort: reasoningLevelSchema.nullable(),
  context: z
    .object({
      usedTokens: z.number().int().nonnegative(),
      modelContextWindow: z.number().int().positive(),
      estimated: z.boolean(),
    })
    .nullable(),
  summary: z.string().nullable(),
  branchName: z.string().nullable(),
  links: z.array(externalLinkSchema),
  workflow: workflowStateSchema,
  attention: z.array(attentionSchema),
  updatedAt: z.number(),
});

const laneSchema = z.object({
  status: boardStatusSchema,
  sectionId: z.string(),
  softLimit: z.number().int().positive().nullable(),
  overLimit: z.boolean(),
  capacityCount: z.number().int().nonnegative(),
  cards: z.array(cardSchema),
});

export type BoardResult = {
  lanes: Array<z.infer<typeof laneSchema>>;
  roadmapItems: Array<z.infer<typeof roadmapItemSchema>>;
  needsYouCount: number;
  snoozedCount: number;
};

export const rpcContract = defineRpcContract({
  listBoard: {
    input: z.object({ projectId: z.string().nullable().optional() }).strict(),
    output: z.object({
      lanes: z.array(laneSchema),
      roadmapItems: z.array(roadmapItemSchema),
      needsYouCount: z.number().int().nonnegative(),
      snoozedCount: z.number().int().nonnegative(),
    }),
  },
  moveThread: {
    input: z
      .object({ threadId: z.string().min(1), status: boardStatusSchema })
      .strict(),
    output: z.object({
      threadId: z.string(),
      status: boardStatusSchema,
      warning: z.string().nullable(),
    }),
  },
  getDriver: {
    input: z.null(),
    output: z.object({ threadId: z.string() }),
  },
  clearStatusOverride: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  snoozeRoadmapItem: {
    input: z
      .object({
        itemKey: roadmapItemKeySchema,
        wakeAt: z.number().int().positive(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  wakeRoadmapItem: {
    input: z.object({ itemKey: roadmapItemKeySchema }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  clearClosedCards: {
    input: z
      .object({ projectId: z.string().min(1).nullable().optional() })
      .strict(),
    output: z.object({ cleared: z.number().int().nonnegative() }),
  },
});

type BoardStatus = (typeof BOARD_STATUSES)[number];
type SectionIds = Record<BoardStatus, string>;
type ExternalLink = z.infer<typeof externalLinkSchema>;
type GithubItem = z.infer<typeof githubItemSchema>;
type GithubLink = z.infer<typeof githubLinkSchema>;

interface MoveOptions {
  source?: "workflow" | "user" | "driver" | "automation";
  reason?: string;
  setOverride?: boolean;
  bypassWorkflowGuards?: boolean;
  preserveWorkflowPosition?: boolean;
}

interface CaptureWorkInput {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  labels: string[];
}

interface CapturedWorkItem {
  tracker: "github";
  externalId: string;
  url: string;
  created: boolean;
  warning: string | null;
}

function normalizeSummary(text: string | null): string | null {
  if (!text) return null;
  const normalized = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)")
    .replace(/[#>*_~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return normalized.length > 320
    ? `${normalized.slice(0, 317).trimEnd()}…`
    : normalized;
}

function collectRows(rows: unknown[]): unknown[] {
  const flattened: unknown[] = [];
  for (const row of rows) {
    flattened.push(row);
    if (
      row &&
      typeof row === "object" &&
      "children" in row &&
      Array.isArray(row.children)
    ) {
      flattened.push(...collectRows(row.children));
    }
  }
  return flattened;
}

function latestAssistantText(rows: unknown[]): string | null {
  const assistantRows = collectRows(rows).filter(
    (row): row is { kind: "conversation"; role: "assistant"; text: string } =>
      !!row &&
      typeof row === "object" &&
      "kind" in row &&
      row.kind === "conversation" &&
      "role" in row &&
      row.role === "assistant" &&
      "text" in row &&
      typeof row.text === "string",
  );
  return assistantRows.at(-1)?.text ?? null;
}

function cleanUrl(url: string): string {
  return url.replace(/[),.;!?]+$/, "");
}

function extractExternalLinks(text: string | null): ExternalLink[] {
  if (!text) return [];
  const links: ExternalLink[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>\]]+/g)) {
    const url = cleanUrl(match[0]);
    if (seen.has(url)) continue;

    const github = url.match(
      /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)/i,
    );
    const linear = url.match(
      /^https?:\/\/linear\.app\/[^/]+\/issue\/([^/?#]+)/i,
    );
    if (github) {
      const isPullRequest = github[1].toLowerCase() === "pull";
      links.push({
        kind: isPullRequest ? "pull-request" : "issue",
        label: `${isPullRequest ? "PR" : "Issue"} #${github[2]}`,
        url,
        state: null,
      });
    } else if (linear) {
      links.push({
        kind: "issue",
        label: linear[1].toUpperCase(),
        url,
        state: null,
      });
    }
    seen.add(url);
    if (links.length === 4) break;
  }
  return links;
}

function addLink(links: ExternalLink[], link: ExternalLink): ExternalLink[] {
  return [link, ...links.filter((candidate) => candidate.url !== link.url)].slice(
    0,
    4,
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

export default function plugin(bb: BbPluginApi) {
  const database = bb.storage.database();
  bb.storage.migrate(database, [...WORKFLOW_STATE_MIGRATIONS]);
  const workflowStore = createWorkflowStateStore(database);
  const roadmapSnoozeStore = createRoadmapSnoozeStore(database);
  const legacySnoozeImport = (async () => {
    const stored = await bb.storage.kv.get<Record<string, unknown>>(
      LEGACY_ROADMAP_SNOOZES_KEY,
    );
    if (!stored) return;
    const importedAt = Date.now();
    for (const [itemKey, wakeAt] of Object.entries(stored)) {
      if (
        roadmapItemKeySchema.safeParse(itemKey).success &&
        typeof wakeAt === "number" &&
        Number.isSafeInteger(wakeAt) &&
        wakeAt > importedAt &&
        !roadmapSnoozeStore.get(itemKey)
      ) {
        roadmapSnoozeStore.snooze({
          itemKey,
          snoozedUntil: wakeAt,
          snoozedAt: importedAt,
        });
      }
    }
    await bb.storage.kv.delete(LEGACY_ROADMAP_SNOOZES_KEY);
  })().catch(() => undefined);
  const isolatedChildThreadIds = new Set(
    workflowStore
      .listEvents()
      .filter((event) => event.type === "child.spawned")
      .map((event) => event.payload.childThreadId)
      .filter((threadId): threadId is string => typeof threadId === "string"),
  );
  async function readClosedDismissals() {
    const stored =
      (await bb.storage.kv.get<unknown>(CLOSED_DISMISSALS_KEY)) ?? [];
    return new Set(
      Array.isArray(stored)
        ? stored.filter((threadId): threadId is string => typeof threadId === "string")
        : [],
    );
  }

  function roadmapItemRaisesHand(item: GithubItem) {
    if (issuePriority(item.labels) === 0) return true;
    return item.labels.some((label) =>
      HAND_RAISE_LABELS.has(label.trim().toLowerCase()),
    );
  }

  async function activeRoadmapSnoozes(snapshot: GithubSnapshot) {
    await legacySnoozeImport;
    const now = Date.now();
    const itemByKey = new Map(
      snapshot.items.map((item) => [githubItemKey(item), item]),
    );
    const active: Record<string, number> = {};
    for (const snooze of roadmapSnoozeStore.list()) {
      if (snooze.snoozedUntil <= now) {
        roadmapSnoozeStore.wake(snooze.itemKey);
        continue;
      }
      const item = itemByKey.get(snooze.itemKey);
      if (
        item &&
        !(snapshot.links[snooze.itemKey]?.length) &&
        roadmapItemRaisesHand(item)
      ) {
        roadmapSnoozeStore.wake(snooze.itemKey);
        bb.realtime.publish("board-changed", {
          itemKey: snooze.itemKey,
          event: "roadmap.woken-early",
        });
        continue;
      }
      active[snooze.itemKey] = snooze.snoozedUntil;
    }
    return active;
  }

  const settings = bb.settings.define({
    wipLimit: {
      type: "string",
      label: "Work in progress limit",
      default: "3",
    },
    reviewLimit: {
      type: "string",
      label: "Ready for review limit",
      default: "6",
    },
    staleHours: {
      type: "string",
      label: "Stale work threshold (hours)",
      default: "24",
    },
    contextWarningPercent: {
      type: "string",
      label: "Context warning percent",
      default: "85",
    },
    roadmapLimit: {
      type: "string",
      label: "Open roadmap item limit",
      default: "5",
    },
    roadmapRanking: {
      type: "string",
      label: "Roadmap ranking (balanced | priority | recency)",
      default: "balanced",
    },
    snoozeHours: {
      type: "string",
      label: "Default snooze (hours)",
      description:
        "How long the one-click snooze on an Open roadmap card hides the item.",
      default: "24",
    },
    boardSidebar: {
      type: "boolean",
      label: "Board sidebar",
      description:
        "Offer the Autobahn board as a sidebar thread list replacement (picked under Settings → Appearance → Sidebar). Off by default.",
      default: false,
    },
  });

  const childAdapter: ChildSessionAdapter = {
    async spawnChild(input, { signal }) {
      if (signal.aborted) throw signal.reason;
      let environment:
        | { type: "reuse"; environmentId: string }
        | {
            type: "host";
            hostId: string;
            workspace: {
              type: "managed-worktree";
              baseBranch: { kind: "named"; name: string };
            };
          }
        | { type: "project-default" } = { type: "project-default" };
      if (input.environmentId) {
        const controllerEnvironment = await bb.sdk.environments.get({
          environmentId: input.environmentId,
        });
        if (!controllerEnvironment.isGitRepo || !controllerEnvironment.branchName) {
          throw new Error(
            "Fresh-context workflows require a branch-backed git environment for isolated child worktrees.",
          );
        }
        environment = {
          type: "host",
          hostId: controllerEnvironment.hostId,
          workspace: {
            type: "managed-worktree",
            baseBranch: {
              kind: "named",
              name: controllerEnvironment.branchName,
            },
          },
        };
      } else {
        throw new Error(
          "Fresh-context workflows require a controller environment.",
        );
      }
      const child = await bb.sdk.threads.spawn({
        projectId: input.projectId,
        parentThreadId: input.parentThreadId,
        environment,
        prompt: input.prompt,
        title: input.title,
        visibility: "hidden",
        permissionMode: "accept-edits",
      });
      isolatedChildThreadIds.add(child.id);
      workflowStore.appendEvent({
        threadId: input.controllerThreadId,
        type: "child.spawned",
        payload: {
          childThreadId: child.id,
          role: input.role,
          title: input.title,
        },
      });
      return { threadId: child.id };
    },
    async waitForChild({ threadId, signal }) {
      await bb.sdk.threads.wait({
        threadId,
        status: "idle",
        signal,
      });
      const { output } = await bb.sdk.threads.output({ threadId, signal });
      if (!output?.trim()) {
        throw new Error(`Child thread ${threadId} returned no output.`);
      }
      return output;
    },
    async stopChild({ threadId }) {
      await bb.sdk.threads.archive({ threadId }).catch(() => undefined);
      await bb.sdk.threads.stop({ threadId });
    },
  };

  let sectionCreation: Promise<SectionIds> | null = null;
  let driverCreation: Promise<string> | null = null;
  let driverThreadIdCache: string | null = null;
  void bb.storage.kv
    .get<string>(DRIVER_THREAD_KEY)
    .then((threadId) => {
      driverThreadIdCache = threadId ?? null;
    })
    .catch(() => undefined);
  let dispatching = false;
  const inFlightGateDecisions = new Set<string>();

  async function ensureDriver(): Promise<string> {
    if (driverCreation) return driverCreation;
    driverCreation = (async () => {
      const storedThreadId =
        await bb.storage.kv.get<string>(DRIVER_THREAD_KEY);
      if (storedThreadId) {
        try {
          const storedThread = await bb.sdk.threads.get({
            threadId: storedThreadId,
          });
          if (!storedThread.archivedAt && !storedThread.deletedAt) {
            driverThreadIdCache = storedThread.id;
            return storedThread.id;
          }
        } catch {
          await bb.storage.kv.delete(DRIVER_THREAD_KEY);
        }
      }

      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const project =
        projects.find((candidate) => candidate.kind === "personal") ??
        projects[0];
      if (!project) {
        throw new Error("Create a bb project before opening the Driver.");
      }

      const thread = await bb.sdk.threads.spawn({
        projectId: project.id,
        environment: { type: "project-default" },
        prompt: DRIVER_PROMPT,
        title: DRIVER_TITLE,
        visibility: "hidden",
      });
      await bb.storage.kv.set(DRIVER_THREAD_KEY, thread.id);
      driverThreadIdCache = thread.id;
      return thread.id;
    })();

    try {
      return await driverCreation;
    } finally {
      driverCreation = null;
    }
  }

  async function ensureSections(): Promise<SectionIds> {
    if (sectionCreation) return sectionCreation;
    sectionCreation = (async () => {
      const existing = await bb.sdk.threadSections.list();
      const byName = new Map(
        existing.map((section) => [section.name.trim().toUpperCase(), section]),
      );
      const sectionIds = {} as SectionIds;

      for (const status of BOARD_STATUSES) {
        const found = byName.get(status);
        const section =
          found ?? (await bb.sdk.threadSections.create({ name: status }));
        sectionIds[status] = section.id;
      }
      return sectionIds;
    })();

    try {
      return await sectionCreation;
    } finally {
      sectionCreation = null;
    }
  }

  function positiveInteger(value: string, fallback: number) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  function roadmapRanking(value: string): RoadmapRanking {
    const normalized = value.trim().toLowerCase();
    return (ROADMAP_RANKINGS as readonly string[]).includes(normalized)
      ? (normalized as RoadmapRanking)
      : "balanced";
  }

  interface GithubSnapshot {
    items: GithubItem[];
    links: Record<string, GithubLink[]>;
    projectByRepo: Map<string, string | null>;
  }

  let githubSnapshotCache:
    | { value: GithubSnapshot; fetchedAt: number }
    | null = null;
  let githubSnapshotInFlight: Promise<GithubSnapshot> | null = null;

  async function githubRpc<T>(
    method: string,
    input: JsonObject | null,
    outputSchema: z.ZodType<T>,
  ): Promise<T> {
    return await bb.sdk.plugins.callRpc<T>({
      pluginId: "github",
      method,
      ...(input === null ? {} : { input }),
      outputSchema,
    });
  }

  async function loadGithubSnapshot(force = false): Promise<GithubSnapshot> {
    if (
      !force &&
      githubSnapshotCache &&
      Date.now() - githubSnapshotCache.fetchedAt < 30_000
    ) {
      return githubSnapshotCache.value;
    }
    if (githubSnapshotInFlight) return githubSnapshotInFlight;
    githubSnapshotInFlight = (async () => {
      try {
        const [itemResult, linkResult, statusResult] = await Promise.all([
          githubRpc("listItems", {}, githubItemsOutputSchema),
          githubRpc("listLinks", null, githubLinksOutputSchema),
          githubRpc("status", null, githubStatusOutputSchema),
        ]);
        const value: GithubSnapshot = {
          items: itemResult.items,
          links: linkResult.links,
          projectByRepo: new Map(
            statusResult.repos.map((entry) => [entry.repo, entry.projectId]),
          ),
        };
        githubSnapshotCache = { value, fetchedAt: Date.now() };
        return value;
      } catch (error) {
        bb.log.debug(
          `GitHub roadmap snapshot unavailable: ${String(error)}`,
        );
        const value: GithubSnapshot = {
          items: [],
          links: {},
          projectByRepo: new Map(),
        };
        githubSnapshotCache = { value, fetchedAt: Date.now() };
        return value;
      } finally {
        githubSnapshotInFlight = null;
      }
    })();
    return await githubSnapshotInFlight;
  }

  function issuePriority(labels: string[]) {
    const normalized = labels.map((label) => label.trim().toLowerCase());
    if (
      normalized.some((label) =>
        ["p0", "priority:p0", "priority: critical", "critical", "urgent"].includes(
          label,
        ),
      )
    ) {
      return 0;
    }
    if (
      normalized.some((label) =>
        ["p1", "priority:p1", "priority: high", "high"].includes(label),
      )
    ) {
      return 1;
    }
    if (
      normalized.some((label) =>
        ["p2", "priority:p2", "priority: medium", "medium"].includes(label),
      )
    ) {
      return 2;
    }
    if (
      normalized.some((label) =>
        ["p3", "priority:p3", "priority: low", "low"].includes(label),
      )
    ) {
      return 3;
    }
    return 4;
  }

  function githubItemKey(item: Pick<GithubItem, "kind" | "repo" | "number">) {
    return `${item.kind}:${item.repo}#${item.number}`;
  }

  function capturedIssueKeys() {
    return new Set(
      workflowStore
        .listEvents()
        .filter((event) =>
          ["work.captured", "work.capture-reused"].includes(event.type),
        )
        .map((event) => event.payload.itemKey)
        .filter((itemKey): itemKey is string => typeof itemKey === "string"),
    );
  }

  function roadmapItems(
    snapshot: GithubSnapshot,
    limit: number,
    projectId: string | null | undefined,
    ranking: RoadmapRanking,
    capturedKeys: Set<string>,
    snoozes: Record<string, number>,
  ) {
    const candidates = snapshot.items
      .filter(
        (item) =>
          item.kind === "issue" &&
          item.state.toLowerCase() === "open" &&
          (!projectId || snapshot.projectByRepo.get(item.repo) === projectId),
      )
      .filter((item) => !(snapshot.links[githubItemKey(item)]?.length))
      .filter((item) => !(githubItemKey(item) in snoozes))
      .map((item) => ({
        id: githubItemKey(item),
        repo: item.repo,
        number: item.number,
        title: item.title,
        url: item.url,
        labels: item.labels,
        priority: issuePriority(item.labels),
        updatedAt: item.updatedAt,
        projectId: snapshot.projectByRepo.get(item.repo) ?? null,
        linkedThreadId:
          snapshot.links[githubItemKey(item)]?.at(-1)?.threadId ?? null,
        captured: capturedKeys.has(githubItemKey(item)),
      }));
    return rankRoadmapItems(candidates, limit, ranking);
  }

  function snoozedRoadmapCount(
    snapshot: GithubSnapshot,
    snoozes: Record<string, number>,
    projectId?: string | null,
  ) {
    return snapshot.items.filter(
      (item) =>
        item.kind === "issue" &&
        item.state.toLowerCase() === "open" &&
        githubItemKey(item) in snoozes &&
        !(snapshot.links[githubItemKey(item)]?.length) &&
        (!projectId || snapshot.projectByRepo.get(item.repo) === projectId),
    ).length;
  }

  function normalizedWorkTitle(title: string) {
    return title.trim().replace(/\s+/g, " ").toLowerCase();
  }

  function capturedWorkBody(
    input: CaptureWorkInput,
    source: { id: string; title: string },
  ) {
    const criteria = input.acceptanceCriteria.length
      ? [
          "## Acceptance criteria",
          "",
          ...input.acceptanceCriteria.map((criterion) => `- ${criterion}`),
        ].join("\n")
      : null;
    return [
      input.description.trim(),
      criteria,
      [
        "## Provenance",
        "",
        `Captured by Autobahn from bb thread \`${source.id}\` (${source.title}).`,
      ].join("\n"),
    ]
      .filter((section): section is string => Boolean(section))
      .join("\n\n");
  }

  async function captureGithubWorkItem(
    input: CaptureWorkInput,
    source: { id: string; projectId: string; title: string },
  ): Promise<CapturedWorkItem> {
    const snapshot = await loadGithubSnapshot(true);
    const linkedRepos = [
      ...new Set(
        (linkedItemsByThread(snapshot).get(source.id) ?? []).map(
          (item) => item.repo,
        ),
      ),
    ];
    const projectRepos = [
      ...snapshot.projectByRepo.entries(),
    ]
      .filter(([, projectId]) => projectId === source.projectId)
      .map(([repo]) => repo);
    const linkedProjectRepos = linkedRepos.filter(
      (repo) => snapshot.projectByRepo.get(repo) === source.projectId,
    );
    const candidateRepos = linkedProjectRepos.length
      ? linkedProjectRepos
      : projectRepos;
    if (candidateRepos.length === 0) {
      throw new Error(
        "No issue tracker repository is configured for this project.",
      );
    }
    if (candidateRepos.length > 1) {
      throw new Error(
        `Work capture is ambiguous because this project maps to multiple repositories: ${candidateRepos.join(", ")}. File the item explicitly in the tracker.`,
      );
    }
    const repo = candidateRepos[0]!;
    const duplicate = snapshot.items.find(
      (item) =>
        item.kind === "issue" &&
        item.repo === repo &&
        item.state.toLowerCase() === "open" &&
        normalizedWorkTitle(item.title) === normalizedWorkTitle(input.title),
    );
    if (duplicate) {
      workflowStore.appendEvent({
        threadId: source.id,
        type: "work.capture-reused",
        payload: {
          tracker: "github",
          externalId: `${repo}#${duplicate.number}`,
          itemKey: githubItemKey(duplicate),
          url: duplicate.url,
          title: input.title.trim(),
        },
      });
      return {
        tracker: "github",
        externalId: `${repo}#${duplicate.number}`,
        url: duplicate.url,
        created: false,
        warning: null,
      };
    }

    const labels = [...new Set(input.labels.map((label) => label.trim()))];
    const created = await githubRpc(
      "createIssue",
      {
        repo,
        title: input.title.trim(),
        body: capturedWorkBody(input, source),
      },
      githubCreateIssueOutputSchema,
    );
    let warning: string | null = null;
    if (labels.length) {
      if (created.number === null) {
        warning =
          "Issue created, but labels could not be applied because its number was unavailable.";
      } else {
        try {
          await githubRpc(
            "setLabels",
            { repo, number: created.number, labels },
            githubSetLabelsOutputSchema,
          );
        } catch (error) {
          warning = `Issue created, but labels could not be applied: ${String(error)}`;
        }
      }
    }
    githubSnapshotCache = null;
    try {
      await githubRpc("refresh", null, githubRefreshOutputSchema);
    } catch (error) {
      bb.log.debug(`GitHub refresh after work capture failed: ${String(error)}`);
    }
    githubSnapshotCache = null;
    const externalId =
      created.number === null ? created.url : `${repo}#${created.number}`;
    workflowStore.appendEvent({
      threadId: source.id,
      type: "work.captured",
      payload: {
        tracker: "github",
        externalId,
        itemKey:
          created.number === null
            ? null
            : `issue:${repo}#${created.number}`,
        url: created.url,
        title: input.title.trim(),
        labels,
        warning,
      },
    });
    bb.realtime.publish("board-changed", {
      threadId: source.id,
      event: "work.captured",
    });
    return {
      tracker: "github",
      externalId,
      url: created.url,
      created: true,
      warning,
    };
  }

  async function captureWorkItem(
    input: CaptureWorkInput,
    source: { id: string; projectId: string; title: string },
  ) {
    // GitHub is the first adapter. Keep the agent contract tracker-neutral so
    // another adapter, such as Linear, can be selected here later.
    return await captureGithubWorkItem(input, source);
  }

  async function moveWarning(
    threadId: string,
    status: BoardStatus,
    sections: SectionIds,
  ): Promise<string | null> {
    const state = workflowStore.get(threadId);
    if (
      status === "WIP" &&
      (!state?.planContract ||
        state.gate !== "none" ||
        state.parkedWake !== null ||
        !dependenciesComplete(state))
    ) {
      throw new Error(
        "WIP requires an approved plan contract, no open gate, satisfied dependencies, and no parking condition.",
      );
    }
    const events = workflowStore.listEvents(threadId);
    if (
      status === "R4R" &&
      (!state ||
        state.phase !== "verify" ||
        !events.some((event) => event.type === "verification.completed") ||
        !["DONE", "DONE_WITH_CONCERNS"].includes(state.exitStatus ?? "") ||
        state.evidence.length === 0)
    ) {
      throw new Error(
        "R4R requires a completed fresh-context verification panel, a typed successful verify exit, and evidence.",
      );
    }
    if (
      status === "CLOSED" &&
      (!state ||
        state.phase !== "egress" ||
        state.exitStatus !== "DONE" ||
        state.evidence.length === 0 ||
        state.gate !== "none" ||
        state.parkedWake !== null)
    ) {
      throw new Error(
        "CLOSED requires a clean egress DONE exit with evidence and no open gate or parking condition.",
      );
    }
    if (status === "CLOSED") {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.environmentId) {
          const pr = await bb.sdk.environments.pullRequest({
            environmentId: thread.environmentId,
          });
          if (
            pr.outcome === "available" &&
            pr.pullRequest.state !== "merged" &&
            pr.pullRequest.state !== "closed"
          ) {
            throw new Error("CLOSED requires the linked pull request to be merged or closed.");
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("CLOSED requires")) {
          throw error;
        }
      }
    }
    if (status !== "WIP") return null;

    let thread: Awaited<ReturnType<typeof bb.sdk.threads.get>> | null = null;
    try {
      thread = await bb.sdk.threads.get({ threadId });
    } catch {
      return null;
    }
    const { wipLimit } = await settings.get();
    const limit = positiveInteger(wipLimit, 3);
    try {
      const wipThreads = await bb.sdk.threads.list({
        projectId: thread.projectId,
        sectionId: sections.WIP,
        archived: false,
        includeHidden: false,
        limit: 500,
      });
      const activeWip = wipThreads.filter(
        (candidate) => workflowStore.get(candidate.id)?.parkedWake == null,
      ).length;
      if (thread.sectionId !== sections.WIP && activeWip >= limit) {
        return `Soft WIP limit exceeded for this project (${activeWip}/${limit}).`;
      }
    } catch {
      return null;
    }
    return null;
  }

  async function moveThread(
    threadId: string,
    status: BoardStatus,
    options: MoveOptions = {},
  ) {
    const source = options.source ?? "workflow";
    const sections = await ensureSections();
    const current = workflowStore.get(threadId);
    if (
      source === "workflow" &&
      current?.statusOverride &&
      current.statusOverride !== status
    ) {
      throw new Error(
        `Manual status override ${current.statusOverride} is active; the Driver or user must clear it before workflow automation can move this card.`,
      );
    }
    const warning = options.bypassWorkflowGuards
      ? null
      : await moveWarning(threadId, status, sections);
    await bb.sdk.threads.update({ threadId, sectionId: sections[status] });
    if (status !== "CLOSED") {
      const dismissals = await readClosedDismissals();
      if (dismissals.delete(threadId)) {
        await bb.storage.kv.set(CLOSED_DISMISSALS_KEY, [...dismissals]);
      }
    }
    const phase = options.preserveWorkflowPosition
      ? current?.phase ?? "intake"
      : status === "WIP"
        ? "build"
        : status === "R4R"
          ? "egress"
          : status === "CLOSED"
            ? "complete"
            : "intake";
    workflowStore.upsert(threadId, {
      phase,
      ...(options.preserveWorkflowPosition
        ? {}
        : { completedAt: status === "CLOSED" ? Date.now() : null }),
      ...(options.setOverride
        ? {
            statusOverride: status,
            statusOverrideReason:
              options.reason ?? `${source} set a manual override`,
            statusOverrideAt: Date.now(),
          }
        : {}),
    });
    workflowStore.appendEvent({
      threadId,
      type: "card.moved",
      payload: {
        status,
        warning,
        source,
        reason: options.reason ?? null,
        override: options.setOverride ?? false,
      },
    });
    bb.realtime.publish("board-changed", { threadId, status });
    return { threadId, status, warning };
  }

  async function createSession({
    projectId,
    title,
    prompt,
    status,
  }: {
    projectId: string;
    title: string;
    prompt: string;
    status: BoardStatus;
  }) {
    const sections = await ensureSections();
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      prompt,
      title,
      sectionId: sections[status],
      visibility: "visible",
    });
    workflowStore.upsert(thread.id, {
      phase:
        status === "WIP"
          ? "build"
          : status === "R4R"
            ? "egress"
            : status === "CLOSED"
              ? "complete"
              : "intake",
      nextAction:
        status === "OPEN"
          ? "Run the plan workflow"
          : "Complete the assigned work and report a typed exit",
    });
    bb.realtime.publish("board-changed", { threadId: thread.id, status });
    return thread;
  }

  async function listThreads(projectId?: string | null) {
    const threads = [];
    const pageSize = 200;
    let offset = 0;

    while (true) {
      const page = await bb.sdk.threads.list({
        ...(projectId ? { projectId } : {}),
        archived: false,
        includeHidden: false,
        limit: pageSize,
        offset,
      });
      threads.push(...page);
      if (page.length < pageSize) return threads;
      offset += page.length;
    }
  }

  let externalStatusSyncInFlight: Promise<void> | null = null;

  function linkedItemsByThread(snapshot: GithubSnapshot) {
    const itemByKey = new Map(
      snapshot.items.map((item) => [githubItemKey(item), item]),
    );
    const byThread = new Map<string, GithubItem[]>();
    for (const [key, links] of Object.entries(snapshot.links)) {
      const item = itemByKey.get(key);
      if (!item) continue;
      for (const link of links) {
        const current = byThread.get(link.threadId) ?? [];
        current.push(item);
        byThread.set(link.threadId, current);
      }
    }
    return byThread;
  }

  async function syncExternalStatuses(projectId?: string | null) {
    if (externalStatusSyncInFlight) return externalStatusSyncInFlight;
    externalStatusSyncInFlight = (async () => {
      const [snapshot, sections, threads] = await Promise.all([
        loadGithubSnapshot(),
        ensureSections(),
        listThreads(projectId),
      ]);
      const linkedByThread = linkedItemsByThread(snapshot);
      for (const thread of threads) {
        const workflow = workflowStore.get(thread.id);
        if (workflow?.statusOverride) continue;
        const linked = linkedByThread.get(thread.id) ?? [];
        let externalClosed = linked.some((item) =>
          ["closed", "merged"].includes(item.state.toLowerCase()),
        );
        let externalOpen = linked.some((item) =>
          ["open", "draft"].includes(item.state.toLowerCase()),
        );
        let pullReason: string | null = null;

        if (thread.environmentId) {
          try {
            const pull = await bb.sdk.environments.pullRequest({
              environmentId: thread.environmentId,
            });
            if (pull.outcome === "available") {
              externalClosed ||= ["merged", "closed"].includes(
                pull.pullRequest.state,
              );
              externalOpen ||= ["open", "draft"].includes(
                pull.pullRequest.state,
              );
              if (["merged", "closed"].includes(pull.pullRequest.state)) {
                pullReason =
                  "Pull request #" + pull.pullRequest.number + " is " + pull.pullRequest.state;
              }
            }
          } catch {
            // Cached GitHub issue/link state remains usable.
          }
        }

        const reason = externalClosed
          ? pullReason ?? "Linked GitHub issue or pull request closed"
          : "Linked GitHub issue or pull request reopened";

        const currentStatus =
          (Object.entries(sections).find(
            ([, sectionId]) => sectionId === thread.sectionId,
          )?.[0] as BoardStatus | undefined) ?? "OPEN";
        let destination: BoardStatus | null = null;
        if (externalClosed && currentStatus !== "CLOSED") {
          if (
            currentStatus === "R4R" &&
            workflow?.phase === "egress" &&
            workflow.evidence.length > 0
          ) {
            // The egress gate is a human decision: raise the interaction
            // instead of closing the verified card automatically.
            if (
              workflow.parkedWake === null &&
              !thread.hasPendingInteraction &&
              !inFlightGateDecisions.has(thread.id)
            ) {
              raiseGateDecisions([{ threadId: thread.id, reason }]);
            }
            continue;
          }
          if (gateSendBackActive(thread.id)) continue;
          destination = "CLOSED";
        } else if (
          !externalClosed &&
          externalOpen &&
          currentStatus === "CLOSED"
        ) {
          destination = workflowStore
            .listEvents(thread.id)
            .some((event) => event.type === "verification.completed")
            ? "R4R"
            : "OPEN";
        }
        if (!destination) continue;

        await moveThread(thread.id, destination, {
          source: "automation",
          reason,
          bypassWorkflowGuards: true,
        });
        workflowStore.upsert(thread.id, {
          phase:
            destination === "CLOSED"
              ? "complete"
              : destination === "R4R"
                ? "egress"
                : "intake",
          nextAction:
            destination === "CLOSED"
              ? "No action"
              : destination === "R4R"
                ? "Review the reopened pull request"
                : "Review roadmap priority and plan the reopened work",
        });
        workflowStore.appendEvent({
          threadId: thread.id,
          type: "status.external-sync",
          payload: {
            destination,
            reason,
          },
        });
      }
    })().finally(() => {
      externalStatusSyncInFlight = null;
    });
    return await externalStatusSyncInFlight;
  }

  function nativeGate(
    attention: string | null | undefined,
  ): CardWorkflowState["gate"] {
    if (attention === "checks_failed") return "checks-failed";
    if (attention === "changes_requested") return "changes-requested";
    if (attention === "review_requested") return "review-requested";
    if (attention === "conflicts" || attention === "blocked") return "blocked";
    return "none";
  }

  async function listBoard(projectId?: string | null) {
    await syncExternalStatuses(projectId);
    const [
      sections,
      projects,
      threads,
      configured,
      githubSnapshot,
      closedDismissals,
    ] = await Promise.all([
        ensureSections(),
        bb.sdk.projects.list({ includePersonal: true }),
        listThreads(projectId),
        settings.get(),
        loadGithubSnapshot(),
        readClosedDismissals(),
      ]);
    const roadmapSnoozes = await activeRoadmapSnoozes(githubSnapshot);
    const activeClosedIds = new Set(
      threads
        .filter((thread) => thread.sectionId === sections.CLOSED)
        .map((thread) => thread.id),
    );
    let dismissalsPruned = false;
    for (const threadId of closedDismissals) {
      if (!activeClosedIds.has(threadId)) {
        closedDismissals.delete(threadId);
        dismissalsPruned = true;
      }
    }
    if (dismissalsPruned) {
      await bb.storage.kv.set(CLOSED_DISMISSALS_KEY, [...closedDismissals]);
    }
    const projectNames = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const sectionStatuses = new Map(
      BOARD_STATUSES.map((status) => [sections[status], status]),
    );
    const githubItemsByThread = linkedItemsByThread(githubSnapshot);
    const staleMs =
      positiveInteger(configured.staleHours, 24) * 60 * 60 * 1_000;
    const contextWarning =
      positiveInteger(configured.contextWarningPercent, 85) / 100;

    const cards = await mapWithConcurrency(threads, 8, async (thread) => {
      const [execution, timeline, output, pullRequest] = await Promise.all([
        bb.sdk.threads
          .defaultExecutionOptions({ threadId: thread.id })
          .catch(() => null),
        bb.sdk.threads
          .timeline({
            threadId: thread.id,
            segmentLimit: "1",
            includeNestedRows: "true",
          })
          .catch(() => null),
        bb.sdk.threads.output({ threadId: thread.id }).catch(() => null),
        thread.environmentId
          ? bb.sdk.environments
              .pullRequest({ environmentId: thread.environmentId })
              .catch(() => null)
          : Promise.resolve(null),
      ]);
      const assistantText =
        output?.output ?? (timeline ? latestAssistantText(timeline.rows) : null);
      let links = extractExternalLinks(assistantText);
      for (const item of githubItemsByThread.get(thread.id) ?? []) {
        links = addLink(links, {
          kind: item.kind === "pr" ? "pull-request" : "issue",
          label: `${item.kind === "pr" ? "PR" : "Issue"} #${item.number}`,
          url: item.url,
          state: item.state.toLowerCase(),
        });
      }
      if (pullRequest?.outcome === "available") {
        links = addLink(links, {
          kind: "pull-request",
          label: `PR #${pullRequest.pullRequest.number}`,
          url: pullRequest.pullRequest.url,
          state: pullRequest.pullRequest.state,
        });
      }

      let workflow =
        workflowStore.get(thread.id) ??
        workflowStore.upsert(thread.id, {
          phase:
            thread.sectionId === sections.WIP
              ? "build"
              : thread.sectionId === sections.R4R
                ? "egress"
                : thread.sectionId === sections.CLOSED
                  ? "complete"
                  : "intake",
          nextAction:
            thread.sectionId === sections.OPEN ? "Define and approve the plan" : null,
        });
      if (!workflow.nextAction) {
        const nextAction =
          thread.sectionId === sections.OPEN
            ? "Run the plan workflow"
            : thread.sectionId === sections.WIP
              ? "Complete the current pass and report a typed exit"
              : thread.sectionId === sections.R4R
                ? "Review the verified change"
                : "No action";
        workflow = workflowStore.upsert(thread.id, { nextAction });
      }
      const prAttention =
        pullRequest?.outcome === "available"
          ? pullRequest.pullRequest.attention
          : null;
      const derivedGate =
        workflow.gate === "none"
          ? thread.hasPendingInteraction
            ? "needs-input"
            : nativeGate(prAttention)
          : workflow.gate;
      if (derivedGate !== workflow.gate) {
        workflow = { ...workflow, gate: derivedGate };
      }

      const attention = new Set<z.infer<typeof attentionSchema>>();
      if (derivedGate !== "none") attention.add(derivedGate);
      if (thread.hasPendingInteraction) attention.add("needs-input");
      if (thread.status === "error") attention.add("runtime-error");
      if (Date.now() - thread.updatedAt > staleMs && thread.sectionId !== sections.CLOSED) {
        attention.add("stale");
      }
      if (
        timeline?.contextWindowUsage &&
        timeline.contextWindowUsage.usedTokens /
          timeline.contextWindowUsage.modelContextWindow >=
          contextWarning &&
        !workflowStore
          .listEvents(thread.id)
          .some(
            (event) =>
              event.type === "station.exited" &&
              event.createdAt >= workflow.phaseStartedAt,
          )
      ) {
        attention.add("context-high");
      }
      if (
        thread.sectionId === sections.CLOSED &&
        pullRequest?.outcome === "available" &&
        pullRequest.pullRequest.state !== "merged" &&
        pullRequest.pullRequest.state !== "closed"
      ) {
        attention.add("done-with-open-pr");
      }

      return {
        id: thread.id,
        title: thread.title ?? thread.titleFallback ?? "Untitled thread",
        projectId: thread.projectId,
        projectName: projectNames.get(thread.projectId) ?? "Unknown project",
        status: sectionStatuses.get(thread.sectionId ?? "") ?? "OPEN",
        runtimeStatus: thread.status,
        harness: thread.providerId,
        model: execution?.model ?? null,
        effort: execution?.reasoningLevel ?? null,
        context: timeline?.contextWindowUsage ?? null,
        summary: normalizeSummary(assistantText),
        branchName: thread.environmentBranchName,
        links,
        workflow: {
          phase: workflow.phase,
          gate: derivedGate,
          riskClass: workflow.riskClass,
          priority: workflow.priority,
          attempt: workflow.attempt,
          exitStatus: workflow.exitStatus,
          nextAction: workflow.nextAction,
          concerns: workflow.concerns,
          evidence: workflow.evidence,
          planContract: workflow.planContract,
          blockedBy: workflow.blockedBy,
          parkedWake: workflow.parkedWake,
          phaseStartedAt: workflow.phaseStartedAt,
          statusOverride: workflow.statusOverride,
          statusOverrideReason: workflow.statusOverrideReason,
          statusOverrideAt: workflow.statusOverrideAt,
        },
        attention: [...attention],
        updatedAt: thread.updatedAt,
      };
    });

    cards.sort((a, b) => b.updatedAt - a.updatedAt);
    const limits: Record<BoardStatus, number | null> = {
      OPEN: null,
      WIP: positiveInteger(configured.wipLimit, 3),
      R4R: positiveInteger(configured.reviewLimit, 6),
      CLOSED: null,
    };
    const lanes = BOARD_STATUSES.map((status) => {
      const laneCards = cards.filter(
        (card) =>
          card.status === status &&
          !(status === "CLOSED" && closedDismissals.has(card.id)),
      );
      const capacityCount = laneCards.filter(
        (card) => card.workflow.parkedWake === null,
      ).length;
      const softLimit = limits[status];
      return {
        status,
        sectionId: sections[status],
        softLimit,
        capacityCount,
        overLimit: softLimit !== null && capacityCount > softLimit,
        cards: laneCards.map((card) =>
          softLimit !== null && capacityCount > softLimit
            ? {
                ...card,
                attention: [...new Set([...card.attention, "wip-overflow" as const])],
              }
            : card,
        ),
      };
    });
    return {
      lanes,
      roadmapItems: roadmapItems(
        githubSnapshot,
        positiveInteger(configured.roadmapLimit, 5),
        projectId,
        roadmapRanking(configured.roadmapRanking),
        capturedIssueKeys(),
        roadmapSnoozes,
      ),
      snoozedCount: snoozedRoadmapCount(
        githubSnapshot,
        roadmapSnoozes,
        projectId,
      ),
      needsYouCount: lanes
        .flatMap((lane) => lane.cards)
        .filter((card) => card.attention.length > 0).length,
    };
  }

  const DEFAULT_VERIFICATION_LENSES: VerificationLens[] = [
    {
      id: "correctness",
      title: "Correctness",
      instructions:
        "Find concrete logic errors, broken edge cases, and behavior that violates the plan acceptance criteria.",
    },
    {
      id: "silent-failures",
      title: "Silent failures",
      instructions:
        "Find swallowed errors, misleading fallbacks, missing propagation, and failure paths that look successful.",
    },
    {
      id: "test-adequacy",
      title: "Test adequacy",
      instructions:
        "Check whether tests actually enforce every acceptance criterion and whether new failure paths are covered.",
    },
    {
      id: "conventions",
      title: "Repository conventions",
      instructions:
        "Check the changed work against repository instructions and established patterns in the touched modules.",
    },
  ];

  async function notifyController(threadId: string, text: string) {
    try {
      await bb.sdk.threads.send({
        threadId,
        input: [
          {
            type: "text",
            text,
            mentions: [],
            visibility: "agent-only",
          },
        ],
        mode: "auto",
      });
    } catch (error) {
      bb.log.warn(
        `Could not deliver workflow handoff to ${threadId}: ${String(error)}`,
      );
    }
  }

  async function notifyDriver(text: string) {
    if (!driverThreadIdCache) return;
    await notifyController(driverThreadIdCache, text);
  }

  function planForStore(
    objective: string,
    plan: Awaited<ReturnType<typeof runPlanWorkflow>>["plan"],
  ): PlanContract {
    const expectedFiles = [
      ...new Set(
        plan.implementationSteps.flatMap((step) =>
          step.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/g) ?? [],
        ),
      ),
    ];
    return {
      objective,
      scope: plan.scope,
      outOfScope: plan.outOfScope,
      expectedFiles,
      acceptanceCriteria: plan.acceptanceCriteria,
      verificationCommands: plan.verification,
    };
  }

  async function runPlanForCard(
    threadId: string,
    objective: string,
    context: string | undefined,
    signal: AbortSignal,
  ) {
    const controller = await bb.sdk.threads.get({ threadId, signal });
    const state =
      workflowStore.get(threadId) ??
      workflowStore.upsert(threadId, { phase: "plan" });
    workflowStore.upsert(threadId, {
      phase: "plan",
      gate: "none",
      nextAction: "Planner and adversarial reviewer are running",
    });
    const result = await runPlanWorkflow(
      childAdapter,
      {
        projectId: controller.projectId,
        environmentId: controller.environmentId,
        parentThreadId: threadId,
        controllerThreadId: threadId,
        objective,
        context,
        maxRevisionRounds: 2,
      },
      { signal, timeoutMs: 60 * 60 * 1_000 },
    ).catch((error) => {
      workflowStore.upsert(threadId, {
        phase: "plan",
        gate: "blocked",
        exitStatus: "BLOCKED",
        nextAction: "Retry the plan workflow after resolving its failure",
        concerns: [...state.concerns, String(error)],
      });
      workflowStore.appendEvent({
        threadId,
        type: "plan.failed",
        payload: { error: String(error) },
      });
      bb.realtime.publish("board-changed", {
        threadId,
        event: "plan.failed",
      });
      throw error;
    });
    const planContract = planForStore(objective, result.plan);
    const humanGate =
      state.riskClass === "high" || state.riskClass === "critical";
    const gate =
      result.outcome === "accepted"
        ? humanGate
          ? "plan-approval"
          : "none"
        : result.outcome === "needs-context"
          ? "needs-input"
          : "blocked";
    const nextAction =
      result.outcome === "accepted"
        ? humanGate
          ? "Approve the plan before dispatch"
          : "Dispatch the ready card"
        : result.review.requiredChanges[0] ??
          result.review.concerns[0] ??
          "Resolve the plan blocker";
    workflowStore.upsert(threadId, {
      phase: "plan",
      gate,
      planContract,
      concerns: result.review.concerns,
      attempt: state.attempt + result.attempts,
      nextAction,
      exitStatus: result.accepted ? "DONE" : "BLOCKED",
    });
    workflowStore.appendEvent({
      threadId,
      type: "plan.completed",
      payload: {
        outcome: result.outcome,
        revisions: result.revisions,
        attempts: result.attempts,
        reviewSummary: result.review.summary,
      },
    });
    bb.realtime.publish("board-changed", { threadId, event: "plan.completed" });
    await notifyController(
      threadId,
      [
        "Autobahn planning workflow completed.",
        `Outcome: ${result.outcome} after ${result.attempts} attempt(s).`,
        `Reviewer: ${result.review.summary}`,
        `Gate: ${gate}.`,
        `Next: ${nextAction}`,
        `Plan contract: ${JSON.stringify(planContract)}`,
      ].join("\n"),
    );
    return { result, planContract, gate, nextAction };
  }

  async function runVerificationForCard(
    threadId: string,
    objective: string,
    lenses: VerificationLens[],
    signal: AbortSignal,
  ) {
    const controller = await bb.sdk.threads.get({ threadId, signal });
    const sections = await ensureSections();
    if (controller.sectionId !== sections.WIP) {
      throw new Error("Verification requires the controller card to be in WIP.");
    }
    await bb.sdk.threads.stop({ threadId });
    let verificationHeadSha: string | null = null;
    if (controller.environmentId) {
      const environmentStatus = await bb.sdk.environments.status({
        environmentId: controller.environmentId,
        signal,
      });
      if (environmentStatus.outcome === "available") {
        if (environmentStatus.workspace.workingTree.hasUncommittedChanges) {
          throw new Error(
            "Commit controller changes before verification so isolated reviewers inspect an immutable branch.",
          );
        }
        verificationHeadSha =
          environmentStatus.workspace.checkout.kind === "branch"
            ? environmentStatus.workspace.checkout.headSha
            : null;
      }
    }
    const state =
      workflowStore.get(threadId) ??
      workflowStore.upsert(threadId, { phase: "verify" });
    const successfulBuildExit = workflowStore
      .listEvents(threadId)
      .some(
        (event) =>
          event.type === "station.exited" &&
          event.payload.phase === "build" &&
          (event.payload.status === "DONE" ||
            event.payload.status === "DONE_WITH_CONCERNS"),
      );
    if (
      !state.planContract ||
      state.phase !== "verify" ||
      !successfulBuildExit
    ) {
      throw new Error(
        "Verification requires an approved plan contract and a successful typed build exit.",
      );
    }
    workflowStore.upsert(threadId, {
      phase: "verify",
      gate: "none",
      nextAction: "Fresh-context verification panel is running",
    });
    const effectiveLenses = [
      ...DEFAULT_VERIFICATION_LENSES,
      ...lenses.filter(
        (lens) =>
          !DEFAULT_VERIFICATION_LENSES.some(
            (baseline) => baseline.id === lens.id,
          ),
      ),
    ];
    if (
      (state.riskClass === "high" || state.riskClass === "critical") &&
      !effectiveLenses.some((lens) => lens.id === "security")
    ) {
      effectiveLenses.push({
        id: "security",
        title: "Security",
        instructions:
          "Inspect permissions, authentication, tenant boundaries, secrets, injection, and unsafe trust assumptions in the changed work.",
      });
    }
    const result = await runVerificationWorkflow(
      childAdapter,
      {
        projectId: controller.projectId,
        environmentId: controller.environmentId,
        parentThreadId: threadId,
        controllerThreadId: threadId,
        objective,
        context: state.planContract
          ? `Plan contract:\n${JSON.stringify(state.planContract, null, 2)}`
          : undefined,
        lenses: effectiveLenses,
      },
      { signal, timeoutMs: 60 * 60 * 1_000 },
    ).catch((error) => {
      workflowStore.upsert(threadId, {
        phase: "verify",
        gate: "blocked",
        exitStatus: "BLOCKED",
        nextAction: "Retry verification after resolving its failure",
        concerns: [...state.concerns, String(error)],
      });
      workflowStore.appendEvent({
        threadId,
        type: "verification.failed",
        payload: { error: String(error) },
      });
      bb.realtime.publish("board-changed", {
        threadId,
        event: "verification.failed",
      });
      throw error;
    });
    if (verificationHeadSha && controller.environmentId) {
      const refreshedStatus = await bb.sdk.environments.status({
        environmentId: controller.environmentId,
        signal,
      });
      const refreshedHead =
        refreshedStatus.outcome === "available" &&
        refreshedStatus.workspace.checkout.kind === "branch"
          ? refreshedStatus.workspace.checkout.headSha
          : null;
      if (refreshedHead !== verificationHeadSha) {
        const error = new Error(
          "Controller branch changed during verification; discard the panel and rerun.",
        );
        workflowStore.upsert(threadId, {
          phase: "verify",
          gate: "blocked",
          exitStatus: "BLOCKED",
          nextAction: "Rerun verification against the new branch head",
          concerns: [...state.concerns, error.message],
        });
        workflowStore.appendEvent({
          threadId,
          type: "verification.failed",
          payload: { error: error.message },
        });
        throw error;
      }
    }
    const evidence: WorkflowEvidence[] = [
      {
        label: `Verification panel: ${result.counts.lenses} lenses; ${result.counts.confirmed} confirmed; ${result.counts.rejected} rejected`,
      },
      ...result.confirmedFindings.map(
      (finding) => ({
        label: `${finding.severity.toUpperCase()}: ${finding.title}`,
        ...(finding.evidence[0]?.url
          ? { url: finding.evidence[0].url }
          : {}),
        ...(finding.evidence[0]?.path
          ? { path: finding.evidence[0].path }
          : {}),
      }),
    ),
    ];
    const concerns = [
      ...result.confirmedFindings.map(
        (finding) => `${finding.severity}: ${finding.summary}`,
      ),
      ...result.inconclusiveFindings.map(
        ({ finding }) => `needs context: ${finding.title}`,
      ),
    ];
    const blocking = result.confirmedFindings.some((finding) =>
      ["critical", "high"].includes(finding.severity),
    );
    const inconclusive = result.inconclusiveFindings.length > 0;
    const status = blocking
      ? "BLOCKED"
      : inconclusive
        ? "NEEDS_CONTEXT"
        : result.confirmedFindings.length > 0
          ? "DONE_WITH_CONCERNS"
          : "DONE";
    const gate = blocking
      ? "blocked"
      : inconclusive
        ? "needs-input"
        : "review-requested";
    const nextAction = blocking
      ? "Fix confirmed high-severity findings and rerun verification"
      : inconclusive
        ? "Provide the context requested by verification"
        : "Review the verified change";
    workflowStore.reportExit({
      threadId,
      phase: "verify",
      status,
      summary: `Verification: ${result.counts.confirmed} confirmed, ${result.counts.rejected} rejected, ${result.counts.inconclusive} inconclusive.`,
      nextAction,
      concerns,
      evidence,
      gate,
    });
    workflowStore.appendEvent({
      threadId,
      type: "verification.completed",
      payload: {
        counts: result.counts,
        confirmedFindingIds: result.confirmedFindings.map(
          (finding) => finding.id,
        ),
      },
    });
    if (!blocking && !inconclusive) {
      await moveThread(threadId, "R4R");
    } else {
      bb.realtime.publish("board-changed", {
        threadId,
        event: "verification.completed",
      });
    }
    await notifyController(
      threadId,
      [
        "Autobahn verification workflow completed.",
        `Status: ${status}.`,
        `Panel: ${result.counts.lenses} lenses, ${result.counts.confirmed} confirmed, ${result.counts.rejected} rejected, ${result.counts.inconclusive} inconclusive.`,
        concerns.length ? `Concerns: ${concerns.join(" | ")}` : "Concerns: none.",
        `Next: ${nextAction}`,
      ].join("\n"),
    );
    return { result, status, gate, nextAction };
  }

  function dependenciesComplete(state: CardWorkflowState) {
    return state.blockedBy.every(
      (dependencyId) =>
        workflowStore.get(dependencyId)?.phase === "complete",
    );
  }

  async function wakeReadyCards() {
    const now = Date.now();
    const woken: string[] = [];
    for (const state of workflowStore.list()) {
      const wake = state.parkedWake;
      if (!wake) continue;
      let ready = false;
      if (wake.kind === "timer") {
        ready = wake.until !== null && wake.until <= now;
      } else if (wake.kind === "dependency") {
        ready = dependenciesComplete(state);
      } else if (wake.kind === "interaction") {
        try {
          ready =
            (await bb.sdk.threads.interactions.list({
              threadId: state.threadId,
            })).length === 0;
        } catch {
          ready = false;
        }
      } else if (
        wake.kind === "pr-merged" ||
        wake.kind === "checks-finished"
      ) {
        try {
          const thread = await bb.sdk.threads.get({
            threadId: state.threadId,
          });
          if (thread.environmentId) {
            const pr = await bb.sdk.environments.pullRequest({
              environmentId: thread.environmentId,
            });
            ready =
              pr.outcome === "available" &&
              (wake.kind === "pr-merged"
                ? pr.pullRequest.state === "merged"
                : pr.pullRequest.checks.state === "passing" ||
                  pr.pullRequest.checks.state === "no_checks");
          }
        } catch {
          ready = false;
        }
      }
      if (!ready) continue;
      workflowStore.wake({
        threadId: state.threadId,
        reason: `${wake.kind} wake condition satisfied`,
        nextAction: "Ready for Driver dispatch",
      });
      woken.push(state.threadId);
    }
    if (woken.length) {
      bb.realtime.publish("board-changed", { event: "cards.woken", woken });
      await notifyDriver(
        `Autobahn wake pass surfaced ${woken.length} card(s): ${woken.join(", ")}. Inventory the board and recommend the single next dispatch action.`,
      );
    }
    return woken;
  }

  interface GateReadyCard {
    threadId: string;
    reason: string;
  }

  function gateSendBackActive(threadId: string) {
    let active = false;
    for (const event of workflowStore.listEvents(threadId)) {
      if (event.type === "gate.sent-back") active = true;
      else if (event.type === "gate.approved") active = false;
    }
    return active;
  }

  async function witnessReport(projectId?: string) {
    const board = await listBoard(projectId);
    const gateReady: GateReadyCard[] = [];
    const findings = board.lanes.flatMap((lane) =>
      lane.cards.flatMap((card) => {
        const findings: string[] = [];
        const mergedPullRequest = card.links.some(
          (link) => link.kind === "pull-request" && link.state === "merged",
        );
        const gateReadyCard =
          lane.status === "R4R" &&
          card.workflow.phase === "egress" &&
          card.workflow.evidence.length > 0 &&
          card.workflow.parkedWake === null &&
          !card.attention.includes("needs-input") &&
          mergedPullRequest;
        if (gateReadyCard) {
          gateReady.push({
            threadId: card.id,
            reason:
              "Merged pull request with verification evidence is waiting on the egress gate",
          });
          findings.push(
            `${card.id}: gate-ready — human egress decision requested`,
          );
        }
        if (card.attention.includes("stale")) {
          findings.push(`${card.id}: stale in ${lane.status}`);
        }
        if (card.attention.includes("runtime-error")) {
          findings.push(`${card.id}: runtime is in error`);
        }
        if (
          card.attention.includes("needs-input") &&
          card.attention.includes("stale")
        ) {
          findings.push(`${card.id}: pending human interaction is stale`);
        }
        if (card.attention.includes("context-high")) {
          findings.push(`${card.id}: high context without a next action`);
        }
        if (card.attention.includes("done-with-open-pr")) {
          findings.push(`${card.id}: CLOSED while its PR remains open`);
        }
        if (card.attention.includes("checks-failed")) {
          findings.push(`${card.id}: pull request checks failed`);
        }
        if (card.attention.includes("changes-requested")) {
          findings.push(`${card.id}: review changes requested`);
        }
        if (!gateReadyCard && card.status !== "CLOSED" && mergedPullRequest) {
          findings.push(`${card.id}: pull request merged but card is not CLOSED`);
        }
        if (
          card.runtimeStatus === "active" &&
          card.workflow.phase === "complete"
        ) {
          findings.push(`${card.id}: completed card still has an active runtime`);
        }
        if (card.attention.includes("wip-overflow")) {
          findings.push(`${card.id}: lane soft limit exceeded`);
        }
        if (
          card.runtimeStatus === "active" &&
          card.workflow.parkedWake !== null
        ) {
          findings.push(`${card.id}: parked card still has an active runtime`);
        }
        return findings;
      }),
    );
    return { findings, gateReady };
  }

  async function witnessFindings(projectId?: string) {
    return (await witnessReport(projectId)).findings;
  }

  async function applyGateDecision(
    threadId: string,
    decision: z.infer<typeof gateDecisionSchema>,
  ): Promise<string> {
    const state = workflowStore.get(threadId);
    if (!state) {
      throw new Error(`The card ${threadId} has no workflow state.`);
    }
    const note = decision.note.trim();
    if (decision.decision === "approve") {
      workflowStore.reportExit({
        threadId,
        phase: "egress",
        status: "DONE",
        summary: note || "Human approved the egress gate",
        nextAction: "No action",
        concerns: state.concerns,
        evidence: state.evidence,
        gate: "none",
      });
      workflowStore.appendEvent({
        threadId,
        type: "gate.approved",
        payload: { note },
      });
      await moveThread(threadId, "CLOSED", {
        source: "user",
        reason: "Human approved the egress gate",
      });
      return `Gate approved; ${threadId} moved to CLOSED.`;
    }
    if (decision.decision === "send-back") {
      const gaps = note || "Gaps identified at the egress gate";
      workflowStore.reportExit({
        threadId,
        phase: "egress",
        status: "BLOCKED",
        summary: gaps,
        nextAction: `Close the gate gaps: ${gaps}`,
        concerns: [...state.concerns, gaps],
        evidence: state.evidence,
        gate: "none",
      });
      workflowStore.appendEvent({
        threadId,
        type: "gate.sent-back",
        payload: { note: gaps },
      });
      await moveThread(threadId, "WIP", {
        source: "user",
        reason: "Human sent the card back with gaps",
        bypassWorkflowGuards: true,
      });
      workflowStore.upsert(threadId, {
        nextAction: `Close the gate gaps: ${gaps}`,
      });
      await notifyController(
        threadId,
        `The human egress gate sent this card back with gaps: ${gaps}. Close the gaps, rerun verification, and report a typed exit.`,
      );
      return `Gate sent ${threadId} back to WIP with gaps: ${gaps}`;
    }
    const now = Date.now();
    const until = decision.snoozeUntilEpochMs ?? now + DEFAULT_GATE_SNOOZE_MS;
    if (until <= now || until > now + MAX_SNOOZE_MS) {
      throw new Error("Gate snooze must end in the future within 366 days.");
    }
    workflowStore.park({
      threadId,
      wake: { kind: "timer", ref: null, until },
      nextAction: "Revisit the egress gate decision",
    });
    workflowStore.appendEvent({
      threadId,
      type: "gate.snoozed",
      payload: { until, note },
    });
    bb.realtime.publish("board-changed", { threadId, event: "gate.snoozed" });
    return `Gate snoozed for ${threadId} until ${new Date(until).toISOString()}.`;
  }

  async function requestGateDecision(
    input: { threadId: string; reason: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const { threadId } = input;
    if (inFlightGateDecisions.has(threadId)) {
      return `A gate decision is already pending for ${threadId}.`;
    }
    const state = workflowStore.get(threadId);
    if (!state || state.phase !== "egress" || state.evidence.length === 0) {
      throw new Error(
        "A gate decision requires a card at egress with verification evidence.",
      );
    }
    const thread = await bb.sdk.threads.get({ threadId });
    inFlightGateDecisions.add(threadId);
    try {
      // The payload is a compact summary; the decision response is delivered
      // only to this waiting invocation and stays well under the 64 KiB cap.
      const interaction = await bb.ui.requestInput(
        {
          threadId,
          rendererId: GATE_DECISION_RENDERER,
          title: "Autobahn gate decision",
          payload: {
            cardThreadId: threadId,
            cardTitle: (thread.title ?? thread.titleFallback ?? threadId).slice(
              0,
              200,
            ),
            objective: (state.planContract?.objective ?? "").slice(0, 500),
            reason: input.reason.slice(0, 500),
            evidence: state.evidence.slice(0, 12).map((item) => ({
              label: item.label.slice(0, 200),
              ...(item.url ? { url: item.url.slice(0, 500) } : {}),
              ...(item.path ? { path: item.path.slice(0, 500) } : {}),
            })),
            concerns: state.concerns
              .slice(0, 12)
              .map((concern) => concern.slice(0, 300)),
          },
          timeoutMs: GATE_DECISION_TIMEOUT_MS,
        },
        options.signal ? { signal: options.signal } : {},
      );
      if (interaction.outcome === "cancelled") {
        return `Gate decision cancelled for ${threadId}; the card is unchanged.`;
      }
      const decision = gateDecisionSchema.parse(interaction.value);
      return await applyGateDecision(threadId, decision);
    } finally {
      inFlightGateDecisions.delete(threadId);
    }
  }

  function raiseGateDecisions(gateReady: GateReadyCard[]) {
    for (const gate of gateReady) {
      if (inFlightGateDecisions.has(gate.threadId)) continue;
      void requestGateDecision(gate).then(
        (outcome) => bb.log.info(`Autobahn gate decision: ${outcome}`),
        (error) =>
          bb.log.warn(
            `Autobahn gate decision failed for ${gate.threadId}: ${String(error)}`,
          ),
      );
    }
  }

  async function runHiddenWorker(input: {
    projectId: string;
    parentThreadId: string;
    role: string;
    title: string;
    prompt: string;
  }): Promise<string> {
    const worker = await bb.sdk.threads.spawn({
      projectId: input.projectId,
      parentThreadId: input.parentThreadId,
      environment: { type: "project-default" },
      prompt: input.prompt,
      title: input.title,
      visibility: "hidden",
    });
    isolatedChildThreadIds.add(worker.id);
    workflowStore.appendEvent({
      threadId: input.parentThreadId,
      type: "child.spawned",
      payload: {
        childThreadId: worker.id,
        role: input.role,
        title: input.title,
      },
    });
    try {
      await bb.sdk.threads.wait({ threadId: worker.id, status: "idle" });
      const { output } = await bb.sdk.threads.output({ threadId: worker.id });
      if (!output?.trim()) {
        throw new Error(`Hidden worker ${worker.id} returned no output.`);
      }
      return output;
    } finally {
      await bb.sdk.threads.archive({ threadId: worker.id }).catch(() => undefined);
      await bb.sdk.threads.stop({ threadId: worker.id });
    }
  }

  async function runWitnessProbe(input: {
    projectId: string;
    threadId: string;
    findings: string[];
  }): Promise<string | null> {
    try {
      return await runHiddenWorker({
        projectId: input.projectId,
        parentThreadId: input.threadId,
        role: "witness",
        title: WITNESS_PROBE_TITLE,
        prompt: [
          "You are a fresh-context, read-only Autobahn witness probe. Independently confirm the findings below and recommend the single next Driver action. Do not edit files, stop sessions, or bypass human gates.",
          `Card thread ID: ${input.threadId}`,
          `Findings:\n${input.findings.map((finding) => `- ${finding}`).join("\n")}`,
        ].join("\n\n"),
      });
    } catch (error) {
      bb.log.warn(`Autobahn witness probe failed: ${String(error)}`);
      return null;
    }
  }

  async function runThreadWitness(threadId: string) {
    if (threadId === driverThreadIdCache) return;
    let thread: Awaited<ReturnType<typeof bb.sdk.threads.get>>;
    try {
      thread = await bb.sdk.threads.get({ threadId });
    } catch {
      return;
    }
    if (thread.archivedAt || thread.deletedAt) return;
    const report = await witnessReport(thread.projectId);
    raiseGateDecisions(
      report.gateReady.filter((gate) => gate.threadId === threadId),
    );
    const findings = report.findings.filter((finding) =>
      finding.startsWith(`${threadId}: `),
    );
    const fingerprintKey = `${WITNESS_FINGERPRINT_KEY}:${threadId}`;
    const fingerprint = JSON.stringify(findings);
    const previous =
      (await bb.storage.kv.get<string>(fingerprintKey)) ?? "";
    if (fingerprint === previous) return;
    await bb.storage.kv.set(fingerprintKey, fingerprint);
    if (!findings.length) return;
    bb.log.warn(`Autobahn witness: ${findings.join(" | ")}`);
    if (!driverThreadIdCache) return;
    const recommendation = await runWitnessProbe({
      projectId: thread.projectId,
      threadId,
      findings,
    });
    await notifyDriver(
      [
        `Autobahn witness found:\n${findings.join("\n")}`,
        recommendation
          ? `Witness probe recommendation:\n${recommendation}`
          : "Recommend action; do not stop work automatically.",
      ].join("\n"),
    );
  }

  async function clearStatusOverride(threadId: string, reason: string) {
    workflowStore.upsert(threadId, {
      statusOverride: null,
      statusOverrideReason: null,
      statusOverrideAt: null,
    });
    workflowStore.appendEvent({
      threadId,
      type: "status.override-cleared",
      payload: { reason },
    });
    githubSnapshotCache = null;
    await syncExternalStatuses();
    bb.realtime.publish("board-changed", {
      threadId,
      event: "status.override-cleared",
    });
  }

  async function clearClosedCards(projectId?: string | null) {
    const sections = await ensureSections();
    const threads = await listThreads(projectId);
    const closedIds = threads
      .filter((thread) => thread.sectionId === sections.CLOSED)
      .map((thread) => thread.id);
    const dismissals = await readClosedDismissals();
    for (const threadId of closedIds) dismissals.add(threadId);
    await bb.storage.kv.set(CLOSED_DISMISSALS_KEY, [...dismissals]);
    bb.realtime.publish("board-changed", {
      event: "closed.cleared",
      count: closedIds.length,
    });
    return closedIds.length;
  }

  async function snoozeRoadmapItem(itemKey: string, wakeAt: number) {
    const now = Date.now();
    if (wakeAt <= now || wakeAt > now + MAX_SNOOZE_MS) {
      throw new Error("Roadmap snooze must end in the future within 366 days.");
    }
    const snapshot = await loadGithubSnapshot(true);
    const item = snapshot.items.find(
      (candidate) =>
        candidate.kind === "issue" &&
        githubItemKey(candidate) === itemKey &&
        candidate.state.toLowerCase() === "open" &&
        !(snapshot.links[itemKey]?.length),
    );
    if (!item) {
      throw new Error("Only an open, unstarted roadmap issue can be snoozed.");
    }
    await legacySnoozeImport;
    roadmapSnoozeStore.snooze({
      itemKey,
      snoozedUntil: wakeAt,
      snoozedAt: now,
    });
    bb.realtime.publish("board-changed", {
      itemKey,
      wakeAt,
      event: "roadmap.snoozed",
    });
  }

  async function wakeRoadmapItem(itemKey: string) {
    await legacySnoozeImport;
    roadmapSnoozeStore.wake(itemKey);
    bb.realtime.publish("board-changed", {
      itemKey,
      event: "roadmap.woken",
    });
  }

  bb.rpc.register(rpcContract, {
    listBoard: ({ projectId }) => listBoard(projectId),
    moveThread: ({ threadId, status }) =>
      moveThread(threadId, status, {
        source: "user",
        reason: "User moved the card",
        setOverride: true,
        bypassWorkflowGuards: true,
      }),
    getDriver: async () => ({
      threadId: await ensureDriver(),
    }),
    clearStatusOverride: async ({ threadId }) => {
      await clearStatusOverride(threadId, "User restored automatic status");
      return { ok: true as const };
    },
    snoozeRoadmapItem: async ({ itemKey, wakeAt }) => {
      await snoozeRoadmapItem(itemKey, wakeAt);
      return { ok: true as const };
    },
    wakeRoadmapItem: async ({ itemKey }) => {
      await wakeRoadmapItem(itemKey);
      return { ok: true as const };
    },
    clearClosedCards: async ({ projectId }) => ({
      cleared: await clearClosedCards(projectId),
    }),
  });

  bb.agents.registerTool({
    name: "autobahn_move_thread",
    description:
      "Move the current bb thread's Autobahn card to OPEN, WIP, R4R, or CLOSED.",
    instructions:
      "Keep the current thread's board status accurate. OPEN is the roadmap, WIP is active execution, R4R is verified review, and CLOSED follows external completion unless manually overridden.",
    experimental_statusLabels: {
      pending: "Moving Autobahn card",
      completed: "Moved Autobahn card",
    },
    parameters: z.object({ status: boardStatusSchema }).strict(),
    execute: async ({ status }, { threadId }) => {
      await moveThread(threadId, status);
      return `Moved this thread to ${status}.`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_list_cards",
    description:
      "List active Autobahn cards with their thread IDs, projects, and statuses.",
    experimental_statusLabels: {
      pending: "Reading Autobahn board",
      completed: "Read Autobahn board",
    },
    parameters: z
      .object({ projectId: z.string().min(1).optional() })
      .strict(),
    execute: async ({ projectId }) => {
      const board = await listBoard(projectId);
      const cards = board.lanes.flatMap((lane) =>
        lane.cards.map(
          (card) =>
            `[${lane.status}] ${card.title} | thread=${card.id} | project=${card.projectName} (${card.projectId}) | phase=${card.workflow.phase} | gate=${card.workflow.gate} | next=${card.workflow.nextAction ?? "unset"}${card.workflow.parkedWake ? ` | parked=${card.workflow.parkedWake.kind}` : ""}`,
        ),
      );
      return cards.length ? cards.join("\n") : "No active Autobahn cards.";
    },
  });

  bb.agents.registerTool({
    name: "autobahn_capture_work",
    description:
      "Capture newly discovered durable work in the configured issue tracker without starting an agent session.",
    instructions:
      "Use this for net-new requirements found during brainstorming or closeout. Do not create a coding session merely to remember future work.",
    experimental_statusLabels: {
      pending: "Capturing discovered work",
      completed: "Captured discovered work",
    },
    parameters: z
      .object({
        projectId: z.string().min(1).optional(),
        title: z.string().min(1).max(160),
        description: z.string().min(1).max(10_000),
        acceptanceCriteria: z
          .array(z.string().min(1).max(500))
          .max(20)
          .default([]),
        labels: z.array(z.string().min(1).max(80)).max(10).default([]),
      })
      .strict(),
    execute: async ({ projectId, ...input }, { threadId, signal }) => {
      const sourceThread = await bb.sdk.threads.get({ threadId });
      const isDriver = threadId === driverThreadIdCache;
      if (projectId && projectId !== sourceThread.projectId && !isDriver) {
        throw new Error(
          "Controller agents may capture work only in their current project.",
        );
      }
      const targetProjectId = projectId ?? sourceThread.projectId;
      const interaction = await bb.ui.requestInput(
        {
          threadId,
          rendererId: "work-capture-approval",
          title: "Capture tracker work",
          payload: {
            projectId: targetProjectId,
            title: input.title,
            description: input.description,
            acceptanceCriteria: input.acceptanceCriteria,
            labels: input.labels,
          },
          timeoutMs: 30 * 60 * 1_000,
        },
        { signal },
      );
      if (interaction.outcome === "cancelled") {
        return "Work capture cancelled; no tracker item was created.";
      }
      const decision = z
        .object({ approved: z.boolean() })
        .strict()
        .parse(interaction.value);
      if (!decision.approved) {
        return "Work capture declined; no tracker item was created.";
      }
      const result = await captureWorkItem(input, {
        id: sourceThread.id,
        projectId: targetProjectId,
        title:
          sourceThread.title ?? sourceThread.titleFallback ?? sourceThread.id,
      });
      const action = result.created ? "Created" : "Reused existing";
      return [
        `${action} ${result.tracker} work item ${result.externalId}: ${result.url}.`,
        "It remains in the roadmap; no agent session was started.",
        result.warning,
      ]
        .filter(Boolean)
        .join(" ");
    },
  });

  bb.agents.registerTool({
    name: "autobahn_create_session",
    description:
      "Create and assign a new visible coding session in a project and place its card on the board.",
    experimental_statusLabels: {
      pending: "Creating coding session",
      completed: "Created coding session",
    },
    parameters: z
      .object({
        projectId: z.string().min(1),
        title: z.string().min(1).max(160),
        prompt: z.string().min(1),
      })
      .strict(),
    execute: async ({ projectId, title, prompt }) => {
      const thread = await createSession({
        projectId,
        title,
        prompt,
        status: "OPEN",
      });
      return `Created "${title}" as OPEN thread ${thread.id}; run planning before dispatch.`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_assign_session",
    description:
      "Assign more work to an existing thread by sending or steering a prompt to it.",
    experimental_statusLabels: {
      pending: "Assigning coding session",
      completed: "Assigned coding session",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        prompt: z.string().min(1),
      })
      .strict(),
    execute: async ({ threadId, prompt }, { threadId: senderThreadId }) => {
      const state = workflowStore.get(threadId);
      const sections = await ensureSections();
      const thread = await bb.sdk.threads.get({ threadId });
      if (
        thread.sectionId !== sections.WIP ||
        !state?.planContract ||
        state.gate !== "none" ||
        state.parkedWake !== null ||
        !dependenciesComplete(state)
      ) {
        throw new Error(
          "Assignment requires a planned, approved, unparked WIP card with satisfied dependencies.",
        );
      }
      await bb.sdk.threads.send({
        threadId,
        input: [{ type: "text", text: prompt, mentions: [] }],
        mode: "auto",
        senderThreadId,
      });
      workflowStore.upsert(threadId, {
        phase: "build",
        nextAction: "Complete the assignment and report a typed exit",
      });
      return `Assigned work to thread ${threadId}.`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_move_card",
    description:
      "Set a Driver status override on any card. Automation pauses until the override is cleared.",
    experimental_statusLabels: {
      pending: "Overriding Autobahn status",
      completed: "Overrode Autobahn status",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        status: boardStatusSchema,
        reason: z.string().min(1),
      })
      .strict(),
    execute: async ({ threadId, status, reason }) => {
      await moveThread(threadId, status, {
        source: "driver",
        reason,
        setOverride: true,
        bypassWorkflowGuards: true,
      });
      return `Overrode thread ${threadId} to ${status}: ${reason}`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_clear_status_override",
    description:
      "Clear a manual card status override and immediately resume issue/PR automation.",
    experimental_statusLabels: {
      pending: "Restoring automatic status",
      completed: "Restored automatic status",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        reason: z.string().min(1),
      })
      .strict(),
    execute: async ({ threadId, reason }) => {
      await clearStatusOverride(threadId, reason);
      return `Automatic external status restored for ${threadId}.`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_start_roadmap_item",
    description:
      "Create a stopped OPEN controller thread from a tracked GitHub issue.",
    experimental_statusLabels: {
      pending: "Starting roadmap item",
      completed: "Started roadmap item",
    },
    parameters: z
      .object({
        repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        number: z.number().int().positive(),
      })
      .strict(),
    execute: async ({ repo, number }) => {
      const snapshot = await loadGithubSnapshot(true);
      const issue = snapshot.items.find(
        (item) =>
          item.kind === "issue" &&
          item.repo === repo &&
          item.number === number,
      );
      if (!issue) {
        throw new Error(`GitHub issue ${repo}#${number} is not cached.`);
      }
      if (issue.state.toLowerCase() !== "open") {
        throw new Error(`GitHub issue ${repo}#${number} is not open.`);
      }
      const started = await githubRpc(
        "startWork",
        { repo, number },
        githubStartWorkOutputSchema,
      );
      await bb.sdk.threads.stop({ threadId: started.threadId });
      await moveThread(started.threadId, "OPEN", {
        source: "automation",
        reason: `Roadmap issue ${repo}#${number} added`,
        bypassWorkflowGuards: true,
      });
      workflowStore.upsert(started.threadId, {
        phase: "intake",
        priority: issuePriority(issue.labels),
        nextAction: "Run the plan workflow",
      });
      workflowStore.appendEvent({
        threadId: started.threadId,
        type: "roadmap.started",
        payload: {
          repo,
          number,
          url: issue.url,
        },
      });
      githubSnapshotCache = null;
      return `Created OPEN controller ${started.threadId} for ${repo}#${number}.`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_control_session",
    description:
      "Stop, archive, or unarchive a coding session. Archiving is reversible.",
    experimental_statusLabels: {
      pending: "Managing coding session",
      completed: "Managed coding session",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        action: z.enum(["stop", "archive", "unarchive"]),
      })
      .strict(),
    execute: async ({ threadId, action }) => {
      if (action === "stop") {
        await bb.sdk.threads.stop({ threadId });
      } else if (action === "archive") {
        await bb.sdk.threads.stop({ threadId });
        await bb.sdk.threads.archive({ threadId });
      } else {
        await bb.sdk.threads.unarchive({ threadId });
      }
      bb.realtime.publish("board-changed", { threadId, action });
      return `${action} completed for thread ${threadId}.`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_report_exit",
    description:
      "Report a typed station exit with evidence and the single next action.",
    instructions:
      "Call this at the end of every plan, build, verify, or egress pass. A successful build does not close the card; it advances to verification.",
    experimental_statusLabels: {
      pending: "Recording station exit",
      completed: "Recorded station exit",
    },
    parameters: z
      .object({
        phase: workflowPhaseSchema,
        status: exitStatusSchema,
        summary: z.string().min(1),
        nextAction: z.string().min(1),
        concerns: z.array(z.string()).default([]),
        evidence: z.array(workflowEvidenceSchema).default([]),
      })
      .strict(),
    execute: async (
      { phase, status, summary, nextAction, concerns, evidence },
      { threadId },
    ) => {
      if (
        phase === "build" &&
        (status === "DONE" || status === "DONE_WITH_CONCERNS")
      ) {
        const state = workflowStore.get(threadId);
        const sections = await ensureSections();
        const thread = await bb.sdk.threads.get({ threadId });
        if (
          thread.sectionId !== sections.WIP ||
          !state?.planContract ||
          state.gate !== "none" ||
          state.parkedWake !== null
        ) {
          throw new Error(
            "A successful build exit requires a planned, approved, unparked card currently in WIP.",
          );
        }
      }
      if (
        (phase === "verify" || phase === "egress") &&
        (status === "DONE" || status === "DONE_WITH_CONCERNS") &&
        evidence.length === 0
      ) {
        throw new Error(
          "A successful verification or egress exit requires at least one evidence item.",
        );
      }
      if (phase === "egress" && status === "DONE") {
        const current = workflowStore.get(threadId);
        const sections = await ensureSections();
        const thread = await bb.sdk.threads.get({ threadId });
        const verified = workflowStore
          .listEvents(threadId)
          .some((event) => event.type === "verification.completed");
        if (
          current?.phase !== "egress" ||
          thread.sectionId !== sections.R4R ||
          !verified
        ) {
          throw new Error(
            "Closing requires a verified card currently in R4R.",
          );
        }
      }
      const gate =
        status === "BLOCKED"
          ? "blocked"
          : status === "NEEDS_CONTEXT"
            ? "needs-input"
            : "none";
      workflowStore.reportExit({
        threadId,
        phase,
        status,
        summary,
        nextAction,
        concerns,
        evidence,
        gate,
      });
      if (
        phase === "build" &&
        (status === "DONE" || status === "DONE_WITH_CONCERNS")
      ) {
        workflowStore.upsert(threadId, {
          phase: "verify",
          nextAction: "Run the fresh-context verification panel",
        });
      } else if (phase === "egress" && status === "DONE") {
        await moveThread(threadId, "CLOSED");
      }
      bb.realtime.publish("board-changed", {
        threadId,
        event: "station.exited",
      });
      return `${phase} exited ${status}. Next: ${nextAction}`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_set_contract",
    description:
      "Set a card's risk, priority, dependencies, and evidence-checkable plan contract.",
    experimental_statusLabels: {
      pending: "Setting card contract",
      completed: "Set card contract",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        riskClass: riskClassSchema,
        priority: z.number().int().min(0).max(3),
        blockedBy: z.array(z.string()).default([]),
        requiresHumanApproval: z.boolean().default(false),
        contract: planContractSchema,
      })
      .strict(),
    execute: async ({
      threadId,
      riskClass,
      priority,
      blockedBy,
      requiresHumanApproval,
      contract,
    }) => {
      const humanGate =
        requiresHumanApproval ||
        riskClass === "high" ||
        riskClass === "critical";
      workflowStore.upsert(threadId, {
        phase: "plan",
        riskClass,
        priority,
        blockedBy,
        planContract: contract,
        gate: humanGate ? "plan-approval" : "none",
        nextAction: humanGate
          ? "Approve the plan before dispatch"
          : "Dispatch the ready card",
      });
      bb.realtime.publish("board-changed", {
        threadId,
        event: "contract.updated",
      });
      return humanGate
        ? `Contract saved for ${threadId}; human plan approval is required.`
        : `Contract saved for ${threadId}; ready for dispatch.`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_run_plan",
    description:
      "Run a read-only planner child followed by a fresh adversarial reviewer, with at most two revision rounds.",
    experimental_statusLabels: {
      pending: "Planning and reviewing",
      completed: "Planned and reviewed",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        objective: z.string().min(1),
        context: z.string().optional(),
      })
      .strict(),
    execute: async ({ threadId, objective, context }, { signal }) => {
      const { result, gate, nextAction } = await runPlanForCard(
        threadId,
        objective,
        context,
        signal,
      );
      return `Plan ${result.outcome} after ${result.attempts} attempt(s). Gate: ${gate}. Next: ${nextAction}`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_approve_plan",
    description:
      "Open a blocking bb interaction so the human can approve or reject a card's plan.",
    experimental_statusLabels: {
      pending: "Requesting plan decision",
      completed: "Recorded plan decision",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        recommendation: z.string().min(1),
      })
      .strict(),
    execute: async (
      { threadId, recommendation },
      { threadId: driverThreadId, signal },
    ) => {
      const state = workflowStore.get(threadId);
      if (!state?.planContract) {
        throw new Error("The card has no plan contract to approve.");
      }
      const interaction = await bb.ui.requestInput(
        {
          threadId: driverThreadId,
          rendererId: "plan-approval",
          title: "Autobahn plan approval",
          payload: {
            cardThreadId: threadId,
            objective: state.planContract.objective,
            recommendation,
          },
          timeoutMs: 30 * 60 * 1_000,
        },
        { signal },
      );
      if (interaction.outcome === "cancelled") {
        return `Plan decision cancelled for ${threadId}.`;
      }
      const decision = z
        .object({
          approved: z.boolean(),
          note: z.string(),
        })
        .strict()
        .parse(interaction.value);
      workflowStore.upsert(threadId, {
        gate: decision.approved ? "none" : "needs-input",
        exitStatus: decision.approved ? "DONE" : "BLOCKED",
        nextAction: decision.approved
          ? "Dispatch the ready card"
          : "Revise the plan from the human feedback",
        concerns: decision.approved
          ? state.concerns
          : [...state.concerns, decision.note || "Plan revision requested"],
      });
      workflowStore.appendEvent({
        threadId,
        type: decision.approved ? "plan.approved" : "plan.rejected",
        payload: { note: decision.note },
      });
      bb.realtime.publish("board-changed", {
        threadId,
        event: "plan.decision",
      });
      return decision.approved
        ? `Plan approved for ${threadId}.`
        : `Plan revision requested for ${threadId}.`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_gate_decision",
    description:
      "Open the blocking human egress gate form (approve, send back with gaps, or snooze) for a verified card.",
    instructions:
      "Raise this when a verified R4R card is ready to close, for example after its pull request merged with verification evidence attached. Never decide the gate yourself; the human response is applied directly.",
    experimental_statusLabels: {
      pending: "Requesting gate decision",
      completed: "Recorded gate decision",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        reason: z.string().min(1),
      })
      .strict(),
    execute: async ({ threadId, reason }, { signal }) =>
      await requestGateDecision({ threadId, reason }, { signal }),
  });

  bb.agents.registerTool({
    name: "autobahn_run_verification",
    description:
      "Run parallel fresh-context verification lenses and a fresh validator for every proposed finding.",
    experimental_statusLabels: {
      pending: "Running verification panel",
      completed: "Ran verification panel",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        objective: z.string().min(1),
        lenses: z
          .array(
            z
              .object({
                id: z.string().min(1),
                title: z.string().min(1),
                instructions: z.string().min(1),
              })
              .strict(),
          )
          .min(1)
          .max(1)
          .optional(),
      })
      .strict(),
    execute: async ({ threadId, objective, lenses }, { signal }) => {
      const result = await runVerificationForCard(
        threadId,
        objective,
        lenses ?? [],
        signal,
      );
      return `Verification ${result.status}: ${result.result.counts.confirmed} confirmed, ${result.result.counts.rejected} rejected, ${result.result.counts.inconclusive} inconclusive. Next: ${result.nextAction}`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_dispatch_ready",
    description:
      "Deterministically fill available WIP slots with planned, approved, unblocked, unparked OPEN cards.",
    experimental_statusLabels: {
      pending: "Dispatching ready cards",
      completed: "Dispatched ready cards",
    },
    parameters: z
      .object({
        projectId: z.string().min(1),
        maximum: z.number().int().positive().max(20).optional(),
      })
      .strict(),
    execute: async ({ projectId, maximum }, { threadId: senderThreadId }) => {
      if (dispatching) {
        throw new Error("Another deterministic dispatch is already running.");
      }
      dispatching = true;
      try {
      const board = await listBoard(projectId);
      const wip = board.lanes.find((lane) => lane.status === "WIP")!;
      const todo = board.lanes.find((lane) => lane.status === "OPEN")!;
      const slots = Math.max(
        0,
        Math.min(
          maximum ?? Number.MAX_SAFE_INTEGER,
          (wip.softLimit ?? Number.MAX_SAFE_INTEGER) - wip.capacityCount,
        ),
      );
      const ready = todo.cards
        .filter(
          (card) =>
            card.workflow.planContract !== null &&
            card.workflow.gate === "none" &&
            card.workflow.parkedWake === null &&
            card.workflow.blockedBy.every(
              (dependencyId) =>
                workflowStore.get(dependencyId)?.phase === "complete",
            ),
        )
        .sort(
          (left, right) =>
            left.workflow.priority - right.workflow.priority ||
            left.updatedAt - right.updatedAt,
        )
        .slice(0, slots);
      for (const card of ready) {
        await moveThread(card.id, "WIP");
        try {
          await bb.sdk.threads.send({
            threadId: card.id,
            input: [
              {
                type: "text",
                text: [
                  "Begin or resume implementation under the stored plan contract.",
                  card.workflow.nextAction
                    ? `Current next action: ${card.workflow.nextAction}`
                    : "",
                  "Finish this pass with autobahn_report_exit. A successful build advances to verification, not directly to CLOSED.",
                ]
                  .filter(Boolean)
                  .join("\n"),
                mentions: [],
              },
            ],
            mode: "auto",
            senderThreadId,
          });
          workflowStore.upsert(card.id, {
            phase: "build",
            nextAction: "Complete implementation and report a typed exit",
          });
        } catch (error) {
          await bb.sdk.threads.stop({ threadId: card.id }).catch(() => undefined);
          await moveThread(card.id, "OPEN").catch(() => undefined);
          workflowStore.upsert(card.id, {
            phase: "plan",
            gate: "blocked",
            exitStatus: "BLOCKED",
            nextAction: "Retry dispatch after resolving the send failure",
            concerns: [
              ...card.workflow.concerns,
              `Dispatch failed: ${String(error)}`,
            ],
          });
          workflowStore.appendEvent({
            threadId: card.id,
            type: "dispatch.failed",
            payload: { error: String(error) },
          });
          throw error;
        }
      }
      return ready.length
        ? `Dispatched ${ready.length}: ${ready.map((card) => card.id).join(", ")}.`
        : `Dispatched 0. Available WIP slots: ${slots}; no planned and approved card was ready.`;
      } finally {
        dispatching = false;
      }
    },
  });

  bb.agents.registerTool({
    name: "autobahn_park_card",
    description:
      "Park a card without consuming WIP until a timer, dependency, interaction, PR merge, or check completion.",
    experimental_statusLabels: {
      pending: "Parking card",
      completed: "Parked card",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        kind: z.enum([
          "timer",
          "dependency",
          "interaction",
          "pr-merged",
          "checks-finished",
        ]),
        ref: z.string().optional(),
        untilEpochMs: z.number().int().nonnegative().optional(),
        nextAction: z.string().min(1),
      })
      .strict(),
    execute: async ({ threadId, kind, ref, untilEpochMs, nextAction }) => {
      if (kind === "timer" && untilEpochMs === undefined) {
        throw new Error("Timer parking requires untilEpochMs.");
      }
      if (kind === "dependency" && !ref) {
        throw new Error("Dependency parking requires a dependency thread ref.");
      }
      workflowStore.park({
        threadId,
        wake: {
          kind,
          ref: ref ?? null,
          until: untilEpochMs ?? null,
        },
        nextAction,
      });
      if (kind === "dependency" && ref) {
        const state = workflowStore.get(threadId)!;
        workflowStore.upsert(threadId, {
          blockedBy: [...new Set([...state.blockedBy, ref])],
        });
      }
      await moveThread(threadId, "OPEN", {
        source: "automation",
        reason: `Parked until ${kind} is satisfied`,
        bypassWorkflowGuards: true,
        preserveWorkflowPosition: true,
      });
      await bb.sdk.threads.stop({ threadId });
      return `Parked ${threadId} in OPEN until ${kind} is satisfied. Next: ${nextAction}`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_wake_card",
    description: "Manually wake a parked card and make it dispatchable.",
    experimental_statusLabels: {
      pending: "Waking card",
      completed: "Woke card",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        reason: z.string().min(1),
        nextAction: z.string().min(1).default("Ready for Driver dispatch"),
      })
      .strict(),
    execute: async ({ threadId, reason, nextAction }) => {
      workflowStore.wake({ threadId, reason, nextAction });
      bb.realtime.publish("board-changed", { threadId, event: "card.woken" });
      return `Woke ${threadId}. Next: ${nextAction}`;
    },
  });

  bb.agents.registerTool({
    name: "autobahn_witness",
    description:
      "Read-only witness scan for stale, inconsistent, over-limit, or incorrectly parked cards. It never kills work.",
    experimental_statusLabels: {
      pending: "Scanning Autobahn health",
      completed: "Scanned Autobahn health",
    },
    parameters: z
      .object({ projectId: z.string().min(1).optional() })
      .strict(),
    execute: async ({ projectId }) => {
      const findings = await witnessFindings(projectId);
      return findings.length
        ? `Witness findings:\n${findings.join("\n")}\nNext: address the highest-risk finding.`
        : "Witness found no workflow inconsistency. Next: nothing; the queue is healthy.";
    },
  });

  const driverTools = [
    "autobahn_list_cards",
    "autobahn_capture_work",
    "autobahn_create_session",
    "autobahn_assign_session",
    "autobahn_move_card",
    "autobahn_clear_status_override",
    "autobahn_start_roadmap_item",
    "autobahn_control_session",
    "autobahn_set_contract",
    "autobahn_run_plan",
    "autobahn_approve_plan",
    "autobahn_gate_decision",
    "autobahn_run_verification",
    "autobahn_dispatch_ready",
    "autobahn_park_card",
    "autobahn_wake_card",
    "autobahn_witness",
  ];

  bb.agents.configure((context) => {
    const hasChildTitle = [
      "Autobahn planner",
      "Autobahn adversarial plan review",
      "Autobahn verification:",
      "Autobahn validate:",
      WITNESS_PROBE_TITLE,
    ].some((prefix) => context.thread.title?.startsWith(prefix));
    const isPluginChild =
      context.origin.pluginId === bb.pluginId &&
      (isolatedChildThreadIds.has(context.thread.id) ||
        (context.thread.parentThreadId !== null && hasChildTitle));
    if (isPluginChild) {
      return {
        tools: [],
        skills: [],
        instructions:
          "This is a read-only fresh-context station. Inspect and return only the requested structured result. Do not edit files or mutate Autobahn state.",
      };
    }
    const isDriver =
      context.thread.id === driverThreadIdCache &&
      context.origin.pluginId === bb.pluginId;
    return isDriver
      ? {
          tools: driverTools,
          skills: ["autobahn-driver"],
          instructions:
            `You are the Autobahn Driver, running an opinionated, automated Kanban flywheel. Keep work flowing: inventory before acting; use fresh child sessions for planning and verification. ${DRIVER_OPERATING_RULE} Apply the guardrails (gates, dependencies, parking, soft WIP); require typed exits and one Next action; never bypass human approval or auto-kill work.`,
        }
      : {
          tools: [
            "autobahn_move_thread",
            "autobahn_report_exit",
            "autobahn_capture_work",
          ],
          skills: [],
          instructions:
            "Keep this controller card current and end every station pass with autobahn_report_exit, evidence, and one Next action. Capture newly discovered durable work with autobahn_capture_work instead of starting speculative sessions. Build success advances to verification; only verified work reaches R4R; CLOSED requires a clean final exit.",
        };
  });

  for (const event of [
    "thread.created",
    "thread.active",
    "thread.idle",
    "thread.failed",
    "thread.archived",
    "thread.deleted",
  ] as const) {
    bb.events.on(event, ({ thread }) => {
      bb.realtime.publish("board-changed", { threadId: thread.id });
    });
  }

  bb.events.on("thread.idle", async ({ thread }) => {
    const driverThreadId =
      await bb.storage.kv.get<string>(DRIVER_THREAD_KEY);
    if (thread.id === driverThreadId) {
      await bb.sdk.threads.stop({ threadId: thread.id }).catch((error) => {
        bb.log.warn(
          `Could not release Driver thread ${thread.id}: ${String(error)}`,
        );
      });
    }
  });

  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      const driverThreadId =
        await bb.storage.kv.get<string>(DRIVER_THREAD_KEY);
      if (thread.id === driverThreadId) {
        await bb.storage.kv.delete(DRIVER_THREAD_KEY);
        driverThreadIdCache = null;
      }
    });
  }

  // Event-driven updates; the cron schedules below stay as low-frequency
  // backstops for missed events and external (GitHub) state.
  for (const event of ["thread.idle", "thread.failed"] as const) {
    bb.events.on(event, async ({ thread }) => {
      await runThreadWitness(thread.id);
    });
  }

  bb.events.on("thread.archived", async ({ thread }) => {
    const sections = await ensureSections();
    let archived: Awaited<ReturnType<typeof bb.sdk.threads.get>>;
    try {
      archived = await bb.sdk.threads.get({ threadId: thread.id });
    } catch {
      return;
    }
    if (!archived.archivedAt || archived.sectionId !== sections.CLOSED) return;
    const dismissals = await readClosedDismissals();
    if (dismissals.has(archived.id)) return;
    dismissals.add(archived.id);
    await bb.storage.kv.set(CLOSED_DISMISSALS_KEY, [...dismissals]);
    bb.realtime.publish("board-changed", {
      threadId: archived.id,
      event: "closed.auto-cleared",
    });
  });

  bb.background.schedule("wake-cards", "* * * * *", async () => {
    await wakeReadyCards();
  });

  bb.background.schedule("external-status-sync", "*/5 * * * *", async () => {
    githubSnapshotCache = null;
    await syncExternalStatuses();
  });

  bb.background.schedule("witness-scan", "*/15 * * * *", async () => {
    const { findings, gateReady } = await witnessReport();
    raiseGateDecisions(gateReady);
    const fingerprint = JSON.stringify(findings);
    const previous =
      (await bb.storage.kv.get<string>(WITNESS_FINGERPRINT_KEY)) ?? "";
    if (fingerprint === previous) return;
    await bb.storage.kv.set(WITNESS_FINGERPRINT_KEY, fingerprint);
    if (findings.length) {
      bb.log.warn(`Autobahn witness: ${findings.join(" | ")}`);
      await notifyDriver(
        `Autobahn witness found:\n${findings.join("\n")}\nRecommend action; do not stop work automatically.`,
      );
    }
  });

  bb.log.info("Autobahn board loaded");
}
