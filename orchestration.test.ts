import { describe, expect, it } from "vitest";
import {
  OrchestrationTimeoutError,
  parseFindingValidation,
  parsePlanContract,
  parsePlanReview,
  parseVerificationLensReport,
  runPlanWorkflow,
  runVerificationWorkflow,
  type ChildRole,
  type ChildSessionAdapter,
  type ChildSpawnInput,
} from "./orchestration";

const PLAN = {
  summary: "Implement the workflow end to end.",
  scope: ["Autobahn orchestration"],
  outOfScope: ["External issue trackers"],
  implementationSteps: ["Add a typed orchestration module"],
  acceptanceCriteria: ["Fresh reviewers validate every plan"],
  verification: ["Run unit tests"],
  risks: ["Agent output can be malformed"],
  openQuestions: [],
};

const EVIDENCE = {
  description: "The guard is missing",
  path: "src/worker.ts",
  url: null,
  line: 42,
};

class FakeAdapter implements ChildSessionAdapter {
  readonly spawns: ChildSpawnInput[] = [];
  readonly stopped: string[] = [];
  readonly activeByRole = new Map<ChildRole, number>();
  readonly maxActiveByRole = new Map<ChildRole, number>();
  private readonly roleOutputs: Record<ChildRole, string[]> = {
    planner: [],
    "plan-reviewer": [],
    "verification-lens": [],
    "finding-validator": [],
  };
  delayMs = 0;
  hangRoles = new Set<ChildRole>();

  queue(role: ChildRole, ...outputs: Array<string | object>) {
    this.roleOutputs[role].push(
      ...outputs.map((output) =>
        typeof output === "string" ? output : JSON.stringify(output),
      ),
    );
    return this;
  }

  async spawnChild(input: ChildSpawnInput, options: { signal: AbortSignal }) {
    if (options.signal.aborted) throw options.signal.reason;
    this.spawns.push(input);
    return { threadId: `child-${this.spawns.length}` };
  }

  async waitForChild({
    threadId,
    signal,
  }: {
    threadId: string;
    signal: AbortSignal;
  }) {
    const spawn = this.spawns[Number(threadId.split("-")[1]) - 1]!;
    const role = spawn.role;
    const active = (this.activeByRole.get(role) ?? 0) + 1;
    this.activeByRole.set(role, active);
    this.maxActiveByRole.set(
      role,
      Math.max(this.maxActiveByRole.get(role) ?? 0, active),
    );

    try {
      if (this.hangRoles.has(role)) {
        // The orchestrator must enforce cancellation even if an adapter wait ignores it.
        await new Promise<void>(() => undefined);
      } else if (this.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, this.delayMs);
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      }
      const output = this.roleOutputs[role].shift();
      if (output === undefined) throw new Error(`No queued output for ${role}`);
      return output;
    } finally {
      this.activeByRole.set(role, (this.activeByRole.get(role) ?? 1) - 1);
    }
  }

  async stopChild({ threadId }: { threadId: string }) {
    this.stopped.push(threadId);
  }
}

const COMMON = {
  projectId: "project-1",
  environmentId: "environment-1",
  parentThreadId: "parent-thread",
  controllerThreadId: "controller-thread",
  objective: "Ship reliable workflow orchestration.",
  context: "The implementation is in the shared controller environment.",
};

describe("plan orchestration", () => {
  it("runs a read-only planner followed by a fresh adversarial reviewer", async () => {
    const adapter = new FakeAdapter()
      .queue("planner", PLAN)
      .queue(
        "plan-reviewer",
        "VERDICT: ACCEPT\nSUMMARY: Complete and verifiable.\nCONCERNS:\nREQUIRED CHANGES:",
      );

    const result = await runPlanWorkflow(adapter, COMMON);

    expect(result).toMatchObject({
      outcome: "accepted",
      accepted: true,
      revisions: 0,
      attempts: 1,
      plan: PLAN,
      review: { verdict: "ACCEPT" },
    });
    expect(adapter.spawns.map((spawn) => spawn.role)).toEqual([
      "planner",
      "plan-reviewer",
    ]);
    expect(adapter.spawns).toEqual(
      adapter.spawns.map((spawn) =>
        expect.objectContaining({
          projectId: "project-1",
          environmentId: "environment-1",
          parentThreadId: "parent-thread",
          controllerThreadId: "controller-thread",
          hidden: true,
          readOnly: true,
        }),
      ),
    );
    expect(adapter.spawns[1]!.prompt).toContain(JSON.stringify(PLAN));
    expect(adapter.spawns[1]!.prompt).toContain("Controller thread ID: controller-thread");
    expect(adapter.stopped).toEqual(["child-1", "child-2"]);
  });

  it("allows at most two revision rounds and uses fresh children for every pass", async () => {
    const revise = {
      verdict: "REVISE",
      summary: "Missing a check.",
      concerns: ["No failure-path coverage"],
      requiredChanges: ["Add failure-path coverage"],
    };
    const adapter = new FakeAdapter()
      .queue("planner", PLAN, PLAN, PLAN)
      .queue("plan-reviewer", revise, revise, revise);

    const result = await runPlanWorkflow(adapter, COMMON);

    expect(result).toMatchObject({
      outcome: "rejected",
      accepted: false,
      revisions: 2,
      attempts: 3,
    });
    expect(adapter.spawns).toHaveLength(6);
    expect(new Set(adapter.stopped)).toEqual(
      new Set(["child-1", "child-2", "child-3", "child-4", "child-5", "child-6"]),
    );
    expect(adapter.spawns[2]!.prompt).toContain("Revise the prior plan");
    expect(adapter.spawns[2]!.prompt).toContain("No failure-path coverage");
  });

  it("returns typed needs-context and blocked exits without starting another round", async () => {
    const adapter = new FakeAdapter()
      .queue("planner", PLAN)
      .queue("plan-reviewer", {
        verdict: "NEEDS_CONTEXT",
        summary: "The API contract is missing.",
        concerns: ["Unknown API"],
        requiredChanges: ["Ask for the API contract"],
      });

    await expect(runPlanWorkflow(adapter, COMMON)).resolves.toMatchObject({
      outcome: "needs-context",
      accepted: false,
      attempts: 1,
    });
    expect(adapter.spawns).toHaveLength(2);
    expect(adapter.stopped).toHaveLength(2);
  });
});

describe("verification orchestration", () => {
  it("rejects empty verification panels", async () => {
    await expect(
      runVerificationWorkflow(new FakeAdapter(), {
        ...COMMON,
        lenses: [],
      }),
    ).rejects.toThrow("at least one lens");
  });

  it("rejects a verification run whose signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Already cancelled"));
    await expect(
      runVerificationWorkflow(
        new FakeAdapter(),
        {
          ...COMMON,
          lenses: [
            {
              id: "correctness",
              title: "Correctness",
              instructions: "Inspect correctness.",
            },
          ],
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("Already cancelled");
  });

  it("runs lenses in parallel, validates every proposed finding fresh, and drops rejections", async () => {
    const adapter = new FakeAdapter();
    adapter.delayMs = 10;
    adapter
      .queue("verification-lens", {
        verdict: "FINDINGS",
        summary: "Two possible defects.",
        findings: [
          {
            title: "Missing cancellation guard",
            severity: "medium",
            summary: "Cancellation can leave work running.",
            evidence: [EVIDENCE],
            recommendation: "Stop the child in finally.",
          },
          {
            title: "False alarm",
            severity: "high",
            summary: "This looked unsafe.",
            evidence: [],
            recommendation: "Change it.",
          },
        ],
      })
      .queue("verification-lens", "VERDICT: PASS\nSUMMARY: Tests cover the contract.")
      .queue("finding-validator", {
        verdict: "CONFIRMED",
        summary: "The missing guard is reproducible.",
        severity: "high",
        evidence: [
          {
            description: "Abort path does not stop the child",
            path: "src/worker.ts",
            url: null,
            line: 44,
          },
        ],
      })
      .queue("finding-validator", {
        verdict: "REJECTED",
        summary: "The existing guard handles this case.",
        severity: null,
        evidence: [],
      });

    const result = await runVerificationWorkflow(adapter, {
      ...COMMON,
      lenses: [
        { id: "correctness", title: "Correctness", instructions: "Find behavioral bugs." },
        { id: "tests", title: "Tests", instructions: "Find missing test coverage." },
      ],
    });

    expect(adapter.maxActiveByRole.get("verification-lens")).toBe(2);
    expect(adapter.maxActiveByRole.get("finding-validator")).toBe(2);
    expect(result.counts).toEqual({
      lenses: 2,
      proposed: 2,
      confirmed: 1,
      rejected: 1,
      inconclusive: 0,
    });
    expect(result.confirmedFindings).toEqual([
      expect.objectContaining({
        id: "correctness:1",
        originalSeverity: "medium",
        severity: "high",
        validationSummary: "The missing guard is reproducible.",
      }),
    ]);
    expect(result.evidence).toEqual([
      expect.objectContaining({
        findingId: "correctness:1",
        lensId: "correctness",
        line: 44,
      }),
    ]);
    expect(adapter.spawns.every((spawn) => spawn.hidden && spawn.readOnly)).toBe(true);
    expect(adapter.stopped).toHaveLength(4);
  });

  it("keeps needs-context validations separate from confirmed evidence", async () => {
    const adapter = new FakeAdapter()
      .queue("verification-lens", {
        verdict: "FINDINGS",
        summary: "One uncertain issue.",
        findings: [
          {
            title: "Remote-only race",
            severity: "low",
            summary: "The race needs a remote host to reproduce.",
            evidence: [],
            recommendation: "Reproduce remotely.",
          },
        ],
      })
      .queue(
        "finding-validator",
        "VERDICT: NEEDS CONTEXT\nSUMMARY: A remote reproduction is required.\nSEVERITY:\nEVIDENCE:",
      );

    const result = await runVerificationWorkflow(adapter, {
      ...COMMON,
      lenses: [{ id: "runtime", title: "Runtime", instructions: "Inspect races." }],
    });

    expect(result.counts).toMatchObject({ proposed: 1, confirmed: 0, inconclusive: 1 });
    expect(result.confirmedFindings).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("cancels sibling workers on failure and still stops every spawned child", async () => {
    const adapter = new FakeAdapter()
      .queue("verification-lens", "not a verdict")
      .queue("verification-lens", { verdict: "PASS", summary: "Clean.", findings: [] });
    adapter.delayMs = 5;

    await expect(
      runVerificationWorkflow(adapter, {
        ...COMMON,
        lenses: [
          { id: "one", title: "One", instructions: "Inspect one." },
          { id: "two", title: "Two", instructions: "Inspect two." },
        ],
      }),
    ).rejects.toThrow(/strict JSON or start with VERDICT/);
    expect(adapter.stopped).toHaveLength(2);
  });
});

describe("cancellation and parsing", () => {
  it("enforces child timeouts and stops the timed-out hidden child", async () => {
    const adapter = new FakeAdapter().queue("planner", PLAN);
    adapter.hangRoles.add("planner");

    await expect(
      runPlanWorkflow(adapter, COMMON, { childTimeoutMs: 10 }),
    ).rejects.toBeInstanceOf(OrchestrationTimeoutError);
    expect(adapter.stopped).toEqual(["child-1"]);
  });

  it("honors caller cancellation and stops an in-flight hidden child", async () => {
    const adapter = new FakeAdapter().queue("planner", PLAN);
    adapter.hangRoles.add("planner");
    const controller = new AbortController();
    const running = runPlanWorkflow(adapter, COMMON, { signal: controller.signal });
    const outcome = running.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.resolve();
    controller.abort(new Error("User cancelled"));

    const error = await outcome;
    expect(error).toEqual(expect.objectContaining({ message: "User cancelled" }));
    expect(adapter.stopped).toEqual(["child-1"]);
  });

  it("accepts fenced strict JSON but rejects extra keys and surrounding prose", () => {
    expect(parsePlanContract(`\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``)).toEqual(PLAN);
    expect(() => parsePlanContract(JSON.stringify({ ...PLAN, extra: true }))).toThrow(
      /Unrecognized key/,
    );
    expect(() => parsePlanContract(`Here is the plan: ${JSON.stringify(PLAN)}`)).toThrow(
      /not valid JSON/,
    );
  });

  it("parses clear verdict forms and preserves strict typed invariants", () => {
    expect(
      parsePlanReview(
        "VERDICT: REVISE\nSUMMARY: Missing checks.\nCONCERNS:\n- Error paths\nREQUIRED CHANGES:\n- Add an abort test",
      ),
    ).toEqual({
      verdict: "REVISE",
      summary: "Missing checks.",
      concerns: ["Error paths"],
      requiredChanges: ["Add an abort test"],
    });
    expect(parseVerificationLensReport("PASS\nSUMMARY: No concrete defects.")).toEqual({
      verdict: "PASS",
      summary: "No concrete defects.",
      findings: [],
    });
    expect(
      parseFindingValidation(
        "VERDICT: CONFIRMED\nSUMMARY: Reproduced.\nSEVERITY: HIGH\nEVIDENCE:\n- Fails at worker.ts:42",
      ),
    ).toEqual({
      verdict: "CONFIRMED",
      summary: "Reproduced.",
      severity: "high",
      evidence: [
        {
          description: "Fails at worker.ts:42",
          path: null,
          url: null,
          line: null,
        },
      ],
    });
    expect(() =>
      parseFindingValidation(
        JSON.stringify({
          verdict: "CONFIRMED",
          summary: "Reproduced.",
          severity: null,
          evidence: [],
        }),
      ),
    ).toThrow(/independently assign severity/);
  });
});
