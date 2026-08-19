import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  EXIT_STATUSES,
  RISK_CLASSES,
  WORKFLOW_GATES,
  WORKFLOW_PHASES,
  WORKFLOW_STATE_MIGRATIONS,
  createWorkflowStateStore,
  type CardWorkflowState,
  type PlanContract,
  type WorkflowEvidence,
} from "./workflow-state";
import {
  runPlanWorkflow,
  runVerificationWorkflow,
  type ChildSessionAdapter,
  type VerificationLens,
} from "./orchestration";

export const BOARD_STATUSES = ["TODO", "WIP", "R4R", "DONE"] as const;

const CHIEF_TITLE = "Autobahn Chief of Staff";
const CHIEF_THREAD_KEY = "chief-of-staff-thread-id";
const WITNESS_FINGERPRINT_KEY = "witness-last-fingerprint";
const CHIEF_PROMPT =
  "You are the policy-driven Chief of Staff for this Autobahn board board. Briefly introduce yourself and offer to inventory work, establish plan contracts and gates, dispatch within WIP, run fresh-context planning and verification, park or wake work, and surface witness findings. Inspect the board before making claims. Never bypass a human gate, stop, or archive a session unless the user asks.";

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
  needsYouCount: number;
};

export const rpcContract = defineRpcContract({
  listBoard: {
    input: z.object({ projectId: z.string().nullable().optional() }).strict(),
    output: z.object({
      lanes: z.array(laneSchema),
      needsYouCount: z.number().int().nonnegative(),
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
  getChiefOfStaff: {
    input: z.null(),
    output: z.object({ threadId: z.string() }),
  },
});

type BoardStatus = (typeof BOARD_STATUSES)[number];
type SectionIds = Record<BoardStatus, string>;
type ExternalLink = z.infer<typeof externalLinkSchema>;

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
        permissionMode: "auto",
      });
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
  let chiefCreation: Promise<string> | null = null;
  let chiefThreadIdCache: string | null = null;
  void bb.storage.kv
    .get<string>(CHIEF_THREAD_KEY)
    .then((threadId) => {
      chiefThreadIdCache = threadId ?? null;
    })
    .catch(() => undefined);
  let dispatching = false;

  async function ensureChiefOfStaff(): Promise<string> {
    if (chiefCreation) return chiefCreation;
    chiefCreation = (async () => {
      const storedThreadId =
        await bb.storage.kv.get<string>(CHIEF_THREAD_KEY);
      if (storedThreadId) {
        try {
          const storedThread = await bb.sdk.threads.get({
            threadId: storedThreadId,
          });
          if (!storedThread.archivedAt && !storedThread.deletedAt) {
            chiefThreadIdCache = storedThread.id;
            return storedThread.id;
          }
        } catch {
          await bb.storage.kv.delete(CHIEF_THREAD_KEY);
        }
      }

      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const project =
        projects.find((candidate) => candidate.kind === "personal") ??
        projects[0];
      if (!project) {
        throw new Error("Create a bb project before opening the Chief of Staff.");
      }

      const thread = await bb.sdk.threads.spawn({
        projectId: project.id,
        environment: { type: "project-default" },
        prompt: CHIEF_PROMPT,
        title: CHIEF_TITLE,
        visibility: "hidden",
      });
      await bb.storage.kv.set(CHIEF_THREAD_KEY, thread.id);
      chiefThreadIdCache = thread.id;
      return thread.id;
    })();

    try {
      return await chiefCreation;
    } finally {
      chiefCreation = null;
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
      status === "DONE" &&
      (!state ||
        state.phase !== "egress" ||
        state.exitStatus !== "DONE" ||
        state.evidence.length === 0 ||
        state.gate !== "none" ||
        state.parkedWake !== null)
    ) {
      throw new Error(
        "DONE requires a clean egress DONE exit with evidence and no open gate or parking condition.",
      );
    }
    if (status === "DONE") {
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
            throw new Error("DONE requires the linked pull request to be merged or closed.");
          }
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("DONE requires")) {
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

  async function moveThread(threadId: string, status: BoardStatus) {
    const sections = await ensureSections();
    const warning = await moveWarning(threadId, status, sections);
    await bb.sdk.threads.update({ threadId, sectionId: sections[status] });
    const current = workflowStore.get(threadId);
    const phase =
      status === "WIP"
        ? "build"
        : status === "R4R"
          ? "egress"
          : status === "DONE"
            ? "complete"
            : current?.phase ?? "intake";
    workflowStore.upsert(threadId, {
      phase,
      ...(status === "DONE" ? { completedAt: Date.now() } : {}),
    });
    workflowStore.appendEvent({
      threadId,
      type: "card.moved",
      payload: { status, warning },
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
            : status === "DONE"
              ? "complete"
              : "intake",
      nextAction:
        status === "TODO"
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
    const [sections, projects, threads, configured] = await Promise.all([
      ensureSections(),
      bb.sdk.projects.list({ includePersonal: true }),
      listThreads(projectId),
      settings.get(),
    ]);
    const projectNames = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const sectionStatuses = new Map(
      BOARD_STATUSES.map((status) => [sections[status], status]),
    );
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
                : thread.sectionId === sections.DONE
                  ? "complete"
                  : "intake",
          nextAction:
            thread.sectionId === sections.TODO ? "Define and approve the plan" : null,
        });
      if (!workflow.nextAction) {
        const nextAction =
          thread.sectionId === sections.TODO
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
      if (Date.now() - thread.updatedAt > staleMs && thread.sectionId !== sections.DONE) {
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
        thread.sectionId === sections.DONE &&
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
        status: sectionStatuses.get(thread.sectionId ?? "") ?? "TODO",
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
        },
        attention: [...attention],
        updatedAt: thread.updatedAt,
      };
    });

    cards.sort((a, b) => b.updatedAt - a.updatedAt);
    const limits: Record<BoardStatus, number | null> = {
      TODO: null,
      WIP: positiveInteger(configured.wipLimit, 3),
      R4R: positiveInteger(configured.reviewLimit, 6),
      DONE: null,
    };
    const lanes = BOARD_STATUSES.map((status) => {
      const laneCards = cards.filter((card) => card.status === status);
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

  async function notifyChief(text: string) {
    if (!chiefThreadIdCache) return;
    await notifyController(chiefThreadIdCache, text);
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
        nextAction: "Ready for Chief dispatch",
      });
      woken.push(state.threadId);
    }
    if (woken.length) {
      bb.realtime.publish("board-changed", { event: "cards.woken", woken });
      await notifyChief(
        `Autobahn wake pass surfaced ${woken.length} card(s): ${woken.join(", ")}. Inventory the board and recommend the single next dispatch action.`,
      );
    }
    return woken;
  }

  async function witnessFindings(projectId?: string) {
    const board = await listBoard(projectId);
    return board.lanes.flatMap((lane) =>
      lane.cards.flatMap((card) => {
        const findings: string[] = [];
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
          findings.push(`${card.id}: DONE while its PR remains open`);
        }
        if (card.attention.includes("checks-failed")) {
          findings.push(`${card.id}: pull request checks failed`);
        }
        if (card.attention.includes("changes-requested")) {
          findings.push(`${card.id}: review changes requested`);
        }
        if (
          card.status !== "DONE" &&
          card.links.some(
            (link) => link.kind === "pull-request" && link.state === "merged",
          )
        ) {
          findings.push(`${card.id}: pull request merged but card is not DONE`);
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
  }

  bb.rpc.register(rpcContract, {
    listBoard: ({ projectId }) => listBoard(projectId),
    moveThread: ({ threadId, status }) => moveThread(threadId, status),
    getChiefOfStaff: async () => ({
      threadId: await ensureChiefOfStaff(),
    }),
  });

  bb.agents.registerTool({
    name: "autobahn_move_thread",
    description:
      "Move the current bb thread's Autobahn card to TODO, WIP, R4R, or DONE.",
    instructions:
      "Keep the current thread's board status accurate. Use WIP after substantive work begins, R4R when the result is ready for review, and DONE only when the requested outcome is complete.",
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
        status: "TODO",
      });
      return `Created "${title}" as TODO thread ${thread.id}; run planning before dispatch.`;
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
    description: "Move any thread card to TODO, WIP, R4R, or DONE.",
    experimental_statusLabels: {
      pending: "Moving Autobahn card",
      completed: "Moved Autobahn card",
    },
    parameters: z
      .object({
        threadId: z.string().min(1),
        status: boardStatusSchema,
      })
      .strict(),
    execute: async ({ threadId, status }) => {
      await moveThread(threadId, status);
      return `Moved thread ${threadId} to ${status}.`;
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
      "Call this at the end of every plan, build, verify, or egress pass. A successful build does not mean DONE; it advances to verification.",
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
            "Egress DONE requires a verified card currently in R4R.",
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
        await moveThread(threadId, "DONE");
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
      { threadId: chiefThreadId, signal },
    ) => {
      const state = workflowStore.get(threadId);
      if (!state?.planContract) {
        throw new Error("The card has no plan contract to approve.");
      }
      const interaction = await bb.ui.requestInput(
        {
          threadId: chiefThreadId,
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
      "Deterministically fill available WIP slots with planned, approved, unblocked, unparked TODO cards.",
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
      const todo = board.lanes.find((lane) => lane.status === "TODO")!;
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
                  "Finish this pass with autobahn_report_exit. A successful build advances to verification, not directly to DONE.",
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
          await moveThread(card.id, "TODO").catch(() => undefined);
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
      await bb.sdk.threads.stop({ threadId });
      bb.realtime.publish("board-changed", { threadId, event: "card.parked" });
      return `Parked ${threadId} until ${kind} is satisfied. Next: ${nextAction}`;
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
        nextAction: z.string().min(1).default("Ready for Chief dispatch"),
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

  const chiefTools = [
    "autobahn_list_cards",
    "autobahn_create_session",
    "autobahn_assign_session",
    "autobahn_move_card",
    "autobahn_control_session",
    "autobahn_set_contract",
    "autobahn_run_plan",
    "autobahn_approve_plan",
    "autobahn_run_verification",
    "autobahn_dispatch_ready",
    "autobahn_park_card",
    "autobahn_wake_card",
    "autobahn_witness",
  ];

  bb.agents.configure((context) => {
    const isPluginChild =
      context.origin.pluginId === bb.pluginId &&
      [
        "Autobahn planner",
        "Autobahn adversarial plan review",
        "Autobahn verification:",
        "Autobahn validate:",
      ].some((prefix) => context.thread.title?.startsWith(prefix));
    if (isPluginChild) {
      return {
        tools: [],
        skills: [],
        instructions:
          "This is a read-only fresh-context station. Inspect and return only the requested structured result. Do not edit files or mutate Autobahn state.",
      };
    }
    const isChief =
      context.thread.id === chiefThreadIdCache &&
      context.origin.pluginId === bb.pluginId;
    return isChief
      ? {
          tools: chiefTools,
          skills: ["autobahn-chief"],
          instructions:
            "You are the policy-driven Autobahn Chief of Staff. Inventory before acting; use fresh child sessions for planning and verification; enforce gates, dependencies, parking, and soft WIP; require typed exits and one Next action; never bypass human approval or auto-kill work.",
        }
      : {
          tools: ["autobahn_move_thread", "autobahn_report_exit"],
          skills: [],
          instructions:
            "Keep this controller card current and end every station pass with autobahn_report_exit, evidence, and one Next action. Build success advances to verification; only verified work reaches R4R; DONE requires a clean final exit.",
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
    const chiefThreadId =
      await bb.storage.kv.get<string>(CHIEF_THREAD_KEY);
    if (thread.id === chiefThreadId) {
      await bb.sdk.threads.stop({ threadId: thread.id }).catch((error) => {
        bb.log.warn(
          `Could not release Chief of Staff thread ${thread.id}: ${String(error)}`,
        );
      });
    }
  });

  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, async ({ thread }) => {
      const chiefThreadId =
        await bb.storage.kv.get<string>(CHIEF_THREAD_KEY);
      if (thread.id === chiefThreadId) {
        await bb.storage.kv.delete(CHIEF_THREAD_KEY);
        chiefThreadIdCache = null;
      }
    });
  }

  bb.background.schedule("wake-cards", "* * * * *", async () => {
    await wakeReadyCards();
  });

  bb.background.schedule("witness-scan", "*/15 * * * *", async () => {
    const findings = await witnessFindings();
    const fingerprint = JSON.stringify(findings);
    const previous =
      (await bb.storage.kv.get<string>(WITNESS_FINGERPRINT_KEY)) ?? "";
    if (fingerprint === previous) return;
    await bb.storage.kv.set(WITNESS_FINGERPRINT_KEY, fingerprint);
    if (findings.length) {
      bb.log.warn(`Autobahn witness: ${findings.join(" | ")}`);
      await notifyChief(
        `Autobahn witness found:\n${findings.join("\n")}\nRecommend action; do not stop work automatically.`,
      );
    }
  });

  bb.log.info("Autobahn board loaded");
}
