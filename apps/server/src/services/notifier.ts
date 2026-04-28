import type { AgentEvent, DashboardSnapshot } from "../shared-types.js";

export type HubStreamMessage =
  | { type: "snapshot"; data: DashboardSnapshot }
  | { type: "event"; data: AgentEvent }
  | { type: "heartbeat"; data: { generatedAt: string } };

type HubListener = (message: HubStreamMessage) => void;

export class HubNotifier {
  private readonly listeners = new Set<HubListener>();

  subscribe(listener: HubListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(message: HubStreamMessage): void {
    for (const listener of this.listeners) {
      listener(message);
    }
  }
}
