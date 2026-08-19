// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
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
    },
  ],
  needsYouCount: 1,
};

describe("autobahn panel", () => {
  it("renders compact cards with logos and moves them by drag and drop", async () => {
    const moveThread = vi.fn(({ threadId, status }) => ({
      threadId,
      status,
    }));
    const clearStatusOverride = vi.fn(() => ({ ok: true as const }));
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
        },
      },
    );

    expect(
      (await slot.findAllByRole("heading")).map((node) => node.textContent),
    ).toEqual(["OPEN", "WIP", "R4R", "CLOSED"]);
    expect(slot.getByText("Ship feature")).toBeTruthy();
    expect(slot.getByText("Top roadmap issue")).toBeTruthy();
    expect(slot.getByRole("link", { name: "acme/repo#42" })).toBeTruthy();
    expect(slot.getByLabelText("Card state colors")).toBeTruthy();
    expect(
      slot.getByLabelText("Card state: Needs human attention"),
    ).toBeTruthy();
    expect(slot.getByLabelText("Card state: Idle or queued")).toBeTruthy();
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
});
