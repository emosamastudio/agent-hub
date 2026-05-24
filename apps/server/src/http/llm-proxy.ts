import type { FastifyRequest, FastifyReply } from "fastify";
import { hashApiKey } from "../security.js";
import type { ProxyTokenRepository } from "../repositories/proxy-token-repository.js";
import type { TraceRepository } from "../repositories/trace-repository.js";
import type { ExecutionRepository } from "../repositories/execution-repository.js";

// ── Types ──

export interface LlmProxyDependencies {
  proxyTokenRepo: ProxyTokenRepository;
  traceRepo: TraceRepository;
  executionRepo: ExecutionRepository;
  anthropicApiKey: string;
  anthropicEndpoint: string;
  openaiApiKey: string;
  openaiEndpoint: string;
}

interface ProviderConfig {
  /** Path appended to endpoint, e.g. "/v1/messages" or "/v1/chat/completions" */
  upstreamPath: string;
  /** Header name to extract the proxy token from the agent request */
  tokenHeader: string;
  /** How the upstream expects auth: "anthropic" uses x-api-key, "openai" uses Authorization: Bearer */
  authStyle: "anthropic" | "openai";
  /** The real API key to forward to the upstream */
  apiKey: string;
  /** The upstream base URL */
  endpoint: string;
  /** Provider name written to traces */
  provider: string;
  /** Extract model, content, and token usage from a non-streaming JSON response */
  parseResponseJson: (json: any) => {
    model?: string;
    outputContent?: string;
    inputTokens?: number;
    outputTokens?: number;
  };
  /** Parse one SSE data event for streaming accumulation */
  parseStreamEvent: (event: any) => {
    textDelta?: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  };
}

// ── Helpers ──

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Extract the most recent meaningful message from the messages array for trace display.
 *  Handles ReAct loop patterns: user messages, tool results, assistant follow-ups. */
function extractInputContent(body: Record<string, unknown> | undefined): string | undefined {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  // Walk backwards to find the last non-system message that adds new information
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown> | undefined;
    if (!msg) continue;

    if (msg.role === "user" && typeof msg.content === "string" && msg.content.length > 0) {
      return msg.content;
    }
    if (msg.role === "tool") {
      const name = typeof msg.name === "string" ? msg.name : (typeof msg.tool_call_id === "string" ? msg.tool_call_id.slice(0, 20) : "tool");
      const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      const summary = contentStr.length > 200 ? contentStr.slice(0, 200) + "…" : contentStr;
      return `[${name}] ${summary}`;
    }
    if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 0) {
      // Assistant with text (previous turn summary context — less preferred, keep walking)
      continue;
    }
  }

  // Fallback: any non-system message with string content
  const last = messages[messages.length - 1] as Record<string, unknown> | undefined;
  if (last && typeof last.content === "string" && last.content.length > 0) {
    return last.content;
  }
  return undefined;
}

// ── Provider configs ──

function anthropicProvider(deps: LlmProxyDependencies): ProviderConfig {
  return {
    upstreamPath: "/v1/messages",
    tokenHeader: "x-api-key",
    authStyle: "anthropic",
    apiKey: deps.anthropicApiKey,
    endpoint: deps.anthropicEndpoint,
    provider: "anthropic",
    parseResponseJson(json: any) {
      const content = json?.content;
      const textBlocks = Array.isArray(content)
        ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text)
        : [];
      return {
        model: json?.model,
        outputContent: textBlocks.length > 0 ? textBlocks.join("") : JSON.stringify(json),
        inputTokens: json?.usage?.input_tokens,
        outputTokens: json?.usage?.output_tokens,
      };
    },
    parseStreamEvent(event: any) {
      switch (event.type) {
        case "message_start":
          return {
            model: event.message?.model,
            inputTokens: event.message?.usage?.input_tokens,
          };
        case "content_block_delta":
          if (event.delta?.type === "text_delta") return { textDelta: event.delta.text };
          if (event.delta?.type === "input_json_delta") return { textDelta: event.delta.partial_json };
          return {};
        case "message_delta":
          return { outputTokens: event.usage?.output_tokens };
        default:
          return {};
      }
    },
  };
}

function openaiProvider(deps: LlmProxyDependencies): ProviderConfig {
  return {
    upstreamPath: "/v1/chat/completions",
    tokenHeader: "authorization",
    authStyle: "openai",
    apiKey: deps.openaiApiKey || deps.anthropicApiKey,
    endpoint: deps.openaiEndpoint || deps.anthropicEndpoint,
    provider: "openai",
    parseResponseJson(json: any) {
      const choices = Array.isArray(json?.choices) ? json.choices : [];
      const message = choices[0]?.message;
      const textContent = message?.content;
      const toolCalls = message?.tool_calls;
      let outputContent: string;
      if (typeof textContent === "string" && textContent.length > 0) {
        outputContent = textContent;
      } else if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const names = toolCalls.map((tc: any) => tc?.function?.name ?? "call").join(", ");
        outputContent = `[调用工具: ${names}]`;
      } else {
        outputContent = JSON.stringify(json);
      }
      return {
        model: json?.model,
        outputContent,
        inputTokens: json?.usage?.prompt_tokens,
        outputTokens: json?.usage?.completion_tokens,
      };
    },
    parseStreamEvent(event: any) {
      const choices = Array.isArray(event?.choices) ? event.choices : [];
      const delta = choices[0]?.delta;
      return {
        textDelta: delta?.content ?? undefined,
        model: event?.model,
      };
    },
  };
}

// ── Core proxy handler factory ──

function createProxyHandler(deps: LlmProxyDependencies, provider: ProviderConfig) {
  return async function proxyHandler(request: FastifyRequest, reply: FastifyReply) {
    const startTime = Date.now();

    // 1. Extract proxy token
    let rawToken: string | null = null;
    if (provider.tokenHeader === "authorization") {
      const auth = firstHeader(request.headers.authorization);
      if (auth?.startsWith("Bearer ")) {
        rawToken = auth.slice("Bearer ".length);
      }
    } else {
      rawToken = firstHeader(request.headers[provider.tokenHeader as keyof typeof request.headers] as string | string[] | undefined);
    }
    if (!rawToken) {
      return reply.status(401).send({ error: "proxy token required" });
    }

    // 2. Lookup token
    const tokenHash = hashApiKey(rawToken);
    const tokenRow = await deps.proxyTokenRepo.findByTokenHash(tokenHash);
    if (!tokenRow || new Date(tokenRow.expiresAt) < new Date()) {
      return reply.status(401).send({ error: "invalid or expired proxy token" });
    }

    // 3. Check provider key
    if (!provider.apiKey) {
      return reply.status(502).send({ error: `no upstream API key configured for ${provider.provider}` });
    }

    const executionId = tokenRow.executionId;

    // 4. Reconstruct raw body and extract display content
    const rawBody = JSON.stringify(request.body);
    const body = request.body as Record<string, unknown> | undefined;
    const model = typeof body?.model === "string" ? body.model : null;
    const isStreaming = body?.stream === true;
    const inputContent = extractInputContent(body) ?? rawBody;

    // 5. Get next turn index
    const turnIndex = await deps.traceRepo.getNextTurnIndex(executionId);

    // 6. Build upstream headers
    const upstreamHeaders: Record<string, string> = { "content-type": "application/json" };
    if (provider.authStyle === "anthropic") {
      upstreamHeaders["x-api-key"] = provider.apiKey;
    } else {
      upstreamHeaders["authorization"] = `Bearer ${provider.apiKey}`;
    }

    // 7. Forward to provider
    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(`${provider.endpoint}${provider.upstreamPath}`, {
        method: "POST",
        headers: upstreamHeaders,
        body: rawBody,
      });
    } catch {
      return reply.status(502).send({ error: "upstream unreachable" });
    }

    // 8. Provider error — relay + trace
    if (!upstreamResp.ok) {
      const errorBody = await upstreamResp.text().catch(() => "");
      await deps.traceRepo.insertBatch([{
        executionId,
        turnIndex,
        role: "system",
        spanType: "llm",
        model: model ?? undefined,
        provider: provider.provider,
        inputContent,
        outputContent: errorBody,
        latencyMs: Date.now() - startTime,
        metadata: { error: true, statusCode: upstreamResp.status, _rawInput: rawBody },
      }]);
      await deps.executionRepo.incrementTraceCount(executionId, 1);
      return reply.status(upstreamResp.status).send(errorBody);
    }

    // 9. Non-streaming path
    if (!isStreaming) {
      const responseText = await upstreamResp.text();
      let responseJson: any = null;
      try { responseJson = JSON.parse(responseText); } catch { /* not JSON */ }

      const parsed = provider.parseResponseJson(responseJson ?? {});
      await deps.traceRepo.insertBatch([{
        executionId,
        turnIndex,
        role: "assistant",
        spanType: "llm",
        model: parsed.model ?? model ?? undefined,
        provider: provider.provider,
        inputContent,
        outputContent: parsed.outputContent ?? responseText,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
        latencyMs: Date.now() - startTime,
        metadata: { _rawInput: rawBody, _rawOutput: responseText },
      }]);
      await deps.executionRepo.incrementTraceCount(executionId, 1);

      return reply
        .header("content-type", upstreamResp.headers.get("content-type") ?? "application/json")
        .send(responseText);
    }

    // 10. Streaming path
    const reader = upstreamResp.body?.getReader();
    if (!reader) {
      return reply.status(502).send({ error: "upstream returned no body" });
    }

    reply.hijack();
    reply.raw.writeHead(upstreamResp.status, {
      "content-type": upstreamResp.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-robots-tag": "noindex",
    });

    const decoder = new TextDecoder();
    let lineBuffer = "";
    let accumulatedText = "";
    let streamModel: string | null = model;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        reply.raw.write(value);

        const chunk = decoder.decode(value, { stream: true });
        lineBuffer += chunk;

        while (lineBuffer.includes("\n")) {
          const newlineIdx = lineBuffer.indexOf("\n");
          let line = lineBuffer.slice(0, newlineIdx);
          lineBuffer = lineBuffer.slice(newlineIdx + 1);
          line = line.replace(/\r$/, "");

          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6);
          if (jsonStr === "[DONE]") continue;

          try {
            const event = JSON.parse(jsonStr);
            const parsed = provider.parseStreamEvent(event);
            if (parsed.textDelta) accumulatedText += parsed.textDelta;
            if (parsed.model) streamModel = parsed.model;
            if (parsed.inputTokens != null) inputTokens = parsed.inputTokens;
            if (parsed.outputTokens != null) outputTokens = parsed.outputTokens;
          } catch {
            // ignore unparseable SSE events
          }
        }
      }
    } catch {
      // Stream interrupted — still write partial trace
    } finally {
      reply.raw.end();
    }

    // Write trace after stream ends
    await deps.traceRepo.insertBatch([{
      executionId,
      turnIndex,
      role: "assistant",
      spanType: "llm",
      model: streamModel ?? undefined,
      provider: provider.provider,
      inputContent,
      outputContent: accumulatedText || undefined,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - startTime,
      metadata: { _rawInput: rawBody },
    }]);
    await deps.executionRepo.incrementTraceCount(executionId, 1);
  };
}

// ── Public factory functions ──

export function createAnthropicProxyHandler(deps: LlmProxyDependencies) {
  return createProxyHandler(deps, anthropicProvider(deps));
}

export function createOpenAiProxyHandler(deps: LlmProxyDependencies) {
  return createProxyHandler(deps, openaiProvider(deps));
}

/** Backward-compatible alias */
export function createLlmProxyHandler(deps: LlmProxyDependencies) {
  return createAnthropicProxyHandler(deps);
}
