package agenthub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	AgentTypeCronTask = "cron_task"
	AgentTypeLLMAgent = "llm_agent"

	StatusSuccess = "success"
	StatusFailed  = "failed"
)

// Config holds connection settings for an Agent Hub executor.
type Config struct {
	ServerURL  string
	Project    string
	APIKey     string
	HTTPClient *http.Client
}

// AgentSpec describes an agent registered with Agent Hub.
type AgentSpec struct {
	Name            string            `json:"name"`
	DisplayName     string            `json:"displayName"`
	Description     string            `json:"description"`
	AgentType       string            `json:"agentType"`
	Cron            string            `json:"cron,omitempty"`
	Handler         string            `json:"handler,omitempty"`
	InputSchema     map[string]any    `json:"inputSchema,omitempty"`
	Concurrency     int               `json:"concurrency,omitempty"`
	TimeoutSeconds  int               `json:"timeoutSeconds,omitempty"`
	RetryMax        int               `json:"retryMax,omitempty"`
	MaxPendingQueue int               `json:"maxPendingQueue,omitempty"`
	MisfirePolicy   string            `json:"misfirePolicy,omitempty"`
	ExecutorHost    string            `json:"executorHost,omitempty"`
	Labels          map[string]string `json:"labels,omitempty"`
}

// RegisteredAgent is the hub record returned after registry sync.
type RegisteredAgent struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	HandlerName string `json:"handlerName"`
}

// Job represents a claimed execution.
type Job struct {
	ExecutionID    string         `json:"id"`
	AgentID        string         `json:"agentId"`
	AgentName      string         `json:"agentName,omitempty"`
	HandlerName    string         `json:"handlerName,omitempty"`
	TriggerType    string         `json:"triggerType"`
	Status         string         `json:"status,omitempty"`
	InputPayload   map[string]any `json:"inputPayload"`
	TimeoutSeconds int            `json:"timeoutSeconds,omitempty"`
}

// Result is reported after a job handler finishes.
type Result struct {
	Status             string         `json:"status"`
	Summary            string         `json:"result_summary,omitempty"`
	Data               map[string]any `json:"result_data,omitempty"`
	ErrorMessage       string         `json:"error_message,omitempty"`
	ErrorStack         string         `json:"error_stack,omitempty"`
	TraceCountExpected int            `json:"trace_count_expected,omitempty"`
}

// ExecutionProgress is sent through executor heartbeat.
type ExecutionProgress struct {
	ExecutionID     string `json:"execution_id"`
	ProgressPercent int    `json:"progress_percent,omitempty"`
	ProgressMessage string `json:"progress_message,omitempty"`
}

// HeartbeatResult is Agent Hub's heartbeat response.
type HeartbeatResult struct {
	OK                    bool     `json:"ok"`
	ExecutionsUpdated     int      `json:"executions_updated,omitempty"`
	CancelledExecutionIDs []string `json:"cancelled_execution_ids,omitempty"`
}

type heartbeatRequest struct {
	AgentNames []string            `json:"agent_names"`
	Executions []ExecutionProgress `json:"executions,omitempty"`
}

// HandlerFunc handles one hub-dispatched job.
type HandlerFunc func(ctx *Context, job *Job) error

// ServeMux maps Agent Hub handler names to local functions.
type ServeMux struct {
	handlers map[string]HandlerFunc
}

// NewServeMux creates an empty handler registry.
func NewServeMux() *ServeMux {
	return &ServeMux{handlers: make(map[string]HandlerFunc)}
}

// HandleFunc registers a handler function for an Agent Hub handler name.
func (m *ServeMux) HandleFunc(name string, fn HandlerFunc) {
	m.handlers[name] = fn
}

type registeredAgent struct {
	id      string
	name    string
	handler string
}

// Client registers local agents, polls Agent Hub for work, and reports results.
type Client struct {
	config     Config
	httpClient *http.Client
	agents     []AgentSpec
	registered []registeredAgent
}

// NewClient returns an Agent Hub client with conservative HTTP defaults.
func NewClient(config Config) *Client {
	config.ServerURL = strings.TrimRight(config.ServerURL, "/")
	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 35 * time.Second}
	}
	return &Client{
		config:     config,
		httpClient: httpClient,
	}
}

// Register adds an agent to the local registry set used by SyncRegistry and Run.
func (c *Client) Register(spec AgentSpec) {
	c.agents = append(c.agents, normalizeAgentSpec(spec))
}

// SyncRegistry upserts all registered local agents into Agent Hub.
func (c *Client) SyncRegistry(ctx context.Context) ([]RegisteredAgent, error) {
	c.registered = c.registered[:0]
	registered := make([]RegisteredAgent, 0, len(c.agents))
	for _, agent := range c.agents {
		if strings.TrimSpace(agent.Description) == "" {
			return nil, fmt.Errorf("agenthub: agent %s description is required", agent.Name)
		}
		resp, err := c.do(ctx, http.MethodPut, "/api/registry/agents", agent)
		if err != nil {
			return nil, err
		}
		var hubAgent RegisteredAgent
		if err := decodeResponse(resp, http.StatusOK, &hubAgent); err != nil {
			return nil, fmt.Errorf("register %s: %w", agent.Name, err)
		}
		handler := agent.Handler
		if handler == "" {
			handler = hubAgent.HandlerName
		}
		c.registered = append(c.registered, registeredAgent{
			id:      hubAgent.ID,
			name:    hubAgent.Name,
			handler: handler,
		})
		registered = append(registered, hubAgent)
	}
	return registered, nil
}

// Heartbeat marks this executor's registered agents online and optionally sends execution progress.
func (c *Client) Heartbeat(ctx context.Context, progress []ExecutionProgress) (*HeartbeatResult, error) {
	agentNames := c.agentNames()
	if len(agentNames) == 0 {
		return nil, errors.New("agenthub: no registered agents for heartbeat")
	}
	resp, err := c.do(ctx, http.MethodPost, "/api/executors/heartbeat", heartbeatRequest{
		AgentNames: agentNames,
		Executions: progress,
	})
	if err != nil {
		return nil, err
	}
	return decodeOptionalHeartbeat(resp)
}

// ReportProgress sends a single execution progress heartbeat.
func (c *Client) ReportProgress(ctx context.Context, executionID string, percent int, message string) (*HeartbeatResult, error) {
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	return c.Heartbeat(ctx, []ExecutionProgress{{
		ExecutionID:     executionID,
		ProgressPercent: percent,
		ProgressMessage: message,
	}})
}

// Poll claims one queued execution for this executor's registered agent names.
func (c *Client) Poll(ctx context.Context) (*Job, bool, error) {
	agentNames := c.agentNames()
	if len(agentNames) == 0 {
		return nil, false, errors.New("agenthub: no registered agents to poll")
	}
	query := url.Values{}
	query.Set("agent_names", strings.Join(agentNames, ","))
	resp, err := c.do(ctx, http.MethodGet, "/api/executors/poll?"+query.Encode(), nil)
	if err != nil {
		return nil, false, err
	}
	if resp.StatusCode == http.StatusNoContent {
		return nil, false, closeResponse(resp)
	}
	var job Job
	if err := decodeResponse(resp, http.StatusOK, &job); err != nil {
		return nil, false, err
	}
	if job.ExecutionID == "" {
		return nil, false, errors.New("agenthub: poll response missing execution id")
	}
	return &job, true, nil
}

// Report sends the final execution result to Agent Hub.
func (c *Client) Report(ctx context.Context, executionID string, result Result) error {
	path := "/api/executions/" + url.PathEscape(executionID) + "/report"
	resp, err := c.do(ctx, http.MethodPost, path, result)
	if err != nil {
		return err
	}
	return closeResponse(resp)
}

// Run validates handler wiring, syncs the registry, heartbeats in the background, polls continuously, and reports results.
func (c *Client) Run(ctx context.Context, mux *ServeMux) error {
	if mux == nil {
		return errors.New("agenthub: nil mux")
	}
	if len(mux.handlers) == 0 {
		return errors.New("agenthub: no handlers registered")
	}
	if err := c.validateHandlers(mux); err != nil {
		return err
	}
	if _, err := c.SyncRegistry(ctx); err != nil {
		return fmt.Errorf("sync registry: %w", err)
	}

	go c.heartbeatLoop(ctx)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		job, ok, err := c.Poll(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
				return ctx.Err()
			}
			if err := sleepOrCancel(ctx, time.Second); err != nil {
				return err
			}
			continue
		}
		if !ok {
			continue
		}

		result := c.handleJob(ctx, mux, job)
		if err := c.Report(ctx, job.ExecutionID, result); err != nil {
			return fmt.Errorf("report execution %s: %w", job.ExecutionID, err)
		}
	}
}

func (c *Client) validateHandlers(mux *ServeMux) error {
	for _, agent := range c.agents {
		handlerName := agent.Handler
		if handlerName == "" {
			handlerName = agent.Name
		}
		if _, ok := mux.handlers[handlerName]; !ok {
			return fmt.Errorf("agenthub: handler %s is not registered for agent %s", handlerName, agent.Name)
		}
	}
	return nil
}

func (c *Client) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	_, _ = c.Heartbeat(ctx, nil)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, _ = c.Heartbeat(ctx, nil)
		}
	}
}

func (c *Client) handleJob(ctx context.Context, mux *ServeMux, job *Job) Result {
	handlerName := c.resolveHandler(job)
	handler, ok := mux.handlers[handlerName]
	if !ok && handlerName == "" && len(mux.handlers) == 1 {
		for _, fallback := range mux.handlers {
			handler = fallback
			ok = true
			break
		}
	}
	if !ok {
		return Result{
			Status:       StatusFailed,
			ErrorMessage: fmt.Sprintf("handler not found for agent %q", job.AgentID),
		}
	}

	execCtx := &Context{
		base:   ctx,
		client: c,
		job:    job,
	}
	if err := handler(execCtx, job); err != nil {
		return Result{Status: StatusFailed, ErrorMessage: err.Error()}
	}
	return Result{Status: StatusSuccess}
}

func (c *Client) resolveHandler(job *Job) string {
	if job.HandlerName != "" {
		return job.HandlerName
	}
	for _, agent := range c.registered {
		if agent.id == job.AgentID || agent.name == job.AgentName {
			return agent.handler
		}
	}
	return ""
}

func (c *Client) agentNames() []string {
	names := make([]string, 0, len(c.registered))
	for _, agent := range c.registered {
		if agent.name != "" {
			names = append(names, agent.name)
		}
	}
	return names
}

func (c *Client) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	if c.config.ServerURL == "" {
		return nil, errors.New("agenthub: server url is required")
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal request: %w", err)
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.config.ServerURL+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Agent-Hub-Version", "1")
	if c.config.Project != "" {
		req.Header.Set("X-Agent-Hub-Project", c.config.Project)
	}
	if c.config.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.config.APIKey)
	}
	return c.httpClient.Do(req)
}

func normalizeAgentSpec(spec AgentSpec) AgentSpec {
	if spec.DisplayName == "" {
		spec.DisplayName = spec.Name
	}
	spec.Description = strings.TrimSpace(spec.Description)
	if spec.AgentType == "" {
		spec.AgentType = AgentTypeCronTask
	}
	if spec.Concurrency == 0 {
		spec.Concurrency = 1
	}
	if spec.TimeoutSeconds == 0 {
		spec.TimeoutSeconds = 600
	}
	if spec.RetryMax == 0 {
		spec.RetryMax = 3
	}
	return spec
}

func decodeResponse(resp *http.Response, expectedStatus int, target any) error {
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != expectedStatus {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if target == nil {
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(target); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	return nil
}

func decodeOptionalHeartbeat(resp *http.Response) (*HeartbeatResult, error) {
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if resp.StatusCode == http.StatusNoContent {
		return &HeartbeatResult{OK: true}, nil
	}
	var result HeartbeatResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		if errors.Is(err, io.EOF) {
			return &HeartbeatResult{OK: true}, nil
		}
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &result, nil
}

func closeResponse(resp *http.Response) error {
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
}

func sleepOrCancel(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
