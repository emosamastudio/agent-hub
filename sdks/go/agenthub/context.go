package agenthub

import (
	"context"
	"fmt"
	"sync"
)

// Context is passed to every job handler.
type Context struct {
	base       context.Context
	client     *Client
	job        *Job
	mu         sync.Mutex
	traces     []TraceSpan
	traceCount int
}

// ExecutionID returns the current Agent Hub execution id.
func (c *Context) ExecutionID() string {
	return c.job.ExecutionID
}

// Payload returns the raw job payload.
func (c *Context) Payload() map[string]any {
	if c.job.InputPayload == nil {
		return map[string]any{}
	}
	return c.job.InputPayload
}

// Log prints a hub execution-scoped log line.
func (c *Context) Log(format string, args ...any) {
	message := fmt.Sprintf(format, args...)
	fmt.Printf("[%s] %s\n", c.job.ExecutionID, message)
	c.RecordTrace(TraceSpan{
		Role:          "tool",
		SpanType:      "log",
		OutputContent: message,
	})
}

// Progress reports execution progress through Agent Hub heartbeat.
func (c *Context) Progress(percent int, message string) (*HeartbeatResult, error) {
	return c.client.ReportProgress(c.base, c.job.ExecutionID, percent, message)
}

// RecordTrace appends a custom trace span that is flushed before the final report.
func (c *Context) RecordTrace(span TraceSpan) {
	if span.Role == "" {
		span.Role = "tool"
	}
	if span.SpanType == "" {
		span.SpanType = "custom"
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if span.SpanIndex == 0 && len(c.traces) > 0 {
		span.SpanIndex = len(c.traces)
	}
	c.traces = append(c.traces, span)
	c.traceCount++
}

// TraceCount returns how many trace spans were recorded for the execution.
func (c *Context) TraceCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.traceCount
}

// FlushTraces sends buffered traces to Agent Hub. Run calls this automatically.
func (c *Context) FlushTraces() error {
	c.mu.Lock()
	if len(c.traces) == 0 {
		c.mu.Unlock()
		return nil
	}
	traces := append([]TraceSpan(nil), c.traces...)
	c.traces = nil
	c.mu.Unlock()
	return c.client.postTraces(c.base, c.job.ExecutionID, traces)
}
