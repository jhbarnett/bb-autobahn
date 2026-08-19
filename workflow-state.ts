import type Database from "better-sqlite3";

/**
 * Database migrations are positional migration IDs. Never edit or reorder an
 * entry after release; add new entries at the end instead.
 */
export const WORKFLOW_STATE_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS card_workflow_state (
    thread_id TEXT PRIMARY KEY,
    phase TEXT NOT NULL,
    gate TEXT NOT NULL,
    risk_class TEXT NOT NULL,
    priority INTEGER NOT NULL,
    attempt INTEGER NOT NULL,
    exit_status TEXT,
    next_action TEXT,
    concerns_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    plan_contract_json TEXT,
    blocked_by_json TEXT NOT NULL,
    parked_wake_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    phase_started_at INTEGER NOT NULL,
    completed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS card_workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS card_workflow_events_thread_created_idx
    ON card_workflow_events (thread_id, created_at, id)`,
  `ALTER TABLE card_workflow_state ADD COLUMN status_override TEXT`,
  `ALTER TABLE card_workflow_state ADD COLUMN status_override_reason TEXT`,
  `ALTER TABLE card_workflow_state ADD COLUMN status_override_at INTEGER`,
] as const;

export const WORKFLOW_PHASES = [
  "intake",
  "plan",
  "build",
  "verify",
  "egress",
  "complete",
] as const;

export const WORKFLOW_GATES = [
  "none",
  "needs-input",
  "plan-approval",
  "blocked",
  "checks-failed",
  "changes-requested",
  "review-requested",
] as const;

export const RISK_CLASSES = ["low", "medium", "high", "critical"] as const;

export const EXIT_STATUSES = [
  "DONE",
  "DONE_WITH_CONCERNS",
  "NEEDS_CONTEXT",
  "BLOCKED",
] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];
export type WorkflowGate = (typeof WORKFLOW_GATES)[number];
export type RiskClass = (typeof RISK_CLASSES)[number];
export type ExitStatus = (typeof EXIT_STATUSES)[number];
export const STATUS_OVERRIDES = ["OPEN", "WIP", "R4R", "CLOSED"] as const;
export type StatusOverride = (typeof STATUS_OVERRIDES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface WorkflowEvidence {
  label: string;
  url?: string;
  path?: string;
}

export interface PlanContract {
  objective: string;
  scope: string[];
  outOfScope: string[];
  expectedFiles: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
}

export interface ParkedWake {
  kind: string;
  ref: string | null;
  until: number | null;
}

export interface CardWorkflowState {
  threadId: string;
  phase: WorkflowPhase;
  gate: WorkflowGate;
  riskClass: RiskClass;
  priority: number;
  attempt: number;
  exitStatus: ExitStatus | null;
  nextAction: string | null;
  concerns: string[];
  evidence: WorkflowEvidence[];
  planContract: PlanContract | null;
  blockedBy: string[];
  parkedWake: ParkedWake | null;
  statusOverride: StatusOverride | null;
  statusOverrideReason: string | null;
  statusOverrideAt: number | null;
  createdAt: number;
  updatedAt: number;
  phaseStartedAt: number;
  completedAt: number | null;
}

export type CardWorkflowStatePatch = Partial<
  Omit<CardWorkflowState, "threadId" | "createdAt" | "updatedAt">
>;

export interface ReportExitInput {
  threadId: string;
  phase: WorkflowPhase;
  status: ExitStatus;
  summary: string;
  nextAction: string;
  concerns?: string[];
  evidence?: WorkflowEvidence[];
  gate?: WorkflowGate;
}

export interface ParkInput {
  threadId: string;
  wake: {
    kind: string;
    ref?: string | null;
    until?: number | null;
  };
  nextAction?: string | null;
}

export interface WakeInput {
  threadId: string;
  reason?: string;
  nextAction?: string | null;
}

export interface AppendEventInput {
  threadId: string;
  type: string;
  payload?: JsonObject;
  createdAt?: number;
}

export interface CardWorkflowEvent {
  id: number;
  threadId: string;
  type: string;
  payload: JsonObject;
  createdAt: number;
}

export interface CardWorkflowStore {
  get(threadId: string): CardWorkflowState | null;
  list(): CardWorkflowState[];
  upsert(
    threadId: string,
    patch?: CardWorkflowStatePatch,
  ): CardWorkflowState;
  reportExit(input: ReportExitInput): CardWorkflowState;
  park(input: ParkInput): CardWorkflowState;
  wake(input: WakeInput): CardWorkflowState;
  appendEvent(input: AppendEventInput): CardWorkflowEvent;
  listEvents(threadId?: string): CardWorkflowEvent[];
}

interface WorkflowStateRow {
  thread_id: string;
  phase: string;
  gate: string;
  risk_class: string;
  priority: number;
  attempt: number;
  exit_status: string | null;
  next_action: string | null;
  concerns_json: string;
  evidence_json: string;
  plan_contract_json: string | null;
  blocked_by_json: string;
  parked_wake_json: string | null;
  status_override: string | null;
  status_override_reason: string | null;
  status_override_at: number | null;
  created_at: number;
  updated_at: number;
  phase_started_at: number;
  completed_at: number | null;
}

interface WorkflowEventRow {
  id: number;
  thread_id: string;
  type: string;
  payload_json: string;
  created_at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseStringArray(value: string | null): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function parseEvidence(value: string | null): WorkflowEvidence[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!isRecord(item) || typeof item.label !== "string") return [];
    const evidence: WorkflowEvidence = { label: item.label };
    if (typeof item.url === "string") evidence.url = item.url;
    if (typeof item.path === "string") evidence.path = item.path;
    return [evidence];
  });
}

function parsePlanContract(value: string | null): PlanContract | null {
  const parsed = parseJson(value);
  if (!isRecord(parsed) || typeof parsed.objective !== "string") return null;
  const keys = [
    "scope",
    "outOfScope",
    "expectedFiles",
    "acceptanceCriteria",
    "verificationCommands",
  ] as const;
  if (
    keys.some(
      (key) =>
        !Array.isArray(parsed[key]) ||
        !(parsed[key] as unknown[]).every((item) => typeof item === "string"),
    )
  ) {
    return null;
  }
  return {
    objective: parsed.objective,
    scope: parsed.scope as string[],
    outOfScope: parsed.outOfScope as string[],
    expectedFiles: parsed.expectedFiles as string[],
    acceptanceCriteria: parsed.acceptanceCriteria as string[],
    verificationCommands: parsed.verificationCommands as string[],
  };
}

function parseParkedWake(value: string | null): ParkedWake | null {
  const parsed = parseJson(value);
  if (!isRecord(parsed) || typeof parsed.kind !== "string") return null;
  return {
    kind: parsed.kind,
    ref: typeof parsed.ref === "string" ? parsed.ref : null,
    until:
      typeof parsed.until === "number" && Number.isFinite(parsed.until)
        ? parsed.until
        : null,
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (["string", "boolean"].includes(typeof value)) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    isRecord(value) &&
    Object.values(value).every((item) => isJsonValue(item))
  );
}

function parseJsonObject(value: string | null): JsonObject {
  const parsed = parseJson(value);
  return isRecord(parsed) && isJsonValue(parsed) ? parsed : {};
}

function oneOf<const Values extends readonly string[]>(
  value: string,
  values: Values,
  fallback: Values[number],
): Values[number] {
  return values.includes(value) ? (value as Values[number]) : fallback;
}

function encodeJson(value: JsonValue): string {
  return JSON.stringify(value);
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty.`);
  return normalized;
}

function requireNonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer.`);
  }
  return value;
}

function requireTimestamp(value: number, name: string): number {
  return requireNonnegativeInteger(value, name);
}

function normalizeWake(wake: ParkInput["wake"]): ParkedWake {
  return {
    kind: requireText(wake.kind, "wake.kind"),
    ref: wake.ref ?? null,
    until:
      wake.until === undefined || wake.until === null
        ? null
        : requireTimestamp(wake.until, "wake.until"),
  };
}

function evidenceToJson(evidence: WorkflowEvidence[]): JsonValue[] {
  return evidence.map((item) => ({
    label: item.label,
    ...(item.url === undefined ? {} : { url: item.url }),
    ...(item.path === undefined ? {} : { path: item.path }),
  }));
}

function planContractToJson(planContract: PlanContract): JsonObject {
  return {
    objective: planContract.objective,
    scope: planContract.scope,
    outOfScope: planContract.outOfScope,
    expectedFiles: planContract.expectedFiles,
    acceptanceCriteria: planContract.acceptanceCriteria,
    verificationCommands: planContract.verificationCommands,
  };
}

function parkedWakeToJson(parkedWake: ParkedWake): JsonObject {
  return {
    kind: parkedWake.kind,
    ref: parkedWake.ref,
    until: parkedWake.until,
  };
}

function stateToJson(state: CardWorkflowState): JsonObject {
  return {
    threadId: state.threadId,
    phase: state.phase,
    gate: state.gate,
    riskClass: state.riskClass,
    priority: state.priority,
    attempt: state.attempt,
    exitStatus: state.exitStatus,
    nextAction: state.nextAction,
    concerns: state.concerns,
    evidence: evidenceToJson(state.evidence),
    planContract:
      state.planContract === null
        ? null
        : planContractToJson(state.planContract),
    blockedBy: state.blockedBy,
    parkedWake:
      state.parkedWake === null ? null : parkedWakeToJson(state.parkedWake),
    statusOverride: state.statusOverride,
    statusOverrideReason: state.statusOverrideReason,
    statusOverrideAt: state.statusOverrideAt,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    phaseStartedAt: state.phaseStartedAt,
    completedAt: state.completedAt,
  };
}

export function createWorkflowStateStore(
  db: Database.Database,
  options: { now?: () => number } = {},
): CardWorkflowStore {
  const now = options.now ?? Date.now;

  const selectState = db.prepare<[string], WorkflowStateRow>(
    `SELECT * FROM card_workflow_state WHERE thread_id = ?`,
  );
  const listStates = db.prepare<[], WorkflowStateRow>(
    `SELECT * FROM card_workflow_state ORDER BY updated_at DESC, thread_id ASC`,
  );
  const writeState = db.prepare<WorkflowStateRow>(
    `INSERT INTO card_workflow_state (
      thread_id, phase, gate, risk_class, priority, attempt, exit_status,
      next_action, concerns_json, evidence_json, plan_contract_json,
      blocked_by_json, parked_wake_json, status_override,
      status_override_reason, status_override_at, created_at, updated_at,
      phase_started_at, completed_at
    ) VALUES (
      @thread_id, @phase, @gate, @risk_class, @priority, @attempt, @exit_status,
      @next_action, @concerns_json, @evidence_json, @plan_contract_json,
      @blocked_by_json, @parked_wake_json, @status_override,
      @status_override_reason, @status_override_at, @created_at, @updated_at,
      @phase_started_at, @completed_at
    ) ON CONFLICT(thread_id) DO UPDATE SET
      phase = excluded.phase,
      gate = excluded.gate,
      risk_class = excluded.risk_class,
      priority = excluded.priority,
      attempt = excluded.attempt,
      exit_status = excluded.exit_status,
      next_action = excluded.next_action,
      concerns_json = excluded.concerns_json,
      evidence_json = excluded.evidence_json,
      plan_contract_json = excluded.plan_contract_json,
      blocked_by_json = excluded.blocked_by_json,
      parked_wake_json = excluded.parked_wake_json,
      status_override = excluded.status_override,
      status_override_reason = excluded.status_override_reason,
      status_override_at = excluded.status_override_at,
      updated_at = excluded.updated_at,
      phase_started_at = excluded.phase_started_at,
      completed_at = excluded.completed_at`,
  );
  const insertEvent = db.prepare<
    { thread_id: string; type: string; payload_json: string; created_at: number }
  >(
    `INSERT INTO card_workflow_events (
      thread_id, type, payload_json, created_at
    ) VALUES (@thread_id, @type, @payload_json, @created_at)`,
  );
  const selectEvent = db.prepare<[number], WorkflowEventRow>(
    `SELECT * FROM card_workflow_events WHERE id = ?`,
  );
  const allEvents = db.prepare<[], WorkflowEventRow>(
    `SELECT * FROM card_workflow_events ORDER BY created_at ASC, id ASC`,
  );
  const threadEvents = db.prepare<[string], WorkflowEventRow>(
    `SELECT * FROM card_workflow_events
      WHERE thread_id = ? ORDER BY created_at ASC, id ASC`,
  );

  function fromStateRow(row: WorkflowStateRow): CardWorkflowState {
    return {
      threadId: row.thread_id,
      phase: oneOf(row.phase, WORKFLOW_PHASES, "intake"),
      gate: oneOf(row.gate, WORKFLOW_GATES, "none"),
      riskClass: oneOf(row.risk_class, RISK_CLASSES, "low"),
      priority:
        Number.isSafeInteger(row.priority) && row.priority >= 0
          ? row.priority
          : 0,
      attempt:
        Number.isSafeInteger(row.attempt) && row.attempt >= 0 ? row.attempt : 0,
      exitStatus:
        row.exit_status === null
          ? null
          : oneOf(row.exit_status, EXIT_STATUSES, "BLOCKED"),
      nextAction: row.next_action,
      concerns: parseStringArray(row.concerns_json),
      evidence: parseEvidence(row.evidence_json),
      planContract: parsePlanContract(row.plan_contract_json),
      blockedBy: parseStringArray(row.blocked_by_json),
      parkedWake: parseParkedWake(row.parked_wake_json),
      statusOverride:
        row.status_override === null
          ? null
          : oneOf(row.status_override, STATUS_OVERRIDES, "OPEN"),
      statusOverrideReason: row.status_override_reason,
      statusOverrideAt: row.status_override_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      phaseStartedAt: row.phase_started_at,
      completedAt: row.completed_at,
    };
  }

  function toStateRow(state: CardWorkflowState): WorkflowStateRow {
    return {
      thread_id: state.threadId,
      phase: state.phase,
      gate: state.gate,
      risk_class: state.riskClass,
      priority: state.priority,
      attempt: state.attempt,
      exit_status: state.exitStatus,
      next_action: state.nextAction,
      concerns_json: encodeJson(state.concerns),
      evidence_json: encodeJson(evidenceToJson(state.evidence)),
      plan_contract_json:
        state.planContract === null
          ? null
          : encodeJson(planContractToJson(state.planContract)),
      blocked_by_json: encodeJson(state.blockedBy),
      parked_wake_json:
        state.parkedWake === null
          ? null
          : encodeJson(parkedWakeToJson(state.parkedWake)),
      status_override: state.statusOverride,
      status_override_reason: state.statusOverrideReason,
      status_override_at: state.statusOverrideAt,
      created_at: state.createdAt,
      updated_at: state.updatedAt,
      phase_started_at: state.phaseStartedAt,
      completed_at: state.completedAt,
    };
  }

  function fromEventRow(row: WorkflowEventRow): CardWorkflowEvent {
    return {
      id: row.id,
      threadId: row.thread_id,
      type: row.type,
      payload: parseJsonObject(row.payload_json),
      createdAt: row.created_at,
    };
  }

  function defaultState(threadId: string, timestamp: number): CardWorkflowState {
    return {
      threadId,
      phase: "intake",
      gate: "none",
      riskClass: "low",
      priority: 0,
      attempt: 0,
      exitStatus: null,
      nextAction: null,
      concerns: [],
      evidence: [],
      planContract: null,
      blockedBy: [],
      parkedWake: null,
      statusOverride: null,
      statusOverrideReason: null,
      statusOverrideAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      phaseStartedAt: timestamp,
      completedAt: null,
    };
  }

  function get(threadId: string): CardWorkflowState | null {
    const row = selectState.get(requireText(threadId, "threadId"));
    return row ? fromStateRow(row) : null;
  }

  function persist(
    threadId: string,
    patch: CardWorkflowStatePatch,
    timestamp: number,
  ): CardWorkflowState {
    const normalizedThreadId = requireText(threadId, "threadId");
    const current = get(normalizedThreadId) ??
      defaultState(normalizedThreadId, timestamp);
    const phase = patch.phase ?? current.phase;
    const state: CardWorkflowState = {
      ...current,
      ...patch,
      threadId: normalizedThreadId,
      priority: requireNonnegativeInteger(
        patch.priority ?? current.priority,
        "priority",
      ),
      attempt: requireNonnegativeInteger(
        patch.attempt ?? current.attempt,
        "attempt",
      ),
      createdAt: current.createdAt,
      updatedAt: timestamp,
      phaseStartedAt:
        patch.phase !== undefined && patch.phase !== current.phase
          ? timestamp
          : patch.phaseStartedAt ?? current.phaseStartedAt,
      completedAt:
        patch.completedAt !== undefined
          ? patch.completedAt
          : phase === "complete"
            ? current.completedAt ?? timestamp
            : current.completedAt,
    };
    writeState.run(toStateRow(state));
    return state;
  }

  function appendEvent(input: AppendEventInput): CardWorkflowEvent {
    const timestamp = requireTimestamp(input.createdAt ?? now(), "createdAt");
    const result = insertEvent.run({
      thread_id: requireText(input.threadId, "threadId"),
      type: requireText(input.type, "type"),
      payload_json: encodeJson(input.payload ?? {}),
      created_at: timestamp,
    });
    const id = Number(result.lastInsertRowid);
    const row = selectEvent.get(id);
    if (!row) throw new Error(`Failed to read appended workflow event ${id}.`);
    return fromEventRow(row);
  }

  const upsertTransaction = db.transaction(
    (threadId: string, patch: CardWorkflowStatePatch): CardWorkflowState => {
      const timestamp = requireTimestamp(now(), "now()");
      const state = persist(threadId, patch, timestamp);
      appendEvent({
        threadId: state.threadId,
        type: "card.upserted",
        payload: { state: stateToJson(state) },
        createdAt: timestamp,
      });
      return state;
    },
  );

  const reportExitTransaction = db.transaction(
    (input: ReportExitInput): CardWorkflowState => {
      const timestamp = requireTimestamp(now(), "now()");
      const current = get(input.threadId) ?? defaultState(input.threadId, timestamp);
      const state = persist(
        input.threadId,
        {
          phase: input.phase,
          exitStatus: input.status,
          nextAction: requireText(input.nextAction, "nextAction"),
          concerns: input.concerns ?? current.concerns,
          evidence: input.evidence ?? current.evidence,
          gate: input.gate ?? current.gate,
          attempt: current.attempt + 1,
        },
        timestamp,
      );
      appendEvent({
        threadId: state.threadId,
        type: "station.exited",
        payload: {
          phase: input.phase,
          status: input.status,
          summary: input.summary,
          nextAction: state.nextAction,
          concerns: state.concerns,
          evidence: evidenceToJson(state.evidence),
          attempt: state.attempt,
        },
        createdAt: timestamp,
      });
      return state;
    },
  );

  const parkTransaction = db.transaction((input: ParkInput): CardWorkflowState => {
    const timestamp = requireTimestamp(now(), "now()");
    const wake = normalizeWake(input.wake);
    const state = persist(
      input.threadId,
      {
        parkedWake: wake,
        ...(input.nextAction === undefined
          ? {}
          : { nextAction: input.nextAction }),
      },
      timestamp,
    );
    appendEvent({
      threadId: state.threadId,
      type: "card.parked",
      payload: {
        wake: parkedWakeToJson(wake),
        nextAction: state.nextAction,
      },
      createdAt: timestamp,
    });
    return state;
  });

  const wakeTransaction = db.transaction((input: WakeInput): CardWorkflowState => {
    const timestamp = requireTimestamp(now(), "now()");
    const previousWake = get(input.threadId)?.parkedWake ?? null;
    const state = persist(
      input.threadId,
      {
        parkedWake: null,
        ...(input.nextAction === undefined
          ? {}
          : { nextAction: input.nextAction }),
      },
      timestamp,
    );
    appendEvent({
      threadId: state.threadId,
      type: "card.woken",
      payload: {
        previousWake:
          previousWake === null ? null : parkedWakeToJson(previousWake),
        reason: input.reason ?? null,
        nextAction: state.nextAction,
      },
      createdAt: timestamp,
    });
    return state;
  });

  return {
    get,
    list: () => listStates.all().map(fromStateRow),
    upsert: (threadId, patch = {}) => upsertTransaction(threadId, patch),
    reportExit: (input) => reportExitTransaction(input),
    park: (input) => parkTransaction(input),
    wake: (input) => wakeTransaction(input),
    appendEvent,
    listEvents: (threadId) =>
      (threadId === undefined
        ? allEvents.all()
        : threadEvents.all(requireText(threadId, "threadId"))
      ).map(fromEventRow),
  };
}
