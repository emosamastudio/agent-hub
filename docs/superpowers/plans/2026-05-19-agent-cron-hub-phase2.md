# Agent Cron Hub Phase 2 — SDKs & External Consumer Migration Plan

**Goal:** Build Go and TypeScript SDKs, then migrate one external consumer project to use the Go SDK without coupling Agent Hub to that project.

**Dependencies:** Phase 1 hub running (port 8788, PostgreSQL localhost:5433)

---

## Task 11: Go SDK — Core Library

**Files:** New repo `github.com/emosama/agent-hub-sdk-go`

Implement `client.go`, `mux.go`, `context.go`, `llm.go`, `heartbeat.go`, `cooldowns.go`, `go.mod`

Core API:
```go
client := agenthub.NewClient(agenthub.Config{
    ServerURL: "http://localhost:8788",
    Project:   "consumer-project",
    APIKey:    "...",
})
client.Register(agenthub.AgentSpec{Name: "deep_research", ...})
mux := agenthub.NewServeMux()
mux.HandleFunc("deep_research", handler)
client.Run(ctx, mux)
```

## Task 12: TypeScript SDK

**Files:** `packages/sdk/src/index.ts`, `packages/sdk/package.json`

Same API surface as Go SDK, targets Node.js 20+. Zero deps (uses built-in fetch).

## Task 13: Example Consumer Migration

**Files:** external consumer repository

- Replace selected consumer-side agent processes with Go SDK agents
- Create a consumer-owned `cmd/agent-hub-workers/main.go` registering that project's agents
- Keep all business logic and storage inside the external consumer repository
