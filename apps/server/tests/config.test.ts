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
