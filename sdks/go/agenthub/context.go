package agenthub

import (
	"context"
	"fmt"
)

// Context is passed to every job handler.
type Context struct {
	base   context.Context
	client *Client
	job    *Job
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
	prefix := fmt.Sprintf("[%s] ", c.job.ExecutionID)
	fmt.Printf(prefix+format+"\n", args...)
}

// Progress reports execution progress through Agent Hub heartbeat.
func (c *Context) Progress(percent int, message string) (*HeartbeatResult, error) {
	return c.client.ReportProgress(c.base, c.job.ExecutionID, percent, message)
}
