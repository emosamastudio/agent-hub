// packages/sdk/src/index.ts

export interface AgentHubConfig {
  serverUrl: string;
  serverUrls?: string[];  // HA: randomly pick one per poll
  project: string;
  apiKey?: string;
}

export interface AgentSpec {
  name: string;
  displayName: string;
  agentType: 'cron_task' | 'llm_agent';
  cron?: string;
  handler: string;
  inputSchema?: Record<string, unknown>;
  concurrency?: number;
  timeoutSeconds?: number;
  retryMax?: number;
  maxPendingQueue?: number;
  misfirePolicy?: 'fire_once' | 'fire_all' | 'drop';
  executorHost?: string;
  labels?: Record<string, string>;
}

interface Execution {
  id: string;
  agent_id: string;
  trigger_type: string;
  status: string;
  input_payload: Record<string, unknown>;
}

interface TraceSpan {
  turn_index: number;
  span_index?: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  span_type?: string;
  model?: string;
  provider?: string;
  input_content?: string;
  output_content?: string;
  tool_calls?: unknown;
  tool_results?: unknown;
  input_tokens?: number;
  output_tokens?: number;
  cost_estimate?: number;
  latency_ms?: number;
}

export type HandlerFn = (ctx: ExecutionContext) => Promise<Record<string, unknown>>;

export class AgentHubClient {
  private config: AgentHubConfig;
  private handlers = new Map<string, HandlerFn>();
  private agents: AgentSpec[] = [];
  private traceBuffer: TraceSpan[] = [];
  private currentExecutionId: string | null = null;
  private running = false;

  constructor(config: AgentHubConfig) {
    this.config = config;
    if (!config.serverUrls) {
      config.serverUrls = [config.serverUrl];
    }
  }

  register(spec: AgentSpec) {
    this.agents.push(spec);
  }

  handle(name: string, fn: HandlerFn) {
    this.handlers.set(name, fn);
  }

  async start() {
    this.running = true;
    await this.registerAll();
    this.startHeartbeat();
    await this.pollLoop();
  }

  stop() {
    this.running = false;
  }

  private pickUrl(): string {
    const urls = this.config.serverUrls!;
    return urls[Math.floor(Math.random() * urls.length)];
  }

  private async registerAll() {
    for (const agent of this.agents) {
      const res = await this.fetch('PUT', `/api/registry/agents`, agent);
      if (!res.ok) {
        console.error(`Failed to register ${agent.name}: ${res.status}`);
      }
    }
  }

  private startHeartbeat() {
    setInterval(async () => {
      try {
        await this.fetch('POST', '/api/executors/heartbeat', {});
      } catch {} // silently skip on network error
    }, 10_000);
  }

  private async pollLoop() {
    while (this.running) {
      try {
        const res = await this.fetch('GET', '/api/executors/poll');
        if (res.status === 204) { continue; }

        const exec: Execution = await res.json();
        this.currentExecutionId = exec.id;
        this.traceBuffer = [];

        const agent = this.agents.find(a => a.handler && this.handlers.has(a.handler));
        let handler: HandlerFn | undefined;
        if (agent) {
          handler = this.handlers.get(agent.handler);
        }

        let result: { status: string; result_summary?: string; result_data?: unknown; error_message?: string; error_stack?: string; trace_count_expected?: number };

        if (handler) {
          try {
            const ctx = new ExecutionContext(this, exec);
            const data = await handler(ctx);
            result = { status: 'success', result_data: data, trace_count_expected: this.traceBuffer.length };
          } catch (err: any) {
            result = { status: 'failed', error_message: err.message, error_stack: err.stack, trace_count_expected: this.traceBuffer.length };
          }
        } else {
          result = { status: 'failed', error_message: `No handler for agent`, trace_count_expected: 0 };
        }

        // Flush remaining traces
        await this.flushTraces();

        // Report
        await this.fetch('POST', `/api/executions/${exec.id}/report`, result);
      } catch (err) {
        // Network error — back off and retry
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  async fetch(method: string, path: string, body?: unknown): Promise<Response> {
    const url = this.pickUrl() + path;
    const opts: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Agent-Hub-Version': '1',
      },
    };
    if (this.config.apiKey) {
      (opts.headers as Record<string, string>)['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts);
  }

  async flushTraces() {
    if (this.traceBuffer.length === 0 || !this.currentExecutionId) return;
    const traces = [...this.traceBuffer];
    this.traceBuffer = [];
    await this.fetch('POST', `/api/executions/${this.currentExecutionId}/traces`, { traces });
  }
}

export class ExecutionContext {
  private client: AgentHubClient;
  private exec: Execution;
  signal: AbortSignal;

  constructor(client: AgentHubClient, exec: Execution) {
    this.client = client;
    this.exec = exec;
    this.signal = AbortSignal.timeout(600_000); // default 10 min timeout
  }

  get payload(): Record<string, unknown> {
    return this.exec.input_payload ?? {};
  }

  async log(message: string) {
    console.log(`[${this.exec.id}] ${message}`);
  }

  async progress(_percent: number, _message?: string) {
    // Heartbeat already sends liveness; progress is informational
  }

  async trigger(agentName: string, opts: {
    payload?: Record<string, unknown>;
    idempotencyKey?: string;
    dedupPolicy?: 'skip_if_running' | 'skip_if_exists' | 'allow_duplicate';
  }) {
    const res = await this.client.fetch('POST', `/api/agents/${agentName}/trigger`, {
      payload: opts.payload ?? {},
      idempotency_key: opts.idempotencyKey,
      dedup_policy: opts.dedupPolicy ?? 'skip_if_running',
    });
    return res.json();
  }

  async triggerBatch(requests: Array<{ agent: string; payload?: Record<string, unknown>; idempotencyKey?: string }>, opts?: { concurrency?: number }) {
    const limit = opts?.concurrency ?? 5;
    const results = [];
    for (let i = 0; i < requests.length; i += limit) {
      const batch = requests.slice(i, i + limit);
      results.push(...await Promise.all(batch.map(r => this.trigger(r.agent, { payload: r.payload, idempotencyKey: r.idempotencyKey }))));
    }
    return results;
  }

  llm = {
    chat: async (req: { model: string; messages: Array<{ role: string; content: string }>; signal?: AbortSignal }) => {
      const start = Date.now();
      // Make the actual LLM call (OpenAI-compatible)
      const response = await fetch(process.env.LLM_API_URL ?? 'http://localhost:11434/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: req.model, messages: req.messages }),
        signal: req.signal,
      });
      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content ?? '';

      // Auto-trace
      const span: TraceSpan = {
        turn_index: 0,
        role: 'assistant',
        span_type: 'llm',
        model: req.model,
        input_content: JSON.stringify(req.messages),
        output_content: content,
        input_tokens: data.usage?.prompt_tokens,
        output_tokens: data.usage?.completion_tokens,
        latency_ms: Date.now() - start,
      };
      (this.client as any).traceBuffer.push(span);

      return { content };
    },
  };

  trace = {
    startSpan: (_name: string) => ({
      setOutput: (_data: unknown) => {},
      end: () => {},
      error: (_err: Error) => {},
    }),
  };

  cooldowns = {
    get: async (key: string) => {
      const res = await (this.client as any).fetch('GET', `/api/cooldowns/${this.exec.agent_id}/${key}`);
      return res.json();
    },
    set: async (key: string) => {
      await (this.client as any).fetch('PUT', `/api/cooldowns/${this.exec.agent_id}/${key}`, { last_run_at: new Date().toISOString() });
    },
  };
}
