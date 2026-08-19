import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKFLOW_STATE_MIGRATIONS,
  createWorkflowStateStore,
  type CardWorkflowStore,
  type PlanContract,
} from "./workflow-state";

function setup(timestamps: number[] = [1_000]): {
  db: Database.Database;
  store: CardWorkflowStore;
} {
  const db = new Database(":memory:");
  for (const migration of WORKFLOW_STATE_MIGRATIONS) db.exec(migration);
  let index = 0;
  const store = createWorkflowStateStore(db, {
    now: () => timestamps[Math.min(index++, timestamps.length - 1)]!,
  });
  return { db, store };
}

const databases: Database.Database[] = [];

function trackedSetup(timestamps?: number[]) {
  const result = setup(timestamps);
  databases.push(result.db);
  return result;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("workflow state store", () => {
  it("creates a card with defaults and merges subsequent updates", () => {
    const { store } = trackedSetup([100, 200]);

    expect(store.get("missing")).toBeNull();
    expect(store.upsert("thread-1")).toEqual({
      threadId: "thread-1",
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
      createdAt: 100,
      updatedAt: 100,
      phaseStartedAt: 100,
      completedAt: null,
    });

    const planContract: PlanContract = {
      objective: "Ship the workflow",
      scope: ["autobahn backend"],
      outOfScope: ["new columns"],
      expectedFiles: ["server.ts"],
      acceptanceCriteria: ["state survives reload"],
      verificationCommands: ["npm test"],
    };
    expect(
      store.upsert("thread-1", {
        phase: "plan",
        gate: "plan-approval",
        riskClass: "high",
        priority: 2,
        nextAction: "Approve the plan",
        planContract,
        blockedBy: ["thread-2"],
      }),
    ).toMatchObject({
      threadId: "thread-1",
      phase: "plan",
      gate: "plan-approval",
      riskClass: "high",
      priority: 2,
      nextAction: "Approve the plan",
      planContract,
      blockedBy: ["thread-2"],
      createdAt: 100,
      updatedAt: 200,
      phaseStartedAt: 200,
    });
    expect(store.list()).toEqual([store.get("thread-1")]);
    expect(store.listEvents("thread-1").map((event) => event.type)).toEqual([
      "card.upserted",
      "card.upserted",
    ]);
  });

  it("records typed station exits with evidence and attempts", () => {
    const { store } = trackedSetup([10, 20]);

    const first = store.reportExit({
      threadId: "thread-1",
      phase: "build",
      status: "DONE_WITH_CONCERNS",
      summary: "Implementation works; one edge remains.",
      nextAction: "Run verification",
      concerns: ["Slow integration test"],
      evidence: [{ label: "PR #42", url: "https://example.com/pr/42" }],
      gate: "review-requested",
    });
    expect(first).toMatchObject({
      phase: "build",
      exitStatus: "DONE_WITH_CONCERNS",
      attempt: 1,
      nextAction: "Run verification",
      concerns: ["Slow integration test"],
      evidence: [{ label: "PR #42", url: "https://example.com/pr/42" }],
      gate: "review-requested",
    });

    expect(
      store.reportExit({
        threadId: "thread-1",
        phase: "verify",
        status: "DONE",
        summary: "All checks passed.",
        nextAction: "Request human review",
      }).attempt,
    ).toBe(2);
    expect(store.listEvents("thread-1")).toMatchObject([
      {
        id: 1,
        type: "station.exited",
        payload: {
          phase: "build",
          status: "DONE_WITH_CONCERNS",
          summary: "Implementation works; one edge remains.",
          attempt: 1,
        },
      },
      {
        id: 2,
        type: "station.exited",
        payload: { phase: "verify", status: "DONE", attempt: 2 },
      },
    ]);
  });

  it("parks and wakes cards while retaining an append-only history", () => {
    const { store } = trackedSetup([100, 200]);

    expect(
      store.park({
        threadId: "thread-1",
        wake: { kind: "checks-finished", ref: "pr-42", until: 5_000 },
        nextAction: "Wait for CI",
      }),
    ).toMatchObject({
      parkedWake: { kind: "checks-finished", ref: "pr-42", until: 5_000 },
      nextAction: "Wait for CI",
    });
    expect(
      store.wake({
        threadId: "thread-1",
        reason: "CI completed",
        nextAction: "Inspect checks",
      }),
    ).toMatchObject({ parkedWake: null, nextAction: "Inspect checks" });

    expect(store.listEvents("thread-1")).toMatchObject([
      { type: "card.parked" },
      {
        type: "card.woken",
        payload: {
          previousWake: {
            kind: "checks-finished",
            ref: "pr-42",
            until: 5_000,
          },
          reason: "CI completed",
        },
      },
    ]);
  });

  it("wakes parking without clearing an unrelated workflow gate", () => {
    const { store } = trackedSetup([100, 200, 300]);
    store.upsert("thread-1", {
      gate: "plan-approval",
      nextAction: "Approve the plan",
    });
    store.park({
      threadId: "thread-1",
      wake: { kind: "timer", until: 150 },
      nextAction: "Wait for timer",
    });
    expect(
      store.wake({
        threadId: "thread-1",
        reason: "timer elapsed",
        nextAction: "Plan approval still required",
      }),
    ).toMatchObject({
      gate: "plan-approval",
      parkedWake: null,
      nextAction: "Plan approval still required",
    });
  });

  it("falls back safely when persisted JSON or enum values are malformed", () => {
    const { db, store } = trackedSetup([100]);
    store.upsert("thread-1", {
      concerns: ["valid"],
      evidence: [{ label: "test", path: "report.txt" }],
    });
    db.prepare(
      `UPDATE card_workflow_state SET
        phase = 'future-phase', gate = 'future-gate', risk_class = 'future-risk',
        exit_status = 'future-exit', concerns_json = '{',
        evidence_json = '[null, {"label": 1}]',
        plan_contract_json = '{"objective":"x"}',
        blocked_by_json = '{"not":"an array"}',
        parked_wake_json = '{"kind": 1}'
      WHERE thread_id = ?`,
    ).run("thread-1");
    db.prepare(
      `UPDATE card_workflow_events SET payload_json = '[' WHERE id = 1`,
    ).run();

    expect(store.get("thread-1")).toMatchObject({
      phase: "intake",
      gate: "none",
      riskClass: "low",
      exitStatus: "BLOCKED",
      concerns: [],
      evidence: [],
      planContract: null,
      blockedBy: [],
      parkedWake: null,
    });
    expect(store.listEvents("thread-1")[0]?.payload).toEqual({});
  });

  it("allows explicit domain events with validated timestamps", () => {
    const { store } = trackedSetup();
    expect(
      store.appendEvent({
        threadId: "thread-1",
        type: "gate.opened",
        payload: { gate: "needs-input", nested: { count: 2 } },
        createdAt: 77,
      }),
    ).toEqual({
      id: 1,
      threadId: "thread-1",
      type: "gate.opened",
      payload: { gate: "needs-input", nested: { count: 2 } },
      createdAt: 77,
    });
    expect(() =>
      store.appendEvent({
        threadId: "thread-1",
        type: "bad-time",
        createdAt: -1,
      }),
    ).toThrow("createdAt must be a nonnegative safe integer");
  });
});
