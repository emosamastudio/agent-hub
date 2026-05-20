import { afterEach, test, vi } from "vitest";
import assert from "node:assert";
import { getSchedulerRuntimeStats, startScheduler, stopScheduler } from "../src/services/scheduler.js";

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
});

test("scheduler emits structured lifecycle logs and runtime stats", () => {
  vi.useFakeTimers();
  const logs: Array<{ fields: Record<string, unknown>; message?: string }> = [];
  const logger = {
    info(fields: Record<string, unknown>, message?: string) {
      logs.push({ fields, message });
    },
    warn() {},
    error() {},
  };

  startScheduler({} as any, { logger });
  const started = getSchedulerRuntimeStats();
  stopScheduler();
  const stopped = getSchedulerRuntimeStats();

  assert.strictEqual(logs[0]?.fields.component, "scheduler");
  assert.strictEqual(logs[0]?.fields.event, "scheduler.started");
  assert.strictEqual(logs[1]?.fields.event, "scheduler.stopped");
  assert.strictEqual(started.running, true);
  assert.strictEqual(stopped.running, false);
  assert.strictEqual(typeof stopped.tick_count, "number");
});
