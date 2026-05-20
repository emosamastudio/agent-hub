import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import {
  AgentCreatePanel,
  AgentDirectoryPanel,
  AgentSettingsPanel,
  ExecutionSummaryPanel,
  ExecutionFilterPanel,
  ExecutionHistoryPager,
  ExecutionPayloadPanel,
  AgentTriggerPanel,
  AlertPanel,
} from "./App";
import {
  agentSettingsPatchFromForm,
  executionDisplayTime,
  executionQueryParamsFromFilters,
  parseTriggerPayload,
} from "./lib/dashboard-helpers";

describe("AgentDirectoryPanel", () => {
  test("renders all agent statuses without the executions feed heading", () => {
    const html = renderToStaticMarkup(
      <AgentDirectoryPanel
        projects={[
          {
            id: "project-1",
            name: "default",
            displayName: "Default Project",
          },
        ]}
        agents={[
          {
            id: "agent-1",
            projectId: "project-1",
            name: "open_source_project_hunter_scan",
            displayName: "Open Source Hunter Scan",
            agentType: "cron",
            cronExpression: "0 8 * * *",
            enabled: true,
            executorStatus: "online",
            activeExecutionCount: 0,
            lastExecutionAt: null,
            lastHeartbeatAt: null,
            recentExecutions: [
              {
                id: "execution-1",
                agentId: "agent-1",
                triggerType: "cron",
                status: "success",
                triggeredBy: null,
                startedAt: null,
                finishedAt: null,
                durationMs: null,
                resultSummary: null,
                errorMessage: null,
                traceCountActual: 0,
              },
            ],
          },
          {
            id: "agent-2",
            projectId: "project-1",
            name: "llm_wiki_refresh",
            displayName: "LLM Wiki Refresh",
            agentType: "cron",
            cronExpression: null,
            enabled: true,
            executorStatus: "offline",
            activeExecutionCount: 0,
            lastExecutionAt: null,
            lastHeartbeatAt: null,
            recentExecutions: [],
          },
        ]}
        eyebrow="Agents"
        title="Agent Status"
        description="All registered agents, executor status, schedules, and quick actions."
        emptyTitle="No agents registered"
        emptyDescription="Agents will appear here once they connect or are configured."
        onOpenAgent={vi.fn()}
        onToggleAgent={vi.fn()}
        onTriggerAgent={vi.fn()}
        onDeleteAgent={vi.fn()}
      />,
    );

    expect(html).toContain("Agent Status");
    expect(html).toContain("Default Project");
    expect(html).toContain("Open Source Hunter Scan");
    expect(html).toContain("LLM Wiki Refresh");
    expect(html).toContain("online");
    expect(html).toContain("offline");
    expect(html).toContain("Delete");
    expect(html).not.toContain("Recent Executions");
  });

  test("renders scheduler diagnostics beside each active agent", () => {
    const html = renderToStaticMarkup(
      <AgentDirectoryPanel
        projects={[
          {
            id: "project-1",
            name: "default",
            displayName: "Default Project",
          },
        ]}
        agents={[
          {
            id: "agent-1",
            projectId: "project-1",
            name: "daily_digest",
            displayName: "Daily Digest",
            agentType: "cron_task",
            cronExpression: "*/5 * * * *",
            enabled: true,
            executorStatus: "online",
            activeExecutionCount: 0,
            lastExecutionAt: null,
            lastHeartbeatAt: null,
            recentExecutions: [],
          },
        ]}
        schedulerStatus={{
          generatedAt: "2026-05-20T10:00:00.000Z",
          scheduler: {
            tickMs: 1000,
            executionRetentionDays: 30,
            traceRetentionDays: 7,
          },
          agents: [
            {
              id: "agent-1",
              name: "daily_digest",
              displayName: "Daily Digest",
              enabled: true,
              executorStatus: "online",
              cronExpression: "*/5 * * * *",
              queuedCount: 1,
              runningCount: 0,
              pendingCount: 1,
              activeExecutionCount: 0,
              concurrency: 2,
              capacityAvailable: 2,
              maxPendingQueue: 1,
              queueAvailable: 0,
              dispatchState: "dispatchable",
              scheduleState: "queue_full",
              dueRunAt: "2026-05-20T10:05:00.000Z",
              nextRunAt: "2026-05-20T10:10:00.000Z",
              cronError: null,
            },
          ],
        }}
        eyebrow="Agents"
        title="Agent Status"
        description="All registered agents, executor status, schedules, and quick actions."
        emptyTitle="No agents registered"
        emptyDescription="Agents will appear here once they connect or are configured."
        onOpenAgent={vi.fn()}
        onToggleAgent={vi.fn()}
        onTriggerAgent={vi.fn()}
        onDeleteAgent={vi.fn()}
      />,
    );

    expect(html).toContain("Dispatch");
    expect(html).toContain("Schedule");
    expect(html).toContain("dispatchable");
    expect(html).toContain("queue_full");
    expect(html).toContain("1 / 1 pending");
    expect(html).toContain("2 / 2 free");
  });

  test("can render an archived agent history list without lifecycle actions", () => {
    const html = renderToStaticMarkup(
      <AgentDirectoryPanel
        projects={[
          {
            id: "project-1",
            name: "default",
            displayName: "Default Project",
          },
        ]}
        agents={[
          {
            id: "agent-archived",
            projectId: "project-1",
            name: "archived_daily_digest",
            displayName: "Archived Daily Digest",
            agentType: "cron_task",
            cronExpression: "0 8 * * *",
            enabled: false,
            executorStatus: "offline",
            activeExecutionCount: 0,
            lastExecutionAt: "2026-05-20T08:00:00.000Z",
            lastHeartbeatAt: null,
            archivedAt: "2026-05-20T09:00:00.000Z",
            recentExecutions: [],
          },
        ]}
        eyebrow="Archive"
        title="Archived Agents"
        description="Archived agents are hidden from scheduling but keep execution history."
        emptyTitle="No archived agents"
        emptyDescription="Deleted agents will appear here after they have no active executions."
        showLifecycleActions={false}
        onOpenAgent={vi.fn()}
        onToggleAgent={vi.fn()}
        onTriggerAgent={vi.fn()}
        onDeleteAgent={vi.fn()}
      />,
    );

    expect(html).toContain("Archived Agents");
    expect(html).toContain("Archived Daily Digest");
    expect(html).toContain("Archive");
    expect(html).not.toContain("Run");
    expect(html).not.toContain("Drain");
    expect(html).not.toContain("Delete");
    expect(html).not.toContain("Enable");
  });
});

describe("AgentCreatePanel", () => {
  test("renders a dashboard agent creation form", () => {
    const html = renderToStaticMarkup(
      <AgentCreatePanel
        projects={[
          {
            id: "project-1",
            name: "default",
            displayName: "Default Project",
          },
        ]}
        values={{
          projectId: "project-1",
          name: "daily_digest",
          displayName: "Daily Digest",
          description: "Runs the daily digest workflow and reports delivery status.",
          agentType: "cron_task",
          cronExpression: "0 8 * * *",
          handlerName: "daily_digest",
          concurrency: "1",
          timeoutSeconds: "600",
          retryMax: "3",
          maxPendingQueue: "100",
        }}
        busy={false}
        error={null}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(html).toContain("New Agent");
    expect(html).toContain("Default Project");
    expect(html).toContain("daily_digest");
    expect(html).toContain("0 8 * * *");
  });
});

describe("parseTriggerPayload", () => {
  test("parses object payloads and rejects invalid payloads", () => {
    expect(parseTriggerPayload('{ "topic": "daily", "limit": 3 }')).toEqual({
      topic: "daily",
      limit: 3,
    });
    expect(parseTriggerPayload("   ")).toEqual({});
    expect(() => parseTriggerPayload("[1, 2, 3]")).toThrow("JSON object");
    expect(() => parseTriggerPayload("{")).toThrow("valid JSON");
  });
});

describe("AgentTriggerPanel", () => {
  test("renders manual trigger payload controls", () => {
    const html = renderToStaticMarkup(
      <AgentTriggerPanel
        payloadText={'{ "topic": "daily" }'}
        busy={false}
        error={null}
        onPayloadChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(html).toContain("Manual Trigger");
    expect(html).toContain("Payload JSON");
    expect(html).toContain("topic");
    expect(html).toContain("Trigger Now");
  });
});

describe("agentSettingsPatchFromForm", () => {
  test("normalizes editable agent settings for the patch API", () => {
    expect(agentSettingsPatchFromForm({
      displayName: " Daily Digest ",
      cronExpression: " ",
      handlerName: " daily_digest ",
      misfirePolicy: "drop",
      concurrency: "2",
      maxPendingQueue: "25",
      timeoutSeconds: "120",
      retryMax: "4",
      retryBackoffBaseMs: "15000",
      idempotencyWindowSeconds: "300",
    })).toEqual({
      displayName: "Daily Digest",
      cronExpression: null,
      handlerName: "daily_digest",
      misfirePolicy: "drop",
      concurrency: 2,
      maxPendingQueue: 25,
      timeoutSeconds: 120,
      retryMax: 4,
      retryBackoffBaseMs: 15000,
      idempotencyWindowSeconds: 300,
    });
  });

  test("rejects invalid numeric settings", () => {
    expect(() => agentSettingsPatchFromForm({
      displayName: "Daily Digest",
      cronExpression: "0 8 * * *",
      handlerName: "daily_digest",
      misfirePolicy: "fire_once",
      concurrency: "0",
      maxPendingQueue: "25",
      timeoutSeconds: "120",
      retryMax: "4",
      retryBackoffBaseMs: "15000",
      idempotencyWindowSeconds: "300",
    })).toThrow("Concurrency");
  });
});

describe("AgentSettingsPanel", () => {
  test("renders editable scheduler and runtime settings", () => {
    const html = renderToStaticMarkup(
      <AgentSettingsPanel
        values={{
          displayName: "Daily Digest",
          cronExpression: "0 8 * * *",
          handlerName: "daily_digest",
          misfirePolicy: "fire_once",
          concurrency: "1",
          maxPendingQueue: "100",
          timeoutSeconds: "600",
          retryMax: "3",
          retryBackoffBaseMs: "30000",
          idempotencyWindowSeconds: "3600",
        }}
        busy={false}
        error={null}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(html).toContain("Agent Settings");
    expect(html).toContain("Display name");
    expect(html).toContain("Cron");
    expect(html).toContain("Concurrency");
    expect(html).toContain("Save Settings");
  });
});

describe("ExecutionPayloadPanel", () => {
  test("renders the execution input payload as formatted JSON", () => {
    const html = renderToStaticMarkup(
      <ExecutionPayloadPanel
        payload={{
          source: "dashboard",
          nested: { limit: 3 },
        }}
      />,
    );

    expect(html).toContain("Input Payload");
    expect(html).toContain("&quot;source&quot;: &quot;dashboard&quot;");
    expect(html).toContain("&quot;limit&quot;: 3");
  });
});

describe("ExecutionSummaryPanel", () => {
  test("renders scheduled and created timestamps for queued executions", () => {
    const html = renderToStaticMarkup(
      <ExecutionSummaryPanel
        execution={{
          id: "execution-1",
          agentId: "agent-1",
          triggerType: "manual",
          triggeredBy: "user:dashboard",
          status: "queued",
          scheduledAt: "2026-05-20T01:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          durationMs: null,
          resultSummary: null,
          errorMessage: null,
          inputPayload: null,
          traceCountActual: 0,
          createdAt: "2026-05-20T00:59:00.000Z",
        }}
      />,
    );

    expect(html).toContain("Scheduled");
    expect(html).toContain("Started");
    expect(html).toContain("Created");
    expect(html).toContain("2026");
    expect(html).toContain("agent-1");
  });

  test("renders reported progress for running executions", () => {
    const execution: Parameters<typeof ExecutionSummaryPanel>[0]["execution"] = {
      id: "execution-1",
      agentId: "agent-1",
      triggerType: "manual",
      triggeredBy: "user:dashboard",
      status: "running",
      scheduledAt: "2026-05-20T01:00:00.000Z",
      startedAt: "2026-05-20T01:01:00.000Z",
      finishedAt: null,
      durationMs: null,
      resultSummary: null,
      errorMessage: null,
      inputPayload: null,
      traceCountActual: 0,
      createdAt: "2026-05-20T00:59:00.000Z",
      progressPercent: 42,
      progressMessage: "Halfway through extraction",
    };

    const html = renderToStaticMarkup(
      <ExecutionSummaryPanel execution={execution} />,
    );

    expect(html).toContain("Progress");
    expect(html).toContain("42%");
    expect(html).toContain("Halfway through extraction");
  });
});

describe("executionQueryParamsFromFilters", () => {
  test("maps dashboard filters to execution query parameters", () => {
    expect(executionQueryParamsFromFilters({
      agentId: "agent-1",
      status: "failed",
      triggerType: "manual",
    }, {
      limit: 25,
      offset: 50,
    })).toEqual({
      limit: "25",
      offset: "50",
      agent_id: "agent-1",
      status: "failed",
      trigger_type: "manual",
    });
    expect(executionQueryParamsFromFilters({
      agentId: "",
      status: "",
      triggerType: "",
    })).toEqual({ limit: "50" });
  });
});

describe("executionDisplayTime", () => {
  test("falls back to scheduled and created time before rendering a dash", () => {
    expect(executionDisplayTime({
      startedAt: null,
      scheduledAt: "2026-05-20T01:00:00.000Z",
      createdAt: "2026-05-20T00:59:00.000Z",
    })).toBe("2026-05-20T01:00:00.000Z");

    expect(executionDisplayTime({
      startedAt: null,
      scheduledAt: null,
      createdAt: "2026-05-20T00:59:00.000Z",
    })).toBe("2026-05-20T00:59:00.000Z");
  });
});

describe("ExecutionFilterPanel", () => {
  test("renders execution filter controls", () => {
    const html = renderToStaticMarkup(
      <ExecutionFilterPanel
        agents={[
          {
            id: "agent-1",
            projectId: "project-1",
            name: "daily_digest",
            displayName: "Daily Digest",
            agentType: "cron_task",
            cronExpression: "0 8 * * *",
            enabled: true,
            executorStatus: "online",
            activeExecutionCount: 0,
            lastExecutionAt: null,
            lastHeartbeatAt: null,
          },
        ]}
        values={{
          agentId: "agent-1",
          status: "failed",
          triggerType: "manual",
        }}
        loading={false}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    expect(html).toContain("Execution Filters");
    expect(html).toContain("Daily Digest");
    expect(html).toContain("failed");
    expect(html).toContain("manual");
    expect(html).toContain("Reset Filters");
  });
});

describe("ExecutionHistoryPager", () => {
  test("renders a load-more control for longer execution history", () => {
    const html = renderToStaticMarkup(
      <ExecutionHistoryPager
        visibleCount={50}
        canLoadMore={true}
        loading={false}
        onLoadMore={vi.fn()}
      />,
    );

    expect(html).toContain("Showing 50 executions");
    expect(html).toContain("Load More");
  });
});

describe("AlertPanel", () => {
  test("renders recent operational alerts", () => {
    const html = renderToStaticMarkup(
      <AlertPanel
        alerts={[
          {
            id: 1,
            ruleName: "consecutive_failures",
            severity: "critical",
            agentId: "agent-1",
            agentName: "daily_digest",
            agentDisplayName: "Daily Digest",
            message: "Daily Digest has 3 consecutive failed or timed out executions.",
            context: {},
            createdAt: "2026-05-20T00:00:00.000Z",
          },
          {
            id: 2,
            ruleName: "queue_depth_high",
            severity: "warning",
            agentId: "agent-2",
            agentName: "queue_worker",
            agentDisplayName: "Queue Worker",
            message: "Queue Worker has 12 queued executions.",
            context: {},
            createdAt: "2026-05-20T00:01:00.000Z",
          },
          {
            id: 3,
            ruleName: "queue_depth_high",
            severity: "warning",
            agentId: "agent-2",
            agentName: "queue_worker",
            agentDisplayName: "Queue Worker",
            message: "Older duplicate queue alert should not be shown.",
            context: {},
            createdAt: "2026-05-19T23:50:00.000Z",
          },
        ]}
      />,
    );

    expect(html).toContain("Operational Alerts");
    expect(html).toContain("Daily Digest");
    expect(html).toContain("critical");
    expect(html).toContain("Queue Worker");
    expect(html).toContain("warning");
    expect(html).not.toContain("Older duplicate queue alert");
  });

  test("renders alert acknowledgement actions", () => {
    const html = renderToStaticMarkup(
      <AlertPanel
        alerts={[
          {
            id: 1,
            ruleName: "queue_depth_high",
            severity: "warning",
            agentId: "agent-1",
            agentName: "queue_worker",
            agentDisplayName: "Queue Worker",
            message: "Queue Worker has 12 queued executions.",
            context: {},
            createdAt: "2026-05-20T00:01:00.000Z",
          },
        ]}
        onAcknowledge={vi.fn()}
        actionBusyAlertId={null}
      />,
    );

    expect(html).toContain("Acknowledge");
  });

  test("renders an empty alert state", () => {
    const html = renderToStaticMarkup(<AlertPanel alerts={[]} />);

    expect(html).toContain("Operational Alerts");
    expect(html).toContain("No active alerts");
  });
});
