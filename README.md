# Agent Hub

Local-first TypeScript control plane and dashboard for monitoring multiple coding agents from one place.

## Workspace layout

- `apps/server`: Fastify + WebSocket + SQLite control plane
- `apps/web`: React + Vite dashboard
- `packages/shared`: normalized shared contracts for agents, runs, inbox items, and events

## Run locally

```bash
npm install
npm run dev
```

Default local endpoints:

- Dashboard: `http://127.0.0.1:5173`
- Server: `http://127.0.0.1:8787`
- Health: `http://127.0.0.1:8787/health`

Optional server env flags:

- `AGENT_HUB_ENABLE_MOCK_RUNTIME=true` to enable demo activity
- `AGENT_HUB_ENABLE_COPILOT_DISCOVERY=false` to disable live Copilot session discovery
- `AGENT_HUB_ENABLE_CLAUDE_DISCOVERY=false` to disable live Claude Code session discovery
- `AGENT_HUB_ENABLE_GEMINI_DISCOVERY=false` to disable live Gemini CLI session discovery
- `AGENT_HUB_ENABLE_OPENCLAW_DISCOVERY=false` to disable live OpenClaw discovery
- `AGENT_HUB_COPILOT_SESSION_STATE_DIR=/path/to/session-state` to override the local Copilot session-state directory
- `AGENT_HUB_COPILOT_BIN=/path/to/copilot` to override the Copilot CLI binary used for SDK-backed runtime actions
- `AGENT_HUB_COPILOT_SDK_MODULE_PATH=/path/to/copilot-sdk/index.js` to override the local Copilot SDK module path used for session resume
- `AGENT_HUB_CLAUDE_BIN=/path/to/claude` to override the Claude Code CLI binary used for auth checks and session resume
- `AGENT_HUB_CLAUDE_PROJECTS_DIR=/path/to/.claude/projects` to override the local Claude Code projects directory
- `AGENT_HUB_GEMINI_BIN=/path/to/gemini` to override the Gemini CLI binary used for local prompt dispatch
- `AGENT_HUB_GEMINI_STATE_DIR=/path/to/.gemini` to override the local Gemini CLI state directory
- `AGENT_HUB_OPENCLAW_STATE_DIR=/path/to/.openclaw` to override the local OpenClaw state directory passed into `openclaw status --json`
- `AGENT_HUB_OPENCLAW_BIN=/path/to/openclaw` to override the OpenClaw CLI binary used for discovery
- `AGENT_HUB_COPILOT_POLL_MS=5000` to change Copilot discovery polling frequency
- `AGENT_HUB_CLAUDE_POLL_MS=5000` to change Claude Code discovery polling frequency
- `AGENT_HUB_GEMINI_POLL_MS=5000` to change Gemini CLI discovery polling frequency
- `AGENT_HUB_OPENCLAW_POLL_MS=10000` to change OpenClaw discovery polling frequency
- `AGENT_HUB_ENABLE_DESKTOP_NOTIFICATIONS=false` to disable local desktop alerts
- `AGENT_HUB_NOTIFICATION_COOLDOWN_MS=90000` to change notification dedupe cooldown

## Current MVP

- Unified snapshot API for agents, runs, inbox, and events
- Real-time WebSocket updates
- SQLite-backed seeded demo data
- Live Copilot CLI session discovery from local `~/.copilot/session-state` locks
- Rich Copilot session context from local `workspace.yaml` and `events.jsonl` metadata, including session age, branch, summary count, and Copilot version
- Live Claude Code session discovery from local `~/.claude/projects` logs plus active Claude CLI processes
- Live Gemini CLI session discovery from local `~/.gemini/tmp/*/chats/session-*.json` files plus active Gemini CLI processes
- Live OpenClaw discovery from `openclaw status --json` plus local OpenClaw process/gateway signals
- Mock runtime/adapters for local development
- Generic HTTP ingest API for real local agents and sidecars
- Thin adapter kit with a zero-dependency reference sidecar for runtimes that cannot be discovered directly
- Workspace-first operator filters for search, runtime, workspace, and attention
- Local inbox triage controls for acknowledge, snooze, and mute
- Selected-run operator console with timeline, focus state, and local workspace shortcuts
- Project / session / task topology projected from the live control plane, now with persisted task ownership, operator-completable handoff flows, and persisted task priority so operators can assign work, declare transfer intent, complete ownership transfer, and change queue ordering without pretending a full scheduler already exists
- Runtime-level resource governance foundation: persisted per-platform slot limits plus live occupancy/pressure descriptors so operators can see capacity saturation without pretending a scheduler already exists
- Safe local workspace actions for opening an agent workspace in Finder or Terminal, plus revealing supported local session paths and runtime state folders for Copilot, Claude Code, Gemini CLI, and OpenClaw
- Truthful Claude Code runtime bridge: prompt dispatch by locally resuming a discovered session through `claude --resume` when Agent Hub can prove a session id, a session log path, and a logged-in local Claude CLI
- Truthful Gemini CLI runtime bridge: prompt dispatch by locally resuming a discovered session through `gemini -p ... --resume <sessionId>` when Agent Hub can prove a session id, a session file path, and a usable local Gemini auth posture
- Truthful Copilot runtime bridge: prompt dispatch by locally resuming a discovered session through the Copilot SDK when Agent Hub can prove both a session id and session-state path
- Truthful sidecar runtime bridge: prompt dispatch by calling a sidecar-declared loopback callback only when the external-ingest agent publishes both a local `runtimeActionEndpoint` and `runtimeActionTargets: ["send_prompt"]`
- Truthful OpenClaw runtime bridges: gateway recovery when the gateway is unreachable, plus session reset when Agent Hub can prove a live session key and healthy local gateway bridge
- Persistent Chinese/English UI switch for dashboard chrome, operator controls, and roadmap content
- Function-based dashboard navigation with dedicated Overview, Operations, Agents, Activity, and References pages plus focus jumps into the operator console
- Curated reference catalog of high-star upstream GitHub projects
- Local desktop notifications for approval-needed, paused, failed, and offline attention events
- Truthful-gated operator actions: local demo/mock runs can be controlled, discovered sessions stay read-only for run lifecycle actions, and runtime-side controls only appear when Agent Hub can prove a real bridge

## Connect a real local agent

By default Agent Hub now prioritizes **truthful local discovery** over demo data.  
If you want to bring back seeded demo activity, start the server with mock updates enabled:

```bash
AGENT_HUB_ENABLE_MOCK_RUNTIME=true npm run dev
```

Then push state into the generic ingest endpoint:

```bash
curl -X POST http://127.0.0.1:8787/api/ingest \
  -H "content-type: application/json" \
  -d '{
    "agent": {
      "id": "agent-local-sidecar",
      "name": "Local Sidecar",
      "platform": "generic",
      "workspacePath": "/Users/emosama/workspace/some-repo",
      "state": "running",
      "health": "healthy",
      "attention": "info",
      "currentRunId": "run-local-task",
      "sessionMetadata": {
        "runtimeActionEndpoint": "http://127.0.0.1:9191/runtime-actions",
        "runtimeActionTargets": ["send_prompt"]
      }
    },
    "run": {
      "id": "run-local-task",
      "title": "Stream local status into Agent Hub",
      "state": "running",
      "health": "healthy",
      "attention": "info",
      "progress": {
        "phase": "executing",
        "percent": 45,
        "message": "Publishing updates from a local helper process."
      }
    },
    "event": {
      "type": "run.progress",
      "message": "Local sidecar pushed a progress update into the hub."
    }
  }'
```

## Thin adapter kit

**Purpose:** connect runtimes that do not expose a stable local discovery signal.  
**Value:** reuse one tiny sidecar contract instead of building bespoke Agent Hub glue for every tool.  
**Acceptance:** the reference sidecar can publish live updates into `/api/ingest`, and it can optionally expose a truthful loopback `send_prompt` bridge back out of Agent Hub.

Included in this repo:

- `examples/reference-sidecar.mjs` - zero-dependency Node sidecar
- `examples/reference-sidecar.example.json` - example watched state file
- `npm run adapter:reference -- --help` - built-in usage help

One-shot publish:

```bash
npm run adapter:reference -- \
  --agent-id agent-local-sidecar \
  --name "Local Sidecar" \
  --workspace /Users/emosama/workspace/some-repo \
  --title "Bridge local runtime into Agent Hub"
```

Watched live updates from a JSON state file:

```bash
npm run adapter:reference -- \
  --state-file ./examples/reference-sidecar.example.json \
  --watch \
  --interval-ms 3000
```

When `--watch` is enabled, the sidecar keeps posting heartbeat-style refreshes on the interval and only emits an event when the normalized state payload changes.

Loopback runtime bridge for `send_prompt`:

```bash
npm run adapter:reference -- \
  --state-file ./examples/reference-sidecar.example.json \
  --watch \
  --action-port 9191 \
  --prompt-log-file /tmp/reference-sidecar-prompts.jsonl
```

When `--action-port` is enabled, the sidecar injects a local `agent.sessionMetadata.runtimeActionEndpoint` plus `runtimeActionTargets: ["send_prompt"]` into the ingest payload, starts a loopback callback server on `127.0.0.1`, and writes an explicit `run.output` event back into Agent Hub when it receives a prompt dispatch.

The dashboard no longer pretends every visible session is controllable. If a run comes from Copilot discovery, Claude discovery, Gemini discovery, or generic ingest without a run-control bridge, approve/pause/resume/cancel stays disabled in the UI and the API rejects the action with an explicit read-only message.

For Copilot CLI sessions, Agent Hub now also reads local `workspace.yaml` and `events.jsonl` files from `~/.copilot/session-state/<session-id>/` so the dashboard can show truthful local details like session age, branch, durable summary text, summary count, and Copilot version.

When a discovered Copilot session has both a visible `sessionId` and `sessionPath`, Agent Hub now exposes `send_prompt` as a truthful runtime action. The server resumes that local session through the Copilot SDK, waits until the new `user.message` is persisted into `events.jsonl`, and only then acknowledges the dispatch.

When a discovered Claude Code session has both a visible `sessionId` and `sessionPath`, Agent Hub can also expose `send_prompt` through `claude --resume` — but only if `claude auth status` proves the local Claude CLI is logged in. If Claude is installed but not logged in, the session stays visible while runtime control is downgraded to an explicit `auth_required` posture instead of a fake-controllable state.

When a discovered Gemini CLI session has both a visible `sessionId` and `sessionPath`, Agent Hub can also expose `send_prompt` through `gemini -p ... --resume <sessionId>` — but only if Agent Hub can prove a usable local Gemini auth posture. If Gemini session files are visible but auth is not configured yet, the session stays visible while runtime control is downgraded to an explicit `auth_required` posture instead of a fake-controllable state.

For OpenClaw, Agent Hub now shells out to `openclaw status --json` for runtime metadata and combines that with live local OpenClaw process/gateway signals. That means OpenClaw agents only appear when there is a truthful local runtime signal, and gateway-unreachable situations surface as degraded read-only runs instead of fake-controllable sessions.

For external-ingest sidecars, Agent Hub still keeps run lifecycle actions (`pause`, `resume`, `cancel`) read-only by default. It only exposes `send_prompt` when the sidecar explicitly declares a loopback callback endpoint and target list, and the current reference sidecar bridge is limited to `send_prompt`.

Useful endpoints:

- `GET /api/integrations`: discover the current ingest endpoint and example payload
- `POST /api/ingest`: upsert an agent, optionally upsert a run, and optionally append an event
- `GET /api/projects`, `GET /api/sessions`, `GET /api/tasks`: inspect the current project/session/task topology projected from the truthful control plane, including persisted task ownership and handoff metadata
- `GET /api/resources`: inspect per-runtime capacity, live occupancy, waiting load, and pressure descriptors derived from the current control-plane snapshot
- `POST /api/runs/:id/actions`: apply a truthful run action only when that runtime actually has a supported control path
- `POST /api/tasks/:id/runtime-actions`: dispatch task-scoped runtime actions such as prompt continuation through the task's currently bound local session
- `POST /api/tasks/:id/assignment`: assign, reassign, or clear a persisted task owner without breaking the underlying run/session truth model
- `POST /api/tasks/:id/priority`: raise, lower, or reset a persisted task priority so projected task ordering and audit history can change truthfully without implying automatic dispatch
- `POST /api/tasks/:id/handoff`: create, update, or clear a pending task handoff request while keeping the current owner and bound runtime session explicit
- `POST /api/tasks/:id/handoff-actions`: complete a pending task handoff so task-plane ownership moves to the requested target while the bound runtime session remains explicit
- `POST /api/resources/:platform/policy`: set or clear a persisted platform-level slot limit so the dashboard can surface saturation and overcommitment truthfully
- `POST /api/agents/:id/runtime-actions`: trigger truthful local runtime actions for agents that expose them, including Claude Code prompt dispatch, Gemini CLI prompt dispatch (when local auth is usable), Copilot prompt dispatch, sidecar loopback prompt dispatch, plus OpenClaw gateway recovery and session reset
- `POST /api/agents/:id/workspace-actions`: open the selected agent workspace in Finder or Terminal, reveal a supported local session path such as the Copilot session-state folder or a local Claude/Gemini session file, or open the runtime state folder for supported local runtimes
- `GET /api/references`: fetch a curated list of high-star upstream projects worth reusing from Agent Hub
