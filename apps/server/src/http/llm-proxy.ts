import type { FastifyRequest, FastifyReply } from "fastify";
import { hashApiKey } from "../security.js";
import type { ProxyTokenRepository } from "../repositories/proxy-token-repository.js";
import type { TraceRepository } from "../repositories/trace-repository.js";
import type { ExecutionRepository } from "../repositories/execution-repository.js";

export interface LlmProxyDependencies {
  proxyTokenRepo: ProxyTokenRepository;
  traceRepo: TraceRepository;
  executionRepo: ExecutionRepository;
  anthropicApiKey: string;
  anthropicEndpoint: string;
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function createLlmProxyHandler(deps: LlmProxyDependencies) {
  return async function llmProxyHandler(request: FastifyRequest, reply: FastifyReply) {
    const startTime = Date.now();

    // 1. Extract proxy token
    const rawToken = firstHeader(request.headers["x-api-key"]);
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
    if (!deps.anthropicApiKey) {
      return reply.status(502).send({ error: "no upstream API key configured" });
    }

    const executionId = tokenRow.executionId;

    // 4. Reconstruct raw body
    const rawBody = JSON.stringify(request.body);

    // 5. Extract model name for trace
    const body = request.body as Record<string, unknown> | undefined;
    const model = typeof body?.model === "string" ? body.model : null;
    const isStreaming = body?.stream === true;

    // 6. Forward to Anthropic
    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(`${deps.anthropicEndpoint}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": deps.anthropicApiKey,
          "anthropic-version": firstHeader(request.headers["anthropic-version"]) ?? "2023-06-01",
          "anthropic-beta": firstHeader(request.headers["anthropic-beta"]) ?? undefined,
          "content-type": "application/json",
        } as Record<string, string>,
        body: rawBody,
      });
    } catch (err) {
      return reply.status(502).send({ error: "upstream unreachable" });
    }

    // 7. Provider error — relay + trace
    if (!upstreamResp.ok) {
      const errorBody = await upstreamResp.text().catch(() => "");
      await deps.traceRepo.insertBatch([{
        executionId,
        turnIndex: 0,
        role: "system",
        spanType: "llm",
        model: model ?? undefined,
        provider: "anthropic",
        inputContent: rawBody,
        outputContent: errorBody,
        latencyMs: Date.now() - startTime,
        metadata: { error: true, statusCode: upstreamResp.status },
      }]);
      await deps.executionRepo.incrementTraceCount(executionId, 1);
      return reply.status(upstreamResp.status).send(errorBody);
    }

    // 8. Non-streaming path
    if (!isStreaming) {
      const responseText = await upstreamResp.text();
      let responseJson: any = null;
      try { responseJson = JSON.parse(responseText); } catch { /* not JSON */ }

      const outputContent = responseText;
      const inputTokens = responseJson?.usage?.input_tokens ?? undefined;
      const outputTokens = responseJson?.usage?.output_tokens ?? undefined;

      await deps.traceRepo.insertBatch([{
        executionId,
        turnIndex: 0,
        role: "assistant",
        spanType: "llm",
        model: responseJson?.model ?? model ?? undefined,
        provider: "anthropic",
        inputContent: rawBody,
        outputContent,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - startTime,
      }]);
      await deps.executionRepo.incrementTraceCount(executionId, 1);

      return reply
        .header("content-type", upstreamResp.headers.get("content-type") ?? "application/json")
        .send(responseText);
    }

    // 9. Streaming path
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

        // Relay raw bytes to agent
        reply.raw.write(value);

        // Parse SSE for accumulation
        const chunk = decoder.decode(value, { stream: true });
        lineBuffer += chunk;

        while (lineBuffer.includes("\n")) {
          const newlineIdx = lineBuffer.indexOf("\n");
          const line = lineBuffer.slice(0, newlineIdx).replace(/\r$/, "");
          lineBuffer = lineBuffer.slice(newlineIdx + 1);

          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6);
          if (jsonStr === "[DONE]") continue;

          try {
            const event = JSON.parse(jsonStr);

            switch (event.type) {
              case "message_start":
                if (event.message?.model) streamModel = event.message.model;
                if (event.message?.usage) {
                  inputTokens = event.message.usage.input_tokens ?? inputTokens;
                }
                break;

              case "content_block_delta":
                if (event.delta?.type === "text_delta" && event.delta.text) {
                  accumulatedText += event.delta.text;
                } else if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
                  accumulatedText += event.delta.partial_json;
                }
                break;

              case "message_delta":
                if (event.usage) {
                  outputTokens = event.usage.output_tokens ?? outputTokens;
                }
                if (event.delta?.stop_reason) {
                  // stream is ending
                }
                break;
            }
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

    // 10. Write trace after stream ends
    await deps.traceRepo.insertBatch([{
      executionId,
      turnIndex: 0,
      role: "assistant",
      spanType: "llm",
      model: streamModel ?? undefined,
      provider: "anthropic",
      inputContent: rawBody,
      outputContent: accumulatedText || undefined,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - startTime,
    }]);
    await deps.executionRepo.incrementTraceCount(executionId, 1);
  };
}
