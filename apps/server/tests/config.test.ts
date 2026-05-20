import { test } from "vitest";
import assert from "node:assert";
import { createServerConfig } from "../src/config.js";

test("defaults local server port to 8788", () => {
  const config = createServerConfig({});

  assert.equal(config.port, 8788);
});

test("honors AGENT_HUB_PORT override", () => {
  const config = createServerConfig({ AGENT_HUB_PORT: "9876" });

  assert.equal(config.port, 9876);
});

test("disables bootstrap seed data by default in production", () => {
  const config = createServerConfig({ NODE_ENV: "production" });

  assert.equal(config.bootstrapDefaultProject, false);
  assert.equal(config.seedDemoAgent, false);
});

test("allows explicit production bootstrap for first install", () => {
  const config = createServerConfig({
    NODE_ENV: "production",
    AGENT_HUB_BOOTSTRAP_DEFAULT_PROJECT: "true",
    AGENT_HUB_SEED_DEMO_AGENT: "false",
  });

  assert.equal(config.bootstrapDefaultProject, true);
  assert.equal(config.seedDemoAgent, false);
});
