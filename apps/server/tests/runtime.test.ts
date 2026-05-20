import { test } from "vitest";
import assert from "node:assert";
import { createShutdownHandler } from "../src/runtime.js";

test("shutdown stops scheduler and closes the app once", async () => {
  const calls: string[] = [];
  const shutdown = createShutdownHandler({
    app: {
      close: async () => {
        calls.push("close");
      },
    },
    stopScheduler: () => {
      calls.push("stopScheduler");
    },
    log: () => {},
    error: () => {},
    exit: () => {},
  });

  await Promise.all([
    shutdown("SIGTERM"),
    shutdown("SIGINT"),
  ]);

  assert.deepStrictEqual(calls, ["stopScheduler", "close"]);
});

test("shutdown exits non-zero when app close fails", async () => {
  const calls: string[] = [];
  const shutdown = createShutdownHandler({
    app: {
      close: async () => {
        throw new Error("close failed");
      },
    },
    stopScheduler: () => {
      calls.push("stopScheduler");
    },
    log: () => {},
    error: () => {
      calls.push("error");
    },
    exit: (code) => {
      calls.push(`exit:${code}`);
    },
  });

  await shutdown("SIGTERM");

  assert.deepStrictEqual(calls, ["stopScheduler", "error", "exit:1"]);
});
