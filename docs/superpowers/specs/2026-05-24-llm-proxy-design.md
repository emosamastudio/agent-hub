# LLM Proxy — Universal Trace Capture Spec

**Date:** 2026-05-24
**Status:** Draft (revised after review)
**Depends on:** Agent Cron Hub Phase 1 (running)

---

## 1. Problem

Agent Hub's trace system requires the SDK to explicitly call `ctx.trace.add()` after each LLM call. This works when the agent handler is written with the hub SDK. But in practice:

- **OPH** deep research runs `agent-v5.mjs` — a 1,450-line Node.js subprocess using raw `fetch` for LLM calls
- **Inori** (future) uses Claude Agent SDK — its LLM calls are internal, not exposed to our SDK
- **Any future project** may use OpenAI Python, LangChain, or custom HTTP clients

Forcing every project to instrument LLM calls through our SDK creates per-project migration burden and breaks when upstream SDKs change their internals.

## 2. Solution

**Network-layer LLM proxy inside Agent Hub.** Agents route LLM traffic through the hub instead of calling providers directly. The hub transparently forwards requests while capturing prompt→response pairs as traces.

```
Before:  agent process ──→ api.anthropic.com / api.openai.com
                          (no trace capture)

After:   agent process ──→ Agent Hub :8788/v1 ──→ real provider
                                              ├── forward request
                                              ├── capture prompt + response
                                              ├── compute tokens + cost
                                              └── write trace row (auto-linked to execution)
```

### 2.1 Why This Works Across All Projects

Every LLM SDK and HTTP client ultimately makes HTTP requests. Changing the base URL and API key is always supported:

| Project | Language | LLM Client | Change Needed |
|---------|----------|------------|---------------|
| OPH | Node.js subprocess | raw `fetch` | `ANTHROPIC_BASE_URL` env var |
| Inori | Python | Claude Agent SDK | `ANTHROPIC_BASE_URL` env var |
| Any Python | Python | openai package | `OPENAI_BASE_URL` env var |
| Any TypeScript | TS | OpenAI SDK | `baseURL` config |
| Any Go | Go | any HTTP client | `BaseURL` config |

Zero code changes to the agent's LLM logic. One configuration change.

---

## 3. How It Works

### 3.1 Per-Execution Proxy Token

When the executor polls and claims a job, the hub response includes a short-lived `proxy_token`:

```json
// GET /api/executors/poll (30s long-poll) response
{
  "execution_id": "abc-123",
  "agent_name": "deep_research",
  "input_payload": {...},
  "proxy_token": "agh_proxy_Kj9mX2...",              // 32 random bytes, base64url-encoded
  "proxy_expires_at": "2026-05-24T12:30:00Z"
}
```

Token format: `agh_proxy_` prefix + 32 bytes `crypto.randomBytes(32)` encoded as base64url ≈ 59 characters total.

The executor sets two environment variables before running the agent handler:

```bash
export AGENT_HUB_PROXY_URL="http://agent-hub:8788/v1"
export AGENT_HUB_PROXY_TOKEN="agh_proxy_Kj9mX2..."
```

### 3.2 Agent Configures LLM Base URL

The agent handler (or its subprocess) maps these to the LLM SDK's config:

```python
# Python / Claude Agent SDK
import anthropic
client = anthropic.Anthropic(
    base_url=os.environ["AGENT_HUB_PROXY_URL"],
    api_key=os.environ["AGENT_HUB_PROXY_TOKEN"],
)
```

```javascript
// Node.js subprocess (OPH agent-v5.mjs)
// NOTE: AGENT_HUB_PROXY_URL already ends with /v1
const response = await fetch(`${process.env.AGENT_HUB_PROXY_URL}/messages`, {
    headers: {
        "x-api-key": process.env.AGENT_HUB_PROXY_TOKEN,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    },
    body: JSON.stringify({ model: "...", messages: [...], max_tokens: 4096 }),
});
```

```go
// Go SDK — automatic: the SDK sets these before calling handler.Run()
```

### 3.3 Hub Proxy Forwards + Captures

The proxy handles both streaming and non-streaming responses from the upstream provider:

**Non-streaming mode (`"stream": false` or absent):**

```
Agent sends:
  POST http://hub:8788/v1/messages
  x-api-key: agh_proxy_Kj9mX2...
  {"model":"claude-sonnet-4-6","messages":[...],"max_tokens":4096}

Hub proxy:
  1. Hash proxy_token → look up in proxy_tokens table
     → execution_id=abc-123, agent_id=..., project_id=...
  2. Resolve provider config (agent → project → global)
     → real API key, real endpoint URL
  3. Forward request to real provider
  4. Buffer response body (up to 10 MB)
  5. INSERT INTO traces (execution_id, model, input_content, output_content,
                         input_tokens, output_tokens, cost_estimate, latency_ms)
  6. UPDATE proxy_tokens SET last_used_at = now()
  7. Return response to agent (byte-identical to what provider returned)
```

**Streaming mode (`"stream": true`):**

```
Hub proxy:
  1-2. Same: resolve token + provider config
  3. Forward request to real provider with stream: true
  4. Pipe each SSE frame back to agent as it arrives (sub-ms forwarding latency per frame)
  5. Accumulate all content_block_delta.text and tool_use increments in a buffer
  6. When stream ends (data: [DONE] or connection close):
     a. Assemble final accumulated output (text + tool calls)
     b. INSERT INTO traces (as above)
     c. Update last_used_at
```

Streaming trace rows carry the same fields as non-streaming. The `output_content` is the assembled final text, not raw SSE frames. `tool_calls` JSONB captures tool use blocks.

**Provider error responses (4xx/5xx):**

Provider errors are traced just like successes. The trace `output_content` stores the error body; `role` = `system`; `metadata.error = true`; `metadata.status_code` = the HTTP status. This captures rate limits, token overflows, and model errors in the dashboard trace viewer.

### 3.4 Supported Provider Formats

The hub auto-detects the provider format from the request path:

| Hub Path | Forwards To | Auth Header |
|----------|-------------|-------------|
| `/v1/messages` | Anthropic Messages API | `x-api-key` → real Anthropic key |
| `/v1/chat/completions` | OpenAI Chat Completions API | `Authorization: Bearer` → real OpenAI key |
| `/v1/models` | Provider's models endpoint | same as above |
| `/v1/proxy/{provider}/*` | Custom provider (future) | per-provider config |

**Phase 1:** Anthropic `/v1/messages` only (covers OPH + Inori use cases). OpenAI and custom providers in Phase 2.

### 3.5 Provider API Key Resolution

The hub selects the provider key based on the request path:

- `/v1/messages` → look up `provider_config.anthropic.api_key`
- `/v1/chat/completions` → look up `provider_config.openai.api_key`

Resolution order for each provider:

1. **Agent-level `provider_config.<provider>.api_key`** — agent-specific key (encrypted at rest)
2. **Project-level `provider_config.<provider>.api_key`** — project default (encrypted at rest)
3. **Hub global env var** — `AGENT_HUB_ANTHROPIC_API_KEY` or `AGENT_HUB_OPENAI_API_KEY`

Example `provider_config` JSONB on `agents` or `projects`:

```json
{
  "anthropic": {
    "api_key": "<encrypted>",
    "endpoint": "https://api.anthropic.com",
    "model_default": "claude-sonnet-4-6"
  },
  "openai": {
    "api_key": "<encrypted>",
    "endpoint": "https://api.openai.com",
    "model_default": "gpt-4o"
  }
}
```

This supports agents that call multiple providers within a single execution — each path routes to the correct key.

### 3.6 SSRF Protection

The proxy MUST NOT forward to arbitrary hosts. Allowed endpoints:

- Anthropic: `https://api.anthropic.com` (hardcoded)
- OpenAI: `https://api.openai.com` (hardcoded)
- Custom: must match the `endpoint` in `provider_config.<provider>.endpoint`, and that endpoint is set via dashboard/API, never by the agent at request time

The proxy validates the target URL against this allowlist before forwarding. Requests with unknown paths or unconfigured providers get 403.

### 3.7 Concurrent LLM Call Ordering

When an agent fires multiple parallel LLM calls in one execution, each proxy request independently inserts a trace row. To preserve ordering:

- `turn_index` is copied from the request's `X-Turn-Index` header (set by agent/ReAct loop). If absent, defaults to 0.
- `span_index` is computed at insert time: `SELECT COALESCE(MAX(span_index), -1) + 1 FROM traces WHERE execution_id = $1`. This is atomic within the INSERT transaction.
- `parent_span_id` is NULL for proxy traces (no nested tool calls at this level).

Parallel calls within the same turn get sequential `span_index` values in insertion order. The dashboard groups by `turn_index`, then orders by `span_index`.

---

## 4. Data Model Changes

### 4.1 New Table: `proxy_tokens`

```sql
CREATE TABLE proxy_tokens (
  token_hash    TEXT PRIMARY KEY,              -- SHA-256 of the raw token
  execution_id  UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  agent_id      UUID NOT NULL REFERENCES agents(id),
  project_id    UUID NOT NULL REFERENCES projects(id),
  expires_at    TIMESTAMPTZ NOT NULL,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_proxy_tokens_execution ON proxy_tokens(execution_id);
CREATE INDEX idx_proxy_tokens_expires ON proxy_tokens(expires_at) WHERE expires_at > now();
```

**Lifecycle:**

- **Created** when executor polls and claims a job (`claimForDispatch` is atomic: queued→running, so each execution is claimed exactly once)
- **Expires at:** `max(scheduled_at + timeout_seconds + 60s, now() + 5 minutes)` — enough headroom for the agent to finish all LLM calls
- **Expired tokens** purged by `RetentionCleanup` scheduler step:
  ```sql
  DELETE FROM proxy_tokens WHERE expires_at < now() - INTERVAL '1 hour';
  ```
  Keeps tokens for 1 hour past expiry for debugging, then deletes.
- **No overwrite:** one execution = one token. No re-poll for the same execution.

### 4.2 New Columns

```sql
-- agents table
ALTER TABLE agents ADD COLUMN provider_config JSONB DEFAULT NULL;

-- projects table
ALTER TABLE projects ADD COLUMN provider_config JSONB DEFAULT NULL;
```

`provider_config.api_key` values are encrypted at rest using AES-256-GCM. The encryption key comes from the `AGENT_HUB_ENCRYPTION_KEY` environment variable (64 hex characters = 32 bytes). If this variable is not set, the proxy refuses to start with a clear error message. Keys are decrypted on first use per proxy request and cached in memory for the request lifetime only.

### 4.3 No Changes To

- `traces` table — unchanged, all needed columns exist
- `executions` table — unchanged
- SDK API surface — `ctx.llm.chat()` still works but becomes optional; proxy is the primary trace path

---

## 5. SDK Changes

### 5.1 Go SDK

The Go SDK runner already controls the subprocess environment. After polling:

```go
// Before invoking handler:
cmd.Env = append(cmd.Env,
    "AGENT_HUB_PROXY_URL=" + job.ProxyURL,
    "AGENT_HUB_PROXY_TOKEN=" + job.ProxyToken,
)
```

The `ctx.llm.chat()` method is updated to route through the proxy when these env vars are set, making SDK-native LLM calls also get auto-captured.

### 5.2 Python SDK

Same pattern — the executor wrapper sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` (or `OPENAI_BASE_URL` / `OPENAI_API_KEY`) from the proxy token before running the handler.

### 5.3 TypeScript SDK

Same — set env vars before handler execution.

### 5.4 Trace Priority

When both proxy traces and SDK `ctx.trace.add()` traces exist for the same execution, they merge by `created_at` order. The proxy writes traces directly; the SDK's `trace_count_expected` is set to NULL (unknown) for proxy-traced executions — the dashboard shows all captured traces.

---

## 6. API Changes

### 6.1 Modified: `GET /api/executors/poll`

Adds three fields to the response:

```diff
  {
    "execution_id": "abc-123",
    "agent_name": "deep_research",
    "input_payload": {...},
+   "proxy_token": "agh_proxy_Kj9mX2...",
+   "proxy_url": "http://agent-hub:8788/v1",
+   "proxy_expires_at": "2026-05-24T12:30:00Z"
  }
```

The executor MUST set `AGENT_HUB_PROXY_URL` and `AGENT_HUB_PROXY_TOKEN` before running the handler. If the executor spawns subprocesses, it passes these env vars through.

### 6.2 New: `POST /v1/messages` (LLM Proxy)

Anthropic Messages API compatible. Auth via `x-api-key: <proxy_token>`.

Supports:

- `stream: false` (default) — buffered forward, full trace capture
- `stream: true` — SSE pipe + accumulate, trace written after stream ends

Headers forwarded to provider:
- `x-api-key` → replaced with real Anthropic API key
- `anthropic-version` → forwarded as-is
- `anthropic-beta` → forwarded as-is
- `content-type` → forwarded as-is

### 6.3 New: `GET /v1/models` (LLM Proxy)

Passthrough to provider's models endpoint. Lists models available via the proxy so agent SDKs can discover them.

### 6.4 New: `GET /api/health` — extends with proxy status

```diff
  {
    "status": "ok",
    "database": "ok",
+   "proxy": {
+     "anthropic": "reachable",       // or "unreachable" if last health check failed
+     "openai": "not_configured"      // provider has no keys configured
+   }
  }
```

---

## 7. Auth Bypass

The LLM proxy endpoints (`/v1/*`) are added to the auth middleware skip list. They use proxy token authentication, not Basic Auth or project API key.

Proxy token auth flow:

1. Extract raw token from `x-api-key` header (Anthropic paths) or `Authorization: Bearer` header (OpenAI paths)
2. `token_hash = SHA-256(raw_token)`
3. `SELECT execution_id, agent_id, project_id FROM proxy_tokens WHERE token_hash = $1 AND expires_at > now()`
4. If no row → 401 `{"error": "invalid or expired proxy token"}`
5. Load `provider_config` from agent (fallback project, fallback global)
6. If no provider API key configured → 502 `{"error": "no upstream API key configured for provider"}`

---

## 8. Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Proxy token leaked in logs | SHA-256 hashed at rest; short-lived (execution timeout + 60s) |
| SSRF via custom provider endpoint | Provider endpoints must be pre-configured in DB; agent cannot specify target at request time |
| Agent reads another execution's traces | Proxy token binds to exactly one execution_id |
| Token reuse after expiry | DB lookup checks `expires_at > now()` |
| Provider API key exposure at rest | AES-256-GCM encrypted; `AGENT_HUB_ENCRYPTION_KEY` required at startup |
| Provider API key exposure in transit | Keys only travel hub→provider over TLS; never returned in hub API responses |
| Large request/response bodies | Max 10 MB body size; content stored TOAST-compressed by PostgreSQL |
| Rate limiting | Per-execution: max 100 LLM calls/minute; exceeded → 429 with retry-after |

---

## 9. Deployment Impact

- **Zero downtime:** New routes + new table + new columns. Existing APIs unchanged.
- **Migration:** `ALTER TABLE` for `provider_config` columns + new migration for `proxy_tokens` table
- **New required env var:** `AGENT_HUB_ENCRYPTION_KEY` (64 hex chars). Production startup fails without it.
- **Performance:** One DB write (trace insert) per LLM call. Proxy forwarding adds <5ms latency per request (local Docker network). Streaming mode adds <1ms per SSE frame (pipe, don't buffer).
- **Storage:** Existing trace rows. Proxy increases trace volume proportionally to agent LLM usage — this is the intended behavior.

---

## 10. Verification Checklist

- [ ] `oph-agents` sets `AGENT_HUB_PROXY_URL` / `AGENT_HUB_PROXY_TOKEN` before spawning agent-v5.mjs
- [ ] agent-v5.mjs LLM calls route through hub proxy (verify via hub access logs)
- [ ] Non-streaming Anthropic call → one trace row with full input/output
- [ ] Streaming Anthropic call → SSE piped to agent + trace written after stream ends
- [ ] Provider error (e.g., rate limit) → trace row with `metadata.error = true`
- [ ] Trace rows linked to correct execution_id (dashboard trace viewer)
- [ ] Expired proxy token → 401
- [ ] Unconfigured provider → 502
- [ ] `provider_config.api_key` encrypted at rest in DB (verify with direct SQL query)
- [ ] `AGENT_HUB_ENCRYPTION_KEY` missing → startup fails with clear error
- [ ] SSRF: proxy rejects unknown paths / unconfigured provider endpoints
- [ ] Concurrent executions (concurrency=3) → each gets unique proxy token, traces don't cross-link
- [ ] Parallel LLM calls within one execution → sequential `span_index`, correct `turn_index` grouping
- [ ] Existing SDK `ctx.trace.add()` traces still work alongside proxy traces
- [ ] `/api/health` reports proxy upstream reachability

---

## 11. References

| File | Role |
|------|------|
| `src/db/schema.ts` | Add `proxy_tokens` table, `provider_config` columns on `agents`/`projects` |
| `src/http/routes.ts` | Add proxy token to poll response, register `/v1/*` routes |
| `src/http/llm-proxy.ts` | New — proxy handler logic (forward, stream pipe, trace write, error capture) |
| `src/services/scheduler.ts` | RetentionCleanup: add expired proxy token purge |
| `src/middleware/auth.ts` | Add `/v1/*` to auth skip list |
| `src/config.ts` | Add `AGENT_HUB_ENCRYPTION_KEY`, `AGENT_HUB_ANTHROPIC_API_KEY`, `AGENT_HUB_OPENAI_API_KEY` |
| `internal/hub/executor.go` (OPH) | Set proxy env vars before subprocess |
| `cmd/oph-agents/main.go` (OPH) | No changes (SDK handles proxy token from poll response) |
