// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvidenceConcernsIndicator,
  LaneCapacity,
  NeedsYouStrip,
  NextAction,
  WorkflowGateBadge,
  WorkflowMetadata,
} from "./workflow-meta";

afterEach(cleanup);

describe("workflow card metadata", () => {
  it("renders an accessible attention badge and omits an empty gate", () => {
    const { rerender } = render(<WorkflowGateBadge gate="checks-failed" />);

    expect(screen.getByLabelText("Attention: Checks failed").textContent).toBe(
      "Checks",
    );
    expect(document.querySelector('[data-icon="AlertTriangle"]')).not.toBeNull();

    rerender(<WorkflowGateBadge gate="none" />);
    expect(screen.queryByLabelText("Attention: Checks failed")).toBeNull();
  });

  it("compresses phase, priority, and risk while preserving full labels", () => {
    render(
      <WorkflowMetadata phase="verify" priority="urgent" risk="critical" />,
    );

    expect(screen.getByLabelText("Phase: Verify").textContent).toBe("verify");
    expect(screen.getByLabelText("Priority: Urgent").textContent).toBe("P0");
    expect(screen.getByLabelText("Risk: Critical").textContent).toBe("R4");
  });

  it("shows one-line next action and evidence or concern totals", () => {
    render(
      <>
        <NextAction action="Approve the plan before implementation" />
        <EvidenceConcernsIndicator evidenceCount={3} concernsCount={1} />
      </>,
    );

    expect(
      screen.getByLabelText(
        "Next action: Approve the plan before implementation",
      ).textContent,
    ).toBe("Next:Approve the plan before implementation");
    expect(
      screen.getByLabelText("3 evidence items; 1 concern").textContent,
    ).toBe("31");
    expect(document.querySelector('[data-icon="ExternalLink"]')).not.toBeNull();
  });
});

describe("workflow board summaries", () => {
  it("toggles the Needs you filter and summarizes its reasons", () => {
    const onActiveChange = vi.fn();
    render(
      <NeedsYouStrip
        count={3}
        active={false}
        reasons={[
          { gate: "needs-input", count: 2 },
          { gate: "blocked", count: 1 },
        ]}
        onActiveChange={onActiveChange}
      />,
    );

    const control = screen.getByRole("button", {
      name: /Show Needs you filter/,
    });
    expect(control.getAttribute("aria-pressed")).toBe("false");
    expect(control.textContent).toContain("Needs input: 2; Blocked: 1");
    fireEvent.click(control);
    expect(onActiveChange).toHaveBeenCalledWith(true);
  });

  it("disables an empty inactive attention filter", () => {
    render(
      <NeedsYouStrip
        count={0}
        active={false}
        onActiveChange={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Show Needs you filter/ }).hasAttribute(
        "disabled",
      ),
    ).toBe(true);
  });

  it("shows normal capacity and a soft overflow warning", () => {
    const { rerender } = render(
      <LaneCapacity count={2} limit={3} laneLabel="WIP" />,
    );
    expect(screen.getByLabelText("WIP: 2 of 3").textContent).toBe("2/3");

    rerender(<LaneCapacity count={5} limit={3} laneLabel="WIP" />);
    expect(
      screen.getByLabelText("WIP: 5 of 3; soft limit exceeded by 2").textContent,
    ).toBe("5/3");
    expect(document.querySelector('[data-icon="AlertTriangle"]')).not.toBeNull();
  });
});
