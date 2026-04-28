#!/usr/bin/env node

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_HUB_URL = 'http://127.0.0.1:8787'
const DEFAULT_INTERVAL_MS = 5000
const DEFAULT_CREATED_AT = new Date().toISOString()

const VALID_PLATFORMS = new Set(['claude-code', 'copilot-cli', 'openclaw', 'generic'])
const VALID_HEALTH = new Set([
  'healthy',
  'degraded',
  'stalled',
  'rate_limited',
  'auth_required',
  'unavailable',
])
const VALID_ATTENTION = new Set(['silent', 'info', 'action_needed', 'urgent'])
const VALID_RUN_STATES = new Set([
  'discovered',
  'ready',
  'queued',
  'starting',
  'running',
  'waiting_input',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'offline',
])
const VALID_WAITING_REASONS = new Set([
  'approval',
  'missing_context',
  'tool_permission',
  'login_required',
  'human_review',
  'unknown',
])
const VALID_EVENT_TYPES = new Set([
  'agent.registered',
  'agent.heartbeat',
  'session.opened',
  'run.queued',
  'run.started',
  'run.progress',
  'run.output',
  'run.waiting_input',
  'run.approval_required',
  'run.paused',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.stalled',
  'run.resumed',
  'agent.offline',
  'agent.recovered',
])

const HELP_TEXT = `
Reference sidecar for Agent Hub.

Purpose:
  Bridge tools that do not have a truthful local discovery path into Agent Hub
  through the existing POST /api/ingest surface.

Usage:
  node examples/reference-sidecar.mjs --agent-id my-tool --name "My Tool" --workspace /path/to/repo
  node examples/reference-sidecar.mjs --state-file ./examples/reference-sidecar.example.json
  node examples/reference-sidecar.mjs --state-file /tmp/sidecar.json --watch --interval-ms 3000

Options:
  --hub-url <url>          Agent Hub base URL. Default: ${DEFAULT_HUB_URL}
  --state-file <path>      JSON payload file using the /api/ingest shape.
  --watch                  Poll the state file and publish live heartbeat updates.
  --interval-ms <ms>       Poll interval for --watch. Default: ${DEFAULT_INTERVAL_MS}
  --action-port <port>     Expose a local loopback runtime bridge for send_prompt.
  --prompt-log-file <path> Append accepted prompts to a local JSONL file.
  --agent-id <id>          Agent ID fallback when state file omits it.
  --name <name>            Agent display name fallback.
  --workspace <path>       Agent workspace path fallback.
  --platform <platform>    Platform fallback. Default: generic
  --run-id <id>            Run ID fallback. Default: <agent-id>-run
  --title <title>          Run title fallback.
  --state <state>          Run and agent state fallback. Default: running
  --health <health>        Run and agent health fallback. Default: healthy
  --attention <level>      Run and agent attention fallback. Default: info
  --phase <name>           Run progress phase fallback. Default: executing
  --percent <number>       Run progress percent fallback.
  --message <text>         Progress / event message fallback.
  --event-type <type>      Event type fallback. Default: run.progress
  --waiting-reason <kind>  Run waiting reason fallback when state is waiting_input.
  --dry-run                Print the normalized payload instead of sending it.
  --help                   Show this help.

Environment fallbacks:
  AGENT_HUB_URL, AGENT_HUB_STATE_FILE, AGENT_HUB_WATCH, AGENT_HUB_INTERVAL_MS,
  AGENT_HUB_ACTION_PORT, AGENT_HUB_PROMPT_LOG_FILE,
  AGENT_HUB_AGENT_ID, AGENT_HUB_AGENT_NAME, AGENT_HUB_WORKSPACE, AGENT_HUB_PLATFORM,
  AGENT_HUB_RUN_ID, AGENT_HUB_RUN_TITLE, AGENT_HUB_RUN_STATE, AGENT_HUB_RUN_HEALTH,
  AGENT_HUB_RUN_ATTENTION, AGENT_HUB_PHASE, AGENT_HUB_PROGRESS_PERCENT,
  AGENT_HUB_MESSAGE, AGENT_HUB_EVENT_TYPE, AGENT_HUB_WAITING_REASON.
`.trim()

async function main() {
  const options = parseCliArgs(process.argv.slice(2))

  if (options.help) {
    console.log(HELP_TEXT)
    return
  }

  const settings = resolveSettings(options)
  if (settings.actionPort) {
    const runtimeActionEndpoint = await startRuntimeActionServer(settings)
    console.log(
      `[reference-sidecar] loopback runtime bridge listening on ${runtimeActionEndpoint}`,
    )
  }

  if (settings.watch && !settings.stateFile) {
    throw new Error('--watch requires --state-file so the sidecar has a live source to poll.')
  }

  let lastSignature = null

  do {
    const normalized = await loadNormalizedPayload(settings)
    const signature = stableStringify(normalized)
    const includeEvent = signature !== lastSignature
    const payload = stampPayload(normalized, { includeEvent, createdAt: DEFAULT_CREATED_AT })

    if (settings.dryRun) {
      console.log(JSON.stringify(payload, null, 2))
    } else {
      const result = await postPayload(settings.hubUrl, payload)
      console.log(
        `[reference-sidecar] published ${payload.agent.id} (${includeEvent ? 'state+event' : 'heartbeat'}) -> ${settings.hubUrl}/api/ingest [agents=${result.snapshot.agents.length} runs=${result.snapshot.runs.length}]`,
      )
    }

    lastSignature = signature

    if (!settings.watch) {
      break
    }

    await sleep(settings.intervalMs)
  } while (true)
}

function parseCliArgs(argv) {
  const result = {
    _: [],
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (!token.startsWith('--')) {
      result._.push(token)
      continue
    }

    const trimmed = token.slice(2)
    if (trimmed === 'help') {
      result.help = true
      continue
    }
    if (trimmed === 'watch') {
      result.watch = true
      continue
    }
    if (trimmed === 'dry-run') {
      result.dryRun = true
      continue
    }

    const equalsIndex = trimmed.indexOf('=')
    if (equalsIndex >= 0) {
      const key = trimmed.slice(0, equalsIndex)
      const value = trimmed.slice(equalsIndex + 1)
      result[key] = value
      continue
    }

    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for --${trimmed}`)
    }

    result[trimmed] = next
    index += 1
  }

  return result
}

function resolveSettings(options) {
  return {
    hubUrl: trimTrailingSlash(
      resolveStringOption(options, 'hub-url', 'AGENT_HUB_URL', DEFAULT_HUB_URL),
    ),
    stateFile: resolveOptionalPath(
      resolveStringOption(options, 'state-file', 'AGENT_HUB_STATE_FILE', null),
    ),
    watch: resolveBooleanOption(options.watch, process.env.AGENT_HUB_WATCH, false),
    intervalMs: resolvePositiveIntOption(
      options['interval-ms'],
      process.env.AGENT_HUB_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
    ),
    actionPort: resolveOptionalPositiveIntOption(
      options['action-port'],
      process.env.AGENT_HUB_ACTION_PORT,
    ),
    promptLogFile: resolveOptionalPath(
      resolveStringOption(options, 'prompt-log-file', 'AGENT_HUB_PROMPT_LOG_FILE', null),
    ),
    dryRun: resolveBooleanOption(options.dryRun, process.env.AGENT_HUB_DRY_RUN, false),
    defaults: {
      agentId: resolveStringOption(options, 'agent-id', 'AGENT_HUB_AGENT_ID', null),
      agentName: resolveStringOption(options, 'name', 'AGENT_HUB_AGENT_NAME', null),
      workspacePath: resolveStringOption(options, 'workspace', 'AGENT_HUB_WORKSPACE', null),
      platform: resolveEnumOption(
        resolveStringOption(options, 'platform', 'AGENT_HUB_PLATFORM', 'generic'),
        VALID_PLATFORMS,
        'platform',
      ),
      runId: resolveStringOption(options, 'run-id', 'AGENT_HUB_RUN_ID', null),
      runTitle: resolveStringOption(options, 'title', 'AGENT_HUB_RUN_TITLE', null),
      state: resolveEnumOption(
        resolveStringOption(options, 'state', 'AGENT_HUB_RUN_STATE', 'running'),
        VALID_RUN_STATES,
        'state',
      ),
      health: resolveEnumOption(
        resolveStringOption(options, 'health', 'AGENT_HUB_RUN_HEALTH', 'healthy'),
        VALID_HEALTH,
        'health',
      ),
      attention: resolveEnumOption(
        resolveStringOption(options, 'attention', 'AGENT_HUB_RUN_ATTENTION', 'info'),
        VALID_ATTENTION,
        'attention',
      ),
      phase: resolveStringOption(options, 'phase', 'AGENT_HUB_PHASE', 'executing'),
      percent: resolveNullableNumberOption(
        options.percent,
        process.env.AGENT_HUB_PROGRESS_PERCENT,
      ),
      message: resolveStringOption(
        options,
        'message',
        'AGENT_HUB_MESSAGE',
        'Publishing live updates from the reference sidecar.',
      ),
      eventType: resolveEnumOption(
        resolveStringOption(options, 'event-type', 'AGENT_HUB_EVENT_TYPE', 'run.progress'),
        VALID_EVENT_TYPES,
        'event type',
      ),
      waitingReason: resolveOptionalEnumOption(
        resolveStringOption(options, 'waiting-reason', 'AGENT_HUB_WAITING_REASON', null),
        VALID_WAITING_REASONS,
        'waiting reason',
      ),
    },
  }
}

async function loadNormalizedPayload(settings) {
  const source = settings.stateFile
    ? parseJson(await fs.readFile(settings.stateFile, 'utf8'), settings.stateFile)
    : {}

  if (!isRecord(source)) {
    throw new Error('Sidecar payload must be a JSON object.')
  }

  return normalizePayload(source, settings)
}

function normalizePayload(source, settings) {
  const { defaults } = settings
  const sourceAgent = isRecord(source.agent) ? source.agent : {}
  const sourceRun = isRecord(source.run) ? source.run : null
  const sourceEvent = isRecord(source.event) ? source.event : null

  const agentId = requireString(sourceAgent.id ?? defaults.agentId, 'agent.id')
  const agentName = requireString(sourceAgent.name ?? defaults.agentName, 'agent.name')
  const workspacePath = resolveAbsolutePath(
    requireString(sourceAgent.workspacePath ?? defaults.workspacePath, 'agent.workspacePath'),
  )
  const runId = normalizeString(sourceRun?.id ?? sourceAgent.currentRunId ?? defaults.runId) ?? `${agentId}-run`
  const runTitle =
    normalizeString(sourceRun?.title ?? defaults.runTitle) ?? `${agentName} live session`
  const state = resolveEnumOption(
    sourceRun?.state ?? sourceAgent.state ?? defaults.state,
    VALID_RUN_STATES,
    'state',
  )
  const health = resolveEnumOption(
    sourceRun?.health ?? sourceAgent.health ?? defaults.health,
    VALID_HEALTH,
    'health',
  )
  const attention = resolveEnumOption(
    sourceRun?.attention ?? sourceAgent.attention ?? defaults.attention,
    VALID_ATTENTION,
    'attention',
  )
  const waitingReason = resolveOptionalEnumOption(
    sourceRun?.waitingReason ?? defaults.waitingReason,
    VALID_WAITING_REASONS,
    'waiting reason',
  )
  const progress = normalizeProgress(sourceRun?.progress, defaults)
  const sessionMetadata = normalizeSessionMetadata(
    sourceAgent.sessionMetadata,
    buildRuntimeBridgeMetadata(settings),
  )

  const agent = {
    id: agentId,
    name: agentName,
    platform: resolveEnumOption(
      sourceAgent.platform ?? defaults.platform,
      VALID_PLATFORMS,
      'platform',
    ),
    workspacePath,
    state,
    health,
    attention,
    currentRunId: sourceRun === null && source.agent && sourceAgent.currentRunId === null ? null : runId,
    ...(sessionMetadata ? { sessionMetadata } : {}),
  }

  const run =
    sourceRun === null && source.run === undefined
      ? {
          id: runId,
          title: runTitle,
          state,
          health,
          attention,
          waitingReason,
          progress,
        }
      : source.run === null
        ? null
        : {
            id: runId,
            title: runTitle,
            state,
            health,
            attention,
            waitingReason,
            progress,
            createdAt: normalizeString(sourceRun?.createdAt),
          }

  const event =
    source.event === null
      ? null
      : {
          type: resolveEnumOption(
            sourceEvent?.type ?? defaults.eventType,
            VALID_EVENT_TYPES,
            'event type',
          ),
          message: requireString(sourceEvent?.message ?? defaults.message, 'event.message'),
          state: normalizeOptionalEnum(sourceEvent?.state, VALID_RUN_STATES, 'event.state'),
          attention: normalizeOptionalEnum(
            sourceEvent?.attention,
            VALID_ATTENTION,
            'event.attention',
          ),
          runId: normalizeString(sourceEvent?.runId),
        }

  return { agent, run, event }
}

function normalizeSessionMetadata(source, runtimeBridgeMetadata) {
  const base = isRecord(source) ? { ...source } : {}
  if (runtimeBridgeMetadata) {
    Object.assign(base, runtimeBridgeMetadata)
  }

  return Object.keys(base).length > 0 ? base : undefined
}

function buildRuntimeBridgeMetadata(settings) {
  if (!settings.actionPort) {
    return null
  }

  return {
    runtimeActionEndpoint: `http://127.0.0.1:${settings.actionPort}/runtime-actions`,
    runtimeActionTargets: ['send_prompt'],
  }
}

function normalizeProgress(sourceProgress, defaults) {
  if (sourceProgress === null) {
    return null
  }

  const progressRecord = isRecord(sourceProgress) ? sourceProgress : {}
  return {
    phase: requireString(progressRecord.phase ?? defaults.phase, 'run.progress.phase'),
    percent:
      progressRecord.percent === null
        ? null
        : resolveNullableNumberOption(progressRecord.percent, defaults.percent),
    message: requireString(
      progressRecord.message ?? defaults.message,
      'run.progress.message',
    ),
  }
}

function stampPayload(payload, options) {
  const now = new Date().toISOString()
  const run = payload.run
    ? {
        ...payload.run,
        agentId: payload.agent.id,
        lastEventAt: now,
        createdAt: payload.run.createdAt ?? options.createdAt,
      }
    : undefined

  return {
    agent: {
      ...payload.agent,
      currentRunId: run ? run.id : payload.agent.currentRunId ?? null,
      lastHeartbeatAt: now,
      lastEventAt: run ? now : payload.agent.lastEventAt ?? now,
    },
    run,
    event:
      options.includeEvent && payload.event
        ? {
            ...payload.event,
            runId: payload.event.runId ?? run?.id ?? null,
            state: payload.event.state ?? run?.state ?? null,
            attention: payload.event.attention ?? run?.attention ?? payload.agent.attention,
            createdAt: now,
          }
        : undefined,
  }
}

async function postPayload(hubUrl, payload) {
  const response = await fetch(`${hubUrl}/api/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`POST ${hubUrl}/api/ingest failed with ${response.status}: ${body}`)
  }

  return response.json()
}

async function startRuntimeActionServer(settings) {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/runtime-actions') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: false, message: 'Not found.' }))
        return
      }

      const body = await readJsonBody(request)
      const result = await handleRuntimeAction(settings, body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, message }))
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(settings.actionPort, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  return `http://127.0.0.1:${settings.actionPort}/runtime-actions`
}

async function handleRuntimeAction(settings, source) {
  if (!isRecord(source)) {
    throw new Error('Runtime action payload must be a JSON object.')
  }

  if (source.target !== 'send_prompt') {
    throw new Error(`Unsupported runtime action target: ${String(source.target)}`)
  }

  const message = requireString(source.message, 'message')
  await appendPromptLog(settings.promptLogFile, {
    timestamp: new Date().toISOString(),
    target: 'send_prompt',
    message,
    agentId: normalizeString(source.agentId),
    runId: normalizeString(source.runId),
    sessionId: normalizeString(source.sessionId),
  })

  const payload = await buildRuntimeActionIngestPayload(settings, message, source)
  await postPayload(settings.hubUrl, payload)

  return {
    ok: true,
    message: `Reference sidecar accepted prompt dispatch through ${payload.agent.id}.`,
  }
}

async function buildRuntimeActionIngestPayload(settings, message, source) {
  const normalized = await loadNormalizedPayload(settings)
  const expectedAgentId = normalized.agent.id
  const requestedAgentId = normalizeString(source.agentId)
  if (requestedAgentId && requestedAgentId !== expectedAgentId) {
    throw new Error(
      `Runtime action request targeted ${requestedAgentId}, but this sidecar is currently publishing ${expectedAgentId}.`,
    )
  }

  return stampPayload(
    {
      ...normalized,
      event: {
        type: 'run.output',
        message: `Reference sidecar received Agent Hub prompt: ${message}`,
      },
    },
    { includeEvent: true, createdAt: DEFAULT_CREATED_AT },
  )
}

async function appendPromptLog(filePath, entry) {
  if (!filePath) {
    return
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
}

async function readJsonBody(request) {
  const chunks = []
  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) {
    throw new Error('Runtime action payload must not be empty.')
  }

  try {
    return JSON.parse(raw)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown parse error'
    throw new Error(`Unable to parse runtime action JSON: ${reason}`)
  }
}

function resolveStringOption(options, optionKey, envKey, fallback) {
  const optionValue = options[optionKey]
  if (typeof optionValue === 'string' && optionValue.trim()) {
    return optionValue.trim()
  }

  const envValue = process.env[envKey]
  if (typeof envValue === 'string' && envValue.trim()) {
    return envValue.trim()
  }

  return fallback
}

function resolveBooleanOption(optionValue, envValue, fallback) {
  if (optionValue === true) {
    return true
  }
  if (typeof optionValue === 'string') {
    return parseBooleanString(optionValue, fallback)
  }
  if (typeof envValue === 'string' && envValue.trim()) {
    return parseBooleanString(envValue, fallback)
  }
  return fallback
}

function resolvePositiveIntOption(optionValue, envValue, fallback) {
  const raw =
    optionValue !== undefined ? optionValue : envValue !== undefined ? envValue : fallback
  const parsed = Number.parseInt(String(raw), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer but received: ${raw}`)
  }
  return parsed
}

function resolveOptionalPositiveIntOption(optionValue, envValue) {
  if (
    optionValue === undefined ||
    optionValue === null ||
    optionValue === '' ||
    (typeof optionValue === 'string' && optionValue.trim() === '')
  ) {
    if (envValue === undefined || envValue === null || String(envValue).trim() === '') {
      return null
    }
    return resolvePositiveIntOption(undefined, envValue, 1)
  }

  return resolvePositiveIntOption(optionValue, undefined, 1)
}

function resolveNullableNumberOption(optionValue, fallback) {
  if (optionValue === null) {
    return null
  }
  if (optionValue === undefined || optionValue === '') {
    return fallback === undefined ? null : fallback
  }
  const parsed = Number(optionValue)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a number but received: ${optionValue}`)
  }
  return parsed
}

function resolveOptionalPath(value) {
  const normalized = normalizeString(value)
  return normalized ? path.resolve(normalized) : null
}

function requireString(value, label) {
  const normalized = normalizeString(value)
  if (!normalized) {
    throw new Error(`Missing required ${label}`)
  }
  return normalized
}

function normalizeString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function resolveEnumOption(value, allowed, label) {
  const normalized = requireString(value, label)
  if (!allowed.has(normalized)) {
    throw new Error(`Invalid ${label}: ${normalized}`)
  }
  return normalized
}

function normalizeOptionalEnum(value, allowed, label) {
  const normalized = normalizeString(value)
  if (!normalized) {
    return undefined
  }
  if (!allowed.has(normalized)) {
    throw new Error(`Invalid ${label}: ${normalized}`)
  }
  return normalized
}

function resolveOptionalEnumOption(value, allowed, label) {
  return normalizeOptionalEnum(value, allowed, label) ?? null
}

function resolveAbsolutePath(value) {
  return path.resolve(value)
}

function parseBooleanString(value, fallback) {
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false
  }
  return fallback
}

function parseJson(input, filePath) {
  try {
    return JSON.parse(input)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown parse error'
    throw new Error(`Unable to parse JSON from ${filePath}: ${reason}`)
  }
}

function stableStringify(value) {
  return JSON.stringify(value)
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

main().catch((error) => {
  console.error(`[reference-sidecar] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
