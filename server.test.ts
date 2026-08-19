import { describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

describe("autobahn backend", () => {
  it("builds cards from bb data and lets an agent move its current thread", async () => {
    const sections = ["OPEN", "WIP", "R4R", "CLOSED"].map((name) => ({
      id: `section-${name}`,
      name,
      createdAt: 1,
      updatedAt: 1,
    }));
    const update = vi.fn(() => ({ id: "thread-1" }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "autobahn",
      agentSkillIds: ["autobahn-driver"],
      sdk: {
        threadSections: {
          list: () => sections,
          create: ({ name }) => ({
            id: `section-${name}`,
            name,
            createdAt: 1,
            updatedAt: 1,
          }),
        },
        projects: {
          list: () => [
            {
              id: "project-1",
              name: "Agentbox",
              kind: "standard",
              gitRemoteUrl: null,
              createdAt: 1,
              updatedAt: 1,
              sources: [],
            },
          ],
        },
        threads: {
          list: () => [
            {
              id: "thread-1",
              projectId: "project-1",
              environmentId: "environment-1",
              providerId: "codex",
              title: "Ship feature",
              titleFallback: null,
              sectionId: "section-WIP",
              status: "active",
              environmentBranchName: "feature/autobahn",
              updatedAt: 42,
            },
          ],
          defaultExecutionOptions: async () => ({
            model: "gpt-5.6",
            reasoningLevel: "high",
            permissionMode: "auto",
            serviceTier: "default",
            source: "client/turn/start",
          }),
          timeline: async () => ({
            rows: [],
            contextWindowUsage: {
              usedTokens: 25_000,
              modelContextWindow: 100_000,
              estimated: false,
            },
          }),
          output: async () => ({
            output:
              "Implementation is ready. https://github.com/acme/repo/issues/42",
          }),
          update,
        },
        environments: {
          pullRequest: async () => ({
            outcome: "available",
            pullRequest: {
              number: 17,
              title: "Ship feature",
              state: "draft",
              url: "https://github.com/acme/repo/pull/17",
            },
          }),
        },
      },
    });
    plugin(bb);

    const board = (await harness.behavior.callRpc("listBoard", {})) as {
      lanes: Array<{
        status: string;
        cards: Array<{
          title: string;
          harness: string;
          model: string;
          effort: string;
          summary: string;
          links: Array<{ label: string }>;
        }>;
      }>;
    };

    expect(board.lanes.map((lane) => lane.status)).toEqual([
      "OPEN",
      "WIP",
      "R4R",
      "CLOSED",
    ]);
    expect(board.lanes[1].cards[0]).toMatchObject({
      title: "Ship feature",
      harness: "codex",
      model: "gpt-5.6",
      effort: "high",
      summary:
        "Implementation is ready. https://github.com/acme/repo/issues/42",
      links: [{ label: "PR #17" }, { label: "Issue #42" }],
    });

    await expect(
      harness.behavior.callAgentTool(
        "autobahn_move_thread",
        { status: "OPEN" },
        { threadId: "thread-1" },
      ),
    ).resolves.toBe("Moved this thread to OPEN.");
    expect(update).toHaveBeenCalledWith({
      threadId: "thread-1",
      sectionId: "section-OPEN",
    });
    await expect(
      harness.behavior.callAgentTool(
        "autobahn_move_thread",
        { status: "R4R" },
        { threadId: "thread-1" },
      ),
    ).rejects.toThrow("completed fresh-context verification panel");
  });

  it("persists a hidden Driver with scoped session-management tools", async () => {
    const sections = ["OPEN", "WIP", "R4R", "CLOSED"].map((name) => ({
      id: `section-${name}`,
      name,
      createdAt: 1,
      updatedAt: 1,
    }));
    const spawn = vi.fn(({ title, visibility }) => ({
      id:
        title === "Autobahn Driver" && visibility === "hidden"
          ? "driver-thread"
          : "worker-thread",
    }));
    const send = vi.fn(() => ({ ok: true }));
    const update = vi.fn(() => ({ id: "worker-thread" }));
    const stop = vi.fn(() => ({ ok: true }));
    const archive = vi.fn(() => ({ ok: true }));
    const unarchive = vi.fn(() => ({ ok: true }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "autobahn",
      agentSkillIds: ["autobahn-driver"],
      sdk: {
        threadSections: {
          list: () => sections,
          create: ({ name }) => ({
            id: `section-${name}`,
            name,
            createdAt: 1,
            updatedAt: 1,
          }),
        },
        projects: {
          list: () => [
            {
              id: "personal-project",
              name: "Personal",
              kind: "personal",
              gitRemoteUrl: null,
              createdAt: 1,
              updatedAt: 1,
              sources: [],
            },
            {
              id: "project-1",
              name: "Agentbox",
              kind: "standard",
              gitRemoteUrl: null,
              createdAt: 1,
              updatedAt: 1,
              sources: [],
            },
          ],
        },
        threads: {
          spawn,
          get: () => ({
            id: "worker-thread",
            projectId: "project-1",
            environmentId: "environment-1",
            sectionId: "section-OPEN",
            archivedAt: null,
            deletedAt: null,
          }),
          send,
          update,
          stop,
          archive,
          unarchive,
        },
      },
    });
    plugin(bb);

    await expect(
      harness.behavior.callRpc("getDriver"),
    ).resolves.toEqual({ threadId: "driver-thread" });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "personal-project",
        title: "Autobahn Driver",
        visibility: "hidden",
      }),
    );

    const driverConfig = await harness.behavior.resolveAgentConfiguration({
      thread: {
        id: "driver-thread",
        title: "Autobahn Driver",
        parentThreadId: null,
        sourceThreadId: null,
      },
      project: {
        id: "personal-project",
        kind: "personal",
        name: "Personal",
        gitRemoteUrl: null,
      },
      environment: {
        id: "personal-environment",
        name: null,
        path: null,
        workspaceProvisionType: "personal",
        branchName: null,
      },
      host: { id: "host-1", name: "Local" },
      provider: { id: "codex", model: "gpt-5.6" },
      origin: { kind: null, pluginId: "autobahn" },
    });
    expect(driverConfig.tools.map((tool) => tool.name)).toEqual([
      "autobahn_list_cards",
      "autobahn_create_session",
      "autobahn_assign_session",
      "autobahn_move_card",
      "autobahn_clear_status_override",
      "autobahn_start_roadmap_item",
      "autobahn_control_session",
      "autobahn_set_contract",
      "autobahn_run_plan",
      "autobahn_approve_plan",
      "autobahn_run_verification",
      "autobahn_dispatch_ready",
      "autobahn_park_card",
      "autobahn_wake_card",
      "autobahn_witness",
    ]);

    const childConfig = await harness.behavior.resolveAgentConfiguration({
      thread: {
        id: "review-child",
        title: "Autobahn verification: Correctness",
        parentThreadId: "worker-thread",
        sourceThreadId: null,
      },
      project: {
        id: "project-1",
        kind: "standard",
        name: "Agentbox",
        gitRemoteUrl: null,
      },
      environment: {
        id: "environment-1",
        name: null,
        path: "/workspace",
        workspaceProvisionType: "managed-worktree",
        branchName: "feature/test",
      },
      host: { id: "host-1", name: "Local" },
      provider: { id: "codex", model: "gpt-5.6" },
      origin: { kind: null, pluginId: "autobahn" },
    });
    expect(childConfig.tools).toEqual([]);
    expect(childConfig.instructions).toContain("read-only");

    await expect(
      harness.behavior.callAgentTool("autobahn_create_session", {
        projectId: "project-1",
        title: "Implement compact cards",
        prompt: "Make the Autobahn cards compact.",
      }),
    ).resolves.toContain("worker-thread");
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        sectionId: "section-OPEN",
        title: "Implement compact cards",
        visibility: "visible",
      }),
    );

    await expect(
      harness.behavior.callAgentTool(
        "autobahn_assign_session",
        {
          threadId: "worker-thread",
          prompt: "Also add harness logos.",
        },
        { threadId: "driver-thread" },
      ),
    ).rejects.toThrow("planned, approved, unparked WIP");
    expect(send).not.toHaveBeenCalled();

    await harness.behavior.callAgentTool("autobahn_move_card", {
      threadId: "worker-thread",
      status: "OPEN",
      reason: "Keep this task open",
    });
    expect(update).toHaveBeenCalledWith({
      threadId: "worker-thread",
      sectionId: "section-OPEN",
    });

    await harness.behavior.callAgentTool("autobahn_control_session", {
      threadId: "worker-thread",
      action: "archive",
    });
    expect(stop).toHaveBeenCalledWith({ threadId: "worker-thread" });
    expect(archive).toHaveBeenCalledWith({ threadId: "worker-thread" });

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "driver-thread" }),
      lastAssistantText: "Ready.",
    });
    expect(stop).toHaveBeenCalledWith({ threadId: "driver-thread" });
  });

  it("enforces contracts, dispatches within WIP, records exits, and wakes parked cards", async () => {
    const sections = ["OPEN", "WIP", "R4R", "CLOSED"].map((name) => ({
      id: `section-${name}`,
      name,
      createdAt: 1,
      updatedAt: 1,
    }));
    const row = {
      id: "thread-1",
      projectId: "project-1",
      environmentId: "environment-1",
      providerId: "codex",
      title: "Policy-driven card",
      titleFallback: null,
      sectionId: "section-OPEN",
      status: "idle",
      hasPendingInteraction: false,
      environmentBranchName: "feature/policy",
      updatedAt: Date.now(),
    };
    const update = vi.fn(({ sectionId }) => {
      if (sectionId) row.sectionId = sectionId;
      return row;
    });
    const send = vi.fn(() => ({ ok: true }));
    const stop = vi.fn(() => ({ ok: true }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "autobahn",
      agentSkillIds: ["autobahn-driver"],
      sdk: {
        threadSections: {
          list: () => sections,
          create: ({ name }) => ({
            id: `section-${name}`,
            name,
            createdAt: 1,
            updatedAt: 1,
          }),
        },
        projects: {
          list: () => [
            {
              id: "project-1",
              name: "Agentbox",
              kind: "standard",
              gitRemoteUrl: null,
              createdAt: 1,
              updatedAt: 1,
              sources: [],
            },
          ],
        },
        threads: {
          list: (args) =>
            args?.sectionId && row.sectionId !== args.sectionId ? [] : [row],
          get: () => ({
            ...row,
            archivedAt: null,
            deletedAt: null,
          }),
          update,
          send,
          stop,
          defaultExecutionOptions: async () => ({
            model: "gpt-5.6",
            reasoningLevel: "high",
            permissionMode: "auto",
            serviceTier: "default",
            source: "client/turn/start",
          }),
          timeline: async () => ({ rows: [] }),
          output: async () => ({ output: "Ready." }),
          interactions: {
            list: async () => [],
          },
        },
        environments: {
          pullRequest: async () => ({ outcome: "absent" }),
        },
      },
    });
    plugin(bb);

    await harness.behavior.callAgentTool("autobahn_set_contract", {
      threadId: "thread-1",
      riskClass: "high",
      priority: 1,
      blockedBy: [],
      requiresHumanApproval: false,
      contract: {
        objective: "Implement the policy layer",
        scope: ["autobahn"],
        outOfScope: ["external tracker"],
        expectedFiles: ["server.ts"],
        acceptanceCriteria: ["typed exits persist"],
        verificationCommands: ["npm test"],
      },
    });

    const approval = harness.behavior.callAgentTool(
      "autobahn_approve_plan",
      {
        threadId: "thread-1",
        recommendation: "Approve the reviewed contract",
      },
      { threadId: "driver-thread" },
    );
    await vi.waitFor(() => {
      expect(harness.inspection.pendingInteractions).toHaveLength(1);
    });
    harness.behavior.submitInteraction(
      harness.inspection.pendingInteractions[0]!.id,
      { approved: true, note: "Approved by the operator" },
    );
    await expect(approval).resolves.toContain("Plan approved");

    await expect(
      harness.behavior.callAgentTool(
        "autobahn_dispatch_ready",
        { projectId: "project-1" },
        { threadId: "driver-thread" },
      ),
    ).resolves.toContain("Dispatched 1");
    expect(row.sectionId).toBe("section-WIP");
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        senderThreadId: "driver-thread",
      }),
    );

    await harness.behavior.callAgentTool(
      "autobahn_report_exit",
      {
        phase: "build",
        status: "DONE",
        summary: "Implementation complete.",
        nextAction: "Run verification",
        concerns: [],
        evidence: [{ label: "Unit tests", path: "report.txt" }],
      },
      { threadId: "thread-1" },
    );

    await expect(
      harness.behavior.callAgentTool(
        "autobahn_report_exit",
        {
          phase: "egress",
          status: "DONE",
          summary: "Attempted premature completion.",
          nextAction: "Done",
          concerns: [],
          evidence: [{ label: "Self-asserted evidence" }],
        },
        { threadId: "thread-1" },
      ),
    ).rejects.toThrow("verified card currently in R4R");

    await harness.behavior.callAgentTool("autobahn_park_card", {
      threadId: "thread-1",
      kind: "timer",
      untilEpochMs: 0,
      nextAction: "Wait for the timer",
    });
    expect(row.sectionId).toBe("section-OPEN");
    expect(stop).toHaveBeenCalledWith({ threadId: "thread-1" });
    await harness.behavior.runSchedule("wake-cards");

    const board = (await harness.behavior.callRpc("listBoard", {})) as {
      lanes: Array<{
        status: string;
        softLimit: number | null;
        cards: Array<{
          workflow: {
            phase: string;
            parkedWake: unknown;
            nextAction: string | null;
            evidence: unknown[];
          };
        }>;
      }>;
      needsYouCount: number;
    };
    const card = board.lanes
      .flatMap((lane) => lane.cards)
      .find((candidate) => candidate.workflow);
    expect(board.lanes.find((lane) => lane.status === "WIP")?.softLimit).toBe(
      3,
    );
    expect(card?.workflow).toMatchObject({
      phase: "verify",
      parkedWake: null,
      nextAction: "Ready for Driver dispatch",
      evidence: [{ label: "Unit tests", path: "report.txt" }],
    });

    await expect(
      harness.behavior.callAgentTool("autobahn_witness", {
        projectId: "project-1",
      }),
    ).resolves.toContain("queue is healthy");
  });
});
