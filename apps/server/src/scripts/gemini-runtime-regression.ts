import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentDescriptor } from "../shared-types.js";
import { getAgentRuntimeActionSupport } from "../shared-types.js";
import {
  discoverGeminiSessions,
  getGeminiControlState,
} from "../services/gemini-cli-runtime.js";

function buildAgent(overrides: Partial<AgentDescriptor> = {}): AgentDescriptor {
  return {
    id: "gemini-session-session-test",
    name: "Gemini CLI · agent-hub",
    platform: "gemini-cli",
    workspacePath: "/tmp/agent-hub",
    state: "running",
    health: "healthy",
    attention: "silent",
    lastHeartbeatAt: "2026-04-13T10:05:00.000Z",
    lastEventAt: "2026-04-13T10:05:00.000Z",
    currentRunId: "gemini-run-session-test",
    sessionMetadata: {
      sessionId: "session-test",
      sessionPath: "/tmp/session-test.json",
    },
    ...overrides,
  };
}

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "agent-hub-gemini-regression-"));
  const workspaceDir = path.join(root, "workspace", "agent-hub");
  const geminiDir = path.join(root, ".gemini");
  const projectDir = path.join(geminiDir, "tmp", "agent-hub");
  const chatsDir = path.join(projectDir, "chats");
  const sessionPath = path.join(chatsDir, "session-session-test.json");

  mkdirSync(workspaceDir, { recursive: true });
  mkdirSync(chatsDir, { recursive: true });
  writeFileSync(path.join(projectDir, ".project_root"), `${workspaceDir}\n`);
  writeFileSync(
    sessionPath,
    JSON.stringify(
      {
        sessionId: "session-test",
        startTime: "2026-04-13T10:00:00.000Z",
        lastUpdated: "2026-04-13T10:05:00.000Z",
        messages: [
          {
            type: "user",
            content: "Summarize the current bridge milestone.",
          },
          {
            type: "assistant",
            content: "Bridge milestone summary ready.",
          },
        ],
      },
      null,
      2,
    ),
  );

  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 60_000)", "@google/gemini-cli/dist/index.js"],
    {
      cwd: workspaceDir,
      stdio: "ignore",
    },
  );

  try {
    await wait(1_000);

    const sessions = discoverGeminiSessions(geminiDir, "0.30.0-test");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, "session-test");
    assert.equal(sessions[0]?.cwd, realpathSync.native(workspaceDir));
    assert.equal(sessions[0]?.sessionPath, sessionPath);
    assert.equal(sessions[0]?.toolVersion, "0.30.0-test");
    assert.match(
      sessions[0]?.summary ?? "",
      /summarize the current bridge milestone/i,
    );

    assert.equal(getGeminiControlState(geminiDir), "auth_required");
    assert.deepEqual(
      getAgentRuntimeActionSupport(
        buildAgent({
          health: "auth_required",
          sessionMetadata: {
            sessionId: "session-test",
            sessionPath,
          },
          workspacePath: workspaceDir,
        }),
        "send_prompt",
      ),
      {
        supported: false,
        code: "gemini-auth-required",
      },
    );

    const originalApiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "test-key";

    try {
      assert.equal(getGeminiControlState(geminiDir), "ready");
      assert.deepEqual(
        getAgentRuntimeActionSupport(
          buildAgent({
            sessionMetadata: {
              sessionId: "session-test",
              sessionPath,
            },
            workspacePath: workspaceDir,
          }),
          "send_prompt",
        ),
        {
          supported: true,
          code: "gemini-prompt-dispatch",
        },
      );
    } finally {
      if (typeof originalApiKey === "string") {
        process.env.GEMINI_API_KEY = originalApiKey;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
    }

    console.log("Gemini runtime regression harness passed.");
  } finally {
    child.kill("SIGTERM");
    rmSync(root, {
      force: true,
      recursive: true,
    });
  }
}

function wait(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
