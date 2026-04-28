import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyBaseLogger } from "fastify";

import type { AgentEvent } from "../shared-types.js";
import type { HubNotifier, HubStreamMessage } from "./notifier.js";

const execFileAsync = promisify(execFile);
const noisyEventTypes = new Set([
  "run.approval_required",
  "run.waiting_input",
  "run.paused",
  "run.failed",
  "run.stalled",
  "agent.offline",
]);

interface NotificationPayload {
  title: string;
  subtitle: string;
  body: string;
}

interface NotificationSender {
  readonly supported: boolean;
  send(payload: NotificationPayload): Promise<void>;
}

interface DesktopNotificationServiceOptions {
  enabled: boolean;
  cooldownMs: number;
  logger: FastifyBaseLogger;
  sender?: NotificationSender;
}

class MacOsNotificationSender implements NotificationSender {
  readonly supported = process.platform === "darwin";

  async send(payload: NotificationPayload): Promise<void> {
    if (!this.supported) {
      return;
    }

    const script = `display notification "${escapeAppleScript(
      payload.body,
    )}" with title "${escapeAppleScript(payload.title)}" subtitle "${escapeAppleScript(
      payload.subtitle,
    )}"`;

    await execFileAsync("osascript", ["-e", script]);
  }
}

export class DesktopNotificationService {
  private readonly sender: NotificationSender;
  private readonly lastSentAt = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: DesktopNotificationServiceOptions) {
    this.sender = options.sender ?? new MacOsNotificationSender();
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  get supported(): boolean {
    return this.sender.supported;
  }

  start(notifier: HubNotifier): void {
    if (!this.enabled || !this.supported || this.unsubscribe) {
      return;
    }

    this.unsubscribe = notifier.subscribe((message) => {
      void this.handleMessage(message);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lastSentAt.clear();
  }

  private async handleMessage(message: HubStreamMessage): Promise<void> {
    if (message.type !== "event") {
      return;
    }

    const event = message.data;

    if (!shouldNotifyForEvent(event)) {
      return;
    }

    const key = `${event.type}:${event.agentId}:${event.runId ?? "none"}`;
    const now = Date.now();
    const lastSentAt = this.lastSentAt.get(key) ?? 0;

    if (now - lastSentAt < this.options.cooldownMs) {
      return;
    }

    this.lastSentAt.set(key, now);

    try {
      await this.sender.send(buildPayload(event));
    } catch (error) {
      this.options.logger.warn(
        {
          error,
          eventId: event.id,
          eventType: event.type,
        },
        "Failed to deliver desktop notification",
      );
    }
  }
}

function shouldNotifyForEvent(event: AgentEvent): boolean {
  if (event.type === "agent.heartbeat") {
    return false;
  }

  if (event.attention === "urgent") {
    return true;
  }

  if (event.attention === "action_needed" && noisyEventTypes.has(event.type)) {
    return true;
  }

  return false;
}

function buildPayload(event: AgentEvent): NotificationPayload {
  const urgency = event.attention === "urgent" ? "Urgent" : "Action needed";

  return {
    title: "Agent Hub",
    subtitle: `${urgency} · ${humanizeToken(event.type)}`,
    body: truncate(event.message, 180),
  };
}

function humanizeToken(value: string): string {
  return value
    .replace(/[._-]/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }

  return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
