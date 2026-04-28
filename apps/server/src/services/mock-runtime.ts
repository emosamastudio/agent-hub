import type { ControlPlaneService } from "./control-plane-service.js";
import type { HubNotifier } from "./notifier.js";

interface MockRuntimeOptions {
  service: ControlPlaneService;
  notifier: HubNotifier;
  simulationIntervalMs: number;
  heartbeatIntervalMs: number;
}

export class MockRuntimeService {
  private simulationTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatCursor = 0;

  constructor(private readonly options: MockRuntimeOptions) {}

  start(): void {
    if (!this.simulationTimer) {
      this.simulationTimer = setInterval(() => {
        this.runSimulationTick();
      }, this.options.simulationIntervalMs);
    }

    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this.options.notifier.publish({
          type: "heartbeat",
          data: {
            generatedAt: new Date().toISOString(),
          },
        });
        this.options.notifier.publish({
          type: "snapshot",
          data: this.options.service.getSnapshot(),
        });
      }, this.options.heartbeatIntervalMs);
    }
  }

  stop(): void {
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
      this.simulationTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private runSimulationTick(): void {
    const agents = this.options.service.listAgents();

    if (agents.length === 0) {
      return;
    }

    const nextAgent = agents[this.heartbeatCursor % agents.length];
    this.heartbeatCursor = (this.heartbeatCursor + 1) % agents.length;

    const heartbeatUpdate = this.options.service.recordHeartbeat(nextAgent.id);
    this.options.notifier.publish({
      type: "event",
      data: heartbeatUpdate.event,
    });

    const runningRun = this.options.service.getNextRunningRun();

    if (runningRun) {
      const progressUpdate = this.options.service.advanceRunningRun(runningRun.id);
      this.options.notifier.publish({
        type: "event",
        data: progressUpdate.event,
      });
      this.options.notifier.publish({
        type: "snapshot",
        data: progressUpdate.snapshot,
      });
      return;
    }

    this.options.notifier.publish({
      type: "snapshot",
      data: heartbeatUpdate.snapshot,
    });
  }
}
