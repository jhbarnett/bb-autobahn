// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { BoardResult } from "./server";

const board: BoardResult = {
  lanes: [
    {
      status: "OPEN",
      sectionId: "section-OPEN",
      softLimit: null,
      overLimit: false,
      capacityCount: 0,
      cards: [],
    },
    {
      status: "WIP",
      sectionId: "section-WIP",
      softLimit: 3,
      overLimit: false,
      capacityCount: 1,
      cards: [
        {
          id: "thread-1",
          title: "Ship feature",
          projectId: "project-1",
          projectName: "Agentbox",
          status: "WIP",
          runtimeStatus: "active",
          harness: "codex",
          model: "gpt-5.6",
          effort: "high",
          context: {
            usedTokens: 25_000,
            modelContextWindow: 100_000,
            estimated: false,
          },
          summary: "The implementation is ready for review.",
          branchName: "feature/autobahn",
          links: [
            {
              kind: "pull-request",
              label: "PR #17",
              url: "https://github.com/acme/repo/pull/17",
              state: "draft",
            },
          ],
          workflow: {
            phase: "verify",
            gate: "review-requested",
            riskClass: "high",
            priority: 1,
            attempt: 2,
            exitStatus: "DONE_WITH_CONCERNS",
            nextAction: "Review the verified change",
            concerns: ["One minor concern"],
            evidence: [{ label: "Targeted tests", path: "report.txt" }],
            planContract: null,
            blockedBy: [],
            parkedWake: null,
            phaseStartedAt: 30,
            statusOverride: "WIP",
            statusOverrideReason: "Keep active while the follow-up issue remains",
            statusOverrideAt: 40,
          },
          attention: ["review-requested"],
          updatedAt: 42,
        },
      ],
    },
    {
      status: "R4R",
      sectionId: "section-R4R",
      softLimit: 6,
      overLimit: false,
      capacityCount: 0,
      cards: [],
    },
    {
      status: "CLOSED",
      sectionId: "section-CLOSED",
      softLimit: null,
      overLimit: false,
      capacityCount: 0,
      cards: [],
    },
  ],
  roadmapItems: [
    {
      id: "issue:acme/repo#42",
      repo: "acme/repo",
      number: 42,
      title: "Top roadmap issue",
      url: "https://github.com/acme/repo/issues/42",
      labels: ["P0"],
      priority: 0,
      updatedAt: "2026-08-19T00:00:00Z",
      projectId: "project-1",
      linkedThreadId: null,
      captured: true,
    },
  ],
  needsYouCount: 1,
  snoozedCount: 0,
};

describe("autobahn panel", () => {
  it("renders compact cards with logos and moves them by drag and drop", async () => {
    const moveThread = vi.fn(({ threadId, status }) => ({
      threadId,
      status,
    }));
    const clearStatusOverride = vi.fn(() => ({ ok: true as const }));
    const snoozeRoadmapItem = vi.fn(() => ({ ok: true as const }));
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listBoard: () => board,
          moveThread: async (input) => ({
            ...moveThread(input),
            warning: null,
          }),
          getDriver: () => ({ threadId: "driver-thread" }),
          clearStatusOverride,
          snoozeRoadmapItem,
          wakeRoadmapItem: () => ({ ok: true as const }),
          clearClosedCards: () => ({ cleared: 0 }),
        },
      },
    );

    expect(
      (await slot.findAllByRole("heading")).map((node) => node.textContent),
    ).toEqual(["OPEN", "WIP", "R4R", "CLOSED"]);
    expect(slot.getByText("Ship feature")).toBeTruthy();
    expect(slot.getByText("Top roadmap issue")).toBeTruthy();
    expect(slot.getByText("Captured")).toBeTruthy();
    expect(slot.getByRole("link", { name: "acme/repo#42" })).toBeTruthy();
    const expandRoadmap = slot.getByRole("button", {
      name: "Expand Open roadmap",
    });
    expect(expandRoadmap.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expandRoadmap);
    expect(
      slot
        .getByRole("button", { name: "Collapse Open roadmap" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    const expandClosed = slot.getByRole("button", {
      name: "Expand Closed lane",
    });
    expect(expandClosed.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(expandClosed);
    expect(
      slot
        .getByRole("button", { name: "Collapse Closed lane" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(slot.getByLabelText("Card state colors")).toBeTruthy();
    expect(
      slot.getByLabelText("Card state: Needs human attention"),
    ).toBeTruthy();
    expect(slot.getByLabelText("Card state: Idle or queued")).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", { name: "Snooze Top roadmap issue" }),
    );
    fireEvent.click(slot.getByRole("button", { name: "1 day" }));
    await vi.waitFor(() => {
      expect(snoozeRoadmapItem).toHaveBeenCalledWith(
        expect.objectContaining({
          itemKey: "issue:acme/repo#42",
          wakeAt: expect.any(Number),
        }),
      );
    });
    expect(slot.queryByText("codex")).toBeNull();
    expect(
      slot.container.querySelector('[data-icon="ChatGPT"]'),
    ).not.toBeNull();
    expect(slot.getByText("gpt-5.6 · high")).toBeTruthy();
    expect(slot.getByText("25%")).toBeTruthy();
    expect(slot.queryByText("Context 25%")).toBeNull();
    expect(slot.queryByRole("combobox")).toBeNull();
    expect(
      slot.getByLabelText(
        "Next action: Review the verified change",
      ),
    ).toBeTruthy();
    expect(
      slot.getByRole("button", { name: /Show Needs you filter/ }),
    ).toBeTruthy();
    expect(slot.getByLabelText("WIP: 1 of 3")).toBeTruthy();
    expect(slot.getByLabelText("Attention: Review requested")).toBeTruthy();
    expect(slot.getByText("Agentbox")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Auto" }));
    await vi.waitFor(() => {
      expect(clearStatusOverride).toHaveBeenCalledWith({ threadId: "thread-1" });
    });
    expect(
      slot.getByRole("link", { name: "PR #17" }).getAttribute("href"),
    ).toBe("https://github.com/acme/repo/pull/17");

    const card = slot.getByText("Ship feature").closest("article");
    const targetLane = slot.getByRole("heading", { name: "R4R" }).closest(
      "section",
    );
    expect(card).not.toBeNull();
    expect(targetLane).not.toBeNull();

    const transfer = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      setData: (type: string, value: string) => transfer.set(type, value),
      getData: (type: string) => transfer.get(type) ?? "",
    };
    fireEvent.dragStart(card!, { dataTransfer });
    fireEvent.dragOver(targetLane!, { dataTransfer });
    fireEvent.drop(targetLane!, { dataTransfer });

    await vi.waitFor(() => {
      expect(moveThread).toHaveBeenCalledWith({
        threadId: "thread-1",
        status: "R4R",
      });
    });
    slot.lifecycle.unmount();
  });

  it("shows parked work in Open with the waiting corner tick", async () => {
    const parkedBoard = structuredClone(board);
    const parkedCard = parkedBoard.lanes[1]!.cards.shift()!;
    parkedCard.status = "OPEN";
    parkedCard.runtimeStatus = "idle";
    parkedCard.workflow.gate = "none";
    parkedCard.workflow.exitStatus = "DONE";
    parkedCard.workflow.parkedWake = {
      kind: "timer",
      ref: null,
      until: 100,
    };
    parkedCard.attention = [];
    parkedBoard.lanes[0]!.cards.push(parkedCard);

    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listBoard: () => parkedBoard,
          moveThread: ({ threadId, status }) => ({
            threadId,
            status,
            warning: null,
          }),
          getDriver: () => ({ threadId: "driver-thread" }),
          clearStatusOverride: () => ({ ok: true as const }),
        },
      },
    );

    expect(
      await slot.findByLabelText("Card state: Parked or waiting"),
    ).toBeTruthy();
    const openLane = slot.getByRole("heading", { name: "OPEN" }).closest(
      "section",
    );
    expect(openLane?.textContent).toContain("Ship feature");
    slot.lifecycle.unmount();
  });

  it("clears Closed cards from the display without lifecycle actions", async () => {
    const closedBoard = structuredClone(board);
    const closedCard = closedBoard.lanes[1]!.cards.shift()!;
    closedCard.status = "CLOSED";
    closedCard.runtimeStatus = "idle";
    closedCard.workflow.phase = "complete";
    closedCard.workflow.gate = "none";
    closedCard.attention = [];
    closedBoard.lanes[3]!.cards.push(closedCard);
    const clearClosedCards = vi.fn(() => ({ cleared: 1 }));
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: {
          listBoard: () => closedBoard,
          moveThread: ({ threadId, status }) => ({
            threadId,
            status,
            warning: null,
          }),
          getDriver: () => ({ threadId: "driver-thread" }),
          clearStatusOverride: () => ({ ok: true as const }),
          snoozeRoadmapItem: () => ({ ok: true as const }),
          wakeRoadmapItem: () => ({ ok: true as const }),
          clearClosedCards,
        },
      },
    );

    const broom = await slot.findByRole("button", {
      name: "Clear Closed cards",
    });
    expect(broom).not.toHaveProperty("disabled", true);
    fireEvent.click(broom);
    await vi.waitFor(() => {
      expect(clearClosedCards).toHaveBeenCalledWith({});
    });
    slot.lifecycle.unmount();
  });

  it("opens and closes the persistent Driver thread in a side panel", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const header = renderSlot(
      { component: app.navPanels[0]!.headerContent! },
      {},
      {
        rpc: {
          listBoard: () => board,
          moveThread: ({ threadId, status }) => ({
            threadId,
            status,
            warning: null,
          }),
          getDriver: () => ({ threadId: "driver-thread" }),
        },
      },
    );

    fireEvent.click(
      header.getByRole("button", { name: "Open Autobahn Driver" }),
    );

    const panel = await screen.findByRole("dialog");
    expect(
      screen.getByRole("heading", { name: "Autobahn Driver" }),
    ).toBeTruthy();
    expect(panel.textContent).toContain(
      "Plan, dispatch, verify, gate, park, and witness coding sessions.",
    );

    const chat = await screen.findByTestId("bb-thread-chat");
    expect(chat.getAttribute("data-thread-id")).toBe("driver-thread");
    expect(chat.getAttribute("data-variant")).toBe("compact");
    expect(chat.getAttribute("data-layout")).toBe("contained");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    header.lifecycle.unmount();
  });

  it("requires an explicit human plan decision through the Driver interaction", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const submit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const interaction = renderSlot(
      app.pendingInteractions[0]!,
      {
        interaction: {
          id: "interaction-1",
          threadId: "driver-thread",
          title: "Autobahn plan approval",
          payload: {
            cardThreadId: "thread-1",
            objective: "Ship the workflow",
            recommendation: "Approve after adversarial review",
          },
          createdAt: 1,
          expiresAt: null,
        },
        submit,
        cancel,
      },
    );

    expect(
      interaction.getByText("Approve plan for thread-1?"),
    ).toBeTruthy();
    fireEvent.change(interaction.getByLabelText("Plan decision note"), {
      target: { value: "Looks good" },
    });
    fireEvent.click(
      interaction.getByRole("button", { name: "Approve plan" }),
    );
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledWith({
        approved: true,
        note: "Looks good",
      });
    });
    interaction.lifecycle.unmount();
  });

  it("requires explicit confirmation before capturing tracker work", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const submit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const interaction = renderSlot(
      app.pendingInteractions[1]!,
      {
        interaction: {
          id: "interaction-capture",
          threadId: "thread-1",
          title: "Capture tracker work",
          payload: {
            projectId: "project-1",
            title: "Document security boundary",
            description: "Capture the marketplace hardening follow-up.",
            acceptanceCriteria: ["Security model is documented"],
            labels: ["security", "documentation"],
          },
          createdAt: 1,
          expiresAt: null,
        },
        submit,
        cancel,
      },
    );

    expect(
      interaction.getByText("Capture this work in the issue tracker?"),
    ).toBeTruthy();
    expect(interaction.getByText("Document security boundary")).toBeTruthy();
    expect(interaction.getByText("Security model is documented")).toBeTruthy();
    expect(
      interaction.getByText("Labels: security, documentation"),
    ).toBeTruthy();
    fireEvent.click(
      interaction.getByRole("button", { name: "Capture work" }),
    );
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledWith({ approved: true });
    });
    interaction.lifecycle.unmount();
  });

  it("offers approve, send back, and snooze on the gate decision form", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const submit = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const interaction = renderSlot(
      app.pendingInteractions[2]!,
      {
        interaction: {
          id: "interaction-gate",
          threadId: "thread-1",
          title: "Autobahn gate decision",
          payload: {
            cardThreadId: "thread-1",
            cardTitle: "Gated card",
            objective: "Ship the gated feature",
            reason: "Merged pull request with verification evidence",
            evidence: [
              {
                label: "Verification panel: 4 lenses; 0 confirmed; 0 rejected",
              },
              {
                label: "PR #9",
                url: "https://github.com/acme/repo/pull/9",
              },
            ],
            concerns: ["low: flaky retry"],
          },
          createdAt: 1,
          expiresAt: null,
        },
        submit,
        cancel,
      },
    );

    expect(interaction.getByText("Approve DONE for Gated card?")).toBeTruthy();
    expect(interaction.getByText("PR #9")).toBeTruthy();
    expect(interaction.getByText("low: flaky retry")).toBeTruthy();
    fireEvent.change(interaction.getByLabelText("Gate decision note"), {
      target: { value: "Missing changelog" },
    });
    fireEvent.click(
      interaction.getByRole("button", { name: "Send back with gaps" }),
    );
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledWith({
        decision: "send-back",
        note: "Missing changelog",
      });
    });
    fireEvent.click(
      interaction.getByRole("button", { name: "Approve DONE" }),
    );
    await vi.waitFor(() => {
      expect(submit).toHaveBeenCalledWith({
        decision: "approve",
        note: "Missing changelog",
      });
    });
    interaction.lifecycle.unmount();
  });
});

function makeSidebarThread(
  overrides: Partial<PluginSidebarThread> & { id: string },
): PluginSidebarThread {
  return {
    projectId: "project-1",
    title: null,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "claude-code",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 1,
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 0,
    ...overrides,
  };
}

describe("autobahn board sidebar", () => {
  const sidebarProps = {
    activeThreadId: null as string | null,
    activeProjectId: null as string | null,
    isCompactViewport: false,
    onNavigate: () => undefined,
    searchQuery: "",
  };

  it("registers the thread list replacement slot", async () => {
    const app = await loadPluginApp(() => import("./app"));
    expect(app.threadLists.map((registration) => registration.id)).toEqual([
      "autobahn-board-sidebar",
    ]);
  });

  it("renders board lanes with the sidebar DOM contract and opens threads", async () => {
    const onNavigate = vi.fn();
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.threadLists[0]!,
      { ...sidebarProps, activeThreadId: "thread-1", onNavigate },
      {
        settings: { boardSidebar: true },
        rpc: { listBoard: () => board },
        sidebarThreads: {
          status: "ready",
          threads: [
            makeSidebarThread({
              id: "thread-1",
              title: "Ship feature",
              activity: {
                workflows: 1,
                backgroundAgents: 1,
                backgroundCommands: 0,
                planMode: 0,
                goals: 0,
              },
            }),
            makeSidebarThread({
              id: "thread-2",
              title: "Off-board exploration",
              indicator: "waiting-for-input",
              indicatorLabel: "Thread needs user input",
              updatedAt: 5,
            }),
          ],
        },
      },
    );

    // Wait for the board load; until it lands, cards sit under Other threads.
    await slot.findByRole("heading", { name: "NEEDS YOU · 1" });
    // The attention card renders in both the Needs-you rail and its lane.
    const rows = slot.getAllByRole("button", { name: /Ship feature/ });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.getAttribute("data-sidebar-thread-id")).toBe("thread-1");
      expect(row.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(
        true,
      );
      expect(row.getAttribute("aria-current")).toBe("true");
    }
    const row = rows[0]!;
    expect(slot.getByRole("heading", { name: "NEEDS YOU · 1" })).toBeTruthy();
    expect(
      slot.getByRole("heading", { name: /WIP.*1\/3.*2 agents/ }),
    ).toBeTruthy();
    expect(slot.getByRole("heading", { name: /R4R.*0\/6/ })).toBeTruthy();
    expect(slot.getByRole("heading", { name: "OTHER THREADS" })).toBeTruthy();
    expect(
      slot.getAllByLabelText("Attention: Review requested").length,
    ).toBeGreaterThan(0);
    expect(slot.getAllByLabelText("2 running agents").length).toBeGreaterThan(0);
    const other = slot.getByRole("button", { name: /Off-board exploration/ });
    expect(other.getAttribute("data-sidebar-thread-id")).toBe("thread-2");
    expect(slot.getByLabelText("Thread needs user input")).toBeTruthy();

    fireEvent.click(row);
    expect(slot.inspection.sidebarActionCalls).toContainEqual({
      method: "open",
      threadId: "thread-1",
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    slot.lifecycle.unmount();
  });

  it("filters lanes and other threads by the host search query", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(
      app.threadLists[0]!,
      { ...sidebarProps, searchQuery: "ship" },
      {
        settings: { boardSidebar: true },
        rpc: { listBoard: () => board },
        sidebarThreads: {
          status: "ready",
          threads: [
            makeSidebarThread({ id: "thread-2", title: "Off-board exploration" }),
          ],
        },
      },
    );

    expect(
      (await slot.findAllByRole("button", { name: /Ship feature/ })).length,
    ).toBeGreaterThan(0);
    expect(
      slot.queryByRole("button", { name: /Off-board exploration/ }),
    ).toBeNull();
    expect(slot.queryByRole("heading", { name: /OPEN/ })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("throws when the Board sidebar setting is off so bb falls back", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      expect(() =>
        renderSlot(app.threadLists[0]!, sidebarProps, {
          settings: { boardSidebar: false },
          rpc: { listBoard: () => board },
        }),
      ).toThrowError(/Board sidebar/);
    } finally {
      consoleError.mockRestore();
    }
  });
});
