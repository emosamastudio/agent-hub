package agenthub

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientRunRegistersPollsAndReports(t *testing.T) {
	reported := make(chan Result, 1)
	traced := make(chan struct {
		Traces []struct {
			TurnIndex     int    `json:"turn_index"`
			SpanIndex     int    `json:"span_index"`
			Role          string `json:"role"`
			SpanType      string `json:"span_type"`
			OutputContent string `json:"output_content"`
		} `json:"traces"`
	}, 1)
	var registered AgentSpec

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Agent-Hub-Version") != "1" {
			t.Errorf("missing Agent-Hub-Version header")
		}
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("authorization header = %q", r.Header.Get("Authorization"))
		}
		if r.Header.Get("X-Agent-Hub-Project") != "oph" {
			t.Errorf("project header = %q", r.Header.Get("X-Agent-Hub-Project"))
		}

		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/api/registry/agents":
			if err := json.NewDecoder(r.Body).Decode(&registered); err != nil {
				t.Errorf("decode registration: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"agent-1","name":"deep_research","handlerName":"deep_research_handler"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/executors/poll":
			if r.URL.Query().Get("agent_names") != "deep_research" {
				t.Errorf("poll agent_names = %q", r.URL.Query().Get("agent_names"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"exec-1","agentId":"agent-1","agentName":"deep_research","handlerName":"deep_research_handler","triggerType":"manual","inputPayload":{"repo_name":"openai-go"},"timeoutSeconds":60}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/executions/exec-1/traces":
			var body struct {
				Traces []struct {
					TurnIndex     int    `json:"turn_index"`
					SpanIndex     int    `json:"span_index"`
					Role          string `json:"role"`
					SpanType      string `json:"span_type"`
					OutputContent string `json:"output_content"`
				} `json:"traces"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode traces: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"count":1}`))
			traced <- body
		case r.Method == http.MethodPost && r.URL.Path == "/api/executions/exec-1/report":
			var result Result
			if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
				t.Errorf("decode report: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
			reported <- result
		case r.Method == http.MethodPost && r.URL.Path == "/api/executors/heartbeat":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient(Config{ServerURL: server.URL, Project: "oph", APIKey: "token"})
	client.Register(AgentSpec{
		Name:        "deep_research",
		Description: "Runs the deep research OPH handler against queued repository research jobs.",
		Handler:     "deep_research_handler",
	})

	mux := NewServeMux()
	mux.HandleFunc("deep_research_handler", func(ctx *Context, job *Job) error {
		if job.InputPayload["repo_name"] != "openai-go" {
			t.Fatalf("repo_name = %v", job.InputPayload["repo_name"])
		}
		if ctx.Payload()["repo_name"] != "openai-go" {
			t.Fatalf("context payload = %v", ctx.Payload())
		}
		ctx.Log("processing %s", job.InputPayload["repo_name"])
		return nil
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		errCh <- client.Run(ctx, mux)
	}()

	select {
	case result := <-reported:
		if result.Status != StatusSuccess {
			t.Fatalf("report status = %q", result.Status)
		}
		if result.TraceCountExpected != 1 {
			t.Fatalf("trace count expected = %d", result.TraceCountExpected)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for report")
	}
	select {
	case body := <-traced:
		if len(body.Traces) != 1 {
			t.Fatalf("trace count = %d", len(body.Traces))
		}
		trace := body.Traces[0]
		if trace.TurnIndex != 0 || trace.SpanIndex != 0 {
			t.Fatalf("trace indexes = %d/%d", trace.TurnIndex, trace.SpanIndex)
		}
		if trace.Role != "tool" || trace.SpanType != "log" {
			t.Fatalf("trace role/type = %q/%q", trace.Role, trace.SpanType)
		}
		if trace.OutputContent != "processing openai-go" {
			t.Fatalf("trace output = %q", trace.OutputContent)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for traces")
	}
	cancel()
	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) && !strings.Contains(err.Error(), context.Canceled.Error()) {
			t.Fatalf("Run error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for Run to stop")
	}

	if registered.Name != "deep_research" {
		t.Fatalf("registered name = %q", registered.Name)
	}
	if registered.DisplayName != "deep_research" {
		t.Fatalf("registered display name = %q", registered.DisplayName)
	}
	if registered.Description != "Runs the deep research OPH handler against queued repository research jobs." {
		t.Fatalf("registered description = %q", registered.Description)
	}
	if registered.AgentType != AgentTypeCronTask {
		t.Fatalf("registered agent type = %q", registered.AgentType)
	}
	if registered.Concurrency != 1 {
		t.Fatalf("default concurrency = %d", registered.Concurrency)
	}
	if registered.TimeoutSeconds != 600 {
		t.Fatalf("default timeout = %d", registered.TimeoutSeconds)
	}
}

func TestHeartbeatSendsRegisteredAgentsProgressAndCancellationSignals(t *testing.T) {
	var heartbeatBody heartbeatRequest

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/api/registry/agents":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"agent-1","name":"deep_research","handlerName":"deep_research_handler"}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/executors/heartbeat":
			if err := json.NewDecoder(r.Body).Decode(&heartbeatBody); err != nil {
				t.Errorf("decode heartbeat: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"cancelled_execution_ids":["exec-cancelled"]}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient(Config{ServerURL: server.URL, APIKey: "token"})
	client.Register(testAgentSpec("deep_research", "deep_research_handler"))

	if _, err := client.SyncRegistry(context.Background()); err != nil {
		t.Fatalf("SyncRegistry: %v", err)
	}
	result, err := client.ReportProgress(context.Background(), "exec-1", 42, "halfway")
	if err != nil {
		t.Fatalf("ReportProgress: %v", err)
	}

	if got := strings.Join(heartbeatBody.AgentNames, ","); got != "deep_research" {
		t.Fatalf("heartbeat agent_names = %q", got)
	}
	if len(heartbeatBody.Executions) != 1 {
		t.Fatalf("heartbeat execution count = %d", len(heartbeatBody.Executions))
	}
	if heartbeatBody.Executions[0].ProgressPercent != 42 {
		t.Fatalf("progress percent = %d", heartbeatBody.Executions[0].ProgressPercent)
	}
	if heartbeatBody.Executions[0].ProgressMessage != "halfway" {
		t.Fatalf("progress message = %q", heartbeatBody.Executions[0].ProgressMessage)
	}
	if len(result.CancelledExecutionIDs) != 1 || result.CancelledExecutionIDs[0] != "exec-cancelled" {
		t.Fatalf("cancelled ids = %#v", result.CancelledExecutionIDs)
	}
}

func TestPollSendsAllRegisteredAgentNames(t *testing.T) {
	pollSeen := make(chan string, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/api/registry/agents":
			var spec AgentSpec
			if err := json.NewDecoder(r.Body).Decode(&spec); err != nil {
				t.Errorf("decode registration: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			if spec.Name == "relationship_agent" {
				_, _ = w.Write([]byte(`{"id":"agent-2","name":"relationship_agent","handlerName":"relationship_handler"}`))
				return
			}
			_, _ = w.Write([]byte(`{"id":"agent-1","name":"deep_research","handlerName":"deep_research_handler"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/executors/poll":
			pollSeen <- r.URL.Query().Get("agent_names")
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient(Config{ServerURL: server.URL})
	client.Register(testAgentSpec("deep_research", "deep_research_handler"))
	client.Register(testAgentSpec("relationship_agent", "relationship_handler"))

	if _, err := client.SyncRegistry(context.Background()); err != nil {
		t.Fatalf("SyncRegistry: %v", err)
	}
	job, ok, err := client.Poll(context.Background())
	if err != nil || ok || job != nil {
		t.Fatalf("Poll = job %#v ok %v err %v", job, ok, err)
	}

	if got := <-pollSeen; got != "deep_research,relationship_agent" {
		t.Fatalf("poll agent_names = %q", got)
	}
}

func TestSyncRegistryRequiresAgentDescription(t *testing.T) {
	client := NewClient(Config{ServerURL: "http://agent-hub.invalid"})
	client.Register(AgentSpec{Name: "deep_research", Handler: "deep_research_handler"})

	_, err := client.SyncRegistry(context.Background())
	if err == nil || !strings.Contains(err.Error(), "description is required") {
		t.Fatalf("SyncRegistry error = %v", err)
	}
}

func TestRunRejectsAgentsWithoutMatchingMuxHandlersBeforeSync(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	}))
	defer server.Close()

	client := NewClient(Config{ServerURL: server.URL})
	client.Register(testAgentSpec("deep_research", "deep_research_handler"))

	mux := NewServeMux()
	mux.HandleFunc("relationship_handler", func(ctx *Context, job *Job) error { return nil })

	err := client.Run(context.Background(), mux)
	if err == nil || !strings.Contains(err.Error(), "handler deep_research_handler is not registered for agent deep_research") {
		t.Fatalf("Run error = %v", err)
	}
	if requestCount != 0 {
		t.Fatalf("request count = %d", requestCount)
	}
}

func TestRunReportsMissingHandlerAsFailedExecution(t *testing.T) {
	reported := make(chan Result, 1)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/api/registry/agents":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"agent-1","name":"deep_research","handlerName":"deep_research_handler"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/api/executors/poll":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"exec-1","agentId":"agent-1","agentName":"deep_research","handlerName":"missing_handler","triggerType":"manual","inputPayload":{}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/executions/exec-1/report":
			var result Result
			if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
				t.Errorf("decode report: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
			reported <- result
		case r.Method == http.MethodPost && r.URL.Path == "/api/executors/heartbeat":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewClient(Config{ServerURL: server.URL})
	client.Register(testAgentSpec("deep_research", "deep_research_handler"))
	mux := NewServeMux()
	mux.HandleFunc("deep_research_handler", func(ctx *Context, job *Job) error { return nil })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		errCh <- client.Run(ctx, mux)
	}()

	select {
	case result := <-reported:
		if result.Status != StatusFailed {
			t.Fatalf("report status = %q", result.Status)
		}
		if !strings.Contains(result.ErrorMessage, "handler not found") {
			t.Fatalf("error message = %q", result.ErrorMessage)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for report")
	}
	cancel()
	<-errCh
}

func testAgentSpec(name string, handler string) AgentSpec {
	return AgentSpec{
		Name:        name,
		Description: "Runs the " + name + " handler for Agent Hub Go SDK integration tests.",
		Handler:     handler,
	}
}
