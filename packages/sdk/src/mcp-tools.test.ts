import { describe, expect, test, vi } from "vitest";
import { createAgentHubMcpTools } from "./mcp-tools";

describe("Agent Hub MCP tools", () => {
  test("exposes a compact agent control-plane tool set", () => {
    const tools = createAgentHubMcpTools({} as any);

    expect(tools.map((tool) => tool.name)).toEqual([
      "agent_hub_health",
      "agent_hub_ready",
      "agent_hub_get_metrics",
      "agent_hub_doctor",
      "agent_hub_get_ops_status",
      "agent_hub_observe_ops_status",
      "agent_hub_get_recovery_plan",
      "agent_hub_get_recovery_drill_plan",
      "agent_hub_run_recovery_drill",
      "agent_hub_run_release_check",
      "agent_hub_list_projects",
      "agent_hub_ensure_project",
      "agent_hub_create_project",
      "agent_hub_rotate_project_api_key",
      "agent_hub_drain_project",
      "agent_hub_set_project_enabled",
      "agent_hub_get_scheduler_status",
      "agent_hub_list_executors",
      "agent_hub_list_alerts",
      "agent_hub_acknowledge_alert",
      "agent_hub_list_agents",
      "agent_hub_get_agent",
      "agent_hub_create_agent",
      "agent_hub_update_agent",
      "agent_hub_preview_agent_schedule",
      "agent_hub_delete_agent",
      "agent_hub_drain_agent",
      "agent_hub_list_executions",
      "agent_hub_get_execution",
      "agent_hub_inspect_execution",
      "agent_hub_wait_execution",
      "agent_hub_list_traces",
      "agent_hub_trigger_agent",
      "agent_hub_trigger_and_wait_agent",
      "agent_hub_run_canary",
      "agent_hub_set_agent_enabled",
      "agent_hub_cancel_execution",
      "agent_hub_rerun_execution",
    ]);
  });

  test("readiness tool checks service readiness", async () => {
    const ready = vi.fn(async () => ({
      status: "ok",
      checks: { database: { status: "ok" } },
    }));
    const tools = createAgentHubMcpTools({ ready } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_ready")?.handler({})).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "ok",
            checks: { database: { status: "ok" } },
          }, null, 2),
        },
      ],
    });
    expect(ready).toHaveBeenCalledWith();
  });

  test("metrics tool reads the operational canary snapshot", async () => {
    const getMetrics = vi.fn(async () => ({
      agents_total: 3,
      agents_online: 2,
      executions_queued: 1,
      alerts_active: 0,
      scheduler: {
        running: true,
        tick_count: 42,
        last_tick_error_count: 0,
      },
    }));
    const tools = createAgentHubMcpTools({ getMetrics } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_get_metrics")?.handler({})).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            agents_total: 3,
            agents_online: 2,
            executions_queued: 1,
            alerts_active: 0,
            scheduler: {
              running: true,
              tick_count: 42,
              last_tick_error_count: 0,
            },
          }, null, 2),
        },
      ],
    });
    expect(getMetrics).toHaveBeenCalledWith();
  });

  test("ops status tool reads the project operational snapshot", async () => {
    const getOpsStatus = vi.fn(async () => ({
      ok: true,
      project: { requested: "oph", found: true, id: "project-1", name: "oph" },
      summary: { errors: 0, warnings: 1, agentsTotal: 2, executorsOnline: 1 },
    }));
    const tools = createAgentHubMcpTools({ getOpsStatus } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_get_ops_status")?.handler({
      project: "oph",
      alertLimit: 5,
      executionLimit: 3,
      failOnWarning: true,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            project: { requested: "oph", found: true, id: "project-1", name: "oph" },
            summary: { errors: 0, warnings: 1, agentsTotal: 2, executorsOnline: 1 },
          }, null, 2),
        },
      ],
    });
    expect(getOpsStatus).toHaveBeenCalledWith({
      project: "oph",
      alertLimit: 5,
      executionLimit: 3,
      failOnWarning: true,
    });
  });

  test("ops observe tool runs repeated project operational snapshots", async () => {
    const observeOpsStatus = vi.fn(async () => ({
      ok: false,
      iterations: 2,
      failedIterations: 1,
      snapshots: [{ ok: false }, { ok: true }],
    }));
    const tools = createAgentHubMcpTools({ observeOpsStatus } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_observe_ops_status")?.handler({
      project: "oph",
      iterations: 2,
      intervalMs: 0,
      alertLimit: 4,
      executionLimit: 2,
      failOnWarning: true,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            iterations: 2,
            failedIterations: 1,
            snapshots: [{ ok: false }, { ok: true }],
          }, null, 2),
        },
      ],
    });
    expect(observeOpsStatus).toHaveBeenCalledWith({
      project: "oph",
      iterations: 2,
      intervalMs: 0,
      alertLimit: 4,
      executionLimit: 2,
      failOnWarning: true,
    });
  });

  test("recovery plan tool returns backup and rollback commands", async () => {
    const getRecoveryPlan = vi.fn(() => ({
      ok: true,
      project: "oph",
      backup: { commands: ["pg_dump \"$DATABASE_URL\" > backup.sql"] },
      rollback: { commands: ["psql \"$DATABASE_URL\" < backup.sql"] },
      warnings: [],
    }));
    const tools = createAgentHubMcpTools({ getRecoveryPlan } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_get_recovery_plan")?.handler({
      project: "oph",
      backupDir: "/var/backups/agent-hub",
      backupFile: "/var/backups/agent-hub/pre-upgrade.sql",
      serviceName: "agent-hub",
      envFile: "/etc/agent-hub/agent-hub.env",
      databaseUrlConfigured: true,
      executionLimit: 5,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            project: "oph",
            backup: { commands: ["pg_dump \"$DATABASE_URL\" > backup.sql"] },
            rollback: { commands: ["psql \"$DATABASE_URL\" < backup.sql"] },
            warnings: [],
          }, null, 2),
        },
      ],
    });
    expect(getRecoveryPlan).toHaveBeenCalledWith({
      project: "oph",
      backupDir: "/var/backups/agent-hub",
      backupFile: "/var/backups/agent-hub/pre-upgrade.sql",
      serviceName: "agent-hub",
      envFile: "/etc/agent-hub/agent-hub.env",
      databaseUrlConfigured: true,
      executionLimit: 5,
    });
  });

  test("recovery drill plan tool returns disposable restore rehearsal commands", async () => {
    const getRecoveryDrillPlan = vi.fn(() => ({
      ok: true,
      project: "oph",
      restore: { commands: ["psql \"$AGENT_HUB_RESTORE_DATABASE_URL\" < backup.sql"] },
      warnings: [],
    }));
    const tools = createAgentHubMcpTools({ getRecoveryDrillPlan } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_get_recovery_drill_plan")?.handler({
      project: "oph",
      backupDir: "/var/backups/agent-hub",
      backupFile: "/var/backups/agent-hub/rehearsal.sql",
      envFile: "/etc/agent-hub/agent-hub.env",
      restoreDatabaseEnvVar: "AGENT_HUB_RESTORE_DATABASE_URL",
      databaseUrlConfigured: true,
      restoreDatabaseUrlConfigured: true,
      executionLimit: 5,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            project: "oph",
            restore: { commands: ["psql \"$AGENT_HUB_RESTORE_DATABASE_URL\" < backup.sql"] },
            warnings: [],
          }, null, 2),
        },
      ],
    });
    expect(getRecoveryDrillPlan).toHaveBeenCalledWith({
      project: "oph",
      backupDir: "/var/backups/agent-hub",
      backupFile: "/var/backups/agent-hub/rehearsal.sql",
      envFile: "/etc/agent-hub/agent-hub.env",
      restoreDatabaseEnvVar: "AGENT_HUB_RESTORE_DATABASE_URL",
      databaseUrlConfigured: true,
      restoreDatabaseUrlConfigured: true,
      executionLimit: 5,
    });
  });

  test("recovery drill run tool forwards explicit confirmation", async () => {
    const runRecoveryDrill = vi.fn(async () => ({
      ok: false,
      failedCommand: { stage: "restore", exitCode: 1 },
    }));
    const tools = createAgentHubMcpTools({ runRecoveryDrill } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_run_recovery_drill")?.handler({
      project: "oph",
      confirmRestoreDatabaseReset: true,
      restoreDatabaseUrlConfigured: true,
      databaseUrlConfigured: true,
      commandTimeoutMs: 60000,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            failedCommand: { stage: "restore", exitCode: 1 },
          }, null, 2),
        },
      ],
    });
    expect(runRecoveryDrill).toHaveBeenCalledWith({
      project: "oph",
      confirmRestoreDatabaseReset: true,
      restoreDatabaseUrlConfigured: true,
      databaseUrlConfigured: true,
      commandTimeoutMs: 60000,
    });
  });

  test("release check tool forwards gate options", async () => {
    const runReleaseCheck = vi.fn(async () => ({
      ok: true,
      steps: [{ name: "doctor", ok: true, skipped: false }],
    }));
    const tools = createAgentHubMcpTools({ runReleaseCheck } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_run_release_check")?.handler({
      project: "oph",
      includeRecoveryDrill: true,
      confirmRestoreDatabaseReset: true,
      canaryAgent: "enrich_repo",
      canaryPayload: { repo_name: "agent-hub-smoke" },
      observeIterations: 1,
      observeIntervalMs: 0,
      executionLimit: 5,
      failOnWarning: true,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            steps: [{ name: "doctor", ok: true, skipped: false }],
          }, null, 2),
        },
      ],
    });
    expect(runReleaseCheck).toHaveBeenCalledWith({
      project: "oph",
      includeRecoveryDrill: true,
      confirmRestoreDatabaseReset: true,
      canaryAgent: "enrich_repo",
      canaryPayload: { repo_name: "agent-hub-smoke" },
      observeIterations: 1,
      observeIntervalMs: 0,
      executionLimit: 5,
      failOnWarning: true,
    });
  });

  test("project list tool reads sanitized project records", async () => {
    const listProjects = vi.fn(async () => ([
      { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
    ]));
    const tools = createAgentHubMcpTools({ listProjects } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_list_projects")?.handler({})).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { id: "project-1", name: "oph", displayName: "Open Source Project Hunter" },
          ], null, 2),
        },
      ],
    });
    expect(listProjects).toHaveBeenCalledWith();
  });

  test("project ensure tool returns existing projects or creates missing projects", async () => {
    const ensureProject = vi.fn(async () => ({
      created: false,
      project: { id: "project-1", name: "oph" },
    }));
    const tools = createAgentHubMcpTools({ ensureProject } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_ensure_project")?.handler({
      name: "oph",
      displayName: "Open Source Project Hunter",
      description: "OPH executor integration",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            created: false,
            project: { id: "project-1", name: "oph" },
          }, null, 2),
        },
      ],
    });
    expect(ensureProject).toHaveBeenCalledWith({
      name: "oph",
      displayName: "Open Source Project Hunter",
      description: "OPH executor integration",
    });
  });

  test("project tools create project keys and rotate existing project keys", async () => {
    const createProject = vi.fn(async () => ({
      project: { id: "project-1", name: "oph" },
      api_key: "agh_created",
    }));
    const rotateProjectApiKey = vi.fn(async () => ({
      project: { id: "project-1", name: "oph" },
      api_key: "agh_rotated",
    }));
    const tools = createAgentHubMcpTools({ createProject, rotateProjectApiKey } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_create_project")?.handler({
      name: "oph",
      displayName: "Open Source Project Hunter",
      description: "OPH executor integration",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            project: { id: "project-1", name: "oph" },
            api_key: "agh_created",
          }, null, 2),
        },
      ],
    });
    await expect(tools.find((tool) => tool.name === "agent_hub_rotate_project_api_key")?.handler({
      project: "oph",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            project: { id: "project-1", name: "oph" },
            api_key: "agh_rotated",
          }, null, 2),
        },
      ],
    });

    expect(createProject).toHaveBeenCalledWith({
      name: "oph",
      displayName: "Open Source Project Hunter",
      description: "OPH executor integration",
    });
    expect(rotateProjectApiKey).toHaveBeenCalledWith("oph");
  });

  test("project drain tool forwards project name and cancellation options", async () => {
    const drainProject = vi.fn(async () => ({
      ok: true,
      project_id: "project-1",
      agents_drained: 2,
      cancelled_queued: 1,
      cancelled_running: 1,
      active_execution_count: 0,
    }));
    const tools = createAgentHubMcpTools({
      drainProject,
    } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_drain_project")?.handler({
      project: "oph",
      cancelRunning: true,
    })).resolves.toEqual({
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          project_id: "project-1",
          agents_drained: 2,
          cancelled_queued: 1,
          cancelled_running: 1,
          active_execution_count: 0,
        }, null, 2),
      }],
    });
    expect(drainProject).toHaveBeenCalledWith("oph", { cancelRunning: true });
  });

  test("project enabled tool forwards project name and desired state", async () => {
    const setProjectEnabled = vi.fn(async () => ({
      ok: true,
      count: 3,
    }));
    const tools = createAgentHubMcpTools({
      setProjectEnabled,
    } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_set_project_enabled")?.handler({
      project: "oph",
      enabled: true,
    })).resolves.toEqual({
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          count: 3,
        }, null, 2),
      }],
    });
    expect(setProjectEnabled).toHaveBeenCalledWith("oph", true);
  });

  test("scheduler status tool forwards filter options", async () => {
    const getSchedulerStatus = vi.fn(async () => ({
      generatedAt: "2026-05-20T10:00:00.000Z",
      agents: [{ id: "agent-1", dispatchState: "dispatchable" }],
    }));
    const tools = createAgentHubMcpTools({ getSchedulerStatus } as any);
    const schedulerTool = tools.find((tool) => tool.name === "agent_hub_get_scheduler_status");

    await expect(schedulerTool?.handler({
      agentId: "agent-1",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            generatedAt: "2026-05-20T10:00:00.000Z",
            agents: [{ id: "agent-1", dispatchState: "dispatchable" }],
          }, null, 2),
        },
      ],
    });
    expect(getSchedulerStatus).toHaveBeenCalledWith({ agent_id: "agent-1" });
  });

  test("executor and alert tools forward operator options", async () => {
    const listExecutors = vi.fn(async () => ([
      { agent_name: "oph_deep_research", executor_status: "online" },
    ]));
    const listAlerts = vi.fn(async () => ([
      { id: 7, ruleName: "failed_runs" },
    ]));
    const acknowledgeAlert = vi.fn(async () => ({
      id: 7,
      acknowledgedBy: "agent",
    }));
    const tools = createAgentHubMcpTools({ listExecutors, listAlerts, acknowledgeAlert } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_list_executors")?.handler({
      project: "project-1",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { agent_name: "oph_deep_research", executor_status: "online" },
          ], null, 2),
        },
      ],
    });
    await expect(tools.find((tool) => tool.name === "agent_hub_list_alerts")?.handler({
      limit: 5,
      includeAcknowledged: true,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { id: 7, ruleName: "failed_runs" },
          ], null, 2),
        },
      ],
    });
    await expect(tools.find((tool) => tool.name === "agent_hub_acknowledge_alert")?.handler({
      alertId: 7,
      acknowledgedBy: "agent",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: 7,
            acknowledgedBy: "agent",
          }, null, 2),
        },
      ],
    });

    expect(listExecutors).toHaveBeenCalledWith({ project: "project-1" });
    expect(listAlerts).toHaveBeenCalledWith({ limit: 5, includeAcknowledged: true });
    expect(acknowledgeAlert).toHaveBeenCalledWith(7, { acknowledgedBy: "agent" });
  });

  test("list agents tool forwards the archived filter", async () => {
    const listAgents = vi.fn(async () => ([
      { id: "agent-1", name: "archived_agent", archivedAt: "2026-05-20T10:00:00.000Z" },
    ]));
    const tools = createAgentHubMcpTools({ listAgents } as any);
    const listTool = tools.find((tool) => tool.name === "agent_hub_list_agents");

    await expect(listTool?.handler({
      archived: "only",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { id: "agent-1", name: "archived_agent", archivedAt: "2026-05-20T10:00:00.000Z" },
          ], null, 2),
        },
      ],
    });
    expect(listAgents).toHaveBeenCalledWith({ archived: "only" });
  });

  test("get agent tool can include archived detail records", async () => {
    const getAgent = vi.fn(async () => ({
      id: "agent-1",
      archivedAt: "2026-05-20T10:00:00.000Z",
      recentExecutions: [{ id: "exec-1", status: "success" }],
    }));
    const tools = createAgentHubMcpTools({ getAgent } as any);
    const getTool = tools.find((tool) => tool.name === "agent_hub_get_agent");

    await expect(getTool?.handler({
      agentId: "agent-1",
      includeArchived: true,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            id: "agent-1",
            archivedAt: "2026-05-20T10:00:00.000Z",
            recentExecutions: [{ id: "exec-1", status: "success" }],
          }, null, 2),
        },
      ],
    });
    expect(getAgent).toHaveBeenCalledWith("agent-1", { includeArchived: true });
  });

  test("list executions tool forwards project and agent name filters", async () => {
    const listExecutions = vi.fn(async () => ([
      { id: "exec-1", agentId: "agent-1", status: "failed" },
    ]));
    const tools = createAgentHubMcpTools({ listExecutions } as any);
    const listTool = tools.find((tool) => tool.name === "agent_hub_list_executions");

    await expect(listTool?.handler({
      project: "oph",
      agent: "deep_research",
      status: "failed",
      limit: 10,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { id: "exec-1", agentId: "agent-1", status: "failed" },
          ], null, 2),
        },
      ],
    });
    expect(listExecutions).toHaveBeenCalledWith({
      project: "oph",
      agent: "deep_research",
      status: "failed",
      limit: 10,
    });
  });

  test("trigger tool forwards payload, idempotency, and dedup options", async () => {
    const triggerAgent = vi.fn(async () => ({
      execution_id: "exec-1",
      status: "queued",
      duplicate: false,
    }));
    const tools = createAgentHubMcpTools({ triggerAgent } as any);
    const triggerTool = tools.find((tool) => tool.name === "agent_hub_trigger_agent");

    await expect(triggerTool?.handler({
      agentName: "demo_agent",
      payload: { value: 42 },
      idempotencyKey: "manual-42",
      dedupPolicy: "skip_if_exists",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            execution_id: "exec-1",
            status: "queued",
            duplicate: false,
          }, null, 2),
        },
      ],
    });
    expect(triggerAgent).toHaveBeenCalledWith("demo_agent", {
      payload: { value: 42 },
      idempotencyKey: "manual-42",
      dedupPolicy: "skip_if_exists",
    });
  });

  test("trigger-and-wait tool forwards trigger and polling options", async () => {
    const triggerAgentAndWait = vi.fn(async () => ({
      trigger: { execution_id: "exec-1", status: "queued", duplicate: false },
      execution: { id: "exec-1", status: "success" },
    }));
    const tools = createAgentHubMcpTools({ triggerAgentAndWait } as any);
    const triggerAndWaitTool = tools.find((tool) => tool.name === "agent_hub_trigger_and_wait_agent");

    await expect(triggerAndWaitTool?.handler({
      agentName: "demo_agent",
      payload: { value: 42 },
      idempotencyKey: "manual-42",
      dedupPolicy: "allow_duplicate",
      timeoutMs: 60000,
      intervalMs: 250,
      requireSuccess: true,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            trigger: { execution_id: "exec-1", status: "queued", duplicate: false },
            execution: { id: "exec-1", status: "success" },
          }, null, 2),
        },
      ],
    });
    expect(triggerAgentAndWait).toHaveBeenCalledWith("demo_agent", {
      payload: { value: 42 },
      idempotencyKey: "manual-42",
      dedupPolicy: "allow_duplicate",
    }, {
      timeoutMs: 60000,
      intervalMs: 250,
      requireSuccess: true,
    });
  });

  test("canary tool runs diagnostics around a trigger-and-wait flow", async () => {
    const runCanary = vi.fn(async () => ({
      preflight: { ok: true },
      trigger: { execution_id: "exec-1", status: "queued", duplicate: false },
      execution: { id: "exec-1", status: "success" },
      postflight: { ok: true },
    }));
    const tools = createAgentHubMcpTools({ runCanary } as any);
    const canaryTool = tools.find((tool) => tool.name === "agent_hub_run_canary");

    await expect(canaryTool?.handler({
      agentName: "enrich_repo",
      project: "oph",
      payload: { repo_name: "agent-hub-smoke" },
      timeoutMs: 600000,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            preflight: { ok: true },
            trigger: { execution_id: "exec-1", status: "queued", duplicate: false },
            execution: { id: "exec-1", status: "success" },
            postflight: { ok: true },
          }, null, 2),
        },
      ],
    });
    expect(runCanary).toHaveBeenCalledWith("enrich_repo", {
      project: "oph",
      payload: { repo_name: "agent-hub-smoke" },
      timeoutMs: 600000,
    });
  });

  test("set agent enabled tool forwards the desired state", async () => {
    const setAgentEnabled = vi.fn(async () => ({ id: "agent-1", enabled: false }));
    const tools = createAgentHubMcpTools({ setAgentEnabled } as any);
    const setEnabledTool = tools.find((tool) => tool.name === "agent_hub_set_agent_enabled");

    await expect(setEnabledTool?.handler({
      agentId: "deep_research",
      project: "oph",
      enabled: false,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: "agent-1", enabled: false }, null, 2),
        },
      ],
    });
    expect(setAgentEnabled).toHaveBeenCalledWith("deep_research", false, { project: "oph" });
  });

  test("create and update agent tools forward scheduler settings", async () => {
    const createAgent = vi.fn(async () => ({ id: "agent-1", name: "demo_agent" }));
    const updateAgent = vi.fn(async () => ({ id: "agent-1", displayName: "Renamed Agent" }));
    const tools = createAgentHubMcpTools({ createAgent, updateAgent } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_create_agent")?.handler({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for MCP-driven agent creation.",
      agentType: "cron_task",
      cronExpression: "*/15 * * * *",
      handlerName: "demo_handler",
      concurrency: 2,
      timeoutSeconds: 120,
      labels: { team: "ops" },
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: "agent-1", name: "demo_agent" }, null, 2),
        },
      ],
    });

    await expect(tools.find((tool) => tool.name === "agent_hub_update_agent")?.handler({
      agentId: "agent-1",
      displayName: "Renamed Agent",
      cronExpression: null,
      retryMax: 0,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: "agent-1", displayName: "Renamed Agent" }, null, 2),
        },
      ],
    });

    expect(createAgent).toHaveBeenCalledWith({
      name: "demo_agent",
      displayName: "Demo Agent",
      description: "Runs the demo handler for MCP-driven agent creation.",
      agentType: "cron_task",
      cronExpression: "*/15 * * * *",
      handlerName: "demo_handler",
      concurrency: 2,
      timeoutSeconds: 120,
      labels: { team: "ops" },
    });
    expect(updateAgent).toHaveBeenCalledWith("agent-1", {
      displayName: "Renamed Agent",
      cronExpression: null,
      retryMax: 0,
    });
  });

  test("schedule preview tool forwards agent id and limit", async () => {
    const getAgentSchedulePreview = vi.fn(async () => ({
      runs: ["2026-05-20T12:00:00.000Z"],
    }));
    const tools = createAgentHubMcpTools({ getAgentSchedulePreview } as any);
    const previewTool = tools.find((tool) => tool.name === "agent_hub_preview_agent_schedule");

    await expect(previewTool?.handler({
      agentId: "agent-1",
      limit: 3,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ runs: ["2026-05-20T12:00:00.000Z"] }, null, 2),
        },
      ],
    });
    expect(getAgentSchedulePreview).toHaveBeenCalledWith("agent-1", { limit: 3 });
  });

  test("delete agent tool forwards the agent id", async () => {
    const deleteAgent = vi.fn(async () => undefined);
    const tools = createAgentHubMcpTools({ deleteAgent } as any);
    const deleteTool = tools.find((tool) => tool.name === "agent_hub_delete_agent");

    await expect(deleteTool?.handler({
      agentId: "agent-1",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true }, null, 2),
        },
      ],
    });
    expect(deleteAgent).toHaveBeenCalledWith("agent-1");
  });

  test("drain agent tool forwards cancellation options", async () => {
    const drainAgent = vi.fn(async () => ({
      ok: true,
      agent_id: "agent-1",
      cancelled_queued: 1,
      cancelled_running: 1,
      active_execution_count: 0,
    }));
    const tools = createAgentHubMcpTools({ drainAgent } as any);
    const drainTool = tools.find((tool) => tool.name === "agent_hub_drain_agent");

    await expect(drainTool?.handler({
      agentId: "relationship_agent",
      project: "oph",
      cancelRunning: true,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            agent_id: "agent-1",
            cancelled_queued: 1,
            cancelled_running: 1,
            active_execution_count: 0,
          }, null, 2),
        },
      ],
    });
    expect(drainAgent).toHaveBeenCalledWith("relationship_agent", { cancelRunning: true, project: "oph" });
  });

  test("wait execution tool forwards polling options", async () => {
    const waitForExecution = vi.fn(async () => ({ id: "exec-1", status: "success" }));
    const tools = createAgentHubMcpTools({ waitForExecution } as any);
    const waitTool = tools.find((tool) => tool.name === "agent_hub_wait_execution");

    await expect(waitTool?.handler({
      executionId: "exec-1",
      timeoutMs: 60000,
      intervalMs: 250,
      requireSuccess: true,
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ id: "exec-1", status: "success" }, null, 2),
        },
      ],
    });
    expect(waitForExecution).toHaveBeenCalledWith("exec-1", {
      timeoutMs: 60000,
      intervalMs: 250,
      requireSuccess: true,
    });
  });

  test("inspect execution tool returns the execution diagnostic bundle", async () => {
    const inspectExecution = vi.fn(async () => ({
      execution: { id: "exec-1", status: "failed" },
      traces: [{ id: "trace-1", outputContent: "failure context" }],
      triggerChain: [{ id: "exec-parent", relation: "ancestor" }],
    }));
    const tools = createAgentHubMcpTools({ inspectExecution } as any);
    const inspectTool = tools.find((tool) => tool.name === "agent_hub_inspect_execution");

    await expect(inspectTool?.handler({
      executionId: "exec-1",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            execution: { id: "exec-1", status: "failed" },
            traces: [{ id: "trace-1", outputContent: "failure context" }],
            triggerChain: [{ id: "exec-parent", relation: "ancestor" }],
          }, null, 2),
        },
      ],
    });
    expect(inspectExecution).toHaveBeenCalledWith("exec-1");
  });

  test("cancel and rerun tools forward execution ids", async () => {
    const cancelExecution = vi.fn(async () => ({ ok: true, status: "cancelled" }));
    const rerunExecution = vi.fn(async () => ({
      execution_id: "exec-2",
      source_execution_id: "exec-1",
      status: "queued",
    }));
    const tools = createAgentHubMcpTools({ cancelExecution, rerunExecution } as any);

    await expect(tools.find((tool) => tool.name === "agent_hub_cancel_execution")?.handler({
      executionId: "exec-1",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, status: "cancelled" }, null, 2),
        },
      ],
    });
    await expect(tools.find((tool) => tool.name === "agent_hub_rerun_execution")?.handler({
      executionId: "exec-1",
    })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            execution_id: "exec-2",
            source_execution_id: "exec-1",
            status: "queued",
          }, null, 2),
        },
      ],
    });

    expect(cancelExecution).toHaveBeenCalledWith("exec-1");
    expect(rerunExecution).toHaveBeenCalledWith("exec-1");
  });
});
