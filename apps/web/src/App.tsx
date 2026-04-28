import {
  deriveSessionDescriptorId,
  deriveOperationalTopology,
  getApprovalResolveSupport,
  getAgentRuntimeActionSupport,
  getSessionTerminalAttachSupport,
  hasAgentWorkspaceActionSupport,
  hasAgentRuntimeControlSurface,
  getAgentSourceKind,
  getRunActionSupport,
  listAvailableAgentRuntimeActions,
  listAvailableRunActions,
} from '../../../packages/shared/src/index.ts'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentAttention,
  AgentDescriptor,
  AgentEvent,
  AgentHealth,
  AgentPlatform,
  AgentRun,
  ApprovalBridgeStatus,
  ApprovalDecision,
  ApprovalItem,
  AgentRuntimeActionRequest,
  AgentRuntimeActionResult,
  AgentRuntimeActionSupport,
  AgentRuntimeActionSupportCode,
  AgentRuntimeActionTarget,
  AgentSessionMetadata,
  SessionActionRequest,
  SessionActionResult,
  SessionActionTarget,
  SessionTerminalAttachSupport,
  TaskAssignmentRequest,
  TaskAssignmentResult,
  TaskAssignmentState,
  TaskPriority,
  TaskPriorityRequest,
  TaskPriorityResult,
  TaskPriorityState,
  TaskHandoffActionRequest,
  TaskHandoffRequest,
  TaskHandoffResult,
  TaskHandoffState,
  AgentWorkspaceActionResult,
  AgentWorkspaceActionTarget,
  DashboardSnapshot,
  HubHealth,
  ProjectDescriptor,
  ReferenceProject,
  ReferenceProjectCategory,
  ResourceDescriptor,
  ResourcePolicyUpdateRequest,
  ResourcePolicyUpdateResult,
  RunAction,
  RunActionSupportCode,
  RunState,
  SessionDescriptor,
  TaskDescriptor,
} from '../../../packages/shared/src/index.ts'
import './App.css'

type SocketStatus = 'connecting' | 'open' | 'reconnecting' | 'error'
type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'
type Language = 'en' | 'zh'
type DashboardPage = 'overview' | 'operations' | 'agents' | 'activity' | 'references'
type RuntimeDiagnostic = {
  label: string
  value: string
  detail: string
  tone: StatusTone
}
type DashboardPageDefinition = {
  id: DashboardPage
  label: string
  description: string
  badge?: string
}
type AttentionFilterValue = 'all' | 'needs_attention' | AgentAttention
type PlatformFilterValue = 'all' | AgentPlatform
type RunTriageState = {
  acknowledgedAt?: string
  muted?: boolean
  snoozedUntil?: string
}
type RunTriageStore = Record<string, RunTriageState>
type OperatorNotice = {
  title: string
  message: string
  tone: 'info' | 'warning' | 'error'
}
type RoadmapCapability = {
  id: string
  title: string
  summary: string
  whyNow: string
  acceptance: string
  priorityLabel: string
  tone: StatusTone
}
type IntegrationDescriptor = {
  id: string
  name: string
  method: string
  path: string
  endpoint: string
  description: string
  examplePayload?: Record<string, unknown>
  entrypoint?: string
  exampleStateFile?: string
  quickStartCommand?: string
  watchCommand?: string
  runtimeBridgeCommand?: string
}

const ACTIVE_RUN_STATES = new Set<RunState>([
  'ready',
  'queued',
  'starting',
  'running',
  'waiting_input',
  'paused',
])

const EVENT_LIMIT = 50
const VISIBLE_EVENT_LIMIT = 18
const POLL_INTERVAL_MS = 30_000
const DEFAULT_SNOOZE_MS = 30 * 60 * 1000
const MAX_RUNTIME_PROMPT_LENGTH = 4_000
const LANGUAGE_STORAGE_KEY = 'agent-hub:language'
const DASHBOARD_PAGE_STORAGE_KEY = 'agent-hub:page'
const LOCAL_TRIAGE_STORAGE_KEY = 'agent-hub:run-triage'
const REFERENCE_CATEGORY_ORDER: ReferenceProjectCategory[] = [
  'agent-workbench',
  'workflow-builder',
  'observability',
]
const LOCALE_BY_LANGUAGE: Record<Language, string> = {
  en: 'en-US',
  zh: 'zh-CN',
}
const EMPTY_AGENTS: AgentDescriptor[] = []
const EMPTY_APPROVALS: ApprovalItem[] = []
const EMPTY_RUNS: AgentRun[] = []
const EMPTY_EVENTS: AgentEvent[] = []
const EMPTY_PROJECTS: ProjectDescriptor[] = []
const EMPTY_RESOURCES: ResourceDescriptor[] = []
const EMPTY_SESSIONS: SessionDescriptor[] = []
const EMPTY_TASKS: TaskDescriptor[] = []
const EMPTY_REFERENCES: ReferenceProject[] = []
const EMPTY_INTEGRATIONS: IntegrationDescriptor[] = []
let currentLanguage: Language = 'en'
let currentLocale = LOCALE_BY_LANGUAGE.en

function isLanguage(value: string | null | undefined): value is Language {
  return value === 'en' || value === 'zh'
}

function isDashboardPage(value: string | null | undefined): value is DashboardPage {
  return (
    value === 'overview' ||
    value === 'operations' ||
    value === 'agents' ||
    value === 'activity' ||
    value === 'references'
  )
}

function setDisplayLanguage(language: Language) {
  currentLanguage = language
  currentLocale = LOCALE_BY_LANGUAGE[language]
}

function getHashDashboardPage(): DashboardPage | null {
  if (typeof window === 'undefined') {
    return null
  }

  const hashValue = window.location.hash.replace(/^#\/?/, '').trim()
  return isDashboardPage(hashValue) ? hashValue : null
}

function getInitialLanguage(): Language {
  if (typeof window === 'undefined') {
    return currentLanguage
  }

  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    if (isLanguage(stored)) {
      return stored
    }
  } catch {
    // Ignore storage access issues and fall back to browser preference.
  }

  const browserLanguage = window.navigator.language?.toLowerCase() ?? ''
  return browserLanguage.startsWith('zh') ? 'zh' : 'en'
}

function getInitialDashboardPage(): DashboardPage {
  if (typeof window === 'undefined') {
    return 'operations'
  }

  const hashPage = getHashDashboardPage()
  if (hashPage) {
    return hashPage
  }

  try {
    const stored = window.localStorage.getItem(DASHBOARD_PAGE_STORAGE_KEY)
    if (isDashboardPage(stored)) {
      return stored
    }
  } catch {
    // Ignore storage access issues and fall back to the default page.
  }

  return 'operations'
}

function persistLanguage(language: Language) {
  setDisplayLanguage(language)

  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Ignore storage access issues so the UI still works for the current session.
  }

  if (typeof document !== 'undefined') {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  }
}

function persistDashboardPage(page: DashboardPage) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(DASHBOARD_PAGE_STORAGE_KEY, page)
  } catch {
    // Ignore storage access issues and keep the current page in memory only.
  }

  const nextHash = `#${page}`
  if (window.location.hash === nextHash) {
    return
  }

  const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`
  if (window.location.hash.length === 0) {
    window.history.replaceState(null, '', nextUrl)
    return
  }

  window.history.pushState(null, '', nextUrl)
}

const ROADMAP_CAPABILITIES: Record<Language, RoadmapCapability[]> = {
  en: [
    {
      id: 'runtime-control-bridges',
      title: 'Truthful control bridges',
      summary:
        'Turn discovered Copilot, Claude, and OpenClaw runtimes from read-only visibility into opt-in actionable sessions.',
      whyNow:
        'Fleet visibility is much stronger now, but the hub still cannot truthfully pause, resume, or approve most live sessions.',
      acceptance:
        'At least one discovered runtime exposes a real control bridge with explicit capability negotiation and no fake-enabled buttons.',
      priorityLabel: 'Now',
      tone: 'warning',
    },
    {
      id: 'workspace-filters',
      title: 'Workspace-first filters',
      summary:
        'Group and filter sessions by workspace, runtime, state, and attention level.',
      whyNow:
        'As the number of sessions grows, operators will think in repos and hotspots, not raw rows.',
      acceptance:
        'The dashboard can filter and group by workspace, runtime, state, and attention, with urgent items sorted first.',
      priorityLabel: 'Next',
      tone: 'info',
    },
    {
      id: 'attention-triage',
      title: 'Attention triage controls',
      summary:
        'Let operators acknowledge, snooze, or mute inbox items without changing upstream runtimes.',
      whyNow:
        'Notifications and actions exist, but there is no local triage layer to reduce alert fatigue.',
      acceptance:
        'Inbox items can be acknowledged, snoozed, or muted and the dashboard state updates immediately.',
      priorityLabel: 'Next',
      tone: 'info',
    },
    {
      id: 'run-timeline',
      title: 'Run timeline and blocker view',
      summary:
        'Show what changed before an operator decides to approve, resume, or cancel.',
      whyNow:
        'A richer event trail is the lightest path to operator confidence without rebuilding observability tools.',
      acceptance:
        'Opening a run reveals recent state transitions, waiting reasons, timestamps, and operator actions in order.',
      priorityLabel: 'Soon',
      tone: 'neutral',
    },
    {
      id: 'adapter-kit',
      title: 'Thin adapter kit',
      summary:
        'Speed up support for tools that cannot be discovered directly from the local machine.',
      whyNow:
        'Not every runtime exposes a clean local signal, so sidecars should be cheap to add.',
      acceptance:
        'A documented local adapter contract plus one reference sidecar can publish into /api/ingest quickly.',
      priorityLabel: 'Soon',
      tone: 'neutral',
    },
  ],
  zh: [
    {
      id: 'runtime-control-bridges',
      title: '真实控制桥',
      summary: '把已经发现到的 Copilot、Claude、OpenClaw runtime，从只读可见推进到可选择接管的真实控制。',
      whyNow: '现在 fleet 可见性已经明显增强，但大多数 live session 仍然只能看，不能被真实地 pause、resume 或 approve。',
      acceptance:
        '至少有一种已发现 runtime 暴露真实控制桥，并且带显式 capability 协商，不再出现“看起来能点、实际上不能控”的假动作。',
      priorityLabel: '现在',
      tone: 'warning',
    },
    {
      id: 'workspace-filters',
      title: '按工作区优先的筛选',
      summary: '按 workspace、runtime、state、attention 来组织和筛选 session。',
      whyNow: 'session 一多，操作者关心的是哪个仓库有问题，而不是哪一行数据变了。',
      acceptance:
        'dashboard 支持按 workspace/runtime/state/attention 过滤和分组，并把紧急项排在前面。',
      priorityLabel: '下一步',
      tone: 'info',
    },
    {
      id: 'attention-triage',
      title: '注意力分诊控制',
      summary: '允许操作者本地 ack、snooze、mute inbox 项，而不改动上游 runtime。',
      whyNow: '现在已经有通知和动作，但还缺一层真正减轻告警疲劳的本地分诊。',
      acceptance:
        'inbox 项可被本地 acknowledge、snooze、mute，且 dashboard 状态即时更新。',
      priorityLabel: '下一步',
      tone: 'info',
    },
    {
      id: 'run-timeline',
      title: 'Run 时间线与阻塞视图',
      summary: '让操作者在 approve、resume、cancel 之前先看清楚发生了什么。',
      whyNow: '更清晰的事件轨迹，是不重造 observability 工具前提下最轻量的信任增强。',
      acceptance:
        '打开某个 run 后，能看到最近状态变化、waiting reason、时间戳和操作者动作。',
      priorityLabel: '稍后',
      tone: 'neutral',
    },
    {
      id: 'adapter-kit',
      title: '轻量 adapter 工具包',
      summary: '为那些无法直接本地发现的工具快速接入一个 sidecar 路径。',
      whyNow: '并不是所有 runtime 都暴露了干净的本地信号，所以 sidecar 必须足够便宜。',
      acceptance:
        '提供文档化的本地 adapter 契约和一个参考 sidecar，可快速接入 /api/ingest。',
      priorityLabel: '稍后',
      tone: 'neutral',
    },
  ],
}

function App() {
  const [language, setLanguage] = useState<Language>(() => getInitialLanguage())
  const [activePage, setActivePage] = useState<DashboardPage>(() =>
    getInitialDashboardPage(),
  )
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [health, setHealth] = useState<HubHealth | null>(null)
  const [references, setReferences] = useState<ReferenceProject[]>(EMPTY_REFERENCES)
  const [integrations, setIntegrations] = useState<IntegrationDescriptor[]>(EMPTY_INTEGRATIONS)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [referencesError, setReferencesError] = useState<string | null>(null)
  const [integrationsError, setIntegrationsError] = useState<string | null>(null)
  const [socketStatus, setSocketStatus] = useState<SocketStatus>('connecting')
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [workspaceFilter, setWorkspaceFilter] = useState('all')
  const [platformFilter, setPlatformFilter] = useState<PlatformFilterValue>('all')
  const [attentionFilter, setAttentionFilter] =
    useState<AttentionFilterValue>('all')
  const [showTriaged, setShowTriaged] = useState(false)
  const [selectedApprovalId, setSelectedApprovalId] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [triageStore, setTriageStore] = useState<RunTriageStore>(() =>
    loadTriageStore(),
  )
  const [operatorNotice, setOperatorNotice] = useState<OperatorNotice | null>(null)
  const [pendingActions, setPendingActions] = useState<
    Record<string, RunAction | undefined>
  >({})
  const [pendingApprovalActions, setPendingApprovalActions] = useState<
    Record<string, ApprovalDecision | undefined>
  >({})
  const [pendingWorkspaceActions, setPendingWorkspaceActions] = useState<
    Record<string, AgentWorkspaceActionTarget | undefined>
  >({})
  const [pendingRuntimeActions, setPendingRuntimeActions] = useState<
    Record<string, AgentRuntimeActionTarget | undefined>
  >({})
  const [pendingSessionActions, setPendingSessionActions] = useState<
    Record<string, SessionActionTarget | undefined>
  >({})
  const [pendingTaskRuntimeActions, setPendingTaskRuntimeActions] = useState<
    Record<string, AgentRuntimeActionTarget | undefined>
  >({})
  const [pendingTaskPriorities, setPendingTaskPriorities] = useState<
    Record<string, TaskPriority | undefined>
  >({})
  const [taskPriorityDrafts, setTaskPriorityDrafts] = useState<
    Record<string, TaskPriority | undefined>
  >({})
  const [pendingTaskAssignments, setPendingTaskAssignments] = useState<
    Record<string, 'assign' | 'clear' | undefined>
  >({})
  const [pendingResourcePolicyUpdates, setPendingResourcePolicyUpdates] = useState<
    Partial<Record<AgentPlatform, true>>
  >({})
  const [resourceSlotDrafts, setResourceSlotDrafts] = useState<
    Partial<Record<AgentPlatform, string>>
  >({})
  const [showOperationsResourceStrip, setShowOperationsResourceStrip] = useState(false)
  const [taskOwnerDrafts, setTaskOwnerDrafts] = useState<
    Record<string, string | undefined>
  >({})
  const [pendingTaskHandoffs, setPendingTaskHandoffs] = useState<
    Record<string, 'request' | 'clear' | 'complete' | undefined>
  >({})
  const [taskHandoffTargetDrafts, setTaskHandoffTargetDrafts] = useState<
    Record<string, string | undefined>
  >({})
  const [taskHandoffNoteDrafts, setTaskHandoffNoteDrafts] = useState<
    Record<string, string | undefined>
  >({})
  const [runtimePromptDrafts, setRuntimePromptDrafts] = useState<
    Record<string, string | undefined>
  >({})

  const mountedRef = useRef(true)
  const requestIdRef = useRef(0)
  const refreshTimerRef = useRef<number | null>(null)
  const snapshotRef = useRef<DashboardSnapshot | null>(null)
  const isZh = language === 'zh'
  const roadmapCapabilities = ROADMAP_CAPABILITIES[language]

  setDisplayLanguage(language)

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  useEffect(() => {
    persistLanguage(language)
  }, [language])

  useEffect(() => {
    persistDashboardPage(activePage)
  }, [activePage])

  useEffect(() => {
    persistTriageStore(triageStore)
  }, [triageStore])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const handleHashChange = () => {
      const nextPage = getHashDashboardPage()
      if (nextPage) {
        setActivePage(nextPage)
      }
    }

    window.addEventListener('hashchange', handleHashChange)
    return () => {
      window.removeEventListener('hashchange', handleHashChange)
    }
  }, [])

  useEffect(() => {
    if (!operatorNotice) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setOperatorNotice(null)
    }, 4000)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [operatorNotice])

  useEffect(() => {
    return () => {
      mountedRef.current = false
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
      }
    }
  }, [])

  const loadDashboard = useCallback(
    async (options: { silent?: boolean } = {}) => {
      const requestId = ++requestIdRef.current

      if (options.silent) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }

      setError(null)

      try {
        const nextSnapshot = await fetchDashboardData()

        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return
        }

        setSnapshot(nextSnapshot)
        setLastSyncedAt(new Date().toISOString())
      } catch (loadError) {
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return
        }

        setError(getErrorMessage(loadError))
      } finally {
        if (mountedRef.current && requestId === requestIdRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [],
  )

  useEffect(() => {
    void loadDashboard()
  }, [loadDashboard])

  useEffect(() => {
    let cancelled = false

    const loadHealth = async () => {
      try {
        const nextHealth = await fetchHubHealth()
        if (cancelled) {
          return
        }

        setHealth(nextHealth)
      } catch {
        if (cancelled) {
          return
        }

        setHealth(null)
      }
    }

    void loadHealth()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadReferences = async () => {
      try {
        const nextReferences = await fetchReferenceCatalog()
        if (cancelled) {
          return
        }

        setReferences(nextReferences)
        setReferencesError(null)
      } catch (loadError) {
        if (cancelled) {
          return
        }

        setReferencesError(getErrorMessage(loadError))
      }
    }

    void loadReferences()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const loadIntegrations = async () => {
      try {
        const nextIntegrations = await fetchIntegrationCatalog()
        if (cancelled) {
          return
        }

        setIntegrations(nextIntegrations)
        setIntegrationsError(null)
      } catch (loadError) {
        if (cancelled) {
          return
        }

        setIntegrationsError(getErrorMessage(loadError))
      }
    }

    void loadIntegrations()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadDashboard({ silent: true })
    }, POLL_INTERVAL_MS)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadDashboard])

  useEffect(() => {
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let reconnectAttempt = 0
    let alive = true

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    const scheduleRefresh = () => {
      if (refreshTimerRef.current !== null) {
        return
      }

      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null
        void loadDashboard({ silent: true })
      }, 500)
    }

    const scheduleReconnect = () => {
      if (!alive || reconnectTimer !== null) {
        return
      }

      setSocketStatus('reconnecting')
      const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt)
      reconnectAttempt += 1
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connect()
      }, delay)
    }

    const connect = () => {
      if (!alive) {
        return
      }

      setSocketStatus(reconnectAttempt === 0 ? 'connecting' : 'reconnecting')

      try {
        socket = new WebSocket(buildWebSocketUrl())
      } catch {
        setSocketStatus('error')
        scheduleReconnect()
        return
      }

      socket.onopen = () => {
        reconnectAttempt = 0
        if (!alive) {
          return
        }

        setSocketStatus('open')
      }

      socket.onmessage = (messageEvent) => {
        if (!alive) {
          return
        }

        const payload = parseRealtimePayload(messageEvent.data)

        if (payload === 'ping' || payload === 'pong') {
          return
        }

        if (payload === null) {
          scheduleRefresh()
          return
        }

        const nextSnapshot = applyRealtimePayload(snapshotRef.current, payload)

        if (nextSnapshot) {
          setSnapshot(nextSnapshot)
          setLastSyncedAt(new Date().toISOString())
          return
        }

        scheduleRefresh()
      }

      socket.onerror = () => {
        if (!alive) {
          return
        }

        setSocketStatus('error')
      }

      socket.onclose = () => {
        if (!alive) {
          return
        }

        scheduleReconnect()
      }
    }

    connect()

    return () => {
      alive = false
      clearReconnectTimer()

      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }

      socket?.close()
    }
  }, [loadDashboard])

  const agents = snapshot?.agents ?? EMPTY_AGENTS
  const approvals = snapshot?.approvals ?? EMPTY_APPROVALS
  const runs = snapshot?.runs ?? EMPTY_RUNS
  const inbox = snapshot?.inbox ?? EMPTY_RUNS
  const allEvents = snapshot?.events ?? EMPTY_EVENTS
  const projects = snapshot?.projects ?? EMPTY_PROJECTS
  const resources = snapshot?.resources ?? EMPTY_RESOURCES
  const sessions = snapshot?.sessions ?? EMPTY_SESSIONS
  const tasks = snapshot?.tasks ?? EMPTY_TASKS
  const openClawApprovalBridge = snapshot?.approvalBridge?.openclaw ?? null

  const activeRuns = useMemo(
    () => runs.filter((run) => ACTIVE_RUN_STATES.has(run.state)),
    [runs],
  )
  const liveCopilotSessions = useMemo(
    () =>
      agents.filter(
        (agent) => agent.id.startsWith('copilot-session-') && agent.state !== 'offline',
      ),
    [agents],
  )
  const claudeCodeAgents = useMemo(
    () =>
      agents.filter(
        (agent) => agent.platform === 'claude-code' && agent.state !== 'offline',
      ),
    [agents],
  )
  const geminiCliAgents = useMemo(
    () =>
      agents.filter((agent) => agent.platform === 'gemini-cli' && agent.state !== 'offline'),
    [agents],
  )
  const openClawAgents = useMemo(
    () => agents.filter((agent) => agent.platform === 'openclaw' && agent.state !== 'offline'),
    [agents],
  )
  const genericIngestAgents = useMemo(
    () => agents.filter((agent) => agent.platform === 'generic' && agent.state !== 'offline'),
    [agents],
  )
  const copilotRuntimeIssue = getStrongestRuntimeHealthIssue(liveCopilotSessions)
  const claudeRuntimeIssue = getStrongestRuntimeHealthIssue(claudeCodeAgents)
  const geminiRuntimeIssue = getStrongestRuntimeHealthIssue(geminiCliAgents)
  const openClawRuntimeIssue = getStrongestRuntimeHealthIssue(openClawAgents)

  const agentLookup = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent] as const)),
    [agents],
  )

  const runLookup = useMemo(
    () => new Map(runs.map((run) => [run.id, run] as const)),
    [runs],
  )
  const taskLookup = useMemo(
    () => new Map(tasks.map((task) => [task.id, task] as const)),
    [tasks],
  )
  const taskByRunId = useMemo(
    () => new Map(tasks.map((task) => [task.runId, task] as const)),
    [tasks],
  )
  const projectLookup = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  )
  const sessionLookup = useMemo(
    () => new Map(sessions.map((session) => [session.id, session] as const)),
    [sessions],
  )
  const approvalLookup = useMemo(
    () => new Map(approvals.map((approval) => [approval.id, approval] as const)),
    [approvals],
  )
  const eventLookup = useMemo(
    () => new Map(allEvents.map((event) => [event.id, event] as const)),
    [allEvents],
  )

  const workspaceOptions = useMemo(() => {
    const options = [...new Set(agents.map((agent) => agent.workspacePath))].map(
      (path) => ({
        path,
        label: getWorkspaceLabel(path),
      }),
    )

    return options.sort(
      (left, right) =>
        left.label.localeCompare(right.label) || left.path.localeCompare(right.path),
    )
  }, [agents])

  const filteredAgents = useMemo(
    () =>
      agents.filter((agent) =>
        matchesAgentFilters(agent, {
          attentionFilter,
          platformFilter,
          searchQuery,
          workspaceFilter,
        }),
      ),
    [agents, attentionFilter, platformFilter, searchQuery, workspaceFilter],
  )

  const filteredRuns = useMemo(
    () =>
      runs.filter((run) =>
        matchesRunFilters(run, agentLookup, {
          attentionFilter,
          platformFilter,
          searchQuery,
          workspaceFilter,
        }),
      ),
    [agentLookup, attentionFilter, platformFilter, runs, searchQuery, workspaceFilter],
  )

  const filteredProjects = useMemo(
    () =>
      projects.filter((project) =>
        matchesProjectFilters(project, {
          attentionFilter,
          platformFilter,
          searchQuery,
          workspaceFilter,
        }),
      ),
    [attentionFilter, platformFilter, projects, searchQuery, workspaceFilter],
  )

  const filteredSessions = useMemo(
    () =>
      sessions.filter((session) =>
        matchesSessionFilters(session, {
          attentionFilter,
          platformFilter,
          searchQuery,
          workspaceFilter,
        }),
      ),
    [attentionFilter, platformFilter, searchQuery, sessions, workspaceFilter],
  )

  const filteredTasks = useMemo(
    () =>
      tasks.filter((task) =>
        matchesTaskFilters(task, {
          attentionFilter,
          platformFilter,
          searchQuery,
          workspaceFilter,
        }),
      ),
    [attentionFilter, platformFilter, searchQuery, tasks, workspaceFilter],
  )

  const filteredInboxCandidates = useMemo(
    () =>
      inbox.filter((run) =>
        matchesRunFilters(run, agentLookup, {
          attentionFilter,
          platformFilter,
          searchQuery,
          workspaceFilter,
        }),
      ),
    [agentLookup, attentionFilter, inbox, platformFilter, searchQuery, workspaceFilter],
  )

  const visibleInbox = useMemo(
    () =>
      showTriaged
        ? filteredInboxCandidates
        : filteredInboxCandidates.filter(
            (run) => !shouldHideTriagedRun(triageStore[run.id], Date.now()),
          ),
    [filteredInboxCandidates, showTriaged, triageStore],
  )

  const filteredApprovalCandidates = useMemo(
    () =>
      approvals.filter((approval) =>
        matchesApprovalFilters(approval, agentLookup, {
          attentionFilter,
          platformFilter,
          searchQuery,
          workspaceFilter,
        }),
      ),
    [agentLookup, approvals, attentionFilter, platformFilter, searchQuery, workspaceFilter],
  )

  const hiddenTriagedApprovalCount = useMemo(
    () =>
      filteredApprovalCandidates.filter((approval) =>
        shouldHideTriagedRun(triageStore[approval.id], Date.now()),
      ).length,
    [filteredApprovalCandidates, triageStore],
  )

  const approvalQueue = useMemo(() => {
    const candidates = showTriaged
      ? filteredApprovalCandidates
      : filteredApprovalCandidates.filter(
          (approval) => !shouldHideTriagedRun(triageStore[approval.id], Date.now()),
        )

    return [...candidates].sort((left, right) => {
      const leftActionable = getApprovalResolveSupport(
        left,
        left.platform === 'openclaw' ? openClawApprovalBridge : null,
      ).supported
      const rightActionable = getApprovalResolveSupport(
        right,
        right.platform === 'openclaw' ? openClawApprovalBridge : null,
      ).supported
      if (leftActionable !== rightActionable) {
        return leftActionable ? -1 : 1
      }

      const attentionDelta =
        getAttentionSortValue(right.attention) - getAttentionSortValue(left.attention)
      if (attentionDelta !== 0) {
        return attentionDelta
      }

      return (
        dateValue(right.observedAt) - dateValue(left.observedAt) ||
        dateValue(right.createdAt) - dateValue(left.createdAt)
      )
    })
  }, [filteredApprovalCandidates, openClawApprovalBridge, showTriaged, triageStore])

  const filteredActiveRuns = useMemo(
    () => filteredRuns.filter((run) => ACTIVE_RUN_STATES.has(run.state)),
    [filteredRuns],
  )
  const filteredActiveTasks = useMemo(
    () => filteredTasks.filter((task) => ACTIVE_RUN_STATES.has(task.state)),
    [filteredTasks],
  )
  const filteredWaitingTasks = useMemo(
    () =>
      filteredTasks.filter(
        (task) =>
          task.waitingReason !== null || task.state === 'waiting_input' || task.state === 'paused',
      ),
    [filteredTasks],
  )

  const filteredEvents = useMemo(
    () =>
      allEvents
        .filter((event) =>
          matchesEventFilters(event, agentLookup, runLookup, {
            attentionFilter,
            platformFilter,
            searchQuery,
            workspaceFilter,
          }),
        )
        .slice(0, VISIBLE_EVENT_LIMIT),
    [
      agentLookup,
      allEvents,
      attentionFilter,
      platformFilter,
      runLookup,
      searchQuery,
      workspaceFilter,
    ],
  )
  const supportHealthyAgents = useMemo(
    () => agents.filter((agent) => agent.health === 'healthy'),
    [agents],
  )
  const supportAttentionAgents = useMemo(
    () => agents.filter((agent) => needsAgentAttention(agent.attention)),
    [agents],
  )
  const supportActionableApprovalCount = useMemo(
    () =>
      approvals.filter((approval) =>
        getApprovalResolveSupport(
          approval,
          approval.platform === 'openclaw' ? openClawApprovalBridge : null,
        ).supported,
      ).length,
    [approvals, openClawApprovalBridge],
  )
  const supportReadOnlyApprovalCount = approvals.length - supportActionableApprovalCount
  const supportAttentionEventCount = useMemo(
    () => allEvents.filter((event) => needsAgentAttention(event.attention)).length,
    [allEvents],
  )

  const healthyAgents = useMemo(
    () => filteredAgents.filter((agent) => agent.health === 'healthy'),
    [filteredAgents],
  )

  const attentionAgents = useMemo(
    () => filteredAgents.filter((agent) => needsAgentAttention(agent.attention)),
    [filteredAgents],
  )

  const missingRuntimes = useMemo(() => {
    const missing: string[] = []

    if (health && !health.copilotSessionDiscoveryEnabled) {
      missing.push('Copilot CLI')
    }

    if (health && !health.claudeCodeSessionDiscoveryEnabled) {
      missing.push('Claude Code')
    } else if (claudeCodeAgents.length === 0) {
      missing.push('Claude Code')
    }

    if (health && !health.geminiCliSessionDiscoveryEnabled) {
      missing.push('Gemini CLI')
    } else if (geminiCliAgents.length === 0) {
      missing.push('Gemini CLI')
    }

    if (health && !health.openClawSessionDiscoveryEnabled) {
      missing.push('OpenClaw')
    } else if (openClawAgents.length === 0) {
      missing.push('OpenClaw')
    }

    return missing
  }, [claudeCodeAgents.length, geminiCliAgents.length, health, openClawAgents.length])

  const runtimeDiagnostics = useMemo(
    () =>
      [
        {
          label: 'Copilot CLI',
          value: !health
            ? isZh
              ? '状态加载中'
              : 'Loading status'
            : !health.copilotSessionDiscoveryEnabled
              ? isZh
                ? '发现已关闭'
                : 'Discovery disabled'
              : liveCopilotSessions.length === 0
                ? isZh
                  ? '发现已就绪'
                  : 'Discovery ready'
                : describeRuntimeDiagnosticValue(
                    liveCopilotSessions.length,
                    { zh: '会话', en: 'session' },
                    copilotRuntimeIssue,
                  ),
          detail: !health
            ? isZh
              ? '等待 /health 确认当前 runtime 状态。'
              : 'Waiting for /health to confirm the runtime posture.'
            : !health.copilotSessionDiscoveryEnabled
              ? isZh
                ? '开启本地发现后，才能从 ~/.copilot/session-state 读取活跃 session。'
                : 'Turn on local discovery to read active sessions from ~/.copilot/session-state.'
              : liveCopilotSessions.length === 0
                ? isZh
                  ? '适配器已运行，正在等待活跃的本地 Copilot session。'
                  : 'The adapter is live and waiting for an active local Copilot session.'
                : copilotRuntimeIssue.kind === 'healthy'
                  ? isZh
                    ? '当前正在从 session-state 锁文件和 workspace 元数据读取真实本地 session 数据。'
                    : 'Truthful local session data is being read from session-state locks and workspace metadata.'
                  : describeRuntimeIssueDetail({
                      runtimeLabel: 'Copilot CLI',
                      visibleCount: liveCopilotSessions.length,
                      unit: { zh: '会话', en: 'session' },
                      issue: copilotRuntimeIssue,
                      authLabel: { zh: 'Copilot 本机认证', en: 'local Copilot auth' },
                    }),
          tone: !health
            ? 'neutral'
            : !health.copilotSessionDiscoveryEnabled
              ? 'danger'
              : liveCopilotSessions.length === 0
                ? 'info'
                : copilotRuntimeIssue.kind === 'healthy'
                  ? 'success'
                  : 'warning',
        },
        {
          label: 'Claude Code',
          value: !health
            ? isZh
              ? '状态加载中'
              : 'Loading status'
            : !health.claudeCodeSessionDiscoveryEnabled
              ? isZh
                ? '发现已关闭'
                : 'Discovery disabled'
              : claudeCodeAgents.length === 0
                ? isZh
                 ? '发现已就绪'
                 : 'Discovery ready'
               : describeRuntimeDiagnosticValue(
                   claudeCodeAgents.length,
                   { zh: '会话', en: 'session' },
                   claudeRuntimeIssue,
                 ),
          detail: !health
            ? isZh
              ? '等待 /health 确认当前 runtime 状态。'
              : 'Waiting for /health to confirm the runtime posture.'
            : !health.claudeCodeSessionDiscoveryEnabled
              ? isZh
                ? '开启本地发现后，才能从 ~/.claude/projects 和活跃 Claude CLI 进程读取 session。'
                : 'Turn on local discovery to read sessions from ~/.claude/projects and active Claude CLI processes.'
              : claudeCodeAgents.length === 0
                ? isZh
                  ? '适配器已运行，正在等待活跃的本地 Claude Code session。'
                  : 'The adapter is live and waiting for an active local Claude Code session.'
                : claudeRuntimeIssue.kind === 'healthy'
                  ? isZh
                    ? '当前正在从 ~/.claude/projects 日志和活跃 Claude CLI 进程读取真实本地 session 数据。'
                    : 'Truthful local session data is being read from ~/.claude/projects logs and active Claude CLI processes.'
                  : describeRuntimeIssueDetail({
                      runtimeLabel: 'Claude Code',
                      visibleCount: claudeCodeAgents.length,
                      unit: { zh: '会话', en: 'session' },
                      issue: claudeRuntimeIssue,
                      authLabel: { zh: 'Claude CLI 登录', en: 'Claude CLI login' },
                    }),
          tone: !health
            ? 'neutral'
            : !health.claudeCodeSessionDiscoveryEnabled
              ? 'danger'
              : claudeCodeAgents.length === 0
                ? 'info'
                : claudeRuntimeIssue.kind === 'healthy'
                  ? 'success'
                  : 'warning',
        },
        {
          label: 'Gemini CLI',
          value: !health
            ? isZh
              ? '状态加载中'
              : 'Loading status'
            : !health.geminiCliSessionDiscoveryEnabled
              ? isZh
                ? '发现已关闭'
                : 'Discovery disabled'
              : geminiCliAgents.length === 0
                ? isZh
                  ? '发现已就绪'
                  : 'Discovery ready'
                : describeRuntimeDiagnosticValue(
                    geminiCliAgents.length,
                    { zh: '会话', en: 'session' },
                    geminiRuntimeIssue,
                  ),
          detail: !health
            ? isZh
              ? '等待 /health 确认当前 runtime 状态。'
              : 'Waiting for /health to confirm the runtime posture.'
            : !health.geminiCliSessionDiscoveryEnabled
              ? isZh
                ? '开启本地发现后，才能从 ~/.gemini/tmp 会话文件和活跃 Gemini CLI 进程读取 session。'
                : 'Turn on local discovery to read sessions from ~/.gemini/tmp session files and active Gemini CLI processes.'
              : geminiCliAgents.length === 0
                ? isZh
                  ? '适配器已运行，正在等待活跃的本地 Gemini CLI session。'
                  : 'The adapter is live and waiting for an active local Gemini CLI session.'
                : geminiRuntimeIssue.kind === 'healthy'
                  ? isZh
                    ? '当前正在从 ~/.gemini/tmp 会话文件和活跃 Gemini CLI 进程读取真实本地 session 数据。'
                    : 'Truthful local session data is being read from ~/.gemini/tmp session files and active Gemini CLI processes.'
                  : describeRuntimeIssueDetail({
                      runtimeLabel: 'Gemini CLI',
                      visibleCount: geminiCliAgents.length,
                      unit: { zh: '会话', en: 'session' },
                      issue: geminiRuntimeIssue,
                      authLabel: { zh: 'Gemini 本机认证', en: 'local Gemini auth' },
                    }),
          tone: !health
            ? 'neutral'
            : !health.geminiCliSessionDiscoveryEnabled
              ? 'danger'
              : geminiCliAgents.length === 0
                ? 'info'
                : geminiRuntimeIssue.kind === 'healthy'
                  ? 'success'
                  : 'warning',
        },
        {
          label: 'OpenClaw',
          value: !health
            ? isZh
              ? '状态加载中'
              : 'Loading status'
            : !health.openClawSessionDiscoveryEnabled
              ? isZh
                ? '发现已关闭'
                : 'Discovery disabled'
              : openClawAgents.length === 0
                ? isZh
                  ? '发现已就绪'
                  : 'Discovery ready'
                : describeRuntimeDiagnosticValue(
                    openClawAgents.length,
                    { zh: 'agent', en: 'agent' },
                    openClawRuntimeIssue,
                  ),
          detail: !health
            ? isZh
              ? '等待 /health 确认当前 runtime 状态。'
              : 'Waiting for /health to confirm the runtime posture.'
            : !health.openClawSessionDiscoveryEnabled
              ? isZh
                ? '开启本地发现后，才能从 openclaw status --json 和本地 OpenClaw 运行信号读取 agent。'
                : 'Turn on local discovery to read agents from openclaw status --json and local OpenClaw runtime signals.'
              : openClawAgents.length === 0
                ? isZh
                  ? '发现已开启，正在等待活跃的本地 OpenClaw runtime。'
                  : 'Discovery is enabled and waiting for an active local OpenClaw runtime.'
                : openClawRuntimeIssue.kind === 'healthy'
                  ? isZh
                    ? '当前正在从 openclaw status --json 和本地进程/网关状态读取真实 OpenClaw agent 数据。'
                    : 'Truthful OpenClaw agent data is being read from openclaw status --json and local process/gateway signals.'
                  : describeRuntimeIssueDetail({
                      runtimeLabel: 'OpenClaw',
                      visibleCount: openClawAgents.length,
                      unit: { zh: 'agent', en: 'agent' },
                      issue: openClawRuntimeIssue,
                      authLabel: { zh: 'OpenClaw 本机认证', en: 'local OpenClaw auth' },
                    }),
          tone: !health
            ? 'neutral'
            : !health.openClawSessionDiscoveryEnabled
              ? 'danger'
              : openClawAgents.length === 0
                ? 'info'
                : openClawRuntimeIssue.kind === 'healthy'
                  ? 'success'
                  : 'warning',
        },
        {
          label: isZh ? '通用接入' : 'Generic ingest',
          value:
            genericIngestAgents.length === 0
              ? isZh
                ? '可供 sidecar 接入'
                : 'Ready for sidecars'
              : `${genericIngestAgents.length} adapter${genericIngestAgents.length === 1 ? '' : 's'}`,
          detail:
            genericIngestAgents.length === 0
              ? isZh
                ? '对于无法直接本地发现的工具，可通过 /api/ingest 接入。'
                : 'Use /api/ingest for tools that cannot be discovered directly on the machine.'
              : isZh
                ? '外部本地 adapters 正在把实时状态写入统一控制平面。'
                : 'External local adapters are publishing live state into the shared control plane.',
          tone: genericIngestAgents.length === 0 ? 'neutral' : 'info',
        },
      ] satisfies RuntimeDiagnostic[],
    [
      claudeCodeAgents.length,
      claudeRuntimeIssue.count,
      claudeRuntimeIssue.kind,
      copilotRuntimeIssue.count,
      copilotRuntimeIssue.kind,
      geminiCliAgents.length,
      geminiRuntimeIssue.count,
      geminiRuntimeIssue.kind,
      genericIngestAgents.length,
      health,
      isZh,
      liveCopilotSessions.length,
      openClawAgents.length,
      openClawRuntimeIssue.count,
      openClawRuntimeIssue.kind,
    ],
  )

  const selectableRuns = useMemo(
    () => dedupeById([...visibleInbox, ...filteredActiveRuns, ...filteredRuns]),
    [filteredActiveRuns, filteredRuns, visibleInbox],
  )

  useEffect(() => {
    if (selectedTaskId) {
      const task = taskLookup.get(selectedTaskId) ?? null
      if (task) {
        if (selectedRunId !== task.runId) {
          setSelectedRunId(task.runId)
        }
        return
      }
    }

    if (selectedRunId && selectableRuns.some((run) => run.id === selectedRunId)) {
      return
    }

    setSelectedRunId(selectableRuns[0]?.id ?? null)
  }, [selectableRuns, selectedRunId, selectedTaskId, taskLookup])

  useEffect(() => {
    if (selectedTaskId && !taskLookup.has(selectedTaskId)) {
      setSelectedTaskId(null)
    }
  }, [selectedTaskId, taskLookup])

  const handleRunAction = useCallback(
    async (run: AgentRun, action: RunAction) => {
      if (
        action === 'approve' &&
        !window.confirm(
          currentLanguage === 'zh'
            ? `确认批准“${run.title}”？如果后端存在真实控制桥，执行将继续。`
            : `Approve “${run.title}”? If a truthful bridge exists, execution will continue.`,
        )
      ) {
        return
      }

      if (
        action === 'cancel' &&
        !window.confirm(
          currentLanguage === 'zh'
            ? `确认取消“${run.title}”？`
            : `Cancel “${run.title}”?`,
        )
      ) {
        return
      }

      setPendingActions((current) => ({ ...current, [run.id]: action }))
      setError(null)

      try {
        const response = await requestData<unknown>(
          `/api/runs/${encodeURIComponent(run.id)}/actions`,
          {
            method: 'POST',
            body: JSON.stringify({ action }),
          },
        )

        const nextSnapshot = extractSnapshot(response)
        if (nextSnapshot) {
          setSnapshot(nextSnapshot)
          setLastSyncedAt(new Date().toISOString())
        } else {
          const realtimeUpdate = applyRealtimePayload(snapshotRef.current, response)
          if (realtimeUpdate) {
            setSnapshot(realtimeUpdate)
            setLastSyncedAt(new Date().toISOString())
          } else {
            await loadDashboard({ silent: true })
          }
        }
      } catch (actionError) {
        if (mountedRef.current) {
          setError(
            currentLanguage === 'zh'
              ? `无法${humanizeToken(action)}“${run.title}”：${getErrorMessage(actionError)}`
              : `Could not ${action} “${run.title}”: ${getErrorMessage(actionError)}`,
          )
        }
      } finally {
        if (mountedRef.current) {
          setPendingActions((current) => {
            const next = { ...current }
            delete next[run.id]
            return next
          })
        }
      }
    },
    [currentLanguage, loadDashboard],
  )

  const handleApprovalResolve = useCallback(
    async (approval: ApprovalItem, decision: ApprovalDecision) => {
      const verb =
        decision === 'allow-once'
          ? isZh
            ? '允许一次'
            : 'Allow once'
          : isZh
            ? '拒绝'
            : 'Deny'

      if (
        !window.confirm(
          isZh
            ? `确认对审批项 ${approval.id} 执行“${verb}”？`
            : `${verb} approval ${approval.id}?`,
        )
      ) {
        return
      }

      setPendingApprovalActions((current) => ({ ...current, [approval.id]: decision }))
      setError(null)

      try {
        const response = await requestData<unknown>(
          `/api/approvals/${encodeURIComponent(approval.id)}/resolve`,
          {
            method: 'POST',
            body: JSON.stringify({ decision }),
          },
        )

        const nextSnapshot = extractSnapshot(response)
        if (nextSnapshot) {
          setSnapshot(nextSnapshot)
          setLastSyncedAt(new Date().toISOString())
        } else {
          const realtimeUpdate = applyRealtimePayload(snapshotRef.current, response)
          if (realtimeUpdate) {
            setSnapshot(realtimeUpdate)
            setLastSyncedAt(new Date().toISOString())
          } else {
            await loadDashboard({ silent: true })
          }
        }

        if (isRecord(response) && typeof response.message === 'string') {
          setOperatorNotice({
            title: isZh ? '审批动作已发送' : 'Approval action sent',
            message: response.message,
            tone: 'info',
          })
        }
      } catch (actionError) {
        if (mountedRef.current) {
          setError(
            isZh
              ? `无法处理审批项 ${approval.id}：${getErrorMessage(actionError)}`
              : `Could not resolve approval ${approval.id}: ${getErrorMessage(actionError)}`,
          )
        }
      } finally {
        if (mountedRef.current) {
          setPendingApprovalActions((current) => {
            const next = { ...current }
            delete next[approval.id]
            return next
          })
        }
      }
    },
    [isZh, loadDashboard],
  )

  const handleWorkspaceAction = useCallback(
    async (agent: AgentDescriptor, target: AgentWorkspaceActionTarget) => {
      setPendingWorkspaceActions((current) => ({ ...current, [agent.id]: target }))

      try {
        const result = await requestAgentWorkspaceAction(agent.id, target)
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '已发送本地工作区动作' : 'Local workspace action sent',
          message: result.message,
          tone: 'info',
        })
      } catch (actionError) {
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '工作区动作失败' : 'Workspace action failed',
          message: getErrorMessage(actionError),
          tone: 'error',
        })
      } finally {
        setPendingWorkspaceActions((current) => {
          const next = { ...current }
          delete next[agent.id]
          return next
        })
      }
    },
    [],
  )

  const handleRuntimeAction = useCallback(
    async (
      agent: AgentDescriptor,
      target: AgentRuntimeActionTarget,
      options?: {
        message?: string
        onSuccess?: () => void
      },
    ) => {
      const nextMessage = options?.message?.trim()
      if (target === 'send_prompt' && !nextMessage) {
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '请输入 prompt' : 'Prompt required',
          message:
            currentLanguage === 'zh'
              ? `派发给 ${humanizeToken(agent.platform)} 的消息不能为空。`
              : `A non-empty prompt is required before dispatching to ${humanizeToken(agent.platform)}.`,
          tone: 'warning',
        })
        return
      }

      if (
        target === 'reset_session' &&
        !window.confirm(
          currentLanguage === 'zh'
            ? `确认重置 ${agent.name} 的当前 live session？这会创建一个新的 session id，并让后续对话从新会话继续。`
            : `Reset the current live session for ${agent.name}? This creates a new session id and future turns continue in the new session.`,
        )
      ) {
        return
      }

      setPendingRuntimeActions((current) => ({ ...current, [agent.id]: target }))

      try {
        const result = await requestAgentRuntimeAction(agent.id, {
          target,
          message: nextMessage,
        })
        const nextSnapshot = extractSnapshot(result)
        if (nextSnapshot) {
          setSnapshot(nextSnapshot)
          setLastSyncedAt(new Date().toISOString())
        } else {
          void loadDashboard({ silent: true })
        }
        options?.onSuccess?.()
        setOperatorNotice({
          title:
            target === 'send_prompt'
              ? currentLanguage === 'zh'
                ? '已派发运行时 prompt'
                : 'Runtime prompt dispatched'
              : currentLanguage === 'zh'
                ? '已发送本地运行时动作'
                : 'Local runtime action sent',
          message: result.message,
          tone: 'info',
        })
      } catch (actionError) {
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '运行时动作失败' : 'Runtime action failed',
          message: getErrorMessage(actionError),
          tone: 'error',
        })
      } finally {
        setPendingRuntimeActions((current) => {
          const next = { ...current }
          delete next[agent.id]
          return next
        })
      }
    },
    [currentLanguage, loadDashboard],
  )

  const handleSessionAction = useCallback(
    async (
      session: SessionDescriptor,
      _agent: AgentDescriptor,
      target: SessionActionTarget,
      options?: {
        message?: string
        onSuccess?: () => void
      },
    ) => {
      const nextMessage = options?.message?.trim()
      if (target === 'dispatch_text' && !nextMessage) {
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '请输入 prompt' : 'Prompt required',
          message:
            currentLanguage === 'zh'
              ? `派发到会话“${session.name}”的消息不能为空。`
              : `A non-empty prompt is required before dispatching to session “${session.name}”.`,
          tone: 'warning',
        })
        return
      }

      setPendingSessionActions((current) => ({ ...current, [session.id]: target }))

      try {
        const result = await requestSessionAction(session.id, {
          target,
          message: nextMessage,
        })
        const nextSnapshot = extractSnapshot(result)
        if (nextSnapshot) {
          setSnapshot(nextSnapshot)
          setLastSyncedAt(new Date().toISOString())
        } else {
          void loadDashboard({ silent: true })
        }
        options?.onSuccess?.()
        setOperatorNotice({
          title:
            target === 'dispatch_text'
              ? currentLanguage === 'zh'
                ? '已派发会话 prompt'
                : 'Session prompt dispatched'
              : currentLanguage === 'zh'
                ? '已打开会话终端'
                : 'Session terminal opened',
          message: result.message,
          tone: 'info',
        })
      } catch (actionError) {
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '会话动作失败' : 'Session action failed',
          message: getErrorMessage(actionError),
          tone: 'error',
        })
      } finally {
        setPendingSessionActions((current) => {
          const next = { ...current }
          delete next[session.id]
          return next
        })
      }
    },
    [currentLanguage, loadDashboard],
  )

  const handleTaskRuntimeAction = useCallback(
    async (
      task: TaskDescriptor,
      target: AgentRuntimeActionTarget,
      options?: {
        message?: string
        onSuccess?: () => void
      },
    ) => {
      const nextMessage = options?.message?.trim()
      if (target === 'send_prompt' && !nextMessage) {
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '请输入 prompt' : 'Prompt required',
          message:
            currentLanguage === 'zh'
              ? `派发给任务“${task.title}”的消息不能为空。`
              : `A non-empty prompt is required before dispatching to task “${task.title}”.`,
          tone: 'warning',
        })
        return
      }

      if (
        target === 'reset_session' &&
        !window.confirm(
          currentLanguage === 'zh'
            ? `确认重置任务“${task.title}”当前绑定的 live session？后续交互将继续指向新的 session。`
            : `Reset the live session bound to task “${task.title}”? Future turns will continue in the new session.`,
        )
      ) {
        return
      }

      setPendingTaskRuntimeActions((current) => ({ ...current, [task.id]: target }))

      try {
        const result = await requestTaskRuntimeAction(task.id, {
          target,
          message: nextMessage,
        })
        const nextSnapshot = extractSnapshot(result)
        if (nextSnapshot) {
          setSnapshot(nextSnapshot)
          setLastSyncedAt(new Date().toISOString())
        } else {
          void loadDashboard({ silent: true })
        }
        options?.onSuccess?.()
        setOperatorNotice({
          title:
            target === 'send_prompt'
              ? currentLanguage === 'zh'
                ? '已派发任务 prompt'
                : 'Task prompt dispatched'
              : currentLanguage === 'zh'
                ? '已发送任务动作'
                : 'Task action sent',
          message: result.message,
          tone: 'info',
        })
      } catch (actionError) {
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '任务动作失败' : 'Task action failed',
          message: getErrorMessage(actionError),
          tone: 'error',
        })
      } finally {
        setPendingTaskRuntimeActions((current) => {
          const next = { ...current }
          delete next[task.id]
          return next
        })
      }
    },
    [currentLanguage, loadDashboard],
  )

  const handleTaskPriority = useCallback(
    async (task: TaskDescriptor, priority: TaskPriority) => {
      setPendingTaskPriorities((current) => ({
        ...current,
        [task.id]: priority,
      }))

      try {
        const result = await requestTaskPriority(task.id, { priority })
        const nextSnapshot = extractSnapshot(result)
        if (nextSnapshot) {
          setSnapshot(nextSnapshot)
          setLastSyncedAt(new Date().toISOString())
        } else {
          void loadDashboard({ silent: true })
        }

        setTaskPriorityDrafts((current) => ({
          ...current,
          [task.id]: result.priority,
        }))
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '任务优先级已更新' : 'Task priority updated',
          message: result.message,
          tone: 'info',
        })
      } catch (priorityError) {
        setOperatorNotice({
          title:
            currentLanguage === 'zh'
              ? '任务优先级更新失败'
              : 'Task priority update failed',
          message: getErrorMessage(priorityError),
          tone: 'error',
        })
      } finally {
        setPendingTaskPriorities((current) => {
          const next = { ...current }
          delete next[task.id]
          return next
        })
      }
    },
    [currentLanguage, loadDashboard],
  )

  const handleTaskAssignment = useCallback(
    async (task: TaskDescriptor, owner: string | null) => {
      const nextOwner = owner?.trim() ?? null
      setPendingTaskAssignments((current) => ({
        ...current,
        [task.id]: nextOwner ? 'assign' : 'clear',
      }))

      try {
        const result = await requestTaskAssignment(task.id, { owner: nextOwner })
        const nextSnapshot = extractSnapshot(result)
        if (nextSnapshot) {
          setSnapshot(nextSnapshot)
          setLastSyncedAt(new Date().toISOString())
        } else {
          void loadDashboard({ silent: true })
        }

        setTaskOwnerDrafts((current) => ({
          ...current,
          [task.id]: nextOwner ?? '',
        }))
        setTaskHandoffTargetDrafts((current) => ({
          ...current,
          [task.id]: '',
        }))
        setTaskHandoffNoteDrafts((current) => ({
          ...current,
          [task.id]: '',
        }))
        setOperatorNotice({
          title: nextOwner
            ? currentLanguage === 'zh'
              ? task.owner
                ? '任务负责人已更新'
                : '任务已指派'
              : task.owner
                ? 'Task owner updated'
                : 'Task assigned'
            : currentLanguage === 'zh'
              ? '任务已取消指派'
              : 'Task unassigned',
          message: result.message,
          tone: 'info',
        })
      } catch (assignmentError) {
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '任务归属更新失败' : 'Task ownership update failed',
          message: getErrorMessage(assignmentError),
          tone: 'error',
        })
      } finally {
        setPendingTaskAssignments((current) => {
          const next = { ...current }
          delete next[task.id]
          return next
        })
      }
    },
    [currentLanguage, loadDashboard],
  )

  const handleTaskHandoff = useCallback(
    async (
      task: TaskDescriptor,
      targetOwner: string | null,
      note?: string | null,
    ) => {
      const nextTargetOwner = targetOwner?.trim() ?? null
      const nextNote = nextTargetOwner ? note?.trim() ?? null : null
      setPendingTaskHandoffs((current) => ({
        ...current,
        [task.id]: nextTargetOwner ? 'request' : 'clear',
      }))

      try {
        const result = await requestTaskHandoff(task.id, {
          targetOwner: nextTargetOwner,
          note: nextNote,
        })
        const nextSnapshot = extractSnapshot(result)
        if (nextSnapshot) {
          setSnapshot(nextSnapshot)
          setLastSyncedAt(new Date().toISOString())
        } else {
          void loadDashboard({ silent: true })
        }

        setTaskHandoffTargetDrafts((current) => ({
          ...current,
          [task.id]: nextTargetOwner ?? '',
        }))
        setTaskHandoffNoteDrafts((current) => ({
          ...current,
          [task.id]: nextNote ?? '',
        }))
        setOperatorNotice({
          title: nextTargetOwner
            ? currentLanguage === 'zh'
              ? task.handoffTarget
                ? '任务交接请求已更新'
                : '任务交接请求已创建'
              : task.handoffTarget
                ? 'Task handoff updated'
                : 'Task handoff requested'
            : currentLanguage === 'zh'
              ? '任务交接请求已清除'
              : 'Task handoff cleared',
          message: result.message,
          tone: 'info',
        })
      } catch (handoffError) {
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '任务交接更新失败' : 'Task handoff update failed',
          message: getErrorMessage(handoffError),
          tone: 'error',
        })
      } finally {
        setPendingTaskHandoffs((current) => {
          const next = { ...current }
          delete next[task.id]
          return next
        })
      }
    },
    [currentLanguage, loadDashboard],
  )

  const handleTaskHandoffCompletion = useCallback(
    async (task: TaskDescriptor) => {
      setPendingTaskHandoffs((current) => ({
        ...current,
        [task.id]: 'complete',
      }))

      try {
        const result = await requestTaskHandoffAction(task.id, {
          action: 'complete',
        })
        const nextSnapshot = extractSnapshot(result)
        if (nextSnapshot) {
          setSnapshot(nextSnapshot)
          setLastSyncedAt(new Date().toISOString())
        } else {
          void loadDashboard({ silent: true })
        }

        setTaskOwnerDrafts((current) => ({
          ...current,
          [task.id]: result.owner ?? '',
        }))
        setTaskHandoffTargetDrafts((current) => ({
          ...current,
          [task.id]: '',
        }))
        setTaskHandoffNoteDrafts((current) => ({
          ...current,
          [task.id]: '',
        }))
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '任务交接已完成' : 'Task handoff completed',
          message: result.message,
          tone: 'info',
        })
      } catch (handoffError) {
        setOperatorNotice({
          title: currentLanguage === 'zh' ? '任务交接完成失败' : 'Task handoff completion failed',
          message: getErrorMessage(handoffError),
          tone: 'error',
        })
      } finally {
        setPendingTaskHandoffs((current) => {
          const next = { ...current }
          delete next[task.id]
          return next
        })
      }
    },
    [currentLanguage, loadDashboard],
  )

  const handleResourcePolicyUpdate = useCallback(
    async (resource: ResourceDescriptor, rawSlotLimit: string) => {
      const nextValue = rawSlotLimit.trim()
      let nextSlotLimit: number | null = null

      if (nextValue.length > 0) {
        if (!/^\d+$/.test(nextValue)) {
          setOperatorNotice({
            title: currentLanguage === 'zh' ? '资源槽位无效' : 'Invalid slot limit',
            message:
              currentLanguage === 'zh'
                ? '请输入 0 到 99 之间的整数，或留空表示无限制。'
                : 'Enter an integer between 0 and 99, or leave the field blank for unlimited capacity.',
            tone: 'warning',
          })
          return
        }

        nextSlotLimit = Number(nextValue)
        if (!Number.isInteger(nextSlotLimit) || nextSlotLimit < 0 || nextSlotLimit > 99) {
          setOperatorNotice({
            title: currentLanguage === 'zh' ? '资源槽位超出范围' : 'Slot limit out of range',
            message:
              currentLanguage === 'zh'
                ? '当前资源层基础版只支持 0 到 99 的槽位上限。'
                : 'This resource-plane foundation currently supports slot limits between 0 and 99.',
            tone: 'warning',
          })
          return
        }
      }

      setPendingResourcePolicyUpdates((current) => ({
        ...current,
        [resource.platform]: true,
      }))

      try {
        const result = await requestResourcePolicyUpdate(resource.platform, {
          slotLimit: nextSlotLimit,
        })
        const nextSnapshot = extractSnapshot(result)
        if (nextSnapshot) {
          setSnapshot(nextSnapshot)
          setLastSyncedAt(new Date().toISOString())
        } else {
          void loadDashboard({ silent: true })
        }

        setResourceSlotDrafts((current) => ({
          ...current,
          [resource.platform]: result.slotLimit === null ? '' : String(result.slotLimit),
        }))
        setOperatorNotice({
          title:
            result.slotLimit === null
              ? currentLanguage === 'zh'
                ? '资源上限已清除'
                : 'Resource limit cleared'
              : currentLanguage === 'zh'
                ? '资源上限已更新'
                : 'Resource limit updated',
          message: result.message,
          tone: 'info',
        })
      } catch (resourceError) {
        setOperatorNotice({
          title:
            currentLanguage === 'zh'
              ? '资源策略更新失败'
              : 'Resource policy update failed',
          message: getErrorMessage(resourceError),
          tone: 'error',
        })
      } finally {
        setPendingResourcePolicyUpdates((current) => {
          const next = { ...current }
          delete next[resource.platform]
          return next
        })
      }
    },
    [currentLanguage, loadDashboard],
  )

  const handleCopyValue = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setOperatorNotice({
        title: currentLanguage === 'zh' ? '已复制到剪贴板' : 'Copied to clipboard',
        message:
          currentLanguage === 'zh'
            ? `${label} 已成功复制。`
            : `${label} copied successfully.`,
        tone: 'info',
      })
    } catch (copyError) {
      setOperatorNotice({
        title: currentLanguage === 'zh' ? '复制失败' : 'Copy failed',
        message: getErrorMessage(copyError),
        tone: 'error',
      })
    }
  }, [])

  const handleTriageAction = useCallback(
    (
      runId: string,
      action:
        | 'acknowledge'
        | 'clear_acknowledge'
        | 'mute'
        | 'unmute'
        | 'snooze'
        | 'clear_snooze',
    ) => {
      setTriageStore((current) => applyTriageAction(current, runId, action))
      setOperatorNotice({
        title: currentLanguage === 'zh' ? '本地分诊已更新' : 'Local triage updated',
        message: describeTriageAction(action),
        tone: 'info',
      })
    },
    [],
  )

  const resetFilters = useCallback(() => {
    setSearchQuery('')
    setWorkspaceFilter('all')
    setPlatformFilter('all')
    setAttentionFilter('all')
    setShowTriaged(false)
  }, [])

  const clearAllTriage = useCallback(() => {
    setTriageStore({})
    setOperatorNotice({
      title: currentLanguage === 'zh' ? '本地分诊已清空' : 'Local triage cleared',
      message:
        currentLanguage === 'zh'
          ? '所有已确认、稍后处理和静音的 run 状态都已移除。'
          : 'All acknowledged, snoozed, and muted run states were removed.',
      tone: 'info',
    })
  }, [])

  const navigateToPage = useCallback((page: DashboardPage) => {
    setActivePage(page)
  }, [])

  const focusTask = useCallback((taskId: string) => {
    const task = taskLookup.get(taskId)
    if (!task) {
      return
    }

    setSelectedTaskId(taskId)
    setSelectedRunId(task.runId)
    setSelectedApprovalId(null)
    setActivePage('operations')
  }, [taskLookup])

  const focusRun = useCallback((runId: string) => {
    setSelectedTaskId(taskByRunId.get(runId)?.id ?? null)
    setSelectedRunId(runId)
    setSelectedApprovalId(approvalQueue.find((approval) => approval.runId === runId)?.id ?? null)
    setActivePage('operations')
  }, [approvalQueue, taskByRunId])

  const focusRunWorkload = useCallback((runId: string) => {
    const task = taskByRunId.get(runId)
    if (task) {
      focusTask(task.id)
      return
    }

    focusRun(runId)
  }, [focusRun, focusTask, taskByRunId])

  const focusSession = useCallback((sessionId: string) => {
    const session = sessionLookup.get(sessionId)
    if (!session) {
      return
    }

    setSelectedApprovalId(null)
    setSelectedTaskId(session.currentRunId ? taskByRunId.get(session.currentRunId)?.id ?? null : null)
    setSelectedRunId(session.currentRunId ?? null)
    setActivePage(session.currentRunId ? 'operations' : 'agents')
    if (!session.currentRunId) {
      setSelectedAgentId(session.agentId)
    }
  }, [sessionLookup, taskByRunId])

  const focusApproval = useCallback((approvalId: string, runId?: string | null) => {
    setSelectedApprovalId(approvalId)
    setSelectedTaskId(runId ? taskByRunId.get(runId)?.id ?? null : null)
    if (runId) {
      setSelectedRunId(runId)
    }
    setActivePage('operations')
  }, [taskByRunId])

  const focusAgent = useCallback((agentId: string) => {
    setSelectedAgentId(agentId)
    setActivePage('agents')
  }, [])

  const focusEvent = useCallback((eventId: string) => {
    setSelectedEventId(eventId)
    setActivePage('activity')
  }, [])

  const selectedApproval = useMemo(
    () => (selectedApprovalId ? approvalLookup.get(selectedApprovalId) ?? null : null),
    [approvalLookup, selectedApprovalId],
  )

  const selectedRun = useMemo(
    () => (selectedRunId ? runLookup.get(selectedRunId) ?? null : null),
    [runLookup, selectedRunId],
  )

  const selectedTask = useMemo(
    () =>
      selectedTaskId
        ? taskLookup.get(selectedTaskId) ?? null
        : selectedRun
          ? taskByRunId.get(selectedRun.id) ?? null
          : null,
    [selectedRun, selectedTaskId, taskByRunId, taskLookup],
  )

  const selectedAgent = useMemo(
    () => (selectedRun ? agentLookup.get(selectedRun.agentId) ?? null : null),
    [agentLookup, selectedRun],
  )

  const selectedApprovalAgent = useMemo(
    () => (selectedApproval?.agentId ? agentLookup.get(selectedApproval.agentId) ?? null : null),
    [agentLookup, selectedApproval],
  )

  const selectedDetailAgent = selectedApprovalAgent ?? selectedAgent
  const selectedTaskProject = useMemo(
    () => (selectedTask ? projectLookup.get(selectedTask.projectId) ?? null : null),
    [projectLookup, selectedTask],
  )
  const selectedTaskSession = useMemo(
    () => (selectedTask ? sessionLookup.get(selectedTask.sessionKey) ?? null : null),
    [selectedTask, sessionLookup],
  )
  const selectedDetailSession = useMemo(() => {
    if (selectedTaskSession) {
      return selectedTaskSession
    }

    if (!selectedDetailAgent) {
      return null
    }

    return sessionLookup.get(deriveSessionDescriptorId(selectedDetailAgent.id)) ?? null
  }, [selectedDetailAgent, selectedTaskSession, sessionLookup])
  const selectedTaskPriorityDraft = selectedTask
    ? taskPriorityDrafts[selectedTask.id] ?? selectedTask.priority
    : 'normal'
  const selectedTaskPriorityPending = selectedTask
    ? pendingTaskPriorities[selectedTask.id] !== undefined
    : false
  const selectedTaskOwnerDraft = selectedTask
    ? taskOwnerDrafts[selectedTask.id] ?? selectedTask.owner ?? ''
    : ''
  const selectedTaskOwnerDraftTrimmed = selectedTaskOwnerDraft.trim()
  const selectedTaskAssignmentMode = selectedTask
    ? pendingTaskAssignments[selectedTask.id]
    : undefined
  const selectedTaskAssignmentPending = selectedTask
    ? selectedTaskAssignmentMode !== undefined
    : false
  const selectedTaskHandoffTargetDraft = selectedTask
    ? taskHandoffTargetDrafts[selectedTask.id] ?? selectedTask.handoffTarget ?? ''
    : ''
  const selectedTaskHandoffTargetDraftTrimmed = selectedTaskHandoffTargetDraft.trim()
  const selectedTaskHandoffNoteDraft = selectedTask
    ? taskHandoffNoteDrafts[selectedTask.id] ?? selectedTask.handoffNote ?? ''
    : ''
  const selectedTaskHandoffNoteDraftTrimmed = selectedTaskHandoffNoteDraft.trim()
  const selectedTaskHandoffMode = selectedTask
    ? pendingTaskHandoffs[selectedTask.id]
    : undefined
  const selectedTaskHandoffPending = selectedTask
    ? selectedTaskHandoffMode !== undefined
    : false
  const selectedTaskHandoffRequestDisabled = selectedTask
    ? selectedTaskHandoffPending ||
      !selectedTask.owner ||
      selectedTaskHandoffTargetDraftTrimmed.length === 0 ||
      selectedTaskHandoffTargetDraftTrimmed === selectedTask.owner ||
      (selectedTaskHandoffTargetDraftTrimmed === (selectedTask.handoffTarget ?? '') &&
        selectedTaskHandoffNoteDraftTrimmed === (selectedTask.handoffNote ?? ''))
    : true
  const selectedTaskHandoffCompletionDisabled = selectedTask
    ? selectedTaskHandoffPending || selectedTask.handoffTarget === null
    : true
  const selectedWorkspaceAgent = useMemo(
    () => (selectedAgentId ? agentLookup.get(selectedAgentId) ?? null : null),
    [agentLookup, selectedAgentId],
  )
  const selectedWorkspaceRun = useMemo(
    () =>
      selectedWorkspaceAgent?.currentRunId
        ? runLookup.get(selectedWorkspaceAgent.currentRunId) ?? null
        : null,
    [runLookup, selectedWorkspaceAgent],
  )
  const selectedWorkspaceTask = useMemo(
    () => (selectedWorkspaceRun ? taskByRunId.get(selectedWorkspaceRun.id) ?? null : null),
    [selectedWorkspaceRun, taskByRunId],
  )
  const selectedEvent = useMemo(
    () => (selectedEventId ? eventLookup.get(selectedEventId) ?? null : null),
    [eventLookup, selectedEventId],
  )
  const selectedEventAgent = useMemo(
    () => (selectedEvent ? agentLookup.get(selectedEvent.agentId) ?? null : null),
    [agentLookup, selectedEvent],
  )
  const selectedEventRun = useMemo(
    () => (selectedEvent?.runId ? runLookup.get(selectedEvent.runId) ?? null : null),
    [runLookup, selectedEvent],
  )
  const selectedEventTask = useMemo(
    () => (selectedEventRun ? taskByRunId.get(selectedEventRun.id) ?? null : null),
    [selectedEventRun, taskByRunId],
  )
  const selectedEventSession = useMemo(
    () =>
      selectedEvent?.sessionKey
        ? sessionLookup.get(selectedEvent.sessionKey) ?? null
        : selectedEventTask
          ? sessionLookup.get(selectedEventTask.sessionKey) ?? null
          : null,
    [selectedEvent, selectedEventTask, sessionLookup],
  )
  const selectedEventProject = useMemo(
    () =>
      selectedEvent?.projectId
        ? projectLookup.get(selectedEvent.projectId) ?? null
        : selectedEventTask
          ? projectLookup.get(selectedEventTask.projectId) ?? null
          : null,
    [projectLookup, selectedEvent, selectedEventTask],
  )

  const selectedRunTimeline = useMemo(
    () => {
      if (selectedApproval) {
        return allEvents
          .filter(
            (event) =>
              (selectedApproval.runId && event.runId === selectedApproval.runId) ||
              (selectedApproval.agentId &&
                event.agentId === selectedApproval.agentId &&
                event.type.startsWith('approval.')),
          )
          .slice(0, 8)
      }

      return selectedRun
        ? allEvents.filter((event) => event.runId === selectedRun.id).slice(0, 8)
        : []
    },
    [allEvents, selectedApproval, selectedRun],
  )

  useEffect(() => {
    if (selectedApprovalId && !approvalLookup.has(selectedApprovalId)) {
      setSelectedApprovalId(null)
    }
  }, [approvalLookup, selectedApprovalId])

  useEffect(() => {
    if (filteredAgents.length === 0) {
      if (selectedAgentId !== null) {
        setSelectedAgentId(null)
      }
      return
    }

    if (!selectedAgentId || !filteredAgents.some((agent) => agent.id === selectedAgentId)) {
      setSelectedAgentId(filteredAgents[0].id)
    }
  }, [filteredAgents, selectedAgentId])

  useEffect(() => {
    if (filteredEvents.length === 0) {
      if (selectedEventId !== null) {
        setSelectedEventId(null)
      }
      return
    }

    if (!selectedEventId || !filteredEvents.some((event) => event.id === selectedEventId)) {
      setSelectedEventId(filteredEvents[0].id)
    }
  }, [filteredEvents, selectedEventId])

  const selectedRunTriage = selectedApproval
    ? triageStore[selectedApproval.id] ?? null
    : selectedRun
      ? triageStore[selectedRun.id] ?? null
      : null
  const selectedRunIsApprovalCandidate = selectedApproval !== null
  const selectedApprovalResolveSupport = useMemo(
    () =>
      getApprovalResolveSupport(
        selectedApproval,
        selectedApproval?.platform === 'openclaw' ? openClawApprovalBridge : null,
      ),
    [openClawApprovalBridge, selectedApproval],
  )
  const selectedRunIsActionableApproval = selectedApprovalResolveSupport.supported
  const selectedRunActionSupport = useMemo(
    () => getRunActionSupport(selectedDetailAgent),
    [selectedDetailAgent],
  )
  const selectedAgentRuntimeActions = useMemo(
    () =>
      listAvailableAgentRuntimeActions(selectedDetailAgent).filter(
        (action) => action !== 'send_prompt',
      ),
    [selectedDetailAgent],
  )
  const selectedPrimaryRuntimeAction =
    selectedAgentRuntimeActions.length > 0 ? selectedAgentRuntimeActions[0] : null
  const selectedAgentRuntimeActionSupport = useMemo(
    () =>
      selectedPrimaryRuntimeAction
        ? getAgentRuntimeActionSupport(selectedDetailAgent, selectedPrimaryRuntimeAction)
        : null,
    [selectedDetailAgent, selectedPrimaryRuntimeAction],
  )
  const selectedAgentPromptSupport = useMemo(
    () => getAgentRuntimeActionSupport(selectedDetailAgent, 'send_prompt'),
    [selectedDetailAgent],
  )
  const selectedSessionAttachSupport = useMemo(
    () => getSessionTerminalAttachSupport(selectedDetailAgent, selectedDetailSession),
    [selectedDetailAgent, selectedDetailSession],
  )
  const selectedWorkspaceTimeline = useMemo(() => {
    if (!selectedWorkspaceAgent) {
      return []
    }

    return allEvents
      .filter(
        (event) =>
          event.agentId === selectedWorkspaceAgent.id ||
          (selectedWorkspaceRun ? event.runId === selectedWorkspaceRun.id : false),
      )
      .slice(0, 8)
  }, [allEvents, selectedWorkspaceAgent, selectedWorkspaceRun])
  const selectedWorkspaceCopilotSessionMetadata = useMemo(
    () => getCopilotSessionMetadata(selectedWorkspaceAgent),
    [selectedWorkspaceAgent],
  )
  const selectedWorkspaceRuntimeActions = useMemo(
    () =>
      listAvailableAgentRuntimeActions(selectedWorkspaceAgent).filter(
        (action) => action !== 'send_prompt',
      ),
    [selectedWorkspaceAgent],
  )
  const selectedWorkspacePrimaryRuntimeAction =
    selectedWorkspaceRuntimeActions.length > 0 ? selectedWorkspaceRuntimeActions[0] : null
  const selectedWorkspaceRuntimeActionSupport = useMemo(
    () =>
      selectedWorkspacePrimaryRuntimeAction
        ? getAgentRuntimeActionSupport(
            selectedWorkspaceAgent,
            selectedWorkspacePrimaryRuntimeAction,
          )
        : null,
    [selectedWorkspaceAgent, selectedWorkspacePrimaryRuntimeAction],
  )
  const selectedWorkspacePromptSupport = useMemo(
    () => getAgentRuntimeActionSupport(selectedWorkspaceAgent, 'send_prompt'),
    [selectedWorkspaceAgent],
  )
  const selectedWorkspaceRunActionSupport = useMemo(
    () => getRunActionSupport(selectedWorkspaceAgent),
    [selectedWorkspaceAgent],
  )
  const selectedEventTimeline = useMemo(() => {
    if (!selectedEvent) {
      return []
    }

    return allEvents
      .filter(
        (event) =>
          event.id !== selectedEvent.id &&
          (event.agentId === selectedEvent.agentId ||
            (selectedEvent.runId ? event.runId === selectedEvent.runId : false)),
      )
      .slice(0, 8)
  }, [allEvents, selectedEvent])
  const actionableApprovalCount = useMemo(
    () =>
      approvalQueue.filter((approval) =>
        getApprovalResolveSupport(
          approval,
          approval.platform === 'openclaw' ? openClawApprovalBridge : null,
        ).supported,
      ).length,
    [approvalQueue, openClawApprovalBridge],
  )
  const readOnlyApprovalCount = approvalQueue.length - actionableApprovalCount
  const pressuredResourceCount = useMemo(
    () =>
      resources.filter(
        (resource) =>
          resource.pressure === 'saturated' || resource.pressure === 'overcommitted',
      ).length,
    [resources],
  )
  const configuredResourceLimitCount = useMemo(
    () => resources.filter((resource) => resource.slotLimit !== null).length,
    [resources],
  )
  const selectedCopilotSessionMetadata = useMemo(
    () => getCopilotSessionMetadata(selectedDetailAgent),
    [selectedDetailAgent],
  )
  const visibleWorkspaceCount = useMemo(
    () => new Set(filteredAgents.map((agent) => agent.workspacePath)).size,
    [filteredAgents],
  )
  const visibleEventWorkspaceCount = useMemo(
    () =>
      new Set(
        filteredEvents
          .map((event) => agentLookup.get(event.agentId)?.workspacePath)
          .filter((path): path is string => Boolean(path)),
      ).size,
    [agentLookup, filteredEvents],
  )
  const attentionEventCount = useMemo(
    () => filteredEvents.filter((event) => needsAgentAttention(event.attention)).length,
    [filteredEvents],
  )
  const groupedAgents = useMemo(() => {
    const platformOrder: AgentPlatform[] = [
      'copilot-cli',
      'claude-code',
      'gemini-cli',
      'openclaw',
      'generic',
    ]

    return platformOrder
      .map((platform) => {
        const platformAgents = filteredAgents.filter((agent) => agent.platform === platform)
        if (platformAgents.length === 0) {
          return null
        }

        return {
          platform,
          label: humanizeToken(platform),
          agents: platformAgents,
          activeCount: platformAgents.filter((agent) => agent.currentRunId !== null).length,
          attentionCount: platformAgents.filter((agent) => needsAgentAttention(agent.attention))
            .length,
          healthyCount: platformAgents.filter((agent) => agent.health === 'healthy').length,
          workspaceCount: new Set(platformAgents.map((agent) => agent.workspacePath)).size,
        }
      })
      .filter(
        (
          group,
        ): group is {
          platform: AgentPlatform
          label: string
          agents: AgentDescriptor[]
          activeCount: number
          attentionCount: number
          healthyCount: number
          workspaceCount: number
        } => Boolean(group),
      )
  }, [filteredAgents])
  const overviewNextStep = useMemo(() => {
    if (supportActionableApprovalCount > 0) {
      return {
        page: 'operations' as DashboardPage,
        summaryLabel: isZh ? '操作台' : 'Operations',
        label: isZh ? '去操作台处理审批' : 'Review approvals in Operations',
        detail: isZh
          ? `${supportActionableApprovalCount} 个审批项已有真实本地处理路径，先清掉等待决策的全局队列。`
          : `${supportActionableApprovalCount} approvals already have a truthful local path, so clear that global queue first.`,
      }
    }

    if (activeRuns.length > 0) {
      return {
        page: 'operations' as DashboardPage,
        summaryLabel: isZh ? '操作台' : 'Operations',
        label: isZh ? '去操作台盯住活跃任务' : 'Track active tasks in Operations',
        detail: isZh
          ? `${activeRuns.length} 个任务仍在排队、运行或等待输入，最适合先回到操作台继续跟进。`
          : `${activeRuns.length} tasks are still queued, running, or waiting on input, so Operations is still the fastest path forward.`,
      }
    }

    if (supportAttentionAgents.length > 0) {
      return {
        page: 'agents' as DashboardPage,
        summaryLabel: isZh ? 'Agents' : 'Agents',
        label: isZh ? '去 Agents 处理运行时告警' : 'Inspect runtime alerts in Agents',
        detail: isZh
          ? `${supportAttentionAgents.length} 个 agent 正在请求关注，先处理健康与桥接问题。`
          : `${supportAttentionAgents.length} agents are requesting attention, so inspect health and bridge state next.`,
      }
    }

    if (supportAttentionEventCount > 0) {
      return {
        page: 'activity' as DashboardPage,
        summaryLabel: isZh ? '活动流' : 'Activity',
        label: isZh ? '去活动流查看最近告警' : 'Use Activity for recent alerts',
        detail: isZh
          ? `当前没有更高优先级的待处理项，但最近仍有 ${supportAttentionEventCount} 条需要留意的事件。`
          : `Nothing more urgent is waiting, but ${supportAttentionEventCount} recent event${supportAttentionEventCount === 1 ? '' : 's'} still deserve a quick check in Activity.`,
      }
    }

    return {
      page: 'references' as DashboardPage,
      summaryLabel: isZh ? '参考库' : 'References',
      label: isZh ? '去参考库规划下一步' : 'Plan the next move from References',
      detail: isZh
        ? '运行面当前比较平稳，可以回到参考库和路线图决定下一轮能力建设。'
        : 'The live surface is relatively calm, so use References to choose the next capability to build.',
    }
  }, [
    activeRuns.length,
    isZh,
    supportActionableApprovalCount,
    supportAttentionAgents.length,
    supportAttentionEventCount,
  ])
  const overviewGapCount =
    Number(missingRuntimes.length > 0) +
    Number(supportReadOnlyApprovalCount > 0) +
    Number(supportAttentionAgents.length > 0)
  const overviewGapItems = useMemo(() => {
    const items: string[] = []

    if (missingRuntimes.length > 0) {
      items.push(
        isZh
          ? `真实本地覆盖仍缺少 ${formatList(missingRuntimes)}。`
          : `Truthful local coverage is still missing for ${formatList(missingRuntimes)}.`,
      )
    }

    if (supportReadOnlyApprovalCount > 0) {
      items.push(
        isZh
          ? `${supportReadOnlyApprovalCount} 个审批项仍然只读，暂时不能在 Hub 内直接处理。`
          : `${supportReadOnlyApprovalCount} approvals are still read-only and cannot be resolved directly in the hub yet.`,
      )
    }

    if (supportAttentionAgents.length > 0) {
      items.push(
        isZh
          ? `${supportAttentionAgents.length} 个 agent 处于需要关注状态，需要继续排查 runtime 或桥接。`
          : `${supportAttentionAgents.length} agents are in an attention state and still need runtime or bridge follow-up.`,
      )
    }

    if (items.length === 0) {
      items.push(
        isZh
          ? '当前没有明显覆盖缺口；下一轮可以优先补强复用与产品化能力。'
          : 'No obvious coverage gaps are visible right now; the next pass can focus on reuse and productization.',
      )
    }

    return items
  }, [isZh, missingRuntimes, supportAttentionAgents.length, supportReadOnlyApprovalCount])
  const taskLayerPreviewItems = useMemo(() => {
    const items = [
      isZh
        ? `当前范围内有 ${filteredProjects.length} 个项目、${filteredSessions.length} 个会话、${filteredTasks.length} 个投影任务。`
        : `${filteredProjects.length} project${filteredProjects.length === 1 ? '' : 's'}, ${filteredSessions.length} session${filteredSessions.length === 1 ? '' : 's'}, and ${filteredTasks.length} projected task${filteredTasks.length === 1 ? '' : 's'} are visible in the current scope.`,
      isZh
        ? `${filteredActiveTasks.length} 个任务仍在活跃中，${filteredWaitingTasks.length} 个任务处于等待、暂停或阻塞状态。`
        : `${filteredActiveTasks.length} task${filteredActiveTasks.length === 1 ? '' : 's'} are still active, and ${filteredWaitingTasks.length} task${filteredWaitingTasks.length === 1 ? '' : 's'} are waiting, paused, or blocked.`,
    ]

    const topTasks = filteredTasks.slice(0, 3)
    if (topTasks.length === 0) {
      items.push(
        isZh
          ? '当前还没有可见任务；这通常表示当前范围内没有活跃 run，或者筛选条件过窄。'
          : 'No projected tasks are visible right now; that usually means there are no in-scope runs or the current filters are too narrow.',
      )
      return items
    }

    for (const task of topTasks) {
      const sessionName = sessionLookup.get(task.sessionKey)?.name
      const projectName =
        projectLookup.get(task.projectId)?.name ?? getWorkspaceLabel(task.workspacePath)
      items.push(
        isZh
          ? `任务：${task.title} · 项目 ${projectName}${sessionName ? ` · 会话 ${sessionName}` : ''}`
          : `Task: ${task.title} · Project ${projectName}${sessionName ? ` · Session ${sessionName}` : ''}`,
      )
    }

    return items
  }, [
    filteredActiveTasks.length,
    filteredProjects.length,
    filteredSessions.length,
    filteredTasks,
    filteredWaitingTasks.length,
    isZh,
    projectLookup,
    sessionLookup,
  ])
  const groupedReferences = useMemo(
    () =>
      REFERENCE_CATEGORY_ORDER.map((category) => ({
        category,
        references: references.filter((reference) => reference.category === category),
      })).filter((group) => group.references.length > 0),
    [references],
  )
  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    workspaceFilter !== 'all' ||
    platformFilter !== 'all' ||
    attentionFilter !== 'all'

  const summaryCards = [
    {
      label: isZh ? '审批队列' : 'Approval queue',
      value: String(approvalQueue.length),
      meta:
        approvalQueue.length === 0
          ? hiddenTriagedApprovalCount > 0
            ? isZh
              ? `有 ${hiddenTriagedApprovalCount} 个审批项已被本地分诊。`
              : `${hiddenTriagedApprovalCount} approval item${hiddenTriagedApprovalCount === 1 ? '' : 's'} triaged locally.`
            : isZh
              ? '当前没有等待操作者处理的审批事项。'
              : 'No approvals are waiting on an operator.'
          : readOnlyApprovalCount > 0
            ? isZh
              ? `${actionableApprovalCount} 个可直接处理，${readOnlyApprovalCount} 个仍为只读。`
              : `${actionableApprovalCount} actionable, ${readOnlyApprovalCount} still read-only.`
            : hiddenTriagedApprovalCount > 0
            ? isZh
              ? `有 ${hiddenTriagedApprovalCount} 个已分诊审批项被本地隐藏。`
              : `${hiddenTriagedApprovalCount} triaged approval item${hiddenTriagedApprovalCount === 1 ? '' : 's'} hidden locally.`
            : isZh
              ? `${approvalQueue.length} 个审批项正等待真实本地决策。`
              : `${approvalQueue.length} approval item${approvalQueue.length === 1 ? '' : 's'} await a truthful local decision.`,
      tone: approvalQueue.length > 0 ? 'warning' : 'success',
    },
    {
      label: isZh ? '可见活跃运行' : 'Visible active runs',
      value: String(filteredActiveRuns.length),
      meta:
        hasActiveFilters && filteredActiveRuns.length !== activeRuns.length
          ? isZh
            ? `当前展示 ${activeRuns.length} 个活跃 run 中的 ${filteredActiveRuns.length} 个。`
            : `Showing ${filteredActiveRuns.length} of ${activeRuns.length} active runs.`
          : filteredActiveRuns.length === 0
            ? isZh
              ? '当前没有正在进行的工作。'
              : 'No work is currently in flight.'
            : isZh
              ? `${filteredActiveRuns.length} 个 run 正处于排队、运行或暂停中。`
              : `${filteredActiveRuns.length} runs are queued, running, or paused.`,
      tone: filteredActiveRuns.length > 0 ? 'info' : 'neutral',
    },
    {
      label: isZh ? '可见 agents' : 'Visible agents',
      value:
        filteredAgents.length > 0
          ? `${healthyAgents.length}/${filteredAgents.length}`
          : '0/0',
      meta:
        attentionAgents.length === 0
          ? isZh
            ? '当前视图内没有 agent 健康告警。'
            : 'No agent health alerts in the current view.'
          : isZh
            ? `${attentionAgents.length} 个 agent 正在请求关注。`
            : `${attentionAgents.length} agents are requesting attention.`,
      tone: attentionAgents.length > 0 ? 'warning' : 'success',
    },
    {
      label: isZh ? '任务层视角' : 'Task layer',
      value: `${filteredProjects.length}/${filteredSessions.length}/${filteredTasks.length}`,
      meta: isZh
        ? `项目 / 会话 / 任务只读投影，当前有 ${filteredActiveTasks.length} 个活跃任务。`
        : `Read-only project / session / task projection with ${filteredActiveTasks.length} active task${filteredActiveTasks.length === 1 ? '' : 's'} in scope.`,
      tone: filteredActiveTasks.length > 0 ? 'info' : 'neutral',
    },
    {
      label: isZh ? '实时 Copilot' : 'Live Copilot',
      value:
        !health || !health.copilotSessionDiscoveryEnabled || liveCopilotSessions.length === 0
          ? String(liveCopilotSessions.length)
          : describeRuntimeDiagnosticValue(
              liveCopilotSessions.length,
              { zh: '会话', en: 'session' },
              copilotRuntimeIssue,
            ),
      meta: !health
        ? isZh
          ? '等待 runtime 健康信息...'
          : 'Waiting for runtime health details.'
        : !health.copilotSessionDiscoveryEnabled
          ? isZh
            ? '本地 Copilot 发现当前已关闭。'
            : 'Local Copilot discovery is currently disabled.'
          : liveCopilotSessions.length === 0
            ? isZh
              ? '发现已开启，但当前没有看到活跃的本地 Copilot session。'
              : 'Discovery is enabled but no active local session is visible right now.'
            : copilotRuntimeIssue.kind === 'healthy'
              ? isZh
                ? `当前可见 ${liveCopilotSessions.length} 个真实 Copilot session。`
                : `${liveCopilotSessions.length} truthful Copilot session${liveCopilotSessions.length === 1 ? '' : 's'} are visible.`
              : describeRuntimeIssueDetail({
                  runtimeLabel: 'Copilot CLI',
                  visibleCount: liveCopilotSessions.length,
                  unit: { zh: '会话', en: 'session' },
                  issue: copilotRuntimeIssue,
                  authLabel: { zh: 'Copilot 本机认证', en: 'local Copilot auth' },
                }),
      tone: !health
        ? 'neutral'
        : !health.copilotSessionDiscoveryEnabled
          ? 'danger'
          : liveCopilotSessions.length === 0
            ? 'info'
            : copilotRuntimeIssue.kind === 'healthy'
              ? 'success'
              : 'warning',
    },
    {
      label: isZh ? '实时更新' : 'Live updates',
      value: humanizeToken(socketStatus),
      meta:
        lastSyncedAt !== null
          ? isZh
            ? `最近同步于 ${formatRelativeTime(lastSyncedAt)}。`
            : `Last sync ${formatRelativeTime(lastSyncedAt)}.`
          : isZh
            ? '等待首次快照...'
            : 'Waiting for the first snapshot.',
    tone: getSocketTone(socketStatus),
  },
  ] satisfies Array<{
    label: string
    value: string
    meta: string
    tone: StatusTone
  }>
  const supportSummaryCards = [
    {
      label: isZh ? '审批队列' : 'Approval queue',
      value: String(approvals.length),
      meta:
        approvals.length === 0
          ? isZh
            ? '当前没有等待操作者处理的审批事项。'
            : 'No approvals are waiting on an operator.'
          : supportReadOnlyApprovalCount > 0
            ? isZh
              ? `${supportActionableApprovalCount} 个可直接处理，${supportReadOnlyApprovalCount} 个仍为只读。`
              : `${supportActionableApprovalCount} actionable, ${supportReadOnlyApprovalCount} still read-only.`
            : isZh
              ? `${approvals.length} 个审批项正等待真实本地决策。`
              : `${approvals.length} approval item${approvals.length === 1 ? '' : 's'} await a truthful local decision.`,
      tone: approvals.length > 0 ? 'warning' : 'success',
    },
    {
      label: isZh ? '活跃运行' : 'Active runs',
      value: String(activeRuns.length),
      meta:
        activeRuns.length === 0
          ? isZh
            ? '当前没有正在进行的工作。'
            : 'No work is currently in flight.'
          : isZh
            ? `${activeRuns.length} 个 run 正处于排队、运行或暂停中。`
            : `${activeRuns.length} runs are queued, running, or paused.`,
      tone: activeRuns.length > 0 ? 'info' : 'neutral',
    },
    {
      label: isZh ? '全部 agents' : 'All agents',
      value: agents.length > 0 ? `${supportHealthyAgents.length}/${agents.length}` : '0/0',
      meta:
        supportAttentionAgents.length === 0
          ? isZh
            ? '当前整体没有 agent 健康告警。'
            : 'No agent health alerts are visible overall.'
          : isZh
            ? `${supportAttentionAgents.length} 个 agent 正在请求关注。`
            : `${supportAttentionAgents.length} agents are requesting attention.`,
      tone: supportAttentionAgents.length > 0 ? 'warning' : 'success',
    },
    summaryCards[3],
    summaryCards[4],
  ] satisfies Array<{
    label: string
    value: string
    meta: string
    tone: StatusTone
  }>

  const prioritySummaryCards = [
    summaryCards[0],
    summaryCards[1],
    summaryCards[2],
    summaryCards[4] ?? summaryCards[summaryCards.length - 1],
  ].filter((card): card is (typeof summaryCards)[number] => Boolean(card))

  const isSupportPage = activePage === 'overview' || activePage === 'references'
  const pageDefinitions = useMemo<DashboardPageDefinition[]>(
    () => [
      {
        id: 'operations',
        label: isZh ? '操作台' : 'Operations',
        description: isZh
          ? '默认工作台：先分诊，再审查，最后执行真实可用动作。'
          : 'Default workspace for triage, inspection, and truthful operator actions.',
        badge:
          (isSupportPage ? supportActionableApprovalCount : actionableApprovalCount) > 0
            ? String(isSupportPage ? supportActionableApprovalCount : actionableApprovalCount)
            : undefined,
      },
      {
        id: 'agents',
        label: isZh ? 'Agents' : 'Agents',
        description: isZh
          ? '按 runtime 分组浏览本地 agents，并在 inspector 中执行真实可用动作。'
          : 'Browse local agents by runtime and inspect the truthful actions available for each one.',
        badge:
          (isSupportPage ? agents.length : filteredAgents.length) > 0
            ? String(isSupportPage ? agents.length : filteredAgents.length)
            : undefined,
      },
      {
        id: 'activity',
        label: isZh ? '活动流' : 'Activity',
        description: isZh
          ? '按时间查看最近事件和状态变化。'
          : 'Review the latest event stream and state changes.',
        badge:
          (isSupportPage ? Math.min(allEvents.length, VISIBLE_EVENT_LIMIT) : filteredEvents.length) >
          0
            ? String(
                isSupportPage
                  ? Math.min(allEvents.length, VISIBLE_EVENT_LIMIT)
                  : filteredEvents.length,
              )
            : undefined,
      },
      {
        id: 'overview',
        label: isZh ? '总览' : 'Overview',
        description: isZh
          ? '轻量查看整体态势、覆盖缺口和下一步去向。'
          : 'Lightweight posture view for attention, coverage gaps, and where to continue.',
      },
      {
        id: 'references',
        label: isZh ? '参考库' : 'References',
        description: isZh
          ? '查看本地接入路径、值得复用的上游项目，以及下一阶段能力路线。'
          : 'Browse local integration routes, upstream tools worth reusing, and the next capability roadmap.',
      },
    ],
    [
      actionableApprovalCount,
      activePage,
      agents.length,
      allEvents.length,
      filteredAgents.length,
      filteredEvents.length,
      isSupportPage,
      isZh,
      supportActionableApprovalCount,
    ],
  )

  const showExpandedHeader = activePage === 'overview'
  const showGlobalPosture = false

  return (
    <div className="dashboard-shell">
      <header className={`app-header${showExpandedHeader ? '' : ' app-header--compact'}`}>
        <div className="app-header__copy">
          <span className="eyebrow">
            {isZh ? '本地优先控制平面' : 'Local-first control plane'}
          </span>
          <div className="app-header__title-row">
            <h1>Agent Hub</h1>
            <StatusPill
              tone={
                !health
                  ? 'neutral'
                  : health.mockRuntimeEnabled
                    ? 'warning'
                    : 'success'
              }
            >
              {!health
                ? isZh
                  ? '运行态加载中'
                  : 'Runtime loading'
                : health.mockRuntimeEnabled
                  ? isZh
                    ? '演示模式'
                    : 'Demo mode'
                  : isZh
                    ? '真实本地'
                    : 'Live local'}
            </StatusPill>
          </div>
          {showExpandedHeader ? (
            <p className="subtitle">
              {isZh
                ? '在一个紧凑工作台里分诊待处理事项、审查运行上下文，并只呈现真实可执行的本地动作。'
                : 'Triage blocked work, inspect live local runtime context, and surface only the actions that are truthfully available.'}
            </p>
          ) : null}
        </div>

        <div className="app-header__meta">
          <div className="language-toggle" role="group" aria-label={isZh ? '语言切换' : 'Language switch'}>
            <button
              className={`language-toggle__button${language === 'en' ? ' language-toggle__button--active' : ''}`}
              onClick={() => {
                setLanguage('en')
              }}
              type="button"
            >
              EN
            </button>
            <button
              className={`language-toggle__button${language === 'zh' ? ' language-toggle__button--active' : ''}`}
              onClick={() => {
                setLanguage('zh')
              }}
              type="button"
            >
              中文
            </button>
          </div>
          <StatusPill tone={getSocketTone(socketStatus)}>
            {socketStatus === 'open'
              ? isZh
                ? 'WebSocket 已连接'
                : 'WebSocket live'
              : `WebSocket ${humanizeToken(socketStatus).toLowerCase()}`}
          </StatusPill>
          <button
            className="ghost-button"
            onClick={() => {
              void loadDashboard({ silent: true })
            }}
            disabled={loading || refreshing}
          >
            {refreshing ? (isZh ? '刷新中…' : 'Refreshing…') : isZh ? '刷新快照' : 'Refresh snapshot'}
          </button>
        </div>
      </header>

      <div className={`workspace-frame${isSupportPage ? ' workspace-frame--support' : ''}`}>
        {!isSupportPage ? (
          <aside className="workspace-sidebar">
            <PageNavigation
              activePage={activePage}
              pages={pageDefinitions}
              onNavigate={navigateToPage}
            />
          </aside>
        ) : null}

        <main className="workspace-main">
          {isSupportPage ? (
            <SupportTopNavigation
              activePage={activePage}
              pages={pageDefinitions}
              onNavigate={navigateToPage}
            />
          ) : null}

          {isSupportPage && (hasActiveFilters || showTriaged) ? (
            <div className="banner banner--warning" role="status">
              <div>
                <strong>
                  {isZh
                    ? '工作区筛选仍然处于启用状态'
                    : 'Workspace filters are still active'}
                </strong>
                <p>
                  {isZh
                    ? '当前总览和参考页显示的是全局态势；如果打开操作台、Agents 或活动流，仍会沿用现有 search、workspace、runtime、attention 与本地分诊状态。'
                    : 'Overview and References now show global posture, but Operations, Agents, and Activity will still preserve the current search, workspace, runtime, attention, and local triage state.'}
                </p>
              </div>
              <button
                className="ghost-button ghost-button--light"
                type="button"
                onClick={resetFilters}
              >
                {isZh ? '清空筛选' : 'Clear filters'}
              </button>
            </div>
          ) : null}

          {showGlobalPosture ? (
            <section
              className="priority-strip"
              aria-label={isZh ? '优先态势' : 'Priority posture'}
            >
              <div className="priority-strip__metrics">
                {prioritySummaryCards.map((card) => (
                  <article
                    key={card.label}
                    className={`priority-metric priority-metric--${card.tone}`}
                  >
                    <span>{card.label}</span>
                    <strong>{card.value}</strong>
                    <p>{card.meta}</p>
                  </article>
                ))}
              </div>

              <div className="priority-strip__runtimes">
                {runtimeDiagnostics.map((diagnostic) => (
                  <article
                    key={diagnostic.label}
                    className={`priority-runtime priority-runtime--${diagnostic.tone}`}
                  >
                    <div className="priority-runtime__header">
                      <span>{diagnostic.label}</span>
                      <StatusPill tone={diagnostic.tone}>{diagnostic.value}</StatusPill>
                    </div>
                    <p>{diagnostic.detail}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {error ? (
            <div className="banner banner--error" role="alert">
              <div>
                <strong>{isZh ? '仪表盘同步异常' : 'Dashboard sync issue'}</strong>
                <p>{error}</p>
              </div>
              <button
                className="ghost-button ghost-button--light"
                onClick={() => {
                  void loadDashboard()
                }}
              >
                {isZh ? '立即重试' : 'Retry now'}
              </button>
            </div>
          ) : null}

          {operatorNotice ? (
            <div
              className={`banner ${getNoticeBannerClass(operatorNotice.tone)}`}
              role="status"
            >
              <div>
                <strong>{operatorNotice.title}</strong>
                <p>{operatorNotice.message}</p>
              </div>
            </div>
          ) : null}

          {health && showGlobalPosture ? (
            <div
              className={`banner ${health.mockRuntimeEnabled ? 'banner--warning' : 'banner--info'}`}
              role="status"
            >
              <div>
                <strong>
                  {health.mockRuntimeEnabled
                    ? isZh
                      ? '当前为演示模式'
                      : 'Demo mode is active'
                    : isZh
                      ? '当前为真实运行模式'
                      : 'Live runtime mode is active'}
                </strong>
                <p>
                  {health.mockRuntimeEnabled
                    ? isZh
                      ? '当前正在显示 seeded demo sessions。关闭 AGENT_HUB_ENABLE_MOCK_RUNTIME 后可只保留真实 runtime 数据。'
                      : 'Seeded demo sessions are being shown. Disable AGENT_HUB_ENABLE_MOCK_RUNTIME to use truthful runtime data only.'
                    : isZh
                      ? `Mock 数据已关闭。当前已从本地 session-state 锁中发现 ${liveCopilotSessions.length} 个 Copilot session。${missingRuntimes.length === 0 ? '所有目标 runtime 都已可见。' : `目前仍缺少 ${formatList(missingRuntimes)} 的真实覆盖。`}`
                      : `Mock data is disabled. ${liveCopilotSessions.length} live Copilot session${liveCopilotSessions.length === 1 ? '' : 's'} currently discovered from local session-state locks.${missingRuntimes.length === 0 ? ' All target local runtimes are now visible.' : ` Still missing truthful coverage for ${formatList(missingRuntimes)}.`}`}
                </p>
              </div>
            </div>
          ) : null}

      {activePage === 'overview' ? (
        <>
          <section className="panel overview-toolbar">
              <PanelHeader
                title={isZh ? '总览' : 'Overview'}
                subtitle={
                isZh
                  ? '快速查看当前态势、覆盖缺口和建议入口。'
                  : 'Compact posture, coverage gaps, and the best next route.'
              }
              />

              <div className="control-stats overview-summary-strip">
                <div className="control-stat">
                <span>{isZh ? '推荐入口' : 'Suggested route'}</span>
                <strong>{overviewNextStep.summaryLabel}</strong>
              </div>
              <div className="control-stat">
                <span>{isZh ? '覆盖缺口' : 'Coverage gaps'}</span>
                <strong>{overviewGapCount}</strong>
              </div>
                <div className="control-stat">
                  <span>{isZh ? '只读审批' : 'Read-only approvals'}</span>
                  <strong>{supportReadOnlyApprovalCount}</strong>
                </div>
              </div>
            </section>

            <div className="overview-workspace">
              <div className="overview-pane overview-pane--metrics">
                <section className="summary-grid" aria-label="Overview summary">
                  {supportSummaryCards.map((card) => (
                    <StatCard
                      key={card.label}
                      label={card.label}
                    value={card.value}
                    meta={card.meta}
                    tone={card.tone}
                  />
                ))}
              </section>

              <section
                className="diagnostic-grid"
                aria-label={isZh ? '运行时覆盖诊断' : 'Runtime coverage diagnostics'}
              >
                {runtimeDiagnostics.map((diagnostic) => (
                  <DiagnosticCard key={diagnostic.label} {...diagnostic} />
                ))}
              </section>

              <section className="panel overview-resource-panel">
                <PanelHeader
                  title={isZh ? '资源层态势' : 'Resource posture'}
                  subtitle={
                    isZh
                      ? '先把每条 runtime 的容量、占用和压力看清楚；这是资源治理的基础，不是假装已经有 scheduler。'
                      : 'Read each runtime’s capacity, occupancy, and pressure clearly first; this is resource governance groundwork, not a fake scheduler.'
                  }
                  count={pressuredResourceCount}
                />

                {resources.length === 0 ? (
                  <EmptyState
                    title={isZh ? '暂时没有资源数据' : 'No resource data yet'}
                    description={
                      isZh
                        ? '资源层会随着快照一起出现；如果当前 server 还没升级，继续刷新即可。'
                        : 'Resource descriptors travel with the dashboard snapshot; keep refreshing if the current server has not upgraded yet.'
                    }
                  />
                ) : (
                  <>
                    <div className="resource-card-grid">
                      {resources.map((resource) => (
                        <article
                          key={resource.id}
                          className={`resource-card resource-card--${getResourcePressureTone(resource.pressure)}`}
                        >
                          <div className="resource-card__header">
                            <div>
                              <h3>{humanizeToken(resource.platform)}</h3>
                              <p>{describeResourceUtilization(resource)}</p>
                            </div>
                            <div className="pill-row">
                              <StatusPill tone={getResourcePressureTone(resource.pressure)}>
                                {describeResourcePressure(resource.pressure)}
                              </StatusPill>
                              <StatusPill tone={getHealthTone(resource.health)}>
                                {humanizeToken(resource.health)}
                              </StatusPill>
                            </div>
                          </div>

                          <dl className="meta-grid resource-card__meta">
                            <div>
                              <dt>{isZh ? '槽位策略' : 'Slot policy'}</dt>
                              <dd>{describeResourceSlotLimit(resource.slotLimit)}</dd>
                            </div>
                            <div>
                              <dt>{isZh ? '可用槽位' : 'Available slots'}</dt>
                              <dd>
                                {resource.availableSlots === null ? '—' : resource.availableSlots}
                              </dd>
                            </div>
                            <div>
                              <dt>{isZh ? '等待任务' : 'Waiting tasks'}</dt>
                              <dd>{resource.waitingTaskCount}</dd>
                            </div>
                            <div>
                              <dt>{isZh ? '项目 / 会话' : 'Projects / sessions'}</dt>
                              <dd>
                                {resource.projectCount} / {resource.sessionCount}
                              </dd>
                            </div>
                          </dl>
                        </article>
                      ))}
                    </div>

                    <p className="muted-text">
                      {isZh
                        ? `当前共有 ${configuredResourceLimitCount} 条显式槽位策略，${pressuredResourceCount} 条 runtime 处于饱和或超载。`
                        : `${configuredResourceLimitCount} explicit slot policies are configured, and ${pressuredResourceCount} runtimes are currently saturated or overcommitted.`}
                    </p>
                  </>
                )}
              </section>
            </div>

            <section className="panel panel--accent overview-pane overview-pane--brief">
              <PanelHeader
                title={isZh ? '下一步怎么推进' : 'Where to continue'}
                subtitle={
                  isZh
                    ? '先看建议入口，再看仍未补齐的覆盖缺口。'
                    : 'Start with the suggested route, then scan the remaining coverage gaps.'
                }
                count={overviewGapCount}
              />

              <div className="overview-note-stack">
                <article className="overview-note">
                  <span className="inspector-label">
                    {isZh ? '推荐入口' : 'Suggested route'}
                  </span>
                  <h3>{overviewNextStep.label}</h3>
                  <p>{overviewNextStep.detail}</p>
                  <div className="action-group">
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => {
                        navigateToPage(overviewNextStep.page)
                      }}
                    >
                      {isZh ? '打开推荐视图' : 'Open suggested view'}
                    </button>
                  </div>
                </article>

                <article className="overview-note">
                  <span className="inspector-label">
                    {isZh ? '覆盖缺口' : 'Coverage gaps'}
                  </span>
                  <ul className="overview-list">
                    {overviewGapItems.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>

                <article className="overview-note">
                  <span className="inspector-label">
                    {isZh ? '任务层试运行' : 'Task layer preview'}
                  </span>
                  <h3>
                    {isZh
                      ? '先按 project / session / task 看控制面'
                      : 'Start reading the control plane as projects / sessions / tasks'}
                  </h3>
                  <p>
                    {isZh
                      ? '这一层目前还是只读投影：它基于现有 runs、agents 和事件流聚合，不会假装自己已经是完整调度器。'
                      : 'This layer is read-only for now: it is projected from the current runs, agents, and event stream instead of pretending to be a full scheduler already.'}
                  </p>
                  <ul className="overview-list">
                    {taskLayerPreviewItems.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>
              </div>
            </section>
          </div>
        </>
      ) : null}

      {activePage === 'operations' ? (
        <>
          <section className="panel operations-toolbar">
            <PanelHeader
            title={isZh ? '操作台' : 'Operations'}
            subtitle={
              isZh
                ? '先处理审批和待关注 run，再进入详情与次级看板；筛选只负责收窄当前工作面。'
                : 'Handle approvals and attention runs first, then drill into detail and secondary boards; filters only narrow the current workspace.'
            }
            count={approvalQueue.length + visibleInbox.length}
          />

          <div className="control-grid">
            <label className="control-field">
              <span>{isZh ? '搜索' : 'Search'}</span>
              <input
                className="control-input"
                type="search"
                value={searchQuery}
                placeholder={
                  isZh ? '搜索 runs、agents 或 workspaces' : 'Search runs, agents, or workspaces'
                }
                onChange={(event) => {
                  setSearchQuery(event.target.value)
                }}
              />
            </label>

            <label className="control-field">
              <span>{isZh ? '工作区' : 'Workspace'}</span>
              <select
                className="control-input control-select"
                value={workspaceFilter}
                onChange={(event) => {
                  setWorkspaceFilter(event.target.value)
                }}
              >
                <option value="all">{isZh ? '全部工作区' : 'All workspaces'}</option>
                {workspaceOptions.map((workspace) => (
                  <option key={workspace.path} value={workspace.path}>
                    {workspace.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="control-field">
              <span>{isZh ? '运行时' : 'Runtime'}</span>
              <select
                className="control-input control-select"
                value={platformFilter}
                onChange={(event) => {
                  setPlatformFilter(event.target.value as PlatformFilterValue)
                }}
              >
                <option value="all">{isZh ? '全部运行时' : 'All runtimes'}</option>
                <option value="copilot-cli">Copilot CLI</option>
                <option value="claude-code">Claude Code</option>
                <option value="gemini-cli">Gemini CLI</option>
                <option value="openclaw">OpenClaw</option>
                <option value="generic">{isZh ? '通用接入' : 'Generic ingest'}</option>
              </select>
            </label>

            <label className="control-field">
              <span>{isZh ? '关注级别' : 'Attention'}</span>
              <select
                className="control-input control-select"
                value={attentionFilter}
                onChange={(event) => {
                  setAttentionFilter(event.target.value as AttentionFilterValue)
                }}
              >
                <option value="all">{isZh ? '全部关注状态' : 'All attention states'}</option>
                <option value="needs_attention">{isZh ? '需要关注' : 'Needs attention'}</option>
                <option value="urgent">{isZh ? '紧急' : 'Urgent'}</option>
                <option value="action_needed">
                  {isZh ? '需要动作' : 'Action needed'}
                </option>
                <option value="info">{isZh ? '信息提示' : 'Informational'}</option>
                <option value="silent">{isZh ? '静默' : 'Silent'}</option>
              </select>
            </label>
          </div>

          <div className="control-footer">
            <div className="control-actions">
              <button
                className={`toggle-button${showTriaged ? ' toggle-button--active' : ''}`}
                onClick={() => {
                  setShowTriaged((current) => !current)
                }}
                type="button"
              >
                {showTriaged
                  ? isZh
                    ? '显示已分诊审批项'
                    : 'Showing triaged approvals'
                  : isZh
                    ? '隐藏已分诊审批项'
                    : 'Hide triaged approvals'}
              </button>
              <button
                className="ghost-button ghost-button--compact"
                onClick={resetFilters}
                type="button"
              >
                {isZh ? '重置筛选' : 'Reset filters'}
              </button>
              <button
                className="ghost-button ghost-button--compact"
                onClick={clearAllTriage}
                type="button"
                disabled={Object.keys(triageStore).length === 0}
              >
                {isZh ? '清空本地分诊' : 'Clear local triage'}
              </button>
            </div>

            <div className="operations-toolbar__summary">
              <div className="operations-toolbar__summary-copy">
                <div className="pill-row">
                  <StatusPill tone={actionableApprovalCount > 0 ? 'warning' : 'neutral'}>
                    {isZh
                      ? `${actionableApprovalCount} 个可处理审批`
                      : `${actionableApprovalCount} actionable approval${actionableApprovalCount === 1 ? '' : 's'}`}
                  </StatusPill>
                  <StatusPill tone={visibleInbox.length > 0 ? 'info' : 'neutral'}>
                    {isZh
                      ? `${visibleInbox.length} 个待关注 run`
                      : `${visibleInbox.length} run${visibleInbox.length === 1 ? '' : 's'} in inbox`}
                  </StatusPill>
                  <StatusPill tone={pressuredResourceCount > 0 ? 'danger' : 'neutral'}>
                    {isZh
                      ? `${pressuredResourceCount} 条高压 runtime`
                      : `${pressuredResourceCount} pressured runtime${pressuredResourceCount === 1 ? '' : 's'}`}
                  </StatusPill>
                  {hiddenTriagedApprovalCount > 0 ? (
                    <StatusPill tone="info">
                      {isZh
                        ? `${hiddenTriagedApprovalCount} 个已分诊审批项`
                        : `${hiddenTriagedApprovalCount} triaged approval${hiddenTriagedApprovalCount === 1 ? '' : 's'}`}
                    </StatusPill>
                  ) : null}
                  {readOnlyApprovalCount > 0 ? (
                    <StatusPill tone="warning">
                      {isZh
                        ? `${readOnlyApprovalCount} 个只读审批`
                        : `${readOnlyApprovalCount} read-only approval${readOnlyApprovalCount === 1 ? '' : 's'}`}
                    </StatusPill>
                  ) : null}
                </div>
                <p className="muted-text">
                  {isZh
                    ? `当前可见 ${filteredSessions.length} 个会话、${filteredTasks.length} 个任务、${filteredProjects.length} 个项目。`
                    : `${filteredSessions.length} sessions, ${filteredTasks.length} tasks, and ${filteredProjects.length} projects remain visible in the current scope.`}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section
          className={`panel operations-resource-strip${showOperationsResourceStrip ? ' operations-resource-strip--expanded' : ' operations-resource-strip--collapsed'}`}
        >
          <div className="operations-resource-strip__summary">
            <div>
              <span className="inspector-label">
                {isZh ? '次级管理面' : 'Secondary management surface'}
              </span>
              <h3>{isZh ? '运行时容量策略' : 'Runtime capacity policy'}</h3>
              <p className="muted-text">
                {resources.length === 0
                  ? isZh
                    ? '当前还没有资源描述，因此这里只保留入口位。'
                    : 'No resource descriptors are available yet, so this stays as a reserved secondary surface.'
                  : isZh
                    ? `当前共有 ${configuredResourceLimitCount} 条显式槽位策略，${pressuredResourceCount} 条 runtime 处于高压状态。`
                    : `${configuredResourceLimitCount} explicit slot caps are configured, and ${pressuredResourceCount} runtimes are under pressure.`}
              </p>
            </div>
            <div className="operations-resource-strip__actions">
              <div className="pill-row">
                <StatusPill tone={pressuredResourceCount > 0 ? 'danger' : 'neutral'}>
                  {isZh
                    ? `${pressuredResourceCount} 条高压`
                    : `${pressuredResourceCount} pressured`}
                </StatusPill>
                <StatusPill tone={configuredResourceLimitCount > 0 ? 'info' : 'neutral'}>
                  {isZh
                    ? `${configuredResourceLimitCount} 条已设上限`
                    : `${configuredResourceLimitCount} caps set`}
                </StatusPill>
              </div>
              <button
                className={`toggle-button${showOperationsResourceStrip ? ' toggle-button--active' : ''}`}
                type="button"
                onClick={() => {
                  setShowOperationsResourceStrip((current) => !current)
                }}
              >
                {showOperationsResourceStrip
                  ? isZh
                    ? '收起容量策略'
                    : 'Hide capacity policy'
                  : isZh
                    ? '展开容量策略'
                    : 'Show capacity policy'}
              </button>
            </div>
          </div>

          {showOperationsResourceStrip
            ? resources.length === 0 ? (
                <EmptyState
                  title={isZh ? '还没有可管理的资源面' : 'No resources to manage yet'}
                  description={
                    isZh
                      ? '等 snapshot 带上资源描述后，这里会显示每条 runtime 的容量策略。'
                      : 'This strip will show one card per runtime once the snapshot includes resource descriptors.'
                  }
                />
              ) : (
                <div className="resource-card-grid resource-card-grid--operations">
                  {resources.map((resource) => {
                    const slotDraft =
                      resourceSlotDrafts[resource.platform] ??
                      (resource.slotLimit === null ? '' : String(resource.slotLimit))
                    const pendingPolicyUpdate =
                      pendingResourcePolicyUpdates[resource.platform] === true

                    return (
                      <article
                        key={resource.id}
                        className={`resource-card resource-card--${getResourcePressureTone(resource.pressure)}`}
                      >
                        <div className="resource-card__header">
                          <div>
                            <h3>{humanizeToken(resource.platform)}</h3>
                            <p>{describeResourceUtilization(resource)}</p>
                          </div>
                          <div className="pill-row">
                            <StatusPill tone={getResourcePressureTone(resource.pressure)}>
                              {describeResourcePressure(resource.pressure)}
                            </StatusPill>
                            {resource.slotLimit !== null ? (
                              <StatusPill tone="info">
                                {isZh ? '已设上限' : 'Cap set'}
                              </StatusPill>
                            ) : (
                              <StatusPill tone="neutral">
                                {isZh ? '无限制' : 'Unlimited'}
                              </StatusPill>
                            )}
                          </div>
                        </div>

                        <dl className="meta-grid resource-card__meta">
                          <div>
                            <dt>{isZh ? '活跃 / 等待' : 'Active / waiting'}</dt>
                            <dd>
                              {resource.activeTaskCount} / {resource.waitingTaskCount}
                            </dd>
                          </div>
                          <div>
                            <dt>{isZh ? '会话 / 项目' : 'Sessions / projects'}</dt>
                            <dd>
                              {resource.sessionCount} / {resource.projectCount}
                            </dd>
                          </div>
                          <div>
                            <dt>{isZh ? '可用槽位' : 'Available slots'}</dt>
                            <dd>
                              {resource.availableSlots === null ? '—' : resource.availableSlots}
                            </dd>
                          </div>
                          <div>
                            <dt>{isZh ? '最近活动' : 'Last activity'}</dt>
                            <dd>{formatRelativeTime(resource.lastActivityAt)}</dd>
                          </div>
                        </dl>

                        <div className="resource-card__policy">
                          <label className="control-field">
                            <span>{isZh ? '槽位上限' : 'Slot limit'}</span>
                            <input
                              className="control-input"
                              type="number"
                              min={0}
                              max={99}
                              step={1}
                              value={slotDraft}
                              placeholder={isZh ? '留空 = 无限制' : 'Blank = unlimited'}
                              onChange={(event) => {
                                setResourceSlotDrafts((current) => ({
                                  ...current,
                                  [resource.platform]: event.target.value,
                                }))
                              }}
                            />
                          </label>
                          <button
                            className="ghost-button ghost-button--compact"
                            type="button"
                            disabled={pendingPolicyUpdate}
                            onClick={() => {
                              void handleResourcePolicyUpdate(resource, slotDraft)
                            }}
                          >
                            {pendingPolicyUpdate
                              ? isZh
                                ? '保存中…'
                                : 'Saving…'
                              : isZh
                                ? '保存'
                                : 'Save'}
                          </button>
                          <button
                            className="ghost-button ghost-button--compact"
                            type="button"
                            disabled={pendingPolicyUpdate}
                            onClick={() => {
                              setResourceSlotDrafts((current) => ({
                                ...current,
                                [resource.platform]: '',
                              }))
                              void handleResourcePolicyUpdate(resource, '')
                            }}
                          >
                            {isZh ? '清除上限' : 'Clear cap'}
                          </button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )
            : null}
        </section>

        <div className="operations-workspace">
          <div className="operations-sidebar">
        <section className="panel panel--accent operations-pane operations-pane--inspector">
          <PanelHeader
            title={
              selectedRunIsApprovalCandidate
                ? isZh
                  ? '审批详情'
                  : 'Approval detail'
                : selectedTask
                  ? isZh
                    ? '任务详情'
                    : 'Task detail'
                  : isZh
                    ? '运行详情'
                    : 'Run detail'
            }
            subtitle={
              selectedRunIsApprovalCandidate
                ? isZh
                  ? '查看待决事项的上下文、动作路径、本地分诊和工作区工具。'
                  : 'Review approval context, action path, local triage, and workspace tools.'
                : selectedTask
                  ? isZh
                    ? '查看任务绑定的 project / session / run，上下文不离开 dashboard 就能继续交互。'
                    : 'Inspect the project / session / run bound to this task and continue the conversation without leaving the dashboard.'
                  : isZh
                    ? '查看单个 run、执行本地分诊动作，并直接跳到 workspace，无需离开 dashboard。'
                    : 'Inspect one run, take local triage actions, and jump into the workspace without leaving the dashboard.'
            }
            count={selectedRunTimeline.length}
          />

          {selectedApproval ? (
            <div className="inspector-stack">
              <div className="inspector-header">
                <div>
                  <h3>{selectedApproval.request.command}</h3>
                  <p className="inspector-subtitle">
                    {selectedDetailAgent ? (
                      <>
                        {selectedDetailAgent.name} ·{' '}
                        <span className="truncate-path">
                          {selectedDetailAgent.workspacePath}
                        </span>
                      </>
                    ) : (
                      selectedApproval.id
                    )}
                  </p>
                </div>
                <div className="pill-row">
                  <StatusPill tone={getApprovalStateTone(selectedApproval.state)}>
                    {humanizeToken(selectedApproval.state)}
                  </StatusPill>
                  <StatusPill tone={getAttentionTone(selectedApproval.attention)}>
                    {humanizeToken(selectedApproval.attention)}
                  </StatusPill>
                  <StatusPill
                    tone={selectedRunIsActionableApproval ? 'success' : 'warning'}
                  >
                    {selectedRunIsActionableApproval
                      ? isZh
                        ? '可处理'
                        : 'Actionable'
                      : isZh
                        ? '只读'
                        : 'Read-only'}
                  </StatusPill>
                  {renderTriagePills(selectedRunTriage)}
                </div>
              </div>

              <p className="inspector-summary">
                {describeApprovalSummary(selectedApproval)}
              </p>

              <dl className="meta-grid">
                <div>
                  <dt>{isZh ? '运行时' : 'Runtime'}</dt>
                  <dd>{humanizeToken(selectedApproval.platform)}</dd>
                </div>
                <div>
                  <dt>{isZh ? 'Agent' : 'Agent'}</dt>
                  <dd>{selectedDetailAgent?.name ?? '—'}</dd>
                </div>
                <div>
                  <dt>{isZh ? '工作区' : 'Workspace'}</dt>
                  <dd>
                    {selectedDetailAgent ? (
                      <span className="truncate-path">
                        {selectedDetailAgent.workspacePath}
                      </span>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{isZh ? '决策路径' : 'Decision path'}</dt>
                  <dd>
                    {describeApprovalResolveSupportLabel(
                      selectedApprovalResolveSupport.code,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{isZh ? '创建时间' : 'Created'}</dt>
                  <dd>{formatDateTime(selectedApproval.createdAt)}</dd>
                </div>
                <div>
                  <dt>{isZh ? '过期时间' : 'Expires'}</dt>
                  <dd>{formatDateTime(selectedApproval.expiresAt)}</dd>
                </div>
                <div>
                  <dt>{isZh ? '安全级别' : 'Security'}</dt>
                  <dd>{humanizeToken(selectedApproval.request.security ?? 'none')}</dd>
                </div>
                <div>
                  <dt>{isZh ? '审批策略' : 'Ask mode'}</dt>
                  <dd>{humanizeToken(selectedApproval.request.ask ?? 'unknown')}</dd>
                </div>
                <div>
                  <dt>{isZh ? '当前目录' : 'Working directory'}</dt>
                  <dd>
                    {selectedApproval.request.cwd ? (
                      <span className="truncate-path">
                        {selectedApproval.request.cwd}
                      </span>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{isZh ? '会话 key' : 'Session key'}</dt>
                  <dd>{selectedApproval.sessionKey ?? '—'}</dd>
                </div>
              </dl>

              {openClawApprovalBridge ? (
                <p className="muted-text">
                  {describeApprovalBridgeState(openClawApprovalBridge)}
                </p>
              ) : null}

              <div className="inspector-action-groups">
                <div className="inspector-action-group">
                  <span className="inspector-label">
                    {isZh ? '决策动作' : 'Decision actions'}
                  </span>
                  <ApprovalActionButtons
                    approval={selectedApproval}
                    bridge={
                      selectedApproval.platform === 'openclaw'
                        ? openClawApprovalBridge
                        : null
                    }
                    pendingAction={pendingApprovalActions[selectedApproval.id]}
                    onAction={handleApprovalResolve}
                  />
                </div>

                <div className="inspector-action-group">
                  <span className="inspector-label">
                    {isZh ? '本地分诊' : 'Local triage'}
                  </span>
                  <div className="action-group">
                    <button
                      className="ghost-button ghost-button--compact"
                      type="button"
                      onClick={() => {
                        handleTriageAction(
                          selectedApproval.id,
                          selectedRunTriage?.acknowledgedAt
                            ? 'clear_acknowledge'
                            : 'acknowledge',
                        )
                      }}
                    >
                      {selectedRunTriage?.acknowledgedAt
                        ? isZh
                          ? '清除确认'
                          : 'Clear ack'
                        : isZh
                          ? '确认'
                          : 'Acknowledge'}
                    </button>
                    <button
                      className="ghost-button ghost-button--compact"
                      type="button"
                      onClick={() => {
                        handleTriageAction(
                          selectedApproval.id,
                          isRunSnoozed(selectedRunTriage, Date.now())
                            ? 'clear_snooze'
                            : 'snooze',
                        )
                      }}
                    >
                      {isRunSnoozed(selectedRunTriage, Date.now())
                        ? isZh
                          ? '清除稍后处理'
                          : 'Clear snooze'
                        : isZh
                          ? '稍后 30 分钟'
                          : 'Snooze 30m'}
                    </button>
                    <button
                      className="ghost-button ghost-button--compact"
                      type="button"
                      onClick={() => {
                        handleTriageAction(
                          selectedApproval.id,
                          selectedRunTriage?.muted ? 'unmute' : 'mute',
                        )
                      }}
                    >
                      {selectedRunTriage?.muted
                        ? isZh
                          ? '取消静音'
                          : 'Unmute'
                        : isZh
                          ? '静音'
                          : 'Mute'}
                    </button>
                  </div>
                </div>

                {selectedDetailAgent ? (
                  <div className="inspector-action-group">
                    <span className="inspector-label">
                      {isZh ? '工作区工具' : 'Workspace tools'}
                    </span>
                    <div className="action-group">
                      <button
                        className="ghost-button ghost-button--compact"
                        type="button"
                        onClick={() => {
                          void handleCopyValue(
                            selectedDetailAgent.workspacePath,
                            isZh ? '工作区路径' : 'Workspace path',
                          )
                        }}
                      >
                        {isZh ? '复制路径' : 'Copy path'}
                      </button>
                      <button
                        className="ghost-button ghost-button--compact"
                        type="button"
                        disabled={
                          pendingWorkspaceActions[selectedDetailAgent.id] !== undefined
                        }
                        onClick={() => {
                          void handleWorkspaceAction(selectedDetailAgent, 'finder')
                        }}
                      >
                        {pendingWorkspaceActions[selectedDetailAgent.id] === 'finder'
                          ? isZh
                            ? '正在打开 Finder…'
                            : 'Opening Finder…'
                          : isZh
                            ? '在 Finder 中打开'
                            : 'Open Finder'}
                      </button>
                      <button
                        className="ghost-button ghost-button--compact"
                        type="button"
                        disabled={
                          pendingWorkspaceActions[selectedDetailAgent.id] !== undefined
                        }
                        onClick={() => {
                          void handleWorkspaceAction(selectedDetailAgent, 'terminal')
                        }}
                      >
                        {pendingWorkspaceActions[selectedDetailAgent.id] === 'terminal'
                          ? isZh
                            ? '正在打开终端…'
                            : 'Opening Terminal…'
                          : isZh
                            ? '在终端中打开'
                            : 'Open Terminal'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {selectedDetailAgent && selectedDetailSession ? (
                  <div className="inspector-action-group">
                    <span className="inspector-label">
                      {isZh ? '会话控制' : 'Session controls'}
                    </span>
                    <SessionActionControls
                      agent={selectedDetailAgent}
                      session={selectedDetailSession}
                      isZh={isZh}
                      promptSupport={selectedAgentPromptSupport}
                      attachSupport={selectedSessionAttachSupport}
                      pendingAction={pendingSessionActions[selectedDetailSession.id]}
                      draft={runtimePromptDrafts[selectedDetailSession.id] ?? ''}
                      onDraftChange={(value) => {
                        setRuntimePromptDrafts((current) => ({
                          ...current,
                          [selectedDetailSession.id]: value,
                        }))
                      }}
                      onAction={(session, agent, action, options) => {
                        void handleSessionAction(session, agent, action, options)
                      }}
                    />
                  </div>
                ) : null}

                {selectedDetailAgent &&
                hasAgentRuntimeControlSurface(selectedDetailAgent) ? (
                  <div className="inspector-action-group">
                    <span className="inspector-label">
                      {isZh ? '运行时动作' : 'Runtime actions'}
                    </span>
                    <RuntimeActionControls
                      agent={selectedDetailAgent}
                      isZh={isZh}
                      availableActions={selectedAgentRuntimeActions}
                      primarySupport={selectedAgentRuntimeActionSupport}
                      promptSupport={selectedAgentPromptSupport}
                      showPromptComposer={!selectedDetailSession}
                      pendingAction={pendingRuntimeActions[selectedDetailAgent.id]}
                      draft={runtimePromptDrafts[selectedDetailAgent.id] ?? ''}
                      onDraftChange={(value) => {
                        setRuntimePromptDrafts((current) => ({
                          ...current,
                          [selectedDetailAgent.id]: value,
                        }))
                      }}
                      onAction={(nextAgent, action, options) => {
                        void handleRuntimeAction(nextAgent, action, options)
                      }}
                    />
                  </div>
                ) : null}
              </div>

              <div className="timeline-shell">
                <div className="timeline-shell__header">
                  <h3>{isZh ? '审批时间线' : 'Approval timeline'}</h3>
                  <p>
                    {isZh
                      ? '查看这个审批项最近的状态变化与决策相关事件。'
                      : 'Latest state changes and decision-relevant events for this approval.'}
                  </p>
                </div>

                {selectedRunTimeline.length === 0 ? (
                  <p className="muted-text">
                    {isZh
                      ? '当前快照中，这个审批项还没有最近事件。'
                      : 'No recent events for this approval in the current snapshot.'}
                  </p>
                ) : (
                  <ul className="timeline-list">
                    {selectedRunTimeline.map((event) => (
                      <li className="timeline-item" key={event.id}>
                        <div
                          className={`event-dot event-dot--${getAttentionTone(event.attention)}`}
                          aria-hidden="true"
                        />
                          <div className="timeline-item__body">
                            <div className="timeline-item__meta">
                              <StatusPill tone={getAttentionTone(event.attention)}>
                                {humanizeToken(event.type)}
                              </StatusPill>
                              <span>{formatRelativeTime(event.createdAt)}</span>
                            </div>
                            <p>{event.message}</p>
                            {describeEventLineageSummary(
                              event,
                              event.sessionKey ? sessionLookup.get(event.sessionKey) ?? null : null,
                              event.projectId ? projectLookup.get(event.projectId) ?? null : null,
                            ) ? (
                              <p className="muted-text">
                                {describeEventLineageSummary(
                                  event,
                                  event.sessionKey
                                    ? sessionLookup.get(event.sessionKey) ?? null
                                    : null,
                                  event.projectId
                                    ? projectLookup.get(event.projectId) ?? null
                                    : null,
                                )}
                              </p>
                            ) : null}
                          </div>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </div>
          ) : selectedRun ? (
            <div className="inspector-stack">
              <div className="inspector-header">
                <div>
                  <h3>{selectedRun.title}</h3>
                  <p className="inspector-subtitle">
                    {selectedDetailAgent ? (
                      <>
                        {selectedDetailAgent.name} ·{' '}
                        <span className="truncate-path">{selectedDetailAgent.workspacePath}</span>
                      </>
                    ) : (
                      selectedRun.agentId
                    )}
                  </p>
                </div>
                <div className="pill-row">
                  <StatusPill tone={getRunStateTone(selectedRun.state)}>
                    {humanizeToken(selectedRun.state)}
                  </StatusPill>
                  <StatusPill tone={getAttentionTone(selectedRun.attention)}>
                    {humanizeToken(selectedRun.attention)}
                  </StatusPill>
                  {selectedTask ? (
                    <StatusPill tone={getTaskPriorityTone(selectedTask.priority)}>
                      {humanizeToken(selectedTask.priority)}
                    </StatusPill>
                  ) : null}
                  {selectedRunIsApprovalCandidate ? (
                    <StatusPill
                      tone={selectedRunIsActionableApproval ? 'success' : 'warning'}
                    >
                      {selectedRunIsActionableApproval
                        ? isZh
                          ? '可处理'
                          : 'Actionable'
                        : isZh
                          ? '只读'
                          : 'Read-only'}
                    </StatusPill>
                  ) : null}
                  {renderTriagePills(selectedRunTriage)}
                </div>
              </div>

              <p className="inspector-summary">{getRunSummary(selectedRun)}</p>
              {selectedTask ? (
                <p className="muted-text">
                  {isZh
                    ? `任务视角：${selectedTaskProject?.name ?? getWorkspaceLabel(selectedTask.workspacePath)} · ${selectedTaskSession?.name ?? selectedDetailAgent?.name ?? selectedTask.sessionKey} · ${selectedTask.eventCount} 个事件`
                    : `Task view: ${selectedTaskProject?.name ?? getWorkspaceLabel(selectedTask.workspacePath)} · ${selectedTaskSession?.name ?? selectedDetailAgent?.name ?? selectedTask.sessionKey} · ${selectedTask.eventCount} event${selectedTask.eventCount === 1 ? '' : 's'}`}
                </p>
              ) : null}

              <dl className="meta-grid">
                {selectedTask ? (
                  <>
                    <div>
                      <dt>{isZh ? '任务' : 'Task'}</dt>
                      <dd>{selectedTask.title}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '项目' : 'Project'}</dt>
                      <dd>{selectedTaskProject?.name ?? getWorkspaceLabel(selectedTask.workspacePath)}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '会话' : 'Session'}</dt>
                      <dd>{selectedTaskSession?.name ?? selectedTask.runtimeSessionId ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '负责人' : 'Owner'}</dt>
                      <dd>{selectedTask.owner ?? (isZh ? '未指派' : 'Unassigned')}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '优先级' : 'Priority'}</dt>
                      <dd>{humanizeToken(selectedTask.priority)}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '优先级更新' : 'Priority updated'}</dt>
                      <dd>{formatDateTime(selectedTask.priorityUpdatedAt)}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '指派更新' : 'Assignment updated'}</dt>
                      <dd>{formatDateTime(selectedTask.assignmentUpdatedAt ?? selectedTask.assignedAt)}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '交接目标' : 'Handoff target'}</dt>
                      <dd>{selectedTask.handoffTarget ?? (isZh ? '无' : 'None')}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '交接更新' : 'Handoff updated'}</dt>
                      <dd>{formatDateTime(selectedTask.handoffUpdatedAt ?? selectedTask.handoffRequestedAt)}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '事件数' : 'Events'}</dt>
                      <dd>{String(selectedTask.eventCount)}</dd>
                    </div>
                  </>
                ) : null}
                <div>
                  <dt>{isZh ? 'Agent' : 'Agent'}</dt>
                  <dd>{selectedDetailAgent?.name ?? selectedRun.agentId}</dd>
                </div>
                <div>
                  <dt>{isZh ? '工作区' : 'Workspace'}</dt>
                  <dd>
                    {selectedDetailAgent ? (
                      <span className="truncate-path">{selectedDetailAgent.workspacePath}</span>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{isZh ? '进度' : 'Progress'}</dt>
                  <dd>{formatPercent(selectedRun.progress?.percent)}</dd>
                </div>
                <div>
                  <dt>{isZh ? '等待原因' : 'Waiting reason'}</dt>
                  <dd>{humanizeToken(selectedRun.waitingReason ?? 'none')}</dd>
                </div>
                <div>
                  <dt>{isZh ? '更新时间' : 'Updated'}</dt>
                  <dd>{formatDateTime(selectedRun.lastEventAt)}</dd>
                </div>
                <div>
                  <dt>{isZh ? '开始时间' : 'Started'}</dt>
                  <dd>{formatDateTime(selectedRun.createdAt)}</dd>
                </div>
                <div>
                  <dt>{isZh ? '来源' : 'Source'}</dt>
                  <dd>
                    {selectedDetailAgent ? getAgentSourceLabel(selectedDetailAgent) : '—'}
                  </dd>
                </div>
                <div>
                  <dt>
                    {selectedRunIsApprovalCandidate
                      ? isZh
                        ? '决策路径'
                        : 'Decision path'
                      : isZh
                        ? '动作路径'
                        : 'Action path'}
                  </dt>
                  <dd>{describeRunActionSupportLabel(selectedRunActionSupport.code)}</dd>
                </div>
              </dl>

              {selectedCopilotSessionMetadata ? (
                <CopilotSessionContext metadata={selectedCopilotSessionMetadata} />
              ) : null}

              <div className="inspector-action-groups">
                <div className="inspector-action-group">
                  <span className="inspector-label">
                    {selectedRunIsApprovalCandidate
                      ? isZh
                        ? '决策动作'
                        : 'Decision actions'
                      : isZh
                        ? 'Hub 动作'
                        : 'Hub actions'}
                  </span>
                  <RunActionButtons
                    agent={selectedDetailAgent}
                    run={selectedRun}
                    pendingAction={pendingActions[selectedRun.id]}
                    onAction={handleRunAction}
                  />
                </div>

                <div className="inspector-action-group">
                  <span className="inspector-label">
                    {isZh ? '本地分诊' : 'Local triage'}
                  </span>
                  <div className="action-group">
                    <button
                      className="ghost-button ghost-button--compact"
                      type="button"
                      onClick={() => {
                        handleTriageAction(
                          selectedRun.id,
                          selectedRunTriage?.acknowledgedAt
                            ? 'clear_acknowledge'
                            : 'acknowledge',
                        )
                      }}
                    >
                      {selectedRunTriage?.acknowledgedAt
                        ? isZh
                          ? '清除确认'
                          : 'Clear ack'
                        : isZh
                          ? '确认'
                          : 'Acknowledge'}
                    </button>
                    <button
                      className="ghost-button ghost-button--compact"
                      type="button"
                      onClick={() => {
                        handleTriageAction(
                          selectedRun.id,
                          isRunSnoozed(selectedRunTriage, Date.now())
                            ? 'clear_snooze'
                            : 'snooze',
                        )
                      }}
                    >
                      {isRunSnoozed(selectedRunTriage, Date.now())
                        ? isZh
                          ? '清除稍后处理'
                          : 'Clear snooze'
                        : isZh
                          ? '稍后 30 分钟'
                          : 'Snooze 30m'}
                    </button>
                    <button
                      className="ghost-button ghost-button--compact"
                      type="button"
                      onClick={() => {
                        handleTriageAction(
                          selectedRun.id,
                          selectedRunTriage?.muted ? 'unmute' : 'mute',
                        )
                      }}
                    >
                      {selectedRunTriage?.muted
                        ? isZh
                          ? '取消静音'
                          : 'Unmute'
                        : isZh
                          ? '静音'
                          : 'Mute'}
                    </button>
                  </div>
                </div>

                {selectedTask ? (
                  <div className="inspector-action-group">
                    <span className="inspector-label">
                      {isZh ? '任务优先级' : 'Task priority'}
                    </span>
                    <div className="action-stack action-stack--compact">
                      <select
                        className="control-input control-select"
                        value={selectedTaskPriorityDraft}
                        onChange={(event) => {
                          setTaskPriorityDrafts((current) => ({
                            ...current,
                            [selectedTask.id]: event.target.value as TaskPriority,
                          }))
                        }}
                      >
                        <option value="low">{isZh ? '低' : 'Low'}</option>
                        <option value="normal">{isZh ? '普通' : 'Normal'}</option>
                        <option value="high">{isZh ? '高' : 'High'}</option>
                        <option value="critical">{isZh ? '关键' : 'Critical'}</option>
                      </select>
                      <div className="action-group">
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          disabled={
                            selectedTaskPriorityPending ||
                            selectedTaskPriorityDraft === selectedTask.priority
                          }
                          onClick={() => {
                            void handleTaskPriority(selectedTask, selectedTaskPriorityDraft)
                          }}
                        >
                          {selectedTaskPriorityPending
                            ? isZh
                              ? '正在更新优先级…'
                              : 'Updating priority…'
                            : isZh
                              ? '保存优先级'
                              : 'Save priority'}
                        </button>
                      </div>
                      <p className="muted-text">
                        {isZh
                          ? '优先级只影响 task-plane 的排序和审计轨迹，不会假装已经触发自动调度。'
                          : 'Priority only changes task-plane ordering and audit trail; it does not pretend to trigger automatic scheduling yet.'}
                      </p>
                    </div>
                  </div>
                ) : null}

                {selectedTask ? (
                  <div className="inspector-action-group">
                    <span className="inspector-label">
                      {isZh ? '任务归属' : 'Task ownership'}
                    </span>
                    <div className="action-stack action-stack--compact">
                      <input
                        className="control-input"
                        type="text"
                        maxLength={80}
                        value={selectedTaskOwnerDraft}
                        onChange={(event) => {
                          const value = event.target.value
                          setTaskOwnerDrafts((current) => ({
                            ...current,
                            [selectedTask.id]: value,
                          }))
                        }}
                        placeholder={
                          isZh ? '输入负责人，例如 Eno / reviewer-oncall' : 'Assign an owner, e.g. Eno / reviewer-oncall'
                        }
                      />
                      <div className="action-group">
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          disabled={
                            selectedTaskAssignmentPending ||
                            selectedTaskOwnerDraftTrimmed.length === 0 ||
                            selectedTaskOwnerDraftTrimmed === (selectedTask.owner ?? '')
                          }
                          onClick={() => {
                            void handleTaskAssignment(selectedTask, selectedTaskOwnerDraftTrimmed)
                          }}
                        >
                          {selectedTaskAssignmentPending
                            ? selectedTaskAssignmentMode === 'clear'
                              ? isZh
                                ? '正在取消指派…'
                                : 'Clearing owner…'
                              : isZh
                                ? '正在更新负责人…'
                                : 'Updating owner…'
                            : selectedTask.owner
                              ? isZh
                                ? '重新指派'
                                : 'Reassign'
                              : isZh
                                ? '指派任务'
                                : 'Assign task'}
                        </button>
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          disabled={selectedTaskAssignmentPending || selectedTask.owner === null}
                          onClick={() => {
                            void handleTaskAssignment(selectedTask, null)
                          }}
                        >
                          {selectedTaskAssignmentPending
                            ? selectedTaskAssignmentMode === 'clear'
                              ? isZh
                                ? '正在取消指派…'
                                : 'Clearing owner…'
                              : isZh
                                ? '正在更新负责人…'
                                : 'Updating owner…'
                            : isZh
                              ? '取消指派'
                              : 'Clear owner'}
                        </button>
                      </div>
                      <p className="muted-text">
                        {selectedTask.owner
                          ? isZh
                            ? `当前负责人：${selectedTask.owner}${selectedTask.assignmentUpdatedAt ? ` · 最近更新 ${formatRelativeTime(selectedTask.assignmentUpdatedAt)}` : ''}`
                            : `Current owner: ${selectedTask.owner}${selectedTask.assignmentUpdatedAt ? ` · Updated ${formatRelativeTime(selectedTask.assignmentUpdatedAt)}` : ''}`
                          : isZh
                            ? '当前没有负责人；这一步会把 task plane 从纯投影推进到可分派状态。'
                            : 'No owner is assigned yet; this is the first persisted step beyond a pure projected task plane.'}
                      </p>
                    </div>
                  </div>
                ) : null}

                {selectedTask ? (
                  <div className="inspector-action-group">
                    <span className="inspector-label">
                      {isZh ? '任务交接' : 'Task handoff'}
                    </span>
                    <div className="action-stack action-stack--compact">
                      <input
                        className="control-input"
                        type="text"
                        maxLength={80}
                        value={selectedTaskHandoffTargetDraft}
                        onChange={(event) => {
                          const value = event.target.value
                          setTaskHandoffTargetDrafts((current) => ({
                            ...current,
                            [selectedTask.id]: value,
                          }))
                        }}
                        placeholder={
                          isZh
                            ? '输入交接目标，例如 reviewer-oncall'
                            : 'Enter the handoff target, e.g. reviewer-oncall'
                        }
                      />
                      <input
                        className="control-input"
                        type="text"
                        maxLength={240}
                        value={selectedTaskHandoffNoteDraft}
                        onChange={(event) => {
                          const value = event.target.value
                          setTaskHandoffNoteDrafts((current) => ({
                            ...current,
                            [selectedTask.id]: value,
                          }))
                        }}
                        placeholder={
                          isZh
                            ? '可选：补一条交接说明，例如等待设计确认'
                            : 'Optional: add a handoff note, e.g. waiting on design confirmation'
                        }
                      />
                      <div className="action-group">
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          disabled={selectedTaskHandoffRequestDisabled}
                          onClick={() => {
                            void handleTaskHandoff(
                              selectedTask,
                              selectedTaskHandoffTargetDraftTrimmed,
                              selectedTaskHandoffNoteDraftTrimmed,
                            )
                          }}
                        >
                          {selectedTaskHandoffPending
                            ? selectedTaskHandoffMode === 'clear'
                              ? isZh
                                ? '正在清除交接…'
                                : 'Clearing handoff…'
                              : selectedTaskHandoffMode === 'complete'
                                ? isZh
                                  ? '正在完成交接…'
                                  : 'Completing handoff…'
                              : isZh
                                ? '正在更新交接…'
                                : 'Updating handoff…'
                            : selectedTask.handoffTarget
                              ? isZh
                                ? '更新交接'
                                : 'Update handoff'
                              : isZh
                                ? '请求交接'
                                : 'Request handoff'}
                        </button>
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          disabled={selectedTaskHandoffPending || selectedTask.handoffTarget === null}
                          onClick={() => {
                            void handleTaskHandoff(selectedTask, null, null)
                          }}
                        >
                          {selectedTaskHandoffPending
                            ? selectedTaskHandoffMode === 'clear'
                              ? isZh
                                ? '正在清除交接…'
                                : 'Clearing handoff…'
                              : selectedTaskHandoffMode === 'complete'
                                ? isZh
                                  ? '正在完成交接…'
                                  : 'Completing handoff…'
                              : isZh
                                ? '正在更新交接…'
                                : 'Updating handoff…'
                            : isZh
                              ? '清除交接'
                              : 'Clear handoff'}
                        </button>
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          disabled={selectedTaskHandoffCompletionDisabled}
                          onClick={() => {
                            void handleTaskHandoffCompletion(selectedTask)
                          }}
                        >
                          {selectedTaskHandoffPending && selectedTaskHandoffMode === 'complete'
                            ? isZh
                              ? '正在完成交接…'
                              : 'Completing handoff…'
                            : isZh
                              ? '完成交接'
                              : 'Complete handoff'}
                        </button>
                      </div>
                      <p className="muted-text">
                        {!selectedTask.owner
                          ? isZh
                            ? '交接请求依赖现有负责人；请先给任务指派 owner，再声明准备交给谁。'
                            : 'A handoff request depends on a current owner. Assign an owner first, then declare who the task is being handed to.'
                          : selectedTask.handoffTarget
                            ? isZh
                              ? `当前交接目标：${selectedTask.handoffTarget}${selectedTask.handoffUpdatedAt ? ` · 最近更新 ${formatRelativeTime(selectedTask.handoffUpdatedAt)}` : ''}${selectedTask.handoffNote ? ` · 说明：${selectedTask.handoffNote}` : ''} · 点击“完成交接”后会切换 owner 并清除 pending handoff。`
                              : `Current handoff target: ${selectedTask.handoffTarget}${selectedTask.handoffUpdatedAt ? ` · Updated ${formatRelativeTime(selectedTask.handoffUpdatedAt)}` : ''}${selectedTask.handoffNote ? ` · Note: ${selectedTask.handoffNote}` : ''} · Completing the handoff will switch the owner and clear the pending handoff.`
                            : isZh
                              ? '这一步只记录 pending handoff，不会假装底层 runtime session 已经迁移。'
                              : 'This only records a pending handoff; it does not pretend the underlying runtime session has already moved.'}
                      </p>
                    </div>
                  </div>
                ) : null}

                {selectedDetailAgent ? (
                  <div className="inspector-action-group">
                    <span className="inspector-label">
                      {isZh ? '工作区工具' : 'Workspace tools'}
                    </span>
                    <div className="action-group">
                      <button
                        className="ghost-button ghost-button--compact"
                        type="button"
                        onClick={() => {
                          void handleCopyValue(
                            selectedDetailAgent.workspacePath,
                            isZh ? '工作区路径' : 'Workspace path',
                          )
                        }}
                      >
                        {isZh ? '复制路径' : 'Copy path'}
                      </button>
                      <button
                        className="ghost-button ghost-button--compact"
                        type="button"
                        disabled={pendingWorkspaceActions[selectedDetailAgent.id] !== undefined}
                        onClick={() => {
                          void handleWorkspaceAction(selectedDetailAgent, 'finder')
                        }}
                      >
                        {pendingWorkspaceActions[selectedDetailAgent.id] === 'finder'
                          ? isZh
                            ? '正在打开 Finder…'
                            : 'Opening Finder…'
                          : isZh
                            ? '在 Finder 中打开'
                            : 'Open Finder'}
                      </button>
                      <button
                        className="ghost-button ghost-button--compact"
                        type="button"
                        disabled={pendingWorkspaceActions[selectedDetailAgent.id] !== undefined}
                        onClick={() => {
                          void handleWorkspaceAction(selectedDetailAgent, 'terminal')
                        }}
                      >
                        {pendingWorkspaceActions[selectedDetailAgent.id] === 'terminal'
                          ? isZh
                            ? '正在打开终端…'
                            : 'Opening Terminal…'
                          : isZh
                            ? '在终端中打开'
                            : 'Open Terminal'}
                      </button>
                      {hasAgentWorkspaceActionSupport(selectedDetailAgent, 'runtime_home') ? (
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          disabled={pendingWorkspaceActions[selectedDetailAgent.id] !== undefined}
                          onClick={() => {
                            void handleWorkspaceAction(selectedDetailAgent, 'runtime_home')
                          }}
                        >
                          {pendingWorkspaceActions[selectedDetailAgent.id] === 'runtime_home'
                            ? isZh
                              ? '正在打开运行时目录…'
                              : 'Opening runtime files…'
                            : isZh
                              ? '运行时目录'
                              : 'Runtime files'}
                        </button>
                      ) : null}
                      {hasAgentWorkspaceActionSupport(selectedDetailAgent, 'session_state') ? (
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          disabled={pendingWorkspaceActions[selectedDetailAgent.id] !== undefined}
                          onClick={() => {
                            void handleWorkspaceAction(selectedDetailAgent, 'session_state')
                          }}
                        >
                          {pendingWorkspaceActions[selectedDetailAgent.id] === 'session_state'
                            ? isZh
                              ? '正在打开会话路径…'
                              : 'Opening session path…'
                            : isZh
                              ? '会话路径'
                              : 'Session path'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {selectedDetailAgent && selectedDetailSession ? (
                  <div className="inspector-action-group">
                    <span className="inspector-label">
                      {isZh ? '会话控制' : 'Session controls'}
                    </span>
                    <SessionActionControls
                      agent={selectedDetailAgent}
                      session={selectedDetailSession}
                      isZh={isZh}
                      promptSupport={selectedAgentPromptSupport}
                      attachSupport={selectedSessionAttachSupport}
                      pendingAction={pendingSessionActions[selectedDetailSession.id]}
                      draft={runtimePromptDrafts[selectedDetailSession.id] ?? ''}
                      onDraftChange={(value) => {
                        setRuntimePromptDrafts((current) => ({
                          ...current,
                          [selectedDetailSession.id]: value,
                        }))
                      }}
                      onAction={(session, agent, action, options) => {
                        void handleSessionAction(session, agent, action, options)
                      }}
                    />
                  </div>
                ) : null}

                {selectedDetailAgent &&
                hasAgentRuntimeControlSurface(selectedDetailAgent) ? (
                  <div className="inspector-action-group">
                    <span className="inspector-label">
                      {selectedTask
                        ? isZh
                          ? '任务交互'
                          : 'Task interaction'
                        : isZh
                          ? '运行时动作'
                          : 'Runtime actions'}
                    </span>
                    <RuntimeActionControls
                      agent={selectedDetailAgent}
                      isZh={isZh}
                      availableActions={selectedAgentRuntimeActions}
                      primarySupport={selectedAgentRuntimeActionSupport}
                      promptSupport={selectedAgentPromptSupport}
                      showPromptComposer={!selectedDetailSession}
                      pendingAction={
                        selectedTask
                          ? pendingTaskRuntimeActions[selectedTask.id]
                          : pendingRuntimeActions[selectedDetailAgent.id]
                      }
                      draft={
                        runtimePromptDrafts[selectedTask?.id ?? selectedDetailAgent.id] ?? ''
                      }
                      onDraftChange={(value) => {
                        setRuntimePromptDrafts((current) => ({
                          ...current,
                          [selectedTask?.id ?? selectedDetailAgent.id]: value,
                        }))
                      }}
                      onAction={(nextAgent, action, options) => {
                        if (selectedTask) {
                          void handleTaskRuntimeAction(selectedTask, action, options)
                          return
                        }
                        void handleRuntimeAction(nextAgent, action, options)
                      }}
                    />
                  </div>
                ) : null}
              </div>

                <div className="timeline-shell">
                  <div className="timeline-shell__header">
                    <h3>
                      {selectedRunIsApprovalCandidate
                        ? isZh
                          ? '审批时间线'
                          : 'Approval timeline'
                        : selectedTask
                          ? isZh
                            ? '任务时间线'
                            : 'Task timeline'
                          : isZh
                            ? '最近时间线'
                            : 'Recent timeline'}
                    </h3>
                    <p>
                      {selectedRunIsApprovalCandidate
                        ? isZh
                          ? '查看这个审批项最近的状态变化与决策相关事件。'
                          : 'Latest state changes and decision-relevant events for this approval.'
                        : selectedTask
                          ? isZh
                            ? '查看这个任务最近的状态变化、输出和人工干预记录。'
                            : 'Latest state changes, outputs, and operator interventions for this task.'
                          : isZh
                            ? '查看最近的 run 状态变化和与操作者相关的关键事件。'
                            : 'Latest run transitions and operator-relevant changes.'}
                    </p>
                  </div>

                {selectedRunTimeline.length === 0 ? (
                  <p className="muted-text">
                    {isZh
                      ? '当前快照中，这个 run 还没有最近事件。'
                      : 'No recent events for this run in the current snapshot.'}
                  </p>
                ) : (
                  <ul className="timeline-list">
                    {selectedRunTimeline.map((event) => (
                      <li className="timeline-item" key={event.id}>
                        <div
                          className={`event-dot event-dot--${getAttentionTone(event.attention)}`}
                          aria-hidden="true"
                        />
                        <div className="timeline-item__body">
                          <div className="timeline-item__meta">
                            <StatusPill tone={getAttentionTone(event.attention)}>
                              {humanizeToken(event.type)}
                            </StatusPill>
                            <span>{formatRelativeTime(event.createdAt)}</span>
                          </div>
                          <p>{event.message}</p>
                          {describeEventLineageSummary(
                            event,
                            event.sessionKey ? sessionLookup.get(event.sessionKey) ?? null : null,
                            event.projectId ? projectLookup.get(event.projectId) ?? null : null,
                          ) ? (
                            <p className="muted-text">
                              {describeEventLineageSummary(
                                event,
                                event.sessionKey
                                  ? sessionLookup.get(event.sessionKey) ?? null
                                  : null,
                                event.projectId
                                  ? projectLookup.get(event.projectId) ?? null
                                  : null,
                              )}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <EmptyState
              title={isZh ? '尚未选择审批项' : 'No approval selected'}
              description={
                isZh
                  ? '从审批中心、活跃任务或 Agents 中选择一项，即可查看详情、时间线和本地操作者动作。'
                  : 'Pick an item from Approval Center, Active tasks, or Agents to inspect detail, timeline, and local operator actions.'
              }
            />
          )}
        </section>
          </div>

          <div className="operations-main">
        <section className="panel operations-pane operations-pane--queue">
          <PanelHeader
            title={isZh ? '审批中心' : 'Approval Center'}
            subtitle={
              isZh
                ? '把当前待决的审批项集中成一个队列，先处理最接近真实控制桥的事项。'
                : 'A focused queue of pending approvals and review items, prioritized by truthful local actionability.'
            }
            count={approvalQueue.length}
          />

          {loading && !snapshot ? (
            <LoadingState
              message={
                isZh
                  ? '正在从 /api/snapshot 加载审批队列…'
                  : 'Loading the approval queue from /api/snapshot…'
              }
            />
          ) : approvalQueue.length === 0 ? (
            <EmptyState
              title={
                hasActiveFilters || hiddenTriagedApprovalCount > 0
                  ? isZh
                    ? '当前视图没有审批项'
                    : 'No approvals in view'
                  : isZh
                    ? '审批队列为空'
                    : 'Approval queue clear'
              }
              description={
                hiddenTriagedApprovalCount > 0
                  ? isZh
                    ? '所有匹配的审批项当前都已被本地分诊。'
                    : 'All matching approval items are currently triaged locally.'
                  : hasActiveFilters
                    ? isZh
                      ? '调整筛选条件后，可让匹配的审批项重新出现。'
                      : 'Adjust filters to bring matching approval items back into view.'
                    : isZh
                      ? '等待审批或人工审查的 runs 会显示在这里。'
                      : 'Runs waiting on approvals or human review will appear here.'
              }
            />
          ) : (
            <ul className="run-card-list">
              {approvalQueue.map((approval) => {
                const agent = approval.agentId ? agentLookup.get(approval.agentId) : null
                const resolveSupport = getApprovalResolveSupport(
                  approval,
                  approval.platform === 'openclaw' ? openClawApprovalBridge : null,
                )
                return (
                  <li
                    className={`run-card${selectedApprovalId === approval.id ? ' run-card--selected' : ''}`}
                    key={approval.id}
                  >
                    <div className="run-card__header">
                      <div>
                        <h3>{approval.request.command}</h3>
                        <p>
                          {agent?.name ?? approval.upstreamAgentId ?? approval.id} ·{' '}
                          {approval.request.cwd
                            ? getWorkspaceLabel(approval.request.cwd)
                            : humanizeToken(approval.platform)}
                        </p>
                      </div>
                      <div className="run-card__aside">
                        <div className="pill-row">
                          <StatusPill tone={getApprovalStateTone(approval.state)}>
                            {humanizeToken(approval.state)}
                          </StatusPill>
                          <StatusPill tone={getAttentionTone(approval.attention)}>
                            {humanizeToken(approval.attention)}
                          </StatusPill>
                          <StatusPill tone={resolveSupport.supported ? 'success' : 'warning'}>
                            {resolveSupport.supported
                              ? isZh
                                ? '可处理'
                                : 'Actionable'
                              : isZh
                                ? '只读'
                                : 'Read-only'}
                          </StatusPill>
                          {renderTriagePills(triageStore[approval.id])}
                        </div>
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          onClick={() => {
                            focusApproval(approval.id, approval.runId)
                          }}
                        >
                          {isZh ? '审查' : 'Review'}
                        </button>
                      </div>
                    </div>

                    <p className="run-card__message">{describeApprovalSummary(approval)}</p>

                    <dl className="meta-grid">
                      <div>
                        <dt>{isZh ? 'Agent' : 'Agent'}</dt>
                        <dd>{agent?.name ?? approval.upstreamAgentId ?? '—'}</dd>
                      </div>
                      <div>
                        <dt>{isZh ? '观察时间' : 'Observed'}</dt>
                        <dd>{formatRelativeTime(approval.observedAt)}</dd>
                      </div>
                    </dl>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        <section className="panel operations-pane operations-pane--runs">
          <PanelHeader
            title={isZh ? '关注收件箱' : 'Attention Inbox'}
            subtitle={
              isZh
                ? '把等待输入、阻塞或需要人工动作的 run 聚合成可聚焦的处理面。'
                : 'A focused queue of runs waiting for input, blocked, or requiring operator intervention.'
            }
            count={visibleInbox.length}
          />

          {loading && !snapshot ? (
            <LoadingState message={isZh ? '正在加载收件箱…' : 'Loading inbox…'} />
          ) : visibleInbox.length === 0 ? (
            <EmptyState
              title={isZh ? '当前没有待处理 run' : 'No runs need attention'}
              description={
                isZh
                  ? '等待输入、暂停或阻塞中的 run 会显示在这里。'
                  : 'Runs waiting for input, paused, or blocked will appear here.'
              }
            />
          ) : (
            <ul className="run-card-list run-card-list--compact">
              {visibleInbox.map((run) => {
                const task = taskByRunId.get(run.id) ?? null
                const agent = agentLookup.get(run.agentId) ?? null
                const session =
                  task?.sessionKey
                    ? sessionLookup.get(task.sessionKey) ?? null
                    : agent
                      ? sessionLookup.get(deriveSessionDescriptorId(agent.id)) ?? null
                      : null
                const project =
                  task?.projectId
                    ? projectLookup.get(task.projectId) ?? null
                    : session?.projectId
                      ? projectLookup.get(session.projectId) ?? null
                      : null

                return (
                  <li
                    key={run.id}
                    className={`run-card run-card--compact${selectedRunId === run.id && !selectedApprovalId ? ' run-card--selected' : ''}`}
                  >
                    <div className="run-card__header">
                      <div>
                        <h3>{task?.title ?? run.title}</h3>
                        <p>
                          {project?.name ??
                            (session?.workspacePath || agent?.workspacePath
                              ? getWorkspaceLabel(session?.workspacePath ?? agent?.workspacePath ?? '')
                              : isZh
                                ? '未知工作区'
                                : 'Unknown workspace')}{' '}
                          ·{' '}
                          {session?.name ?? agent?.name ?? run.agentId}
                        </p>
                      </div>
                      <div className="run-card__aside">
                        <div className="pill-row">
                          <StatusPill tone={getRunStateTone(run.state)}>
                            {humanizeToken(run.state)}
                          </StatusPill>
                          <StatusPill tone={getAttentionTone(run.attention)}>
                            {humanizeToken(run.attention)}
                          </StatusPill>
                          {run.waitingReason ? (
                            <StatusPill tone="warning">
                              {humanizeToken(run.waitingReason)}
                            </StatusPill>
                          ) : null}
                        </div>
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          onClick={() => {
                            focusRunWorkload(run.id)
                          }}
                        >
                          {isZh ? '聚焦 run' : 'Focus run'}
                        </button>
                      </div>
                    </div>

                    <p className="run-card__message">{getRunSummary(run)}</p>

                    <div className="run-card__footer">
                      <div className="table-primary table-primary--compact">
                        <strong>{formatRelativeTime(run.lastEventAt)}</strong>
                        <span>
                          {session?.name ?? (isZh ? '未绑定会话' : 'Unbound session')}
                          {task ? ` · ${task.summary}` : ''}
                        </span>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        </div>
        </div>

        <div className="operations-secondary-grid">
        <section className="panel operations-pane operations-pane--runs">
          <PanelHeader
            title={isZh ? '活跃任务' : 'Active tasks'}
            subtitle={
              isZh
                ? '按 project / session / task 查看当前处于排队、运行、等待和暂停中的工作。'
                : 'Current work across queued, running, waiting, and paused projected tasks.'
            }
            count={filteredActiveTasks.length}
          />

          {loading && !snapshot ? (
            <LoadingState message={isZh ? '正在加载任务…' : 'Loading tasks…'} />
          ) : filteredActiveTasks.length === 0 ? (
            <EmptyState
              title={
                hasActiveFilters
                  ? isZh
                    ? '当前视图没有活跃任务'
                    : 'No active tasks in view'
                  : isZh
                    ? '当前没有活跃任务'
                    : 'No active tasks'
              }
              description={
                hasActiveFilters
                  ? isZh
                    ? '当前筛选条件把所有活跃任务都过滤掉了。'
                    : 'The current filters removed all active tasks from view.'
                  : isZh
                    ? '当控制面看到活跃工作后，对应任务会显示在这里。'
                    : 'Projected tasks will appear here once the control plane sees in-flight work.'
              }
            />
          ) : (
            <ul className="run-card-list run-card-list--compact">
              {filteredActiveTasks.map((task) => {
                const agent = agentLookup.get(task.agentId)
                const run = runLookup.get(task.runId) ?? null
                const project = projectLookup.get(task.projectId) ?? null
                const session = sessionLookup.get(task.sessionKey) ?? null
                return (
                  <li
                    key={task.id}
                    className={`run-card run-card--compact${selectedTask?.id === task.id ? ' run-card--selected' : ''}`}
                  >
                    <div className="run-card__header">
                      <div>
                        <h3>{task.title}</h3>
                        <p>
                          {project?.name ?? getWorkspaceLabel(task.workspacePath)} ·{' '}
                          {session?.name ?? agent?.name ?? task.agentId}
                        </p>
                      </div>
                      <div className="run-card__aside">
                        <div className="pill-row">
                          <StatusPill tone={getRunStateTone(task.state)}>
                            {humanizeToken(task.state)}
                          </StatusPill>
                          <StatusPill tone={getTaskPriorityTone(task.priority)}>
                            {humanizeToken(task.priority)}
                          </StatusPill>
                          <StatusPill tone={getAttentionTone(task.attention)}>
                            {humanizeToken(task.attention)}
                          </StatusPill>
                          {task.handoffTarget ? (
                            <StatusPill tone="warning">
                              {isZh ? '交接中' : 'Handoff'}
                            </StatusPill>
                          ) : null}
                        </div>
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          onClick={() => {
                            focusTask(task.id)
                          }}
                        >
                          {isZh ? '聚焦任务' : 'Focus task'}
                        </button>
                      </div>
                    </div>

                    <p className="run-card__message">{task.summary}</p>

                    <TaskProgressMeter task={task} />

                    <div className="run-card__footer">
                      <div className="table-primary table-primary--compact">
                        <strong>{formatRelativeTime(task.lastEventAt)}</strong>
                        <span>{describeTaskFooterMeta(task)}</span>
                      </div>
                      {run ? (
                        <RunActionButtons
                          agent={agent}
                          run={run}
                          pendingAction={pendingActions[run.id]}
                          onAction={handleRunAction}
                          compact
                        />
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="panel operations-pane operations-pane--runs">
          <PanelHeader
            title={isZh ? '会话看板' : 'Session Board'}
            subtitle={
              isZh
                ? '按会话身份查看当前工作区里的活跃、等待和最近更新的会话。'
                : 'Scan active, waiting, and recently updated sessions by stable session identity.'
            }
            count={filteredSessions.length}
          />

          {loading && !snapshot ? (
            <LoadingState message={isZh ? '正在加载会话…' : 'Loading sessions…'} />
          ) : filteredSessions.length === 0 ? (
            <EmptyState
              title={isZh ? '当前没有可见会话' : 'No sessions in view'}
              description={
                isZh
                  ? '调整筛选后，匹配的会话会显示在这里。'
                  : 'Adjust filters to bring matching sessions into view.'
              }
            />
          ) : (
            <ul className="run-card-list run-card-list--compact">
              {filteredSessions.map((session) => {
                const project = projectLookup.get(session.projectId) ?? null
                const run = session.currentRunId ? runLookup.get(session.currentRunId) ?? null : null
                return (
                  <li
                    key={session.id}
                    className={`run-card run-card--compact${selectedDetailSession?.id === session.id ? ' run-card--selected' : ''}`}
                  >
                    <div className="run-card__header">
                      <div>
                        <h3>{session.name}</h3>
                        <p>
                          {project?.name ?? getWorkspaceLabel(session.workspacePath)} ·{' '}
                          {humanizeToken(session.platform)}
                        </p>
                      </div>
                      <div className="run-card__aside">
                        <div className="pill-row">
                          <StatusPill tone={getRunStateTone(session.state)}>
                            {humanizeToken(session.state)}
                          </StatusPill>
                          <StatusPill tone={getAttentionTone(session.attention)}>
                            {humanizeToken(session.attention)}
                          </StatusPill>
                          <StatusPill tone={session.activeTaskCount > 0 ? 'info' : 'neutral'}>
                            {isZh
                              ? `${session.activeTaskCount} 个任务`
                              : `${session.activeTaskCount} task${session.activeTaskCount === 1 ? '' : 's'}`}
                          </StatusPill>
                        </div>
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          onClick={() => {
                            focusSession(session.id)
                          }}
                        >
                          {session.currentRunId
                            ? isZh
                              ? '聚焦会话'
                              : 'Focus session'
                            : isZh
                              ? '查看 agent'
                              : 'Inspect agent'}
                        </button>
                      </div>
                    </div>

                    <p className="run-card__message">
                      {session.summary ??
                        (isZh
                          ? '当前还没有会话摘要。'
                          : 'No session summary is available yet.')}
                    </p>

                    <div className="run-card__footer">
                      <div className="table-primary table-primary--compact">
                        <strong>
                          {formatRelativeTime(session.lastEventAt ?? session.updatedAt ?? null)}
                        </strong>
                        <span>
                          {run ? `${isZh ? '当前 run：' : 'Current run: '}${run.title}` : isZh ? '当前空闲' : 'Currently idle'}
                        </span>
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
        </div>
        </>
      ) : null}

      {activePage === 'agents' ? (
        <>
          <section className="panel agents-toolbar">
            <PanelHeader
              title={isZh ? 'Agents' : 'Agents'}
              subtitle={
                isZh
                  ? '把本地 agent 当作可管理的工作单元，而不是一排平铺的状态卡片。'
                  : 'Manage local agents as operator units instead of a flat wall of status cards.'
              }
              count={filteredAgents.length}
            />

            <div className="control-stats agents-summary-strip">
              <div className="control-stat">
                <span>{isZh ? '可见 agents' : 'Visible agents'}</span>
                <strong>{filteredAgents.length}</strong>
                <p>
                  {visibleWorkspaceCount === 0
                    ? isZh
                      ? '暂无工作区'
                      : 'No workspaces'
                    : isZh
                      ? `${visibleWorkspaceCount} 个工作区`
                      : `${visibleWorkspaceCount} workspace${visibleWorkspaceCount === 1 ? '' : 's'}`}
                </p>
              </div>
              <div className="control-stat">
                <span>{isZh ? '健康态势' : 'Healthy posture'}</span>
                <strong>
                  {filteredAgents.length > 0
                    ? `${healthyAgents.length}/${filteredAgents.length}`
                    : '0/0'}
                </strong>
                <p>
                  {attentionAgents.length === 0
                    ? isZh
                      ? '0 告警'
                      : '0 alerts'
                    : isZh
                      ? `${attentionAgents.length} 个告警`
                      : `${attentionAgents.length} alert${attentionAgents.length === 1 ? '' : 's'}`}
                </p>
              </div>
            </div>

            <div className="control-grid">
              <label className="control-field">
                <span>{isZh ? '搜索' : 'Search'}</span>
                <input
                  className="control-input"
                  type="search"
                  value={searchQuery}
                  placeholder={
                    isZh
                      ? '搜索 agents、workspaces 或 runtime'
                      : 'Search agents, workspaces, or runtimes'
                  }
                  onChange={(event) => {
                    setSearchQuery(event.target.value)
                  }}
                />
              </label>

              <label className="control-field">
                <span>{isZh ? '工作区' : 'Workspace'}</span>
                <select
                  className="control-input control-select"
                  value={workspaceFilter}
                  onChange={(event) => {
                    setWorkspaceFilter(event.target.value)
                  }}
                >
                  <option value="all">{isZh ? '全部工作区' : 'All workspaces'}</option>
                  {workspaceOptions.map((workspace) => (
                    <option key={workspace.path} value={workspace.path}>
                      {workspace.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="control-field">
                <span>{isZh ? '运行时' : 'Runtime'}</span>
                <select
                  className="control-input control-select"
                  value={platformFilter}
                  onChange={(event) => {
                    setPlatformFilter(event.target.value as PlatformFilterValue)
                  }}
                >
                  <option value="all">{isZh ? '全部运行时' : 'All runtimes'}</option>
                  <option value="copilot-cli">Copilot CLI</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="gemini-cli">Gemini CLI</option>
                  <option value="openclaw">OpenClaw</option>
                  <option value="generic">{isZh ? '通用接入' : 'Generic ingest'}</option>
                </select>
              </label>

              <label className="control-field">
                <span>{isZh ? '关注级别' : 'Attention'}</span>
                <select
                  className="control-input control-select"
                  value={attentionFilter}
                  onChange={(event) => {
                    setAttentionFilter(event.target.value as AttentionFilterValue)
                  }}
                >
                  <option value="all">{isZh ? '全部关注状态' : 'All attention states'}</option>
                  <option value="needs_attention">{isZh ? '需要关注' : 'Needs attention'}</option>
                  <option value="urgent">{isZh ? '紧急' : 'Urgent'}</option>
                  <option value="action_needed">
                    {isZh ? '需要动作' : 'Action needed'}
                  </option>
                  <option value="info">{isZh ? '信息提示' : 'Informational'}</option>
                  <option value="silent">{isZh ? '静默' : 'Silent'}</option>
                </select>
              </label>
            </div>

            <div className="agents-toolbar__actions">
              <button
                className="ghost-button ghost-button--compact"
                onClick={resetFilters}
                type="button"
              >
                {isZh ? '重置筛选' : 'Reset filters'}
              </button>
            </div>
          </section>

          <div className="agents-workspace">
            <section className="panel agents-pane agents-pane--directory">
              <PanelHeader
                title={isZh ? 'Agent 目录' : 'Agent directory'}
                subtitle={
                  isZh
                    ? '按 runtime 分组浏览当前可见 agents，并在右侧固定 inspector 中查看详细上下文。'
                    : 'Browse visible agents grouped by runtime, then inspect the selected one in the fixed detail pane.'
                }
                count={filteredAgents.length}
              />

              {loading && !snapshot ? (
                <LoadingState message={isZh ? '正在加载 agents…' : 'Loading agents…'} />
              ) : filteredAgents.length === 0 ? (
                <EmptyState
                  title={
                    hasActiveFilters
                      ? isZh
                        ? '当前视图没有 agent'
                        : 'No agents in view'
                      : isZh
                        ? '尚未注册 agent'
                        : 'No agents registered'
                  }
                  description={
                    hasActiveFilters
                      ? isZh
                        ? '当前筛选条件把所有 agent 都过滤掉了。'
                        : 'The current filters removed all agents from view.'
                      : isZh
                        ? 'agent 在向本地 hub 发送 heartbeat 后会显示在这里。'
                        : 'Agents will appear here after they heartbeat into the local hub.'
                  }
                />
              ) : (
                <div className="agent-group-stack">
                  {groupedAgents.map((group) => (
                    <section className="agent-group" key={group.platform}>
                      <header className="agent-group__header">
                        <div>
                          <h3>{group.label}</h3>
                          <p>
                            {group.activeCount > 0
                              ? isZh
                                ? `${group.activeCount} 个 agent 正在处理活跃 run，覆盖 ${group.workspaceCount} 个工作区。`
                                : `${group.activeCount} agent${group.activeCount === 1 ? '' : 's'} are handling active runs across ${group.workspaceCount} workspace${group.workspaceCount === 1 ? '' : 's'}.`
                              : isZh
                                ? `当前没有活跃 run，覆盖 ${group.workspaceCount} 个工作区。`
                                : `No active runs right now across ${group.workspaceCount} workspace${group.workspaceCount === 1 ? '' : 's'}.`}
                          </p>
                        </div>
                        <div className="pill-row">
                          <StatusPill tone={group.attentionCount > 0 ? 'warning' : 'success'}>
                            {isZh
                              ? `${group.healthyCount}/${group.agents.length} 健康`
                              : `${group.healthyCount}/${group.agents.length} healthy`}
                          </StatusPill>
                          <StatusPill tone="info">
                            {isZh
                              ? `${group.workspaceCount} 个工作区`
                              : `${group.workspaceCount} workspace${group.workspaceCount === 1 ? '' : 's'}`}
                          </StatusPill>
                        </div>
                      </header>

                      <ul className="agent-directory-list">
                        {group.agents.map((agent) => {
                          const currentRun = agent.currentRunId
                            ? runLookup.get(agent.currentRunId)
                            : null
                          const runtimeActions = listAvailableAgentRuntimeActions(agent)
                          const isSelected = agent.id === selectedAgentId

                          return (
                            <li key={agent.id}>
                              <button
                                className={`agent-row agent-row--directory${isSelected ? ' agent-row--selected' : ''}`}
                                type="button"
                                onClick={() => {
                                  focusAgent(agent.id)
                                }}
                              >
                                <div className="agent-row__topline">
                                  <span className="surface-label">
                                    {getWorkspaceLabel(agent.workspacePath)}
                                  </span>
                                  <span className="surface-label surface-label--muted">
                                    {getAgentSourceLabel(agent)}
                                  </span>
                                </div>

                                <div className="agent-row__identity">
                                  <div>
                                    <h3>{agent.name}</h3>
                                    <p>
                                      {humanizeToken(agent.platform)} ·{' '}
                                      <span className="truncate-path">{agent.workspacePath}</span>
                                    </p>
                                  </div>
                                  <div className="pill-row">
                                    <StatusPill tone={getHealthTone(agent.health)}>
                                      {humanizeToken(agent.health)}
                                    </StatusPill>
                                    <StatusPill tone={getAttentionTone(agent.attention)}>
                                      {humanizeToken(agent.attention)}
                                    </StatusPill>
                                  </div>
                                </div>

                                <div className="agent-row__focus">
                                  <span className="agent-row__focus-label">
                                    {isZh ? '当前焦点' : 'Current focus'}
                                  </span>
                                  <strong>{currentRun?.title ?? (isZh ? '空闲' : 'Idle')}</strong>
                                  <p>
                                    {currentRun
                                      ? getRunSummary(currentRun)
                                      : isZh
                                        ? '等待下一个 run 或 heartbeat。'
                                        : 'Waiting for the next run or heartbeat.'}
                                  </p>
                                </div>

                                <dl className="meta-grid meta-grid--tight">
                                  <div>
                                    <dt>{isZh ? '心跳' : 'Heartbeat'}</dt>
                                    <dd>{formatRelativeTime(agent.lastHeartbeatAt)}</dd>
                                  </div>
                                  <div>
                                    <dt>{isZh ? '最近事件' : 'Latest event'}</dt>
                                    <dd>{formatRelativeTime(agent.lastEventAt)}</dd>
                                  </div>
                                  <div>
                                    <dt>{isZh ? '动作姿态' : 'Action posture'}</dt>
                                    <dd>
                                      {runtimeActions.length > 0
                                        ? isZh
                                          ? `${runtimeActions.length} 个本地动作`
                                          : `${runtimeActions.length} local action${runtimeActions.length === 1 ? '' : 's'}`
                                        : isZh
                                          ? '只读发现'
                                          : 'Read-only discovery'}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>{isZh ? '状态' : 'State'}</dt>
                                    <dd>{humanizeToken(agent.state)}</dd>
                                  </div>
                                </dl>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </section>

            <section className="panel panel--accent agents-pane agents-pane--detail">
              <PanelHeader
                title={isZh ? 'Agent 详情' : 'Agent detail'}
                subtitle={
                  isZh
                    ? '查看选中 agent 的当前焦点、工作区元数据、真实动作路径和最近事件。'
                    : 'Inspect the selected agent’s current focus, workspace metadata, truthful action path, and recent events.'
                }
                count={selectedWorkspaceTimeline.length}
              />

              {selectedWorkspaceAgent ? (
                <div className="inspector-stack">
                  <div className="inspector-header">
                    <div>
                      <h3>{selectedWorkspaceAgent.name}</h3>
                      <p className="inspector-subtitle">
                        {humanizeToken(selectedWorkspaceAgent.platform)} ·{' '}
                        <span className="truncate-path">
                          {selectedWorkspaceAgent.workspacePath}
                        </span>
                      </p>
                    </div>
                    <div className="pill-row">
                      <StatusPill tone={getHealthTone(selectedWorkspaceAgent.health)}>
                        {humanizeToken(selectedWorkspaceAgent.health)}
                      </StatusPill>
                      <StatusPill tone={getAttentionTone(selectedWorkspaceAgent.attention)}>
                        {humanizeToken(selectedWorkspaceAgent.attention)}
                      </StatusPill>
                    </div>
                  </div>

                  <div className="agent-inspector__focus">
                    <span className="inspector-label">
                      {isZh ? '当前焦点' : 'Current focus'}
                    </span>
                    <strong>
                      {selectedWorkspaceTask?.title ?? selectedWorkspaceRun?.title ?? (isZh ? '空闲' : 'Idle')}
                    </strong>
                    <p className="inspector-summary">
                      {selectedWorkspaceRun
                        ? getRunSummary(selectedWorkspaceRun)
                        : isZh
                          ? '当前没有绑定活跃 run，正在等待下一次本地心跳或新的工作负载。'
                          : 'No active run is bound right now; waiting for the next local heartbeat or workload.'}
                    </p>
                    {selectedWorkspaceRun ? (
                      <div className="action-group">
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          onClick={() => {
                            if (selectedWorkspaceTask) {
                              focusTask(selectedWorkspaceTask.id)
                              return
                            }
                            focusRun(selectedWorkspaceRun.id)
                          }}
                        >
                          {selectedWorkspaceTask
                            ? isZh
                              ? '在操作台中聚焦任务'
                              : 'Focus task in Operations'
                            : isZh
                              ? '在操作台中聚焦 run'
                              : 'Focus run in Operations'}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <dl className="meta-grid">
                    <div>
                      <dt>{isZh ? '状态' : 'State'}</dt>
                      <dd>{humanizeToken(selectedWorkspaceAgent.state)}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '来源' : 'Source'}</dt>
                      <dd>{getAgentSourceLabel(selectedWorkspaceAgent)}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '工作区' : 'Workspace'}</dt>
                      <dd>
                        <span className="truncate-path">
                          {selectedWorkspaceAgent.workspacePath}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>{isZh ? '心跳' : 'Heartbeat'}</dt>
                      <dd>{formatRelativeTime(selectedWorkspaceAgent.lastHeartbeatAt)}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '最近事件' : 'Latest event'}</dt>
                      <dd>{formatRelativeTime(selectedWorkspaceAgent.lastEventAt)}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '动作路径' : 'Action path'}</dt>
                      <dd>{describeRunActionSupportLabel(selectedWorkspaceRunActionSupport.code)}</dd>
                    </div>
                  </dl>

                  {selectedWorkspaceCopilotSessionMetadata ? (
                    <CopilotSessionContext
                      metadata={selectedWorkspaceCopilotSessionMetadata}
                      compact
                    />
                  ) : null}

                  <div className="inspector-action-groups">
                    <div className="inspector-action-group">
                      <span className="inspector-label">
                        {isZh ? '工作区工具' : 'Workspace tools'}
                      </span>
                      <div className="action-group">
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          onClick={() => {
                            void handleCopyValue(
                              selectedWorkspaceAgent.workspacePath,
                              isZh ? '工作区路径' : 'Workspace path',
                            )
                          }}
                        >
                          {isZh ? '复制路径' : 'Copy path'}
                        </button>
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          disabled={pendingWorkspaceActions[selectedWorkspaceAgent.id] !== undefined}
                          onClick={() => {
                            void handleWorkspaceAction(selectedWorkspaceAgent, 'finder')
                          }}
                        >
                          {pendingWorkspaceActions[selectedWorkspaceAgent.id] === 'finder'
                            ? isZh
                              ? '正在打开 Finder…'
                              : 'Opening Finder…'
                            : isZh
                              ? '在 Finder 中打开'
                              : 'Open Finder'}
                        </button>
                        <button
                          className="ghost-button ghost-button--compact"
                          type="button"
                          disabled={pendingWorkspaceActions[selectedWorkspaceAgent.id] !== undefined}
                          onClick={() => {
                            void handleWorkspaceAction(selectedWorkspaceAgent, 'terminal')
                          }}
                        >
                          {pendingWorkspaceActions[selectedWorkspaceAgent.id] === 'terminal'
                            ? isZh
                              ? '正在打开终端…'
                              : 'Opening Terminal…'
                            : isZh
                              ? '在终端中打开'
                              : 'Open Terminal'}
                        </button>
                        {hasAgentWorkspaceActionSupport(
                          selectedWorkspaceAgent,
                          'runtime_home',
                        ) ? (
                          <button
                            className="ghost-button ghost-button--compact"
                            type="button"
                            disabled={pendingWorkspaceActions[selectedWorkspaceAgent.id] !== undefined}
                            onClick={() => {
                              void handleWorkspaceAction(
                                selectedWorkspaceAgent,
                                'runtime_home',
                              )
                            }}
                          >
                            {pendingWorkspaceActions[selectedWorkspaceAgent.id] === 'runtime_home'
                              ? isZh
                                ? '正在打开运行时目录…'
                                : 'Opening runtime files…'
                              : isZh
                                ? '运行时目录'
                                : 'Runtime files'}
                          </button>
                        ) : null}
                        {hasAgentWorkspaceActionSupport(
                          selectedWorkspaceAgent,
                          'session_state',
                        ) ? (
                          <button
                            className="ghost-button ghost-button--compact"
                            type="button"
                            disabled={pendingWorkspaceActions[selectedWorkspaceAgent.id] !== undefined}
                            onClick={() => {
                              void handleWorkspaceAction(
                                selectedWorkspaceAgent,
                                'session_state',
                              )
                            }}
                          >
                            {pendingWorkspaceActions[selectedWorkspaceAgent.id] === 'session_state'
                              ? isZh
                                ? '正在打开会话路径…'
                                : 'Opening session path…'
                              : isZh
                                ? '会话路径'
                                : 'Session path'}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    <div className="inspector-action-group">
                      <span className="inspector-label">
                        {isZh ? '运行时动作' : 'Runtime actions'}
                      </span>
                      {hasAgentRuntimeControlSurface(selectedWorkspaceAgent) ? (
                        <RuntimeActionControls
                          agent={selectedWorkspaceAgent}
                          isZh={isZh}
                          availableActions={selectedWorkspaceRuntimeActions}
                          primarySupport={selectedWorkspaceRuntimeActionSupport}
                          promptSupport={selectedWorkspacePromptSupport}
                          pendingAction={pendingRuntimeActions[selectedWorkspaceAgent.id]}
                          draft={runtimePromptDrafts[selectedWorkspaceAgent.id] ?? ''}
                          emptyMessage={
                            selectedWorkspaceRun
                              ? describeRunActionSupportLabel(
                                  selectedWorkspaceRunActionSupport.code,
                                )
                              : isZh
                                ? '当前没有可验证的本地运行时动作。'
                                : 'No truthful local runtime action is available right now.'
                          }
                          onDraftChange={(value) => {
                            setRuntimePromptDrafts((current) => ({
                              ...current,
                              [selectedWorkspaceAgent.id]: value,
                            }))
                          }}
                          onAction={(nextAgent, action, options) => {
                            void handleRuntimeAction(nextAgent, action, options)
                          }}
                        />
                      ) : selectedWorkspaceRuntimeActions.length > 0 ? (
                        <div className="action-stack action-stack--compact">
                          <div className="action-group action-group--compact">
                            {selectedWorkspaceRuntimeActions.map((action) => (
                              <button
                                key={action}
                                className="ghost-button ghost-button--compact"
                                type="button"
                                disabled={
                                  pendingRuntimeActions[selectedWorkspaceAgent.id] !==
                                  undefined
                                }
                                onClick={() => {
                                  void handleRuntimeAction(selectedWorkspaceAgent, action)
                                }}
                              >
                                {pendingRuntimeActions[selectedWorkspaceAgent.id] ===
                                action
                                  ? action === 'reset_session'
                                    ? isZh
                                      ? '正在重置 session…'
                                      : 'Resetting session…'
                                    : isZh
                                      ? '正在恢复 gateway…'
                                      : 'Recovering gateway…'
                                  : humanizeAgentRuntimeAction(action)}
                              </button>
                            ))}
                          </div>
                          {selectedWorkspaceRuntimeActionSupport ? (
                            <p className="muted-text">
                              {describeAgentRuntimeActionSupportReason(
                                selectedWorkspaceRuntimeActionSupport.code,
                              )}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <p className="muted-text">
                          {selectedWorkspaceRun
                            ? describeRunActionSupportLabel(selectedWorkspaceRunActionSupport.code)
                            : isZh
                              ? '当前没有可验证的本地运行时动作。'
                              : 'No truthful local runtime action is available right now.'}
                        </p>
                      )}
                    </div>

                    <div className="inspector-action-group">
                      <span className="inspector-label">
                        {isZh ? '最近事件' : 'Recent events'}
                      </span>
                      {selectedWorkspaceTimeline.length === 0 ? (
                        <p className="muted-text">
                          {isZh
                            ? '当前还没有与这个 agent 相关的最近事件。'
                            : 'No recent events are currently associated with this agent.'}
                        </p>
                      ) : (
                        <ul className="agent-event-list">
                          {selectedWorkspaceTimeline.map((event) => (
                            <li className="agent-event-row" key={event.id}>
                              <div className="agent-event-row__meta">
                                <StatusPill tone={getAttentionTone(event.attention)}>
                                  {humanizeToken(event.type)}
                                </StatusPill>
                                <span>{formatRelativeTime(event.createdAt)}</span>
                              </div>
                              <p>{event.message}</p>
                              {describeEventLineageSummary(
                                event,
                                event.sessionKey ? sessionLookup.get(event.sessionKey) ?? null : null,
                                event.projectId ? projectLookup.get(event.projectId) ?? null : null,
                              ) ? (
                                <p className="muted-text">
                                  {describeEventLineageSummary(
                                    event,
                                    event.sessionKey
                                      ? sessionLookup.get(event.sessionKey) ?? null
                                      : null,
                                    event.projectId
                                      ? projectLookup.get(event.projectId) ?? null
                                      : null,
                                  )}
                                </p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <EmptyState
                  title={isZh ? '选择一个 agent' : 'Select an agent'}
                  description={
                    isZh
                      ? '从左侧分组目录中选择一个 agent，即可查看它的运行上下文与本地动作。'
                      : 'Select an agent from the grouped directory to inspect its runtime context and truthful local actions.'
                  }
                />
              )}
            </section>
          </div>
        </>
      ) : null}

      {activePage === 'activity' ? (
        <>
          <section className="panel activity-toolbar">
            <PanelHeader
              title={isZh ? '活动日志' : 'Activity log'}
              subtitle={
                isZh
                  ? '把最近事件变成可筛选、可选中、可追溯的操作者日志工作面。'
                  : 'Turn recent events into a filterable, inspectable operator log workspace.'
              }
              count={filteredEvents.length}
            />

            <div className="control-stats activity-summary-strip">
              <div className="control-stat">
                <span>{isZh ? '可见事件' : 'Visible events'}</span>
                <strong>{filteredEvents.length}</strong>
                <p>
                  {visibleEventWorkspaceCount === 0
                    ? isZh
                      ? '暂无工作区'
                      : 'No workspaces'
                    : isZh
                      ? `${visibleEventWorkspaceCount} 个工作区`
                      : `${visibleEventWorkspaceCount} workspace${visibleEventWorkspaceCount === 1 ? '' : 's'}`}
                </p>
              </div>
              <div className="control-stat">
                <span>{isZh ? '需要关注' : 'Needs attention'}</span>
                <strong>{attentionEventCount}</strong>
                <p>
                  {attentionEventCount === 0
                    ? isZh
                      ? '0 告警'
                      : '0 alerts'
                    : isZh
                      ? `${attentionEventCount} 个高优先事件`
                      : `${attentionEventCount} high-priority event${attentionEventCount === 1 ? '' : 's'}`}
                </p>
              </div>
            </div>

            <div className="control-grid">
              <label className="control-field">
                <span>{isZh ? '搜索' : 'Search'}</span>
                <input
                  className="control-input"
                  type="search"
                  value={searchQuery}
                  placeholder={
                    isZh
                      ? '搜索事件、agent 或 workspace'
                      : 'Search events, agents, or workspaces'
                  }
                  onChange={(event) => {
                    setSearchQuery(event.target.value)
                  }}
                />
              </label>

              <label className="control-field">
                <span>{isZh ? '工作区' : 'Workspace'}</span>
                <select
                  className="control-input control-select"
                  value={workspaceFilter}
                  onChange={(event) => {
                    setWorkspaceFilter(event.target.value)
                  }}
                >
                  <option value="all">{isZh ? '全部工作区' : 'All workspaces'}</option>
                  {workspaceOptions.map((workspace) => (
                    <option key={workspace.path} value={workspace.path}>
                      {workspace.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="control-field">
                <span>{isZh ? '运行时' : 'Runtime'}</span>
                <select
                  className="control-input control-select"
                  value={platformFilter}
                  onChange={(event) => {
                    setPlatformFilter(event.target.value as PlatformFilterValue)
                  }}
                >
                  <option value="all">{isZh ? '全部运行时' : 'All runtimes'}</option>
                  <option value="copilot-cli">Copilot CLI</option>
                  <option value="claude-code">Claude Code</option>
                  <option value="gemini-cli">Gemini CLI</option>
                  <option value="openclaw">OpenClaw</option>
                  <option value="generic">{isZh ? '通用接入' : 'Generic ingest'}</option>
                </select>
              </label>

              <label className="control-field">
                <span>{isZh ? '关注级别' : 'Attention'}</span>
                <select
                  className="control-input control-select"
                  value={attentionFilter}
                  onChange={(event) => {
                    setAttentionFilter(event.target.value as AttentionFilterValue)
                  }}
                >
                  <option value="all">{isZh ? '全部关注状态' : 'All attention states'}</option>
                  <option value="needs_attention">{isZh ? '需要关注' : 'Needs attention'}</option>
                  <option value="urgent">{isZh ? '紧急' : 'Urgent'}</option>
                  <option value="action_needed">
                    {isZh ? '需要动作' : 'Action needed'}
                  </option>
                  <option value="info">{isZh ? '信息提示' : 'Informational'}</option>
                  <option value="silent">{isZh ? '静默' : 'Silent'}</option>
                </select>
              </label>
            </div>

            <div className="activity-toolbar__actions">
              <button
                className="ghost-button ghost-button--compact"
                onClick={resetFilters}
                type="button"
              >
                {isZh ? '重置筛选' : 'Reset filters'}
              </button>
            </div>
          </section>

          <div className="activity-workspace">
            <section className="panel activity-pane activity-pane--list">
              <PanelHeader
                title={isZh ? '事件流' : 'Event stream'}
                subtitle={
                  isZh
                    ? '按时间浏览当前筛选范围内的事件，并选中一条事件查看上下文。'
                    : 'Browse events in the current scope and inspect one event at a time.'
                }
                count={filteredEvents.length}
              />

              {loading && !snapshot ? (
                <LoadingState message={isZh ? '正在加载活动…' : 'Loading activity…'} />
              ) : filteredEvents.length === 0 ? (
                <EmptyState
                  title={
                    hasActiveFilters
                      ? isZh
                        ? '当前视图没有最近活动'
                        : 'No recent activity in view'
                      : isZh
                        ? '暂无最近活动'
                        : 'No recent activity'
                  }
                  description={
                    hasActiveFilters
                      ? isZh
                        ? '当前筛选条件把最近事件都过滤掉了。'
                        : 'The current filters removed all recent events from view.'
                      : isZh
                        ? '当事件开始流动后，这里会按时间倒序显示。'
                        : 'Once events begin flowing, you’ll see them here in reverse chronological order.'
                  }
                />
              ) : (
                <ul className="event-list">
                  {filteredEvents.map((event) => {
                    const agent = agentLookup.get(event.agentId)
                    const run = event.runId ? runLookup.get(event.runId) : null
                    const isSelected = event.id === selectedEventId

                    return (
                      <li key={event.id}>
                        <button
                          className={`event-row event-row--selectable${isSelected ? ' event-row--selected' : ''}`}
                          type="button"
                          onClick={() => {
                            focusEvent(event.id)
                          }}
                        >
                          <div
                            className={`event-dot event-dot--${getAttentionTone(event.attention)}`}
                            aria-hidden="true"
                          />
                          <div className="event-row__body">
                            <div className="event-row__meta">
                              <StatusPill tone={getAttentionTone(event.attention)}>
                                {humanizeToken(event.type)}
                              </StatusPill>
                              <span>{agent?.name ?? event.agentId}</span>
                              <span>{formatDateTime(event.createdAt)}</span>
                            </div>
                            <p>{event.message}</p>
                            <p className="event-row__context">
                              {agent
                                ? `${getWorkspaceLabel(agent.workspacePath)} · ${humanizeToken(agent.platform)}`
                                : isZh
                                  ? '未知工作区'
                                  : 'Unknown workspace'}
                              {run ? ` · ${isZh ? 'Run：' : 'Run: '}${run.title}` : ''}
                            </p>
                            {describeEventLineageSummary(
                              event,
                              event.sessionKey ? sessionLookup.get(event.sessionKey) ?? null : null,
                              event.projectId ? projectLookup.get(event.projectId) ?? null : null,
                            ) ? (
                              <p className="muted-text">
                                {describeEventLineageSummary(
                                  event,
                                  event.sessionKey
                                    ? sessionLookup.get(event.sessionKey) ?? null
                                    : null,
                                  event.projectId
                                    ? projectLookup.get(event.projectId) ?? null
                                    : null,
                                )}
                              </p>
                            ) : null}
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>

            <section className="panel panel--accent activity-pane activity-pane--detail">
              <PanelHeader
                title={isZh ? '事件详情' : 'Event detail'}
                subtitle={
                  isZh
                    ? '查看选中事件的 agent、run、工作区和相关最近事件。'
                    : 'Inspect the selected event, its agent/run context, and related recent events.'
                }
                count={selectedEventTimeline.length}
              />

              {selectedEvent ? (
                <div className="inspector-stack">
                  <div className="inspector-header">
                    <div>
                      <h3>{humanizeToken(selectedEvent.type)}</h3>
                      <p className="inspector-subtitle">
                        {selectedEventAgent?.name ?? selectedEvent.agentId} ·{' '}
                        {formatDateTime(selectedEvent.createdAt)}
                      </p>
                    </div>
                    <div className="pill-row">
                      <StatusPill tone={getAttentionTone(selectedEvent.attention)}>
                        {humanizeToken(selectedEvent.attention)}
                      </StatusPill>
                      {selectedEvent.state ? (
                        <StatusPill tone={getRunStateTone(selectedEvent.state)}>
                          {humanizeToken(selectedEvent.state)}
                        </StatusPill>
                      ) : null}
                    </div>
                  </div>

                  <p className="inspector-summary">{selectedEvent.message}</p>

                  <dl className="meta-grid">
                    <div>
                      <dt>{isZh ? 'Agent' : 'Agent'}</dt>
                      <dd>{selectedEventAgent?.name ?? selectedEvent.agentId}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '工作区' : 'Workspace'}</dt>
                      <dd>
                        {selectedEventAgent ? (
                          <span className="truncate-path">
                            {selectedEventAgent.workspacePath}
                          </span>
                        ) : (
                          '—'
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{isZh ? '运行时' : 'Runtime'}</dt>
                      <dd>
                        {selectedEventAgent
                          ? humanizeToken(selectedEventAgent.platform)
                          : isZh
                            ? '未知'
                            : 'Unknown'}
                      </dd>
                    </div>
                    <div>
                      <dt>{isZh ? 'Run' : 'Run'}</dt>
                      <dd>
                        {selectedEventRun
                          ? selectedEventRun.title
                          : selectedEvent.runId ?? '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>{isZh ? '会话' : 'Session'}</dt>
                      <dd>{selectedEventSession?.name ?? selectedEvent.sessionKey ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '项目' : 'Project'}</dt>
                      <dd>{selectedEventProject?.name ?? selectedEvent.projectId ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '事件时间' : 'Event time'}</dt>
                      <dd>{formatDateTime(selectedEvent.createdAt)}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '动作路径' : 'Action path'}</dt>
                      <dd>
                        {selectedEventAgent
                          ? describeRunActionSupportLabel(
                              getRunActionSupport(selectedEventAgent).code,
                            )
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>{isZh ? '关联 ID' : 'Correlation ID'}</dt>
                      <dd>{selectedEvent.correlationId ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>{isZh ? '源事件 ID' : 'Source event ID'}</dt>
                      <dd>{selectedEvent.sourceEventId ?? '—'}</dd>
                    </div>
                  </dl>

                  <div className="inspector-action-groups">
                    <div className="inspector-action-group">
                      <span className="inspector-label">
                        {isZh ? '跳转动作' : 'Jump actions'}
                      </span>
                      <div className="action-group">
                        {selectedEventRun ? (
                          <button
                            className="ghost-button ghost-button--compact"
                            type="button"
                            onClick={() => {
                              if (selectedEventTask) {
                                focusTask(selectedEventTask.id)
                                return
                              }
                              focusRunWorkload(selectedEventRun.id)
                            }}
                          >
                            {selectedEventTask
                              ? isZh
                                ? '在操作台中聚焦任务'
                                : 'Focus task in Operations'
                              : isZh
                                ? '在操作台中聚焦 run'
                                : 'Focus run in Operations'}
                          </button>
                        ) : null}
                        {selectedEventAgent ? (
                          <button
                            className="ghost-button ghost-button--compact"
                            type="button"
                            onClick={() => {
                              focusAgent(selectedEventAgent.id)
                            }}
                          >
                            {isZh ? '查看 agent' : 'Inspect agent'}
                          </button>
                        ) : null}
                      </div>
                    </div>

                    <div className="inspector-action-group">
                      <span className="inspector-label">
                        {isZh ? '相关最近事件' : 'Related recent events'}
                      </span>
                      {selectedEventTimeline.length === 0 ? (
                        <p className="muted-text">
                          {isZh
                            ? '当前还没有与这条事件相关的最近记录。'
                            : 'No recent related events are currently associated with this log entry.'}
                        </p>
                      ) : (
                        <ul className="agent-event-list">
                          {selectedEventTimeline.map((event) => (
                            <li className="agent-event-row" key={event.id}>
                              <div className="agent-event-row__meta">
                                <StatusPill tone={getAttentionTone(event.attention)}>
                                  {humanizeToken(event.type)}
                                </StatusPill>
                                <span>{formatRelativeTime(event.createdAt)}</span>
                              </div>
                              <p>{event.message}</p>
                              {describeEventLineageSummary(
                                event,
                                event.sessionKey ? sessionLookup.get(event.sessionKey) ?? null : null,
                                event.projectId ? projectLookup.get(event.projectId) ?? null : null,
                              ) ? (
                                <p className="muted-text">
                                  {describeEventLineageSummary(
                                    event,
                                    event.sessionKey
                                      ? sessionLookup.get(event.sessionKey) ?? null
                                      : null,
                                    event.projectId
                                      ? projectLookup.get(event.projectId) ?? null
                                      : null,
                                  )}
                                </p>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <EmptyState
                  title={isZh ? '选择一条事件' : 'Select an event'}
                  description={
                    isZh
                      ? '从左侧日志流里选择一条事件，即可查看它对应的 agent、run 和相关上下文。'
                      : 'Select an event from the log stream to inspect its agent, run, and related context.'
                  }
                />
              )}
            </section>
          </div>
        </>
      ) : null}

      {activePage === 'references' ? (
        <>
            <section className="panel references-toolbar">
              <PanelHeader
                title={isZh ? '接入与参考' : 'Integrations & references'}
                subtitle={
                  isZh
                    ? '把当前可接入的本地集成方式、下一阶段能力，以及可复用上游项目放在同一页里查看。'
                    : 'Review local integration routes, next capabilities, and upstream tools worth reusing in one place.'
                }
              />

            <div className="control-stats references-summary-strip">
              <div className="control-stat">
                <span>{isZh ? '接入通道' : 'Integration routes'}</span>
                <strong>{integrations.length}</strong>
              </div>
              <div className="control-stat">
                <span>{isZh ? '下一阶段能力' : 'Next capabilities'}</span>
                <strong>{roadmapCapabilities.length}</strong>
              </div>
              <div className="control-stat">
                <span>{isZh ? '参考项目' : 'Reference projects'}</span>
                <strong>{references.length}</strong>
              </div>
              <div className="control-stat">
                <span>{isZh ? '分组领域' : 'Categories'}</span>
                <strong>{groupedReferences.length}</strong>
              </div>
            </div>
          </section>

          <div className="references-workspace">
            <section className="panel panel--accent references-pane references-pane--capabilities">
              <PanelHeader
                title={isZh ? '接入路径与下一阶段能力' : 'Integration routes & next capabilities'}
                subtitle={
                  isZh
                    ? '先看当前已经能接的本地集成方式，再看下一阶段要补齐的能力切片。'
                    : 'Start with the local integration surfaces already available, then review the next capability slices to land.'
                }
                count={integrations.length + roadmapCapabilities.length}
              />

              <div className="reference-group-stack">
                <section className="reference-group">
                  <div className="reference-group__header">
                    <div>
                      <h3>{isZh ? '本地接入通道' : 'Local integration routes'}</h3>
                      <p>
                        {isZh
                          ? '直接暴露当前 Agent Hub 已开放的 ingest 接入面，让外部项目负责人不必翻后端代码。'
                          : 'Expose the current ingest surfaces directly in the dashboard so external project owners do not need to read backend routes.'}
                      </p>
                    </div>
                    <StatusPill tone="info">{String(integrations.length)}</StatusPill>
                  </div>

                  {integrationsError ? (
                    <div className="banner banner--error" role="alert">
                      <div>
                        <strong>{isZh ? '接入目录不可用' : 'Integration catalog unavailable'}</strong>
                        <p>{integrationsError}</p>
                      </div>
                    </div>
                  ) : integrations.length === 0 ? (
                    <EmptyState
                      title={isZh ? '暂无可见接入通道' : 'No integration routes loaded'}
                      description={
                        isZh
                          ? '当 /api/integrations 可用时，这里会展示当前实例开放的本地接入能力。'
                          : 'Available local integration routes will appear here once /api/integrations is reachable.'
                      }
                    />
                  ) : (
                    <ul className="integration-card-list">
                      {integrations.map((integration) => (
                        <IntegrationCard
                          integration={integration}
                          key={integration.id}
                          onCopy={handleCopyValue}
                        />
                      ))}
                    </ul>
                  )}
                </section>

                <section className="reference-group">
                  <div className="reference-group__header">
                    <div>
                      <h3>{isZh ? '下一阶段能力' : 'Next capabilities'}</h3>
                      <p>
                        {isZh
                          ? '围绕目标和验收标准，优先补齐最能提升真实可见性和操作者能力的功能。'
                          : 'Purpose-driven work that most improves truthful visibility and operator control next.'}
                      </p>
                    </div>
                    <StatusPill tone="warning">{String(roadmapCapabilities.length)}</StatusPill>
                  </div>

                  <ul className="capability-grid capability-grid--stacked">
                    {roadmapCapabilities.map((capability) => (
                      <CapabilityCard key={capability.id} {...capability} />
                    ))}
                  </ul>
                </section>
              </div>
            </section>

            <section className="panel references-pane references-pane--library">
              <PanelHeader
                title={isZh ? '参考项目' : 'Reference projects'}
                subtitle={
                  isZh
                    ? '优先复用高 star 上游项目，而不是在 Agent Hub 里重复造轮子。'
                    : 'Reuse strong upstream tools first instead of rebuilding them inside Agent Hub.'
                }
                count={references.length}
              />

              {referencesError ? (
                <div className="banner banner--error" role="alert">
                  <div>
                    <strong>{isZh ? '参考目录不可用' : 'Reference catalog unavailable'}</strong>
                    <p>{referencesError}</p>
                  </div>
                </div>
              ) : references.length === 0 ? (
                <EmptyState
                  title={isZh ? '暂无参考项目' : 'No reference projects loaded'}
                  description={
                    isZh
                      ? '当 /api/references 可用时，这里会展示整理好的上游 GitHub 项目。'
                      : 'Curated upstream GitHub projects will appear here when /api/references is reachable.'
                  }
                />
              ) : (
                <div className="reference-group-stack">
                  {groupedReferences.map((group) => (
                    <section className="reference-group" key={group.category}>
                      <div className="reference-group__header">
                        <div>
                          <h3>{getReferenceCategoryLabel(group.category)}</h3>
                          <p>
                            {isZh
                              ? `该分组包含 ${group.references.length} 个可优先复用的上游项目。`
                              : `${group.references.length} upstream project${group.references.length === 1 ? '' : 's'} worth reusing first.`}
                          </p>
                        </div>
                        <StatusPill tone={getReferenceCategoryTone(group.category)}>
                          {String(group.references.length)}
                        </StatusPill>
                      </div>

                      <ul className="reference-grid reference-grid--stacked">
                        {group.references.map((reference) => (
                          <li className="reference-card" key={reference.id}>
                            <div className="reference-card__header">
                              <div>
                                <h3>{reference.name}</h3>
                                <p>{reference.summary}</p>
                              </div>
                              <div className="pill-row">
                                <StatusPill tone={getReferenceCategoryTone(reference.category)}>
                                  {getReferenceCategoryLabel(reference.category)}
                                </StatusPill>
                              </div>
                            </div>

                            <dl className="meta-grid meta-grid--tight">
                              <div>
                                <dt>{isZh ? 'Stars' : 'Stars'}</dt>
                                <dd>{formatStars(reference.stars)}</dd>
                              </div>
                              <div>
                                <dt>{isZh ? '语言' : 'Language'}</dt>
                                <dd>{reference.language}</dd>
                              </div>
                            </dl>

                            <div className="reference-card__body">
                              <div>
                                <h4>{isZh ? '复用价值' : 'Reuse'}</h4>
                                <p>{reference.reuseInsteadOfBuilding}</p>
                              </div>
                              <div>
                                <h4>{isZh ? 'Hub 契合点' : 'Hub fit'}</h4>
                                <p>{reference.hubIntegration}</p>
                              </div>
                            </div>

                            <div className="reference-card__actions">
                              <a
                                className="ghost-button reference-link"
                                href={reference.repoUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {isZh ? '打开 GitHub 仓库' : 'Open GitHub repo'}
                              </a>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      ) : null}

      <footer className="app-footer">
        <span>
          {isZh ? '快照：' : 'Snapshot: '}
          {snapshot
            ? formatDateTime(snapshot.generatedAt)
            : isZh
              ? '等待首次响应'
              : 'Awaiting first response'}
        </span>
        <span>
          {isZh ? 'Mock runtime：' : 'Mock runtime: '}
          {health
            ? health.mockRuntimeEnabled
              ? isZh
                ? '已启用'
                : 'Enabled'
              : isZh
                ? '已关闭'
                : 'Disabled'
            : isZh
              ? '未知'
              : 'Unknown'}
        </span>
        <span>
          {isZh ? 'Copilot 发现：' : 'Copilot discovery: '}
          {health
            ? health.copilotSessionDiscoveryEnabled
              ? isZh
                ? '已启用'
                : 'Enabled'
              : isZh
                ? '已关闭'
                : 'Disabled'
            : isZh
              ? '未知'
              : 'Unknown'}
        </span>
        <span>
          {isZh ? 'Claude 发现：' : 'Claude discovery: '}
          {health
            ? health.claudeCodeSessionDiscoveryEnabled
              ? isZh
                ? '已启用'
                : 'Enabled'
              : isZh
                ? '已关闭'
                : 'Disabled'
            : isZh
              ? '未知'
              : 'Unknown'}
        </span>
        <span>
          {isZh ? 'Gemini 发现：' : 'Gemini discovery: '}
          {health
            ? health.geminiCliSessionDiscoveryEnabled
              ? isZh
                ? '已启用'
                : 'Enabled'
              : isZh
                ? '已关闭'
                : 'Disabled'
            : isZh
              ? '未知'
              : 'Unknown'}
        </span>
        <span>
          {isZh ? 'OpenClaw 发现：' : 'OpenClaw discovery: '}
          {health
            ? health.openClawSessionDiscoveryEnabled
              ? isZh
                ? '已启用'
                : 'Enabled'
              : isZh
                ? '已关闭'
                : 'Disabled'
            : isZh
              ? '未知'
              : 'Unknown'}
        </span>
        <span>
          {isZh ? '桌面通知：' : 'Desktop notifications: '}
          {health ? describeNotificationState(health) : isZh ? '未知' : 'Unknown'}
        </span>
        <span>
          {isZh ? '筛选视图：' : 'Filters: '}
          {hasActiveFilters || showTriaged
            ? isZh
              ? '已自定义'
              : 'Operator view customized'
            : isZh
              ? '默认'
              : 'Default'}
        </span>
        <span>{isZh ? '每 30 秒轮询兜底一次' : 'Polling fallback every 30s'}</span>
      </footer>
        </main>
      </div>
    </div>
  )
}

function PanelHeader(props: {
  title: string
  subtitle: string
  count?: number
}) {
  return (
    <header className="panel__header">
      <div>
        <h2>{props.title}</h2>
        <p>{props.subtitle}</p>
      </div>
      {props.count !== undefined ? <span className="panel__count">{props.count}</span> : null}
    </header>
  )
}

function StatCard(props: {
  label: string
  value: string
  meta: string
  tone: StatusTone
}) {
  return (
    <article className={`stat-card stat-card--${props.tone}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <p>{props.meta}</p>
    </article>
  )
}

function RuntimeActionControls(props: {
  agent: AgentDescriptor
  isZh: boolean
  availableActions: AgentRuntimeActionTarget[]
  primarySupport: AgentRuntimeActionSupport | null
  promptSupport: AgentRuntimeActionSupport
  pendingAction?: AgentRuntimeActionTarget
  draft: string
  emptyMessage?: string
  showPromptComposer?: boolean
  onDraftChange: (value: string) => void
  onAction: (
    agent: AgentDescriptor,
    target: AgentRuntimeActionTarget,
    options?: { message?: string; onSuccess?: () => void },
  ) => void
}) {
  const isBusy = props.pendingAction !== undefined
  const runtimeNote = describeAgentRuntimeControlNote(props.agent)

  return (
    <div className="action-stack action-stack--compact">
      {props.availableActions.length > 0 ? (
        <div className="action-group action-group--compact">
          {props.availableActions.map((action) => (
            <button
              key={action}
              className="ghost-button ghost-button--compact"
              type="button"
              disabled={isBusy}
              onClick={() => {
                props.onAction(props.agent, action)
              }}
            >
              {props.pendingAction === action
                ? action === 'reset_session'
                  ? props.isZh
                    ? '正在重置 session…'
                    : 'Resetting session…'
                  : props.isZh
                    ? '正在恢复 gateway…'
                    : 'Recovering gateway…'
                : humanizeAgentRuntimeAction(action)}
            </button>
          ))}
        </div>
      ) : props.emptyMessage ? (
        <p className="muted-text">{props.emptyMessage}</p>
      ) : null}

      {props.showPromptComposer !== false ? (
        <div className="runtime-prompt-composer">
          <div className="runtime-prompt-composer__header">
            <span className="inspector-label">
              {props.isZh ? '发送 prompt' : 'Dispatch prompt'}
            </span>
            <span className="muted-text">
              {props.agent.sessionMetadata?.sessionId
                ? props.isZh
                  ? `会话 ${props.agent.sessionMetadata.sessionId}`
                  : `Session ${props.agent.sessionMetadata.sessionId}`
                : props.isZh
                  ? '等待会话可见后再派发'
                  : 'Wait until a live session is visible'}
            </span>
          </div>
          <textarea
            className="runtime-prompt-composer__input"
            aria-label={describeRuntimePromptInputLabel(props.agent)}
            maxLength={MAX_RUNTIME_PROMPT_LENGTH}
            rows={4}
            value={props.draft}
            onChange={(event) => {
              props.onDraftChange(event.target.value)
            }}
            placeholder={describeRuntimePromptPlaceholder(props.agent)}
          />
          <div className="runtime-prompt-composer__footer">
            <span className="muted-text">
              {props.draft.length}/{MAX_RUNTIME_PROMPT_LENGTH}
            </span>
            <button
              className="ghost-button ghost-button--compact"
              type="button"
              disabled={
                isBusy || !props.promptSupport.supported || props.draft.trim().length === 0
              }
              onClick={() => {
                props.onAction(props.agent, 'send_prompt', {
                  message: props.draft,
                  onSuccess: () => {
                    props.onDraftChange('')
                  },
                })
              }}
            >
              {props.pendingAction === 'send_prompt'
                ? props.isZh
                  ? '正在派发 prompt…'
                  : 'Dispatching prompt…'
                : props.isZh
                  ? '派发 prompt'
                  : 'Dispatch prompt'}
            </button>
          </div>
        </div>
      ) : null}

      {props.primarySupport ? (
        <p className="muted-text">
          {describeAgentRuntimeActionSupportReason(props.primarySupport.code)}
        </p>
      ) : null}
      {runtimeNote ? <p className="muted-text">{runtimeNote}</p> : null}
      {props.showPromptComposer !== false ? (
        <p className="muted-text">
          {describeAgentRuntimeActionSupportReason(props.promptSupport.code)}
        </p>
      ) : null}
    </div>
  )
}

function SessionActionControls(props: {
  agent: AgentDescriptor
  session: SessionDescriptor
  isZh: boolean
  promptSupport: AgentRuntimeActionSupport
  attachSupport: SessionTerminalAttachSupport
  pendingAction?: SessionActionTarget
  draft: string
  onDraftChange: (value: string) => void
  onAction: (
    session: SessionDescriptor,
    agent: AgentDescriptor,
    target: SessionActionTarget,
    options?: { message?: string; onSuccess?: () => void },
  ) => void
}) {
  const isBusy = props.pendingAction !== undefined

  return (
    <div className="action-stack action-stack--compact">
      <p className="muted-text">
        {props.isZh
          ? `主控路径已切换到会话“${props.session.name}”，文本派发和终端附着都会绑定这条会话身份。`
          : `Primary control is now routed through session “${props.session.name}”, so prompt dispatch and terminal attach both stay bound to the same session identity.`}
      </p>

      <div className="action-group action-group--compact">
        <button
          className="ghost-button ghost-button--compact"
          type="button"
          disabled={isBusy || !props.attachSupport.supported}
          onClick={() => {
            props.onAction(props.session, props.agent, 'attach_terminal')
          }}
        >
          {props.pendingAction === 'attach_terminal'
            ? props.isZh
              ? '正在打开终端…'
              : 'Opening terminal…'
            : props.isZh
              ? '附着终端'
              : 'Attach terminal'}
        </button>
      </div>

      <div className="runtime-prompt-composer">
        <div className="runtime-prompt-composer__header">
          <span className="inspector-label">
            {props.isZh ? '会话派发' : 'Session dispatch'}
          </span>
          <span className="muted-text">
            {props.session.sessionId
              ? props.isZh
                ? `运行时会话 ${props.session.sessionId}`
                : `Runtime session ${props.session.sessionId}`
              : props.isZh
                ? '等待运行时会话可见'
                : 'Waiting for a live runtime session'}
          </span>
        </div>
        <textarea
          className="runtime-prompt-composer__input"
          aria-label={
            props.isZh
              ? `向会话 ${props.session.name} 派发 prompt`
              : `Dispatch prompt to session ${props.session.name}`
          }
          maxLength={MAX_RUNTIME_PROMPT_LENGTH}
          rows={4}
          value={props.draft}
          onChange={(event) => {
            props.onDraftChange(event.target.value)
          }}
          placeholder={describeRuntimePromptPlaceholder(props.agent)}
        />
        <div className="runtime-prompt-composer__footer">
          <span className="muted-text">
            {props.draft.length}/{MAX_RUNTIME_PROMPT_LENGTH}
          </span>
          <button
            className="ghost-button ghost-button--compact"
            type="button"
            disabled={isBusy || !props.promptSupport.supported || props.draft.trim().length === 0}
            onClick={() => {
              props.onAction(props.session, props.agent, 'dispatch_text', {
                message: props.draft,
                onSuccess: () => {
                  props.onDraftChange('')
                },
              })
            }}
          >
            {props.pendingAction === 'dispatch_text'
              ? props.isZh
                ? '正在派发 prompt…'
                : 'Dispatching prompt…'
              : props.isZh
                ? '派发到会话'
                : 'Dispatch to session'}
          </button>
        </div>
      </div>

      <p className="muted-text">
        {describeSessionTerminalAttachSupportReason(props.attachSupport)}
      </p>
      <p className="muted-text">
        {describeAgentRuntimeActionSupportReason(props.promptSupport.code)}
      </p>
    </div>
  )
}

function StatusPill(props: { tone: StatusTone; children: string }) {
  return (
    <span className={`status-pill status-pill--${props.tone}`}>{props.children}</span>
  )
}

function DiagnosticCard(props: RuntimeDiagnostic) {
  return (
    <article className={`diagnostic-card diagnostic-card--${props.tone}`}>
      <span className="diagnostic-card__eyebrow">{props.label}</span>
      <strong>{props.value}</strong>
      <p>{props.detail}</p>
    </article>
  )
}

function PageNavigation(props: {
  activePage: DashboardPage
  pages: DashboardPageDefinition[]
  onNavigate: (page: DashboardPage) => void
}) {
  const primaryPages = props.pages.filter((page) =>
    ['operations', 'agents', 'activity'].includes(page.id),
  )
  const secondaryPages = props.pages.filter(
    (page) => !['operations', 'agents', 'activity'].includes(page.id),
  )

  const renderPageButton = (page: DashboardPageDefinition) => (
    <button
      key={page.id}
      className={`page-nav__button${page.id === props.activePage ? ' page-nav__button--active' : ''}`}
      type="button"
      onClick={() => {
        props.onNavigate(page.id)
      }}
    >
      <span className="page-nav__label">{page.label}</span>
      {page.badge ? <span className="page-nav__badge">{page.badge}</span> : null}
    </button>
  )

  return (
    <nav className="page-nav" aria-label={currentLanguage === 'zh' ? '页面导航' : 'Page navigation'}>
      <div className="page-nav__group">
        <span className="page-nav__title">
          {currentLanguage === 'zh' ? '工作区' : 'Workspace'}
        </span>
        {primaryPages.map(renderPageButton)}
      </div>
      <div className="page-nav__group">
        <span className="page-nav__title">
          {currentLanguage === 'zh' ? '支持视图' : 'Support'}
        </span>
        {secondaryPages.map(renderPageButton)}
      </div>
    </nav>
  )
}

function SupportTopNavigation(props: {
  activePage: DashboardPage
  pages: DashboardPageDefinition[]
  onNavigate: (page: DashboardPage) => void
}) {
  const primaryPages = props.pages.filter((page) =>
    ['operations', 'agents', 'activity'].includes(page.id),
  )
  const secondaryPages = props.pages.filter((page) =>
    ['overview', 'references'].includes(page.id),
  )

  const renderPageButton = (page: DashboardPageDefinition) => (
    <button
      key={page.id}
      className={`support-nav__button${page.id === props.activePage ? ' support-nav__button--active' : ''}`}
      type="button"
      aria-current={page.id === props.activePage ? 'page' : undefined}
      onClick={() => {
        props.onNavigate(page.id)
      }}
    >
      <span className="support-nav__label">{page.label}</span>
    </button>
  )

  return (
    <nav
      className="panel support-topnav"
      aria-label={currentLanguage === 'zh' ? '支持页顶部导航' : 'Support top navigation'}
    >
      <div className="support-topnav__group">
        <span className="support-topnav__title">
          {currentLanguage === 'zh' ? '工作区' : 'Workspace'}
        </span>
        <div className="support-topnav__tabs">{primaryPages.map(renderPageButton)}</div>
      </div>
      <div className="support-topnav__group">
        <span className="support-topnav__title">
          {currentLanguage === 'zh' ? '支持视图' : 'Support'}
        </span>
        <div className="support-topnav__tabs">{secondaryPages.map(renderPageButton)}</div>
      </div>
    </nav>
  )
}

function CapabilityCard(props: RoadmapCapability) {
  return (
    <li className={`capability-card capability-card--${props.tone}`}>
      <div className="capability-card__header">
        <div>
          <h3>{props.title}</h3>
          <p>{props.summary}</p>
        </div>
        <StatusPill tone={props.tone}>{props.priorityLabel}</StatusPill>
      </div>

      <div className="capability-card__body">
        <div>
          <h4>{currentLanguage === 'zh' ? '为什么现在做' : 'Why now'}</h4>
          <p>{props.whyNow}</p>
        </div>
        <div>
          <h4>{currentLanguage === 'zh' ? '验收标准' : 'Acceptance'}</h4>
          <p>{props.acceptance}</p>
        </div>
      </div>
    </li>
  )
}

function IntegrationCard(props: {
  integration: IntegrationDescriptor
  onCopy: (value: string, label: string) => Promise<void> | void
}) {
  const [showExamplePayload, setShowExamplePayload] = useState(false)
  const commands = [
    props.integration.quickStartCommand
      ? {
          id: 'quick-start',
          label: currentLanguage === 'zh' ? '快速开始' : 'Quick start',
          value: props.integration.quickStartCommand,
        }
      : null,
    props.integration.watchCommand
      ? {
          id: 'watch',
          label: currentLanguage === 'zh' ? '持续观察' : 'Watch mode',
          value: props.integration.watchCommand,
        }
      : null,
    props.integration.runtimeBridgeCommand
      ? {
          id: 'runtime-bridge',
          label:
            currentLanguage === 'zh'
              ? '回传 send_prompt 的 sidecar'
              : 'Sidecar with send_prompt bridge',
          value: props.integration.runtimeBridgeCommand,
        }
      : null,
  ].filter(
    (
      entry,
    ): entry is {
      id: string
      label: string
      value: string
    } => Boolean(entry),
  )

  const examplePayload = props.integration.examplePayload
    ? JSON.stringify(props.integration.examplePayload, null, 2)
    : null
  const hasSupplementalMeta = Boolean(
    props.integration.entrypoint || props.integration.exampleStateFile,
  )
  const examplePayloadToggleLabel =
    currentLanguage === 'zh'
      ? showExamplePayload
        ? '收起 JSON'
        : '展开 JSON'
      : showExamplePayload
        ? 'Hide JSON'
        : 'Show JSON'
  const examplePayloadSummary =
    currentLanguage === 'zh'
      ? '默认折叠，避免接入卡被大段 JSON 撑得过高。'
      : 'Collapsed by default so the card stays scannable.'

  return (
    <li className="reference-card integration-card">
      <div className="reference-card__header">
        <div>
          <h3>{props.integration.name}</h3>
          <p>{props.integration.description}</p>
        </div>
        <div className="pill-row">
          <StatusPill tone="info">{props.integration.method}</StatusPill>
          <StatusPill tone="neutral">{props.integration.path}</StatusPill>
        </div>
      </div>

      <div className="integration-card__endpoint">
        <div className="integration-card__endpoint-header">
          <h4>{currentLanguage === 'zh' ? 'Endpoint' : 'Endpoint'}</h4>
          <button
            className="ghost-button ghost-button--compact"
            type="button"
            onClick={() => {
              void props.onCopy(
                props.integration.endpoint,
                currentLanguage === 'zh' ? '接入 endpoint' : 'Integration endpoint',
              )
            }}
          >
            {currentLanguage === 'zh' ? '复制 endpoint' : 'Copy endpoint'}
          </button>
        </div>
        <code className="integration-inline-code">{props.integration.endpoint}</code>
      </div>

      {hasSupplementalMeta ? (
        <dl className="meta-grid meta-grid--tight integration-card__meta">
          {props.integration.entrypoint ? (
            <div>
              <dt>{currentLanguage === 'zh' ? '入口文件' : 'Entrypoint'}</dt>
              <dd>{props.integration.entrypoint}</dd>
            </div>
          ) : null}
          {props.integration.exampleStateFile ? (
            <div>
              <dt>{currentLanguage === 'zh' ? '示例状态文件' : 'Example state file'}</dt>
              <dd>{props.integration.exampleStateFile}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {commands.length > 0 ? (
        <div className="integration-card__commands">
          {commands.map((command) => (
            <div className="integration-command" key={command.id}>
              <div className="integration-command__header">
                <h4>{command.label}</h4>
                <button
                  className="ghost-button ghost-button--compact"
                  type="button"
                  onClick={() => {
                    void props.onCopy(
                      command.value,
                      currentLanguage === 'zh' ? `${command.label}命令` : `${command.label} command`,
                    )
                  }}
                >
                  {currentLanguage === 'zh' ? '复制命令' : 'Copy command'}
                </button>
              </div>
              <pre className="integration-code-block">{command.value}</pre>
            </div>
          ))}
        </div>
      ) : null}

      {examplePayload ? (
        <div className="integration-disclosure">
          <div className="integration-disclosure__header">
            <div>
              <h4>{currentLanguage === 'zh' ? '示例 payload' : 'Example payload'}</h4>
              <p>{examplePayloadSummary}</p>
            </div>
            <div className="integration-disclosure__actions">
              <button
                className="ghost-button ghost-button--compact"
                type="button"
                onClick={() => {
                  void props.onCopy(
                    examplePayload,
                    currentLanguage === 'zh' ? '示例 JSON' : 'Example JSON',
                  )
                }}
              >
                {currentLanguage === 'zh' ? '复制 JSON' : 'Copy JSON'}
              </button>
              <button
                className="ghost-button ghost-button--compact"
                type="button"
                onClick={() => {
                  setShowExamplePayload((currentValue) => !currentValue)
                }}
              >
                {examplePayloadToggleLabel}
              </button>
            </div>
          </div>
          {showExamplePayload ? <pre className="integration-code-block">{examplePayload}</pre> : null}
        </div>
      ) : null}

      {props.integration.entrypoint ? (
        <div className="reference-card__actions">
          <button
            className="ghost-button ghost-button--compact"
            type="button"
            onClick={() => {
              void props.onCopy(
                props.integration.entrypoint ?? '',
                currentLanguage === 'zh' ? '入口文件' : 'Entrypoint',
              )
            }}
          >
            {currentLanguage === 'zh' ? '复制入口文件' : 'Copy entrypoint'}
          </button>
        </div>
      ) : null}
    </li>
  )
}

function EmptyState(props: { title: string; description: string }) {
  return (
    <div className="empty-state">
      <h3>{props.title}</h3>
      <p>{props.description}</p>
    </div>
  )
}

function LoadingState(props: { message: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <p>{props.message}</p>
    </div>
  )
}

function CopilotSessionContext(props: {
  metadata: AgentSessionMetadata
  compact?: boolean
}) {
  const summary =
    props.metadata.summary ??
    (currentLanguage === 'zh'
      ? '当前还没有可复用的持久 summary。'
      : 'No durable reusable summary captured yet.')

  return (
    <div className={`session-context${props.compact ? ' session-context--compact' : ''}`}>
      <div className="session-context__header">
        <span className="inspector-label">
          {currentLanguage === 'zh' ? 'Copilot 会话上下文' : 'Copilot session context'}
        </span>
        <p
          className={`session-context__summary${props.metadata.summary ? '' : ' session-context__summary--muted'}`}
        >
          {summary}
        </p>
      </div>

      <dl className="meta-grid meta-grid--tight">
        {!props.compact ? (
          <div>
            <dt>{currentLanguage === 'zh' ? '会话 ID' : 'Session ID'}</dt>
            <dd>
              <span className="truncate-path">{props.metadata.sessionId ?? '—'}</span>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{currentLanguage === 'zh' ? '开始于' : 'Started'}</dt>
          <dd>{formatRelativeTime(props.metadata.startedAt)}</dd>
        </div>
        <div>
          <dt>{currentLanguage === 'zh' ? '分支' : 'Branch'}</dt>
          <dd>{props.metadata.branch ?? '—'}</dd>
        </div>
        <div>
          <dt>{currentLanguage === 'zh' ? 'Copilot 版本' : 'Copilot'}</dt>
          <dd>{props.metadata.toolVersion ?? '—'}</dd>
        </div>
        <div>
          <dt>{currentLanguage === 'zh' ? '摘要快照' : 'Summaries'}</dt>
          <dd>{formatSummaryCount(props.metadata.summaryCount)}</dd>
        </div>
        {!props.compact ? (
          <>
            <div>
              <dt>{currentLanguage === 'zh' ? '会话模式' : 'Session mode'}</dt>
              <dd>{describeSessionMode(props.metadata.remoteSteerable)}</dd>
            </div>
            <div>
              <dt>{currentLanguage === 'zh' ? 'Git 根目录' : 'Git root'}</dt>
              <dd>
                <span className="truncate-path">{props.metadata.gitRoot ?? '—'}</span>
              </dd>
            </div>
          </>
        ) : null}
      </dl>
    </div>
  )
}

function TaskProgressMeter(props: { task: TaskDescriptor }) {
  const percent =
    typeof props.task.progress?.percent === 'number'
      ? clamp(props.task.progress.percent, 0, 100)
      : null

  const width = percent === null ? '18%' : `${percent}%`

  return (
    <div className="progress-stack">
      <div className="progress-bar" aria-hidden="true">
        <span className="progress-bar__fill" style={{ width }} />
      </div>
      <div className="table-primary table-primary--compact">
        <strong>{formatPercent(percent)}</strong>
        <span>{props.task.summary}</span>
      </div>
    </div>
  )
}

function getReferenceCategoryTone(category: ReferenceProjectCategory): StatusTone {
  switch (category) {
    case 'agent-workbench':
      return 'info'
    case 'workflow-builder':
      return 'success'
    case 'observability':
      return 'warning'
    default:
      return 'neutral'
  }
}

function getReferenceCategoryLabel(category: ReferenceProjectCategory) {
  switch (category) {
    case 'agent-workbench':
      return currentLanguage === 'zh' ? 'Agent 工作台' : 'Agent workbench'
    case 'workflow-builder':
      return currentLanguage === 'zh' ? '工作流构建器' : 'Workflow builder'
    case 'observability':
      return currentLanguage === 'zh' ? '可观测性' : 'Observability'
    default:
      return humanizeToken(category)
  }
}

function ApprovalActionButtons(props: {
  approval: ApprovalItem
  bridge: ApprovalBridgeStatus | null
  pendingAction?: ApprovalDecision
  onAction: (approval: ApprovalItem, decision: ApprovalDecision) => void
}) {
  const support = getApprovalResolveSupport(props.approval, props.bridge)
  const supportTone = getApprovalResolveSupportTone(support.code)
  const decisions: ApprovalDecision[] = ['allow-once', 'deny']

  return (
    <div className="action-stack">
      <div className="action-group">
        {decisions.map((decision) => {
          const isPending = props.pendingAction === decision
          const disabled = props.pendingAction !== undefined || !support.supported
          return (
            <button
              key={decision}
              className={`action-button action-button--${decision === 'allow-once' ? 'approve' : 'cancel'}${!support.supported ? ' action-button--unsupported' : ''}`}
              type="button"
              disabled={disabled}
              title={!support.supported ? describeApprovalResolveSupportReason(support.code) : undefined}
              onClick={() => {
                props.onAction(props.approval, decision)
              }}
            >
              {isPending
                ? `${humanizeToken(decision)}…`
                : humanizeToken(decision)}
            </button>
          )
        })}
      </div>
      <p className={`action-support-note action-support-note--${supportTone}`}>
        {describeApprovalResolveSupportReason(support.code)}
      </p>
    </div>
  )
}

function RunActionButtons(props: {
  agent?: AgentDescriptor | null
  run: AgentRun
  pendingAction?: RunAction
  onAction: (run: AgentRun, action: RunAction) => void
  compact?: boolean
}) {
  const actions = listAvailableRunActions(props.run)
  const actionSupport = getRunActionSupport(props.agent)
  const supportTone = getRunActionSupportTone(actionSupport.code)
  const supportNote = actionSupport.supported
    ? props.compact
      ? null
      : describeRunActionSupportReason(actionSupport.code)
    : describeRunActionSupportReason(actionSupport.code)

  if (actions.length === 0) {
    return (
      <span className="muted-text">
        {currentLanguage === 'zh' ? '无可用动作' : 'No actions'}
      </span>
    )
  }

  return (
    <div className={`action-stack${props.compact ? ' action-stack--compact' : ''}`}>
      <div className={`action-group${props.compact ? ' action-group--compact' : ''}`}>
        {actions.map((action) => {
          const isPending = props.pendingAction === action
          const disabled = props.pendingAction !== undefined || !actionSupport.supported
          const disabledReason = !actionSupport.supported
            ? describeRunActionSupportReason(actionSupport.code)
            : undefined

          return (
            <button
              key={action}
              className={`action-button action-button--${action}${!actionSupport.supported ? ' action-button--unsupported' : ''}`}
              disabled={disabled}
              title={disabledReason}
              onClick={() => {
                props.onAction(props.run, action)
              }}
            >
              {isPending ? `${humanizeToken(action)}…` : humanizeToken(action)}
            </button>
          )
        })}
      </div>
      {supportNote ? (
        <p
          className={`action-support-note action-support-note--${supportTone}${props.compact ? ' action-support-note--compact' : ''}`}
        >
          {supportNote}
        </p>
      ) : null}
    </div>
  )
}

function getRunActionSupportTone(code: RunActionSupportCode): StatusTone {
  switch (code) {
    case 'mock-runtime':
      return 'success'
    case 'agent-missing':
      return 'danger'
    default:
      return 'warning'
  }
}

function describeRunActionSupportLabel(code: RunActionSupportCode) {
  switch (code) {
    case 'mock-runtime':
      return currentLanguage === 'zh' ? 'Mock 运行控制' : 'Mock runtime control'
    case 'copilot-discovery-readonly':
      return currentLanguage === 'zh' ? 'Copilot 只读发现' : 'Read-only Copilot discovery'
    case 'claude-discovery-readonly':
      return currentLanguage === 'zh' ? 'Claude 只读发现' : 'Read-only Claude discovery'
    case 'gemini-discovery-readonly':
      return currentLanguage === 'zh' ? 'Gemini 只读发现' : 'Read-only Gemini discovery'
    case 'openclaw-discovery-readonly':
      return currentLanguage === 'zh' ? 'OpenClaw 只读发现' : 'Read-only OpenClaw discovery'
    case 'external-ingest-readonly':
      return currentLanguage === 'zh' ? '外部接入只读' : 'Read-only external ingest'
    case 'live-adapter-readonly':
      return currentLanguage === 'zh' ? 'Adapter 只读可见' : 'Read-only adapter visibility'
    default:
      return currentLanguage === 'zh' ? '元数据缺失' : 'Missing agent metadata'
  }
}

function describeRunActionSupportReason(code: RunActionSupportCode) {
  switch (code) {
    case 'mock-runtime':
      return currentLanguage === 'zh'
        ? '这些动作当前连接的是本地 mock runtime，用于演示和验证控制台流程，而不是上游真实平台。'
        : 'These actions are wired to the local mock runtime for demo and operator-flow validation, not to a live upstream platform.'
    case 'copilot-discovery-readonly':
      return currentLanguage === 'zh'
        ? '当前只把 Copilot 的 run 视图接成真实发现。Agent Hub 能看到这个 session，但 pause / resume / cancel 这类 run 动作在接上真实 run 控制桥之前仍保持只读。'
        : 'Agent Hub currently has truthful Copilot run discovery only. It can observe this session, but pause / resume / cancel stay read-only until a real Copilot run-control bridge exists.'
    case 'claude-discovery-readonly':
      return currentLanguage === 'zh'
        ? '当前只把 Claude Code 的 run 视图接成真实发现。Agent Hub 能看到这个 session，但 pause / resume / cancel 这类 run 动作在接上真实 run 控制桥之前仍保持只读。'
        : 'Agent Hub currently has truthful Claude Code run discovery only. It can observe this session, but pause / resume / cancel stay read-only until a real Claude Code run-control bridge exists.'
    case 'gemini-discovery-readonly':
      return currentLanguage === 'zh'
        ? '当前只把 Gemini CLI 的 run 视图接成真实发现。Agent Hub 能看到这个 session，但 pause / resume / cancel 这类 run 动作在接上真实 run 控制桥之前仍保持只读。'
        : 'Agent Hub currently has truthful Gemini CLI run discovery only. It can observe this session, but pause / resume / cancel stay read-only until a real Gemini CLI run-control bridge exists.'
    case 'openclaw-discovery-readonly':
      return currentLanguage === 'zh'
        ? '当前只把 OpenClaw 的 run 视图接成真实发现。Agent Hub 能看到这个 agent，但 pause / resume / cancel 这类 run 动作在接上真实 run 控制桥之前仍保持只读。'
        : 'Agent Hub currently has truthful OpenClaw run discovery only. It can observe this agent, but pause / resume / cancel stay read-only until a real OpenClaw run-control bridge exists.'
    case 'external-ingest-readonly':
      return currentLanguage === 'zh'
        ? '这个 runtime 通过外部 ingest 写入状态。它即使声明了独立的 send_prompt 桥，pause / resume / cancel 这类 run 动作也仍然保持只读，直到 adapter 另外声明真实的 run 控制桥。'
        : 'This runtime publishes state through external ingest. Even if it declares a separate send_prompt bridge, pause / resume / cancel stay read-only until that adapter also exposes a truthful run-action bridge.'
    case 'live-adapter-readonly':
      return currentLanguage === 'zh'
        ? '这个 runtime 已经可见，但还没有接入真实可执行的动作桥，所以当前保持只读。'
        : 'This runtime is visible in the hub, but no truthful action bridge has been wired yet, so it remains read-only.'
    default:
      return currentLanguage === 'zh'
        ? '当前快照里缺少这个 run 对应的 agent 元数据，请先刷新。'
        : 'The current snapshot is missing agent metadata for this run. Refresh before attempting actions.'
  }
}

function humanizeAgentRuntimeAction(action: AgentRuntimeActionTarget) {
  switch (action) {
    case 'recover_gateway':
      return currentLanguage === 'zh' ? '恢复 gateway' : 'Recover gateway'
    case 'reset_session':
      return currentLanguage === 'zh' ? '重置 session' : 'Reset session'
    case 'send_prompt':
      return currentLanguage === 'zh' ? '发送 prompt' : 'Send prompt'
  }
}

function describeAgentRuntimeActionSupportReason(
  code: AgentRuntimeActionSupportCode,
) {
  switch (code) {
    case 'openclaw-gateway-recovery':
      return currentLanguage === 'zh'
        ? 'OpenClaw gateway 当前不可达。Agent Hub 可以在本机重新执行 `openclaw gateway --force run`，尝试恢复这条真实本地链路。'
        : 'The OpenClaw gateway is currently unreachable. Agent Hub can try a local recovery by rerunning `openclaw gateway --force run` on this machine.'
    case 'openclaw-session-reset':
      return currentLanguage === 'zh'
        ? 'OpenClaw gateway 已连通，并且 Agent Hub 已发现这个 agent 的真实 session key，所以现在可以安全暴露 reset session。'
        : 'The OpenClaw gateway is reachable and Agent Hub has a truthful session key for this agent, so session reset can now be exposed safely.'
    case 'openclaw-prompt-dispatch':
      return currentLanguage === 'zh'
        ? 'OpenClaw gateway 已连通，并且 Agent Hub 已发现这个 agent 的真实 session id，所以现在可以向这个存活中的会话派发新 prompt。'
        : 'The OpenClaw gateway is reachable and Agent Hub has a truthful live session id for this agent, so a new prompt can be dispatched to that session.'
    case 'copilot-prompt-dispatch':
      return currentLanguage === 'zh'
        ? 'Agent Hub 已发现这个 Copilot 会话的本地 session id，所以现在可以通过 Copilot SDK 复连该会话并派发新 prompt。'
        : 'Agent Hub has a truthful local session id for this Copilot session, so it can resume the session through the Copilot SDK and dispatch a new prompt.'
    case 'claude-prompt-dispatch':
      return currentLanguage === 'zh'
        ? 'Agent Hub 已发现这个 Claude Code 会话的本地 session log，所以现在可以通过 `claude --resume` 复连该会话并派发新 prompt。'
        : 'Agent Hub has a truthful local Claude session log for this session, so it can resume it with `claude --resume` and dispatch a new prompt.'
    case 'gemini-prompt-dispatch':
      return currentLanguage === 'zh'
        ? 'Agent Hub 已发现这个 Gemini CLI 会话的本地 session 文件，所以现在可以通过 `gemini -p ... --resume <sessionId>` 复连该会话并派发新 prompt。'
        : 'Agent Hub has a truthful local Gemini CLI session file for this session, so it can resume it with `gemini -p ... --resume <sessionId>` and dispatch a new prompt.'
    case 'sidecar-prompt-dispatch':
      return currentLanguage === 'zh'
        ? '这个 sidecar 已声明一个本机 loopback callback，并明确暴露 send_prompt，所以 Agent Hub 现在可以把 prompt 回送给它。'
        : 'This sidecar has declared a local loopback callback and explicitly exposed send_prompt, so Agent Hub can now dispatch prompts back into it.'
    case 'openclaw-gateway-healthy':
      return currentLanguage === 'zh'
        ? 'OpenClaw gateway 当前可达，不需要执行恢复动作。'
        : 'The OpenClaw gateway is reachable right now, so no recovery action is needed.'
    case 'openclaw-session-unavailable':
      return currentLanguage === 'zh'
        ? '当前还不能暴露 reset session：需要同时满足 gateway 可达，并且 Agent Hub 已看到这个 agent 的真实 session key。'
        : 'Session reset is not exposed yet: Agent Hub needs both a reachable gateway and a truthful live session key for this agent.'
    case 'openclaw-prompt-unavailable':
      return currentLanguage === 'zh'
        ? '当前还不能派发 prompt：需要同时满足 gateway 可达，并且 Agent Hub 已看到这个 agent 的真实 session id。'
        : 'Prompt dispatch is not exposed yet: Agent Hub needs both a reachable gateway and a truthful live session id for this agent.'
    case 'copilot-prompt-unavailable':
      return currentLanguage === 'zh'
        ? '当前还不能给这个 Copilot 会话派发 prompt：Agent Hub 还没有看到可复连的本地 session id。'
        : 'Prompt dispatch is not exposed for this Copilot session yet: Agent Hub still needs a resumable local session id.'
    case 'claude-prompt-unavailable':
      return currentLanguage === 'zh'
        ? '当前还不能给这个 Claude Code 会话派发 prompt：Agent Hub 还没有同时看到可复连的 session id、session log 和可用的本地 Claude CLI。'
        : 'Prompt dispatch is not exposed for this Claude Code session yet: Agent Hub still needs a resumable session id, session log, and usable local Claude CLI.'
    case 'claude-auth-required':
      return currentLanguage === 'zh'
        ? '当前还不能给这个 Claude Code 会话派发 prompt：本机 Claude CLI 还没有登录。先执行 `claude auth login`。'
        : 'Prompt dispatch is not exposed for this Claude Code session yet: the local Claude CLI is not logged in. Run `claude auth login` first.'
    case 'gemini-prompt-unavailable':
      return currentLanguage === 'zh'
        ? '当前还不能给这个 Gemini CLI 会话派发 prompt：Agent Hub 还没有同时看到可复连的 session id、session 文件和可用的本地 Gemini auth。'
        : 'Prompt dispatch is not exposed for this Gemini CLI session yet: Agent Hub still needs a resumable session id, session file, and usable local Gemini auth.'
    case 'gemini-auth-required':
      return currentLanguage === 'zh'
        ? '当前还不能给这个 Gemini CLI 会话派发 prompt：本机 Gemini CLI 还没有配置可用的认证方式。先完成 Gemini auth。'
        : 'Prompt dispatch is not exposed for this Gemini CLI session yet: the local Gemini CLI does not have a usable auth method configured yet. Configure Gemini auth first.'
    case 'sidecar-prompt-unavailable':
      return currentLanguage === 'zh'
        ? '当前还不能给这个 external sidecar 派发 prompt：它还没有同时声明可达的本机 loopback callback 和 send_prompt 目标。'
        : 'Prompt dispatch is not exposed for this external sidecar yet: it still needs to declare both a reachable local loopback callback and the send_prompt target.'
    case 'unsupported-runtime':
      return currentLanguage === 'zh'
        ? '这个 runtime 还没有暴露真实可用的本地控制桥。'
        : 'This runtime does not expose a truthful local control bridge yet.'
    default:
      return currentLanguage === 'zh'
        ? '当前快照里缺少 agent 元数据，请先刷新。'
        : 'The current snapshot is missing agent metadata. Refresh before attempting recovery.'
  }
}

function describeSessionTerminalAttachSupportReason(
  support: SessionTerminalAttachSupport,
) {
  switch (support.code) {
    case 'claude-resume-terminal':
      return currentLanguage === 'zh'
        ? 'Claude Code 会通过 `claude --resume <sessionId>` 在本机 Terminal 中附着到这条真实会话。'
        : 'Claude Code will attach to this live session in Terminal via `claude --resume <sessionId>`.'
    case 'gemini-resume-terminal':
      return currentLanguage === 'zh'
        ? 'Gemini CLI 会通过 `gemini --resume <sessionId>` 在本机 Terminal 中附着到这条真实会话。'
        : 'Gemini CLI will attach to this live session in Terminal via `gemini --resume <sessionId>`.'
    case 'session-id-missing':
      return currentLanguage === 'zh'
        ? '当前还不能附着终端：Agent Hub 还没有看到这条会话可复连的运行时 session id。'
        : 'Terminal attach is not exposed yet because Agent Hub still needs a resumable runtime session id for this session.'
    case 'session-missing':
      return currentLanguage === 'zh'
        ? '当前还不能附着终端：快照里缺少可绑定的会话身份。'
        : 'Terminal attach is not exposed yet because the current snapshot does not include a bindable session identity.'
    case 'session-attach-unsupported-runtime':
      return currentLanguage === 'zh'
        ? '这个运行时在当前 slice 里还没有真实的会话附着路径。'
        : 'This runtime does not expose a truthful session attach path in the current slice.'
    default:
      return currentLanguage === 'zh'
        ? '当前快照里缺少会话附着所需的元数据。'
        : 'The current snapshot is missing the metadata required for truthful session attach.'
  }
}

function abbreviateIdentifier(value: string, edge = 6) {
  if (value.length <= edge * 2 + 1) {
    return value
  }

  return `${value.slice(0, edge)}…${value.slice(-edge)}`
}

function describeEventLineageSummary(
  event: AgentEvent,
  session?: SessionDescriptor | null,
  project?: ProjectDescriptor | null,
) {
  const parts: string[] = []

  const sessionLabel = session?.name ?? event.sessionKey
  if (sessionLabel) {
    parts.push(`${currentLanguage === 'zh' ? '会话' : 'Session'} ${sessionLabel}`)
  }

  const projectLabel =
    project?.name ??
    (event.projectId
      ? event.projectId.startsWith('project:')
        ? getWorkspaceLabel(event.projectId.slice('project:'.length))
        : event.projectId
      : null)
  if (projectLabel) {
    parts.push(`${currentLanguage === 'zh' ? '项目' : 'Project'} ${projectLabel}`)
  }

  if (event.correlationId) {
    parts.push(
      `${currentLanguage === 'zh' ? '关联' : 'Correlation'} ${abbreviateIdentifier(event.correlationId)}`,
    )
  }

  if (event.sourceEventId) {
    parts.push(
      `${currentLanguage === 'zh' ? '源事件' : 'Source'} ${abbreviateIdentifier(event.sourceEventId)}`,
    )
  }

  return parts.join(' · ')
}

function getRunSummary(run: AgentRun) {
  return (
    run.progress?.message ||
    (run.waitingReason ? humanizeToken(run.waitingReason) : humanizeToken(run.state))
  )
}

function describeApprovalSummary(approval: ApprovalItem) {
  const context = [approval.request.cwd, approval.request.security, approval.request.ask]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' · ')

  if (!context) {
    return currentLanguage === 'zh'
      ? '等待真实本地审批决策。'
      : 'Waiting for a truthful local approval decision.'
  }

  return currentLanguage === 'zh'
    ? `等待真实本地审批决策。${context}`
    : `Waiting for a truthful local approval decision. ${context}`
}

function getApprovalStateTone(state: ApprovalItem['state']): StatusTone {
  switch (state) {
    case 'pending':
      return 'warning'
    case 'resolved':
      return 'success'
    case 'expired':
      return 'danger'
    default:
      return 'neutral'
  }
}

function describeApprovalBridgeState(bridge: ApprovalBridgeStatus) {
  if (bridge.connected) {
    return currentLanguage === 'zh'
      ? `OpenClaw 审批桥已连接。该队列为 live-only 视图，自 ${formatDateTime(bridge.observedSince)} 起观测。`
      : `The OpenClaw approval bridge is connected. This queue is live-only and has been observed since ${formatDateTime(bridge.observedSince)}.`
  }

  return currentLanguage === 'zh'
    ? `OpenClaw 审批桥当前未连接。队列保持只读，且仅代表 Agent Hub 最近一次连接后看到的 live-only 状态。${bridge.lastError ? `错误：${bridge.lastError}` : ''}`
    : `The OpenClaw approval bridge is currently disconnected. The queue remains read-only and only reflects the live-only state seen since Agent Hub last connected.${bridge.lastError ? ` Error: ${bridge.lastError}` : ''}`
}

function describeApprovalResolveSupportLabel(
  code: ReturnType<typeof getApprovalResolveSupport>['code'],
) {
  switch (code) {
    case 'openclaw-bridge-live':
      return currentLanguage === 'zh' ? 'OpenClaw 实时审批桥' : 'OpenClaw live approval bridge'
    case 'approval-not-pending':
      return currentLanguage === 'zh' ? '审批已结束' : 'Approval no longer pending'
    default:
      return currentLanguage === 'zh'
        ? '审批桥未连接（只读）'
        : 'Approval bridge disconnected (read-only)'
  }
}

function describeApprovalResolveSupportReason(
  code: ReturnType<typeof getApprovalResolveSupport>['code'],
) {
  switch (code) {
    case 'openclaw-bridge-live':
      return currentLanguage === 'zh'
        ? 'OpenClaw live-only 审批桥已连接，因此 Agent Hub 现在可以真实地发出 allow once / deny。'
        : 'The live-only OpenClaw approval bridge is connected, so Agent Hub can now truthfully issue allow once / deny.'
    case 'approval-not-pending':
      return currentLanguage === 'zh'
        ? '这个审批项已经不再处于 pending 状态，不能继续决策。'
        : 'This approval is no longer pending, so it cannot be resolved again.'
    default:
      return currentLanguage === 'zh'
        ? 'OpenClaw 审批桥当前未连接，所以这个审批项暂时只能只读展示。'
        : 'The OpenClaw approval bridge is disconnected, so this approval remains read-only for now.'
  }
}

function getApprovalResolveSupportTone(
  code: ReturnType<typeof getApprovalResolveSupport>['code'],
): StatusTone {
  switch (code) {
    case 'openclaw-bridge-live':
      return 'success'
    case 'approval-not-pending':
      return 'neutral'
    default:
      return 'warning'
  }
}

function getSocketTone(status: SocketStatus): StatusTone {
  switch (status) {
    case 'open':
      return 'success'
    case 'connecting':
      return 'info'
    case 'reconnecting':
      return 'warning'
    default:
      return 'danger'
  }
}

function getRunStateTone(state: RunState): StatusTone {
  switch (state) {
    case 'running':
    case 'completed':
      return 'success'
    case 'ready':
    case 'queued':
    case 'starting':
      return 'info'
    case 'waiting_input':
    case 'paused':
      return 'warning'
    case 'failed':
    case 'cancelled':
    case 'offline':
      return 'danger'
    default:
      return 'neutral'
  }
}

function getHealthTone(health: AgentHealth): StatusTone {
  switch (health) {
    case 'healthy':
      return 'success'
    case 'degraded':
    case 'rate_limited':
      return 'warning'
    case 'stalled':
    case 'auth_required':
    case 'unavailable':
      return 'danger'
    default:
      return 'neutral'
  }
}

function getAttentionTone(attention: AgentAttention): StatusTone {
  switch (attention) {
    case 'urgent':
      return 'danger'
    case 'action_needed':
      return 'warning'
    case 'info':
      return 'info'
    default:
      return 'neutral'
  }
}

function getResourcePressureTone(pressure: ResourceDescriptor['pressure']): StatusTone {
  switch (pressure) {
    case 'overcommitted':
      return 'danger'
    case 'saturated':
      return 'warning'
    case 'available':
      return 'success'
    default:
      return 'neutral'
  }
}

function describeResourcePressure(pressure: ResourceDescriptor['pressure']) {
  switch (pressure) {
    case 'overcommitted':
      return currentLanguage === 'zh' ? '超载' : 'Overcommitted'
    case 'saturated':
      return currentLanguage === 'zh' ? '已打满' : 'Saturated'
    case 'available':
      return currentLanguage === 'zh' ? '可接新任务' : 'Available'
    default:
      return currentLanguage === 'zh' ? '空闲' : 'Idle'
  }
}

function describeResourceSlotLimit(slotLimit: number | null) {
  if (slotLimit === null) {
    return currentLanguage === 'zh' ? '无限制' : 'Unlimited'
  }

  return currentLanguage === 'zh' ? `${slotLimit} 个槽位` : `${slotLimit} slots`
}

function describeResourceUtilization(resource: ResourceDescriptor) {
  if (resource.slotLimit === null) {
    return currentLanguage === 'zh'
      ? `${resource.activeTaskCount} 个活跃任务 / 无上限`
      : `${resource.activeTaskCount} active / unlimited`
  }

  return currentLanguage === 'zh'
    ? `${resource.activeTaskCount} / ${resource.slotLimit} 槽位`
    : `${resource.activeTaskCount} / ${resource.slotLimit} slots`
}

function getTaskPriorityTone(priority: TaskPriority): StatusTone {
  switch (priority) {
    case 'critical':
      return 'danger'
    case 'high':
      return 'warning'
    case 'low':
      return 'neutral'
    default:
      return 'info'
  }
}

function needsAgentAttention(attention: AgentAttention) {
  return attention === 'action_needed' || attention === 'urgent'
}

function getStrongestRuntimeHealthIssue(agents: AgentDescriptor[]) {
  let authRequiredCount = 0
  let unavailableCount = 0
  let degradedCount = 0

  for (const agent of agents) {
    switch (agent.health) {
      case 'auth_required':
        authRequiredCount += 1
        break
      case 'unavailable':
        unavailableCount += 1
        break
      case 'healthy':
        break
      default:
        degradedCount += 1
        break
    }
  }

  if (authRequiredCount > 0) {
    return { kind: 'auth_required' as const, count: authRequiredCount }
  }

  if (unavailableCount > 0) {
    return { kind: 'unavailable' as const, count: unavailableCount }
  }

  if (degradedCount > 0) {
    return { kind: 'degraded' as const, count: degradedCount }
  }

  return { kind: 'healthy' as const, count: agents.length }
}

function describeVisibleRuntimeCount(
  count: number,
  unit: { zh: string; en: string },
) {
  return currentLanguage === 'zh'
    ? `${count} 个实时${unit.zh}`
    : `${count} live ${unit.en}${count === 1 ? '' : 's'}`
}

function describeRuntimeDiagnosticValue(
  visibleCount: number,
  unit: { zh: string; en: string },
  issue: ReturnType<typeof getStrongestRuntimeHealthIssue>,
) {
  const base = describeVisibleRuntimeCount(visibleCount, unit)

  switch (issue.kind) {
    case 'auth_required':
      return currentLanguage === 'zh'
        ? `${base} · ${issue.count} 个需认证`
        : `${base} · ${issue.count} auth required`
    case 'unavailable':
      return currentLanguage === 'zh'
        ? `${base} · ${issue.count} 个不可用`
        : `${base} · ${issue.count} unavailable`
    case 'degraded':
      return currentLanguage === 'zh'
        ? `${base} · ${issue.count} 个降级`
        : `${base} · ${issue.count} degraded`
    default:
      return base
  }
}

function describeRuntimeIssueDetail(args: {
  runtimeLabel: string
  visibleCount: number
  unit: { zh: string; en: string }
  issue: ReturnType<typeof getStrongestRuntimeHealthIssue>
  authLabel: { zh: string; en: string }
}) {
  const visible = describeVisibleRuntimeCount(args.visibleCount, args.unit)
  const issueLabelZh = `${args.issue.count} 个`
  const issueLabelEn = `${args.issue.count} ${args.unit.en}${args.issue.count === 1 ? '' : 's'}`
  const visibleVerbEn = args.visibleCount === 1 ? 'is' : 'are'
  const issueVerbEn = args.issue.count === 1 ? 'requires' : 'require'
  const issueStateVerbEn = args.issue.count === 1 ? 'is' : 'are'

  switch (args.issue.kind) {
    case 'auth_required':
      return currentLanguage === 'zh'
        ? `当前已看到 ${visible}，但其中 ${issueLabelZh} 仍需要${args.authLabel.zh}，所以 Agent Hub 还不会暴露 send_prompt。`
        : `${visible} ${visibleVerbEn} visible, but ${issueLabelEn} still ${issueVerbEn} ${args.authLabel.en}, so Agent Hub keeps send_prompt hidden.`
    case 'unavailable':
      return currentLanguage === 'zh'
        ? `当前已看到 ${visible}，但其中 ${issueLabelZh} 还无法证明可用的本机控制桥，所以可用控制面会比可见数量更窄。`
        : `${visible} ${visibleVerbEn} visible, but ${issueLabelEn} still cannot be matched to a usable local control bridge, so the available control surface is narrower than the visible count.`
    case 'degraded':
      return currentLanguage === 'zh'
        ? `当前已看到 ${visible}，但其中 ${issueLabelZh} 处于降级姿态，所以可用控制面可能比表面会话数更少。`
        : `${visible} ${visibleVerbEn} visible, but ${issueLabelEn} ${issueStateVerbEn} in a degraded posture, so the usable control surface may be narrower than the raw live count.`
    default:
      return currentLanguage === 'zh'
        ? `${args.runtimeLabel} 当前处于健康可控姿态。`
        : `${args.runtimeLabel} is currently in a healthy controllable posture.`
  }
}

function needsInboxAttention(run: AgentRun) {
  return (
    run.waitingReason !== null ||
    run.state === 'waiting_input' ||
    run.attention === 'action_needed' ||
    run.attention === 'urgent'
  )
}

function matchesProjectFilters(
  project: ProjectDescriptor,
  filters: {
    attentionFilter: AttentionFilterValue
    platformFilter: PlatformFilterValue
    searchQuery: string
    workspaceFilter: string
  },
) {
  if (filters.workspaceFilter !== 'all' && project.workspacePath !== filters.workspaceFilter) {
    return false
  }

  if (
    filters.platformFilter !== 'all' &&
    !project.runtimePlatforms.includes(filters.platformFilter)
  ) {
    return false
  }

  if (!matchesAttentionFilter(project.attention, filters.attentionFilter)) {
    return false
  }

  return matchesSearch(
    [
      project.id,
      project.name,
      project.workspacePath,
      project.gitRoot ?? '',
      ...project.runtimePlatforms,
    ],
    filters.searchQuery,
  )
}

function matchesSessionFilters(
  session: SessionDescriptor,
  filters: {
    attentionFilter: AttentionFilterValue
    platformFilter: PlatformFilterValue
    searchQuery: string
    workspaceFilter: string
  },
) {
  if (filters.workspaceFilter !== 'all' && session.workspacePath !== filters.workspaceFilter) {
    return false
  }

  if (filters.platformFilter !== 'all' && session.platform !== filters.platformFilter) {
    return false
  }

  if (!matchesAttentionFilter(session.attention, filters.attentionFilter)) {
    return false
  }

  return matchesSearch(
    [
      session.id,
      session.name,
      session.platform,
      session.workspacePath,
      session.sessionId ?? '',
      session.summary ?? '',
    ],
    filters.searchQuery,
  )
}

function matchesTaskFilters(
  task: TaskDescriptor,
  filters: {
    attentionFilter: AttentionFilterValue
    platformFilter: PlatformFilterValue
    searchQuery: string
    workspaceFilter: string
  },
) {
  if (filters.workspaceFilter !== 'all' && task.workspacePath !== filters.workspaceFilter) {
    return false
  }

  if (filters.platformFilter !== 'all' && task.platform !== filters.platformFilter) {
    return false
  }

  if (!matchesAttentionFilter(task.attention, filters.attentionFilter)) {
    return false
  }

  return matchesSearch(
    [
      task.id,
      task.runId,
      task.title,
      task.platform,
      task.priority,
      task.state,
      task.health,
      task.summary,
      task.owner ?? '',
      task.handoffTarget ?? '',
      task.handoffNote ?? '',
      task.workspacePath,
      task.runtimeSessionId ?? '',
      task.sessionPath ?? '',
    ],
    filters.searchQuery,
  )
}

function matchesAgentFilters(
  agent: AgentDescriptor,
  filters: {
    attentionFilter: AttentionFilterValue
    platformFilter: PlatformFilterValue
    searchQuery: string
    workspaceFilter: string
  },
) {
  if (filters.workspaceFilter !== 'all' && agent.workspacePath !== filters.workspaceFilter) {
    return false
  }

  if (filters.platformFilter !== 'all' && agent.platform !== filters.platformFilter) {
    return false
  }

  if (!matchesAttentionFilter(agent.attention, filters.attentionFilter)) {
    return false
  }

  return matchesSearch(
    [
      agent.id,
      agent.name,
      agent.platform,
      agent.workspacePath,
      agent.sessionMetadata?.sessionId ?? '',
      agent.sessionMetadata?.branch ?? '',
      agent.sessionMetadata?.summary ?? '',
      agent.sessionMetadata?.toolVersion ?? '',
      agent.sessionMetadata?.gitRoot ?? '',
    ],
    filters.searchQuery,
  )
}

function matchesRunFilters(
  run: AgentRun,
  agentLookup: Map<string, AgentDescriptor>,
  filters: {
    attentionFilter: AttentionFilterValue
    platformFilter: PlatformFilterValue
    searchQuery: string
    workspaceFilter: string
  },
) {
  const agent = agentLookup.get(run.agentId)

  if (filters.workspaceFilter !== 'all' && agent?.workspacePath !== filters.workspaceFilter) {
    return false
  }

  if (filters.platformFilter !== 'all' && agent?.platform !== filters.platformFilter) {
    return false
  }

  if (!matchesAttentionFilter(run.attention, filters.attentionFilter)) {
    return false
  }

  return matchesSearch(
    [
      run.id,
      run.title,
      run.state,
      run.health,
      run.progress?.message ?? '',
      agent?.name ?? '',
      agent?.workspacePath ?? '',
      agent?.sessionMetadata?.sessionId ?? '',
      agent?.sessionMetadata?.branch ?? '',
      agent?.sessionMetadata?.summary ?? '',
      agent?.sessionMetadata?.toolVersion ?? '',
    ],
    filters.searchQuery,
  )
}

function matchesApprovalFilters(
  approval: ApprovalItem,
  agentLookup: Map<string, AgentDescriptor>,
  filters: {
    attentionFilter: AttentionFilterValue
    platformFilter: PlatformFilterValue
    searchQuery: string
    workspaceFilter: string
  },
) {
  const agent = approval.agentId ? agentLookup.get(approval.agentId) : null

  if (filters.workspaceFilter !== 'all' && agent?.workspacePath !== filters.workspaceFilter) {
    return false
  }

  if (filters.platformFilter !== 'all' && approval.platform !== filters.platformFilter) {
    return false
  }

  if (!matchesAttentionFilter(approval.attention, filters.attentionFilter)) {
    return false
  }

  return matchesSearch(
    [
      approval.id,
      approval.platform,
      approval.state,
      approval.request.command,
      approval.request.cwd ?? '',
      approval.request.security ?? '',
      approval.request.ask ?? '',
      approval.request.sessionKey ?? '',
      approval.request.resolvedPath ?? '',
      approval.request.agentId ?? '',
      approval.request.host ?? '',
      agent?.name ?? '',
      agent?.workspacePath ?? '',
    ],
    filters.searchQuery,
  )
}

function matchesEventFilters(
  event: AgentEvent,
  agentLookup: Map<string, AgentDescriptor>,
  runLookup: Map<string, AgentRun>,
  filters: {
    attentionFilter: AttentionFilterValue
    platformFilter: PlatformFilterValue
    searchQuery: string
    workspaceFilter: string
  },
) {
  const agent = agentLookup.get(event.agentId)
  const run = event.runId ? runLookup.get(event.runId) : null

  if (filters.workspaceFilter !== 'all' && agent?.workspacePath !== filters.workspaceFilter) {
    return false
  }

  if (filters.platformFilter !== 'all' && agent?.platform !== filters.platformFilter) {
    return false
  }

  if (!matchesAttentionFilter(event.attention, filters.attentionFilter)) {
    return false
  }

  return matchesSearch(
    [
      event.type,
      event.message,
      agent?.name ?? '',
      agent?.workspacePath ?? '',
      agent?.sessionMetadata?.branch ?? '',
      agent?.sessionMetadata?.summary ?? '',
      run?.title ?? '',
    ],
    filters.searchQuery,
  )
}

function getCopilotSessionMetadata(
  agent: AgentDescriptor | null | undefined,
): AgentSessionMetadata | null {
  if (!agent || getAgentSourceKind(agent) !== 'copilot-session-state') {
    return null
  }

  return agent.sessionMetadata ?? null
}

function matchesAttentionFilter(
  attention: AgentAttention,
  filter: AttentionFilterValue,
) {
  if (filter === 'all') {
    return true
  }

  if (filter === 'needs_attention') {
    return attention === 'action_needed' || attention === 'urgent'
  }

  return attention === filter
}

function matchesSearch(values: string[], query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return true
  }

  return values.some((value) => value.toLowerCase().includes(normalizedQuery))
}

function loadTriageStore(): RunTriageStore {
  try {
    const raw = window.localStorage.getItem(LOCAL_TRIAGE_STORAGE_KEY)
    if (!raw) {
      return {}
    }

    return normalizeTriageStore(JSON.parse(raw) as RunTriageStore)
  } catch {
    return {}
  }
}

function persistTriageStore(value: RunTriageStore) {
  try {
    window.localStorage.setItem(
      LOCAL_TRIAGE_STORAGE_KEY,
      JSON.stringify(normalizeTriageStore(value)),
    )
  } catch {
    // Ignore localStorage persistence failures and keep the UI usable.
  }
}

function normalizeTriageStore(store: RunTriageStore): RunTriageStore {
  const normalized: RunTriageStore = {}
  const now = Date.now()

  for (const [runId, triage] of Object.entries(store)) {
    const next: RunTriageState = {}

    if (triage.acknowledgedAt) {
      next.acknowledgedAt = triage.acknowledgedAt
    }

    if (triage.muted) {
      next.muted = true
    }

    if (isRunSnoozed(triage, now)) {
      next.snoozedUntil = triage.snoozedUntil
    }

    if (Object.keys(next).length > 0) {
      normalized[runId] = next
    }
  }

  return normalized
}

function applyTriageAction(
  store: RunTriageStore,
  runId: string,
  action:
    | 'acknowledge'
    | 'clear_acknowledge'
    | 'mute'
    | 'unmute'
    | 'snooze'
    | 'clear_snooze',
) {
  const current = store[runId] ?? {}
  const next: RunTriageState = { ...current }

  switch (action) {
    case 'acknowledge':
      next.acknowledgedAt = new Date().toISOString()
      break
    case 'clear_acknowledge':
      delete next.acknowledgedAt
      break
    case 'mute':
      next.muted = true
      break
    case 'unmute':
      delete next.muted
      break
    case 'snooze':
      next.snoozedUntil = new Date(Date.now() + DEFAULT_SNOOZE_MS).toISOString()
      break
    case 'clear_snooze':
      delete next.snoozedUntil
      break
  }

  const merged = {
    ...store,
    [runId]: next,
  }

  return normalizeTriageStore(merged)
}

function describeTriageAction(
  action:
    | 'acknowledge'
    | 'clear_acknowledge'
    | 'mute'
    | 'unmute'
    | 'snooze'
    | 'clear_snooze',
) {
  switch (action) {
    case 'acknowledge':
      return currentLanguage === 'zh'
        ? '该 run 已在本地标记为确认，并会从默认 inbox 视图中移除。'
        : 'The run was acknowledged locally and will drop out of the default inbox view.'
    case 'clear_acknowledge':
      return currentLanguage === 'zh'
        ? '本地确认标记已移除。'
        : 'The local acknowledgement was removed.'
    case 'mute':
      return currentLanguage === 'zh'
        ? '该 run 已在本地静音，并会从默认 inbox 视图中隐藏。'
        : 'The run was muted locally and hidden from the default inbox view.'
    case 'unmute':
      return currentLanguage === 'zh'
        ? '本地静音已取消。'
        : 'The local mute was removed.'
    case 'snooze':
      return currentLanguage === 'zh'
        ? '该 run 已在本地稍后处理 30 分钟。'
        : 'The run was snoozed locally for 30 minutes.'
    case 'clear_snooze':
      return currentLanguage === 'zh'
        ? '本地稍后处理计时已移除。'
        : 'The local snooze timer was removed.'
  }
}

function shouldHideTriagedRun(
  triage: RunTriageState | null | undefined,
  now: number,
) {
  return Boolean(
    triage?.acknowledgedAt ||
      triage?.muted ||
      (triage?.snoozedUntil && dateValue(triage.snoozedUntil) > now),
  )
}

function isRunSnoozed(triage: RunTriageState | null | undefined, now: number) {
  return Boolean(triage?.snoozedUntil && dateValue(triage.snoozedUntil) > now)
}

function renderTriagePills(triage: RunTriageState | null | undefined) {
  const pills: Array<ReturnType<typeof StatusPill>> = []

  if (triage?.acknowledgedAt) {
    pills.push(
      <StatusPill key="acknowledged" tone="neutral">
        {currentLanguage === 'zh' ? '已确认' : 'Acked'}
      </StatusPill>,
    )
  }

  if (isRunSnoozed(triage, Date.now()) && triage?.snoozedUntil) {
    pills.push(
      <StatusPill key="snoozed" tone="info">
        {currentLanguage === 'zh'
          ? `已稍后处理（${formatRelativeTime(triage.snoozedUntil)}）`
          : `Snoozed ${formatRelativeTime(triage.snoozedUntil)}`}
      </StatusPill>,
    )
  }

  if (triage?.muted) {
    pills.push(
      <StatusPill key="muted" tone="warning">
        {currentLanguage === 'zh' ? '已静音' : 'Muted'}
      </StatusPill>,
    )
  }

  return pills
}

function getNoticeBannerClass(tone: OperatorNotice['tone']) {
  switch (tone) {
    case 'error':
      return 'banner--error'
    case 'warning':
      return 'banner--warning'
    default:
      return 'banner--info'
  }
}

function buildApiUrl(path: string) {
  const base = (import.meta.env.VITE_API_BASE_URL ?? '').trim()
  if (!base) {
    return path
  }

  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base
  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  if (normalizedBase.endsWith('/api') && normalizedPath.startsWith('/api/')) {
    return `${normalizedBase}${normalizedPath.slice(4)}`
  }

  return `${normalizedBase}${normalizedPath}`
}

function buildWebSocketUrl() {
  const candidate = (import.meta.env.VITE_WS_URL ?? '').trim()
  if (candidate) {
    return normalizeWebSocketUrl(candidate)
  }

  const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '').trim()
  if (apiBase) {
    const url = new URL(buildApiUrl('/api/snapshot'), window.location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/ws'
    url.search = ''
    return url.toString()
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

function normalizeWebSocketUrl(value: string) {
  if (value.startsWith('ws://') || value.startsWith('wss://')) {
    return value
  }

  const url = new URL(value, window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

async function requestData<T>(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(buildApiUrl(path), {
    ...init,
    headers,
  })

  const text = await response.text()

  if (!response.ok) {
    throw new Error(text.trim() || `${response.status} ${response.statusText}`)
  }

  if (!text) {
    return null as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    return text as T
  }
}

async function fetchDashboardData() {
  try {
    return await fetchSnapshot()
  } catch (snapshotError) {
    const fallbackSnapshot = await fetchFallbackSnapshot()
    if (fallbackSnapshot) {
      return fallbackSnapshot
    }

    throw snapshotError
  }
}

async function fetchReferenceCatalog() {
  const response = await requestData<unknown>('/api/references')
  const references = extractReferenceProjects(response)

  if (!references) {
    throw new Error('Unexpected /api/references response shape.')
  }

  return references
}

async function fetchIntegrationCatalog() {
  const response = await requestData<unknown>('/api/integrations')
  const integrations = extractIntegrationDescriptors(response)

  if (!integrations) {
    throw new Error('Unexpected /api/integrations response shape.')
  }

  return integrations
}

async function fetchHubHealth() {
  const response = await requestData<unknown>('/health')
  if (!isHubHealth(response)) {
    throw new Error('Unexpected /health response shape.')
  }

  return response
}

async function fetchSnapshot() {
  const response = await requestData<unknown>('/api/snapshot')
  const snapshot = extractSnapshot(response)
  if (!snapshot) {
    throw new Error('Unexpected /api/snapshot response shape.')
  }

  return snapshot
}

async function requestAgentWorkspaceAction(
  agentId: string,
  target: AgentWorkspaceActionTarget,
) {
  const response = await requestData<unknown>(
    `/api/agents/${encodeURIComponent(agentId)}/workspace-actions`,
    {
      method: 'POST',
      body: JSON.stringify({ target }),
    },
  )

  if (!isAgentWorkspaceActionResult(response)) {
    throw new Error('Unexpected workspace action response shape.')
  }

  return response
}

async function requestAgentRuntimeAction(
  agentId: string,
  request: AgentRuntimeActionRequest,
) {
  const response = await requestData<unknown>(
    `/api/agents/${encodeURIComponent(agentId)}/runtime-actions`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
  )

  if (!isAgentRuntimeActionResult(response)) {
    throw new Error('Unexpected runtime action response shape.')
  }

  return response
}

async function requestTaskRuntimeAction(
  taskId: string,
  request: AgentRuntimeActionRequest,
) {
  const response = await requestData<unknown>(
    `/api/tasks/${encodeURIComponent(taskId)}/runtime-actions`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
  )

  if (!isAgentRuntimeActionResult(response)) {
    throw new Error('Unexpected task runtime action response shape.')
  }

  return response
}

async function requestSessionAction(
  sessionId: string,
  request: SessionActionRequest,
) {
  const response = await requestData<unknown>(
    `/api/sessions/${encodeURIComponent(sessionId)}/actions`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
  )

  if (!isSessionActionResult(response)) {
    throw new Error('Unexpected session action response shape.')
  }

  return response
}

async function requestTaskAssignment(
  taskId: string,
  request: TaskAssignmentRequest,
) {
  const response = await requestData<unknown>(
    `/api/tasks/${encodeURIComponent(taskId)}/assignment`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
  )

  if (!isTaskAssignmentResult(response)) {
    throw new Error('Unexpected task assignment response shape.')
  }

  return response
}

async function requestTaskPriority(
  taskId: string,
  request: TaskPriorityRequest,
) {
  const response = await requestData<unknown>(
    `/api/tasks/${encodeURIComponent(taskId)}/priority`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
  )

  if (!isTaskPriorityResult(response)) {
    throw new Error('Unexpected task priority response shape.')
  }

  return response
}

async function requestTaskHandoff(
  taskId: string,
  request: TaskHandoffRequest,
) {
  const response = await requestData<unknown>(
    `/api/tasks/${encodeURIComponent(taskId)}/handoff`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
  )

  if (!isTaskHandoffResult(response)) {
    throw new Error('Unexpected task handoff response shape.')
  }

  return response
}

async function requestTaskHandoffAction(
  taskId: string,
  request: TaskHandoffActionRequest,
) {
  const response = await requestData<unknown>(
    `/api/tasks/${encodeURIComponent(taskId)}/handoff-actions`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
  )

  if (!isTaskHandoffResult(response)) {
    throw new Error('Unexpected task handoff action response shape.')
  }

  return response
}

async function requestResourcePolicyUpdate(
  platform: AgentPlatform,
  request: ResourcePolicyUpdateRequest,
) {
  const response = await requestData<unknown>(
    `/api/resources/${encodeURIComponent(platform)}/policy`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
  )

  if (!isResourcePolicyUpdateResult(response)) {
    throw new Error('Unexpected resource policy response shape.')
  }

  return response
}

async function fetchFallbackSnapshot() {
  const [
    agentsResult,
    runsResult,
    inboxResult,
    approvalStateResult,
    eventsResult,
    tasksResult,
    resourcesResult,
  ] = await Promise.allSettled([
    fetchCollection('/api/agents', isAgentDescriptor),
    fetchCollection('/api/runs', isAgentRun),
    fetchCollection('/api/inbox', isAgentRun),
    fetchApprovalState(),
    fetchCollection('/api/events', isAgentEvent),
    fetchCollection('/api/tasks', isTaskDescriptor),
    fetchCollection('/api/resources', isResourceDescriptor),
  ])

  const hasSuccessfulEndpoint = [
    agentsResult,
    runsResult,
    inboxResult,
    approvalStateResult,
    eventsResult,
    tasksResult,
    resourcesResult,
  ].some((result) => result.status === 'fulfilled')

  if (!hasSuccessfulEndpoint) {
    return null
  }

  const approvalState =
    approvalStateResult.status === 'fulfilled'
      ? approvalStateResult.value
      : { approvals: EMPTY_APPROVALS, bridge: null }

  return normalizeSnapshot({
    generatedAt: new Date().toISOString(),
    agents: getSettledCollection(agentsResult),
    runs: getSettledCollection(runsResult),
    inbox: getSettledCollection(inboxResult),
    approvals: approvalState.approvals,
    approvalBridge: approvalState.bridge ? { openclaw: approvalState.bridge } : null,
    events: getSettledCollection(eventsResult),
    tasks: getSettledCollection(tasksResult),
    resources: getSettledCollection(resourcesResult),
  })
}

async function fetchApprovalState() {
  const response = await requestData<unknown>('/api/approvals')
  if (!isRecord(response)) {
    throw new Error('Unexpected /api/approvals response shape.')
  }

  const approvals = Array.isArray(response.approvals)
    ? response.approvals.filter(isApprovalItem)
    : EMPTY_APPROVALS
  const bridge = isApprovalBridgeStatus(response.bridge) ? response.bridge : null

  return {
    approvals,
    bridge,
  }
}

async function fetchCollection<T>(
  path: string,
  guard: (value: unknown) => value is T,
) {
  const response = await requestData<unknown>(path)
  const collection = extractCollection(response, guard)
  if (!collection) {
    throw new Error(`Unexpected ${path} response shape.`)
  }

  return collection
}

function extractSnapshot(value: unknown): DashboardSnapshot | null {
  if (isDashboardSnapshot(value)) {
    return normalizeSnapshot(value)
  }

  if (!isRecord(value)) {
    return null
  }

  const nestedKeys = ['snapshot', 'data', 'payload']

  for (const key of nestedKeys) {
    const candidate = extractSnapshot(value[key])
    if (candidate) {
      return candidate
    }
  }

  return null
}

function extractReferenceProjects(value: unknown): ReferenceProject[] | null {
  if (Array.isArray(value) && value.every(isReferenceProject)) {
    return value
  }

  if (!isRecord(value)) {
    return null
  }

  const direct = value.references
  if (Array.isArray(direct) && direct.every(isReferenceProject)) {
    return direct
  }

  const nestedKeys = ['data', 'items', 'results']

  for (const key of nestedKeys) {
    const candidate = value[key]
    if (Array.isArray(candidate) && candidate.every(isReferenceProject)) {
      return candidate
    }
  }

  return null
}

function extractIntegrationDescriptors(value: unknown): IntegrationDescriptor[] | null {
  if (Array.isArray(value) && value.every(isIntegrationDescriptor)) {
    return value
  }

  if (!isRecord(value)) {
    return null
  }

  const direct = value.integrations
  if (Array.isArray(direct) && direct.every(isIntegrationDescriptor)) {
    return direct
  }

  const nestedKeys = ['data', 'items', 'results']

  for (const key of nestedKeys) {
    const candidate = value[key]
    if (Array.isArray(candidate) && candidate.every(isIntegrationDescriptor)) {
      return candidate
    }
  }

  return null
}

function applyRealtimePayload(
  current: DashboardSnapshot | null,
  payload: unknown,
): DashboardSnapshot | null {
  const fullSnapshot = extractSnapshot(payload)
  if (fullSnapshot) {
    return fullSnapshot
  }

  if (!current || !isRecord(payload)) {
    return null
  }

  let agents = current.agents
  let approvals = current.approvals
  let approvalBridge = current.approvalBridge ?? null
  let runs = current.runs
  let inbox = current.inbox
  let events = current.events
  let tasks = current.tasks
  let resources = current.resources
  let didChange = false

  const incomingAgents = [
    ...(extractCollection(payload.agents, isAgentDescriptor) ?? []),
    ...toArray(
      isAgentDescriptor(payload)
        ? payload
        : extractEntity(payload, 'agent', isAgentDescriptor),
    ),
  ]

  if (incomingAgents.length > 0) {
    agents = sortAgents(mergeById(agents, incomingAgents))
    didChange = true
  }

  const incomingRuns = [
    ...(extractCollection(payload.runs, isAgentRun) ?? []),
    ...toArray(
      isAgentRun(payload) ? payload : extractEntity(payload, 'run', isAgentRun),
    ),
  ]

  if (incomingRuns.length > 0) {
    runs = sortRuns(mergeById(runs, incomingRuns))
    inbox = sortRuns(deriveInboxFromRuns(runs))
    didChange = true
  }

  const incomingInbox = extractCollection(payload.inbox, isAgentRun)
  if (incomingInbox && incomingInbox.length > 0) {
    inbox = sortRuns(mergeById(inbox, incomingInbox))
    didChange = true
  }

  const incomingApprovals = [
    ...(extractCollection(payload.approvals, isApprovalItem) ?? []),
    ...toArray(
      isApprovalItem(payload)
        ? payload
        : extractEntity(payload, 'approval', isApprovalItem),
    ),
  ]

  if (incomingApprovals.length > 0) {
    approvals = sortApprovals(mergeById(approvals, incomingApprovals))
    didChange = true
  }

  if (isRecord(payload) && isApprovalBridgeStatus(payload.bridge)) {
    approvalBridge = {
      ...(approvalBridge ?? {}),
      openclaw: payload.bridge,
    }
    didChange = true
  }

  const incomingEvents = [
    ...(extractCollection(payload.events, isAgentEvent) ?? []),
    ...toArray(
      isAgentEvent(payload)
        ? payload
        : extractEntity(payload, 'event', isAgentEvent),
    ),
  ]

  if (incomingEvents.length > 0) {
    events = sortEvents(mergeById(events, incomingEvents)).slice(0, EVENT_LIMIT)
    didChange = true
  }

  const incomingTasks = extractCollection(payload.tasks, isTaskDescriptor)
  if (incomingTasks && incomingTasks.length > 0) {
    tasks = mergeById(tasks, incomingTasks)
    didChange = true
  }

  const incomingResources = extractCollection(payload.resources, isResourceDescriptor)
  if (incomingResources && incomingResources.length > 0) {
    resources = sortResources(mergeById(resources, incomingResources))
    didChange = true
  }

  if (!didChange) {
    return null
  }

  return normalizeSnapshot({
    generatedAt: new Date().toISOString(),
    agents,
    runs,
    inbox,
    approvals,
    approvalBridge,
    events,
    tasks,
    resources,
  })
}

function extractCollection<T>(
  value: unknown,
  guard: (value: unknown) => value is T,
): T[] | null {
  if (Array.isArray(value) && value.every(guard)) {
    return value
  }

  if (!isRecord(value)) {
    return null
  }

  const nestedKeys = ['data', 'items', 'results']

  for (const key of nestedKeys) {
    const candidate = value[key]
    if (Array.isArray(candidate) && candidate.every(guard)) {
      return candidate
    }
  }

  return null
}

function extractEntity<T>(
  value: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T,
): T | null {
  const candidate = value[key]
  return guard(candidate) ? candidate : null
}

function normalizeSnapshot(
  snapshot: Pick<
    DashboardSnapshot,
    'generatedAt' | 'agents' | 'runs' | 'inbox' | 'approvals' | 'approvalBridge' | 'events'
  > &
    Partial<Pick<DashboardSnapshot, 'projects' | 'sessions' | 'tasks' | 'resources'>>,
): DashboardSnapshot {
  const agents = sortAgents(dedupeById(snapshot.agents))
  const approvals = sortApprovals(dedupeById(snapshot.approvals))
  const runs = sortRuns(dedupeById(snapshot.runs))
  const events = sortEvents(dedupeById(snapshot.events)).slice(0, EVENT_LIMIT)
  const taskPriorities = toTaskPriorityStates(snapshot.tasks)
  const taskAssignments = toTaskAssignmentStates(snapshot.tasks)
  const taskHandoffs = toTaskHandoffStates(snapshot.tasks)
  const inboxSource = snapshot.inbox.length > 0 ? snapshot.inbox : deriveInboxFromRuns(runs)
  const topology = deriveOperationalTopology({
    agents,
    runs,
    events,
    taskPriorities,
    taskAssignments,
    taskHandoffs,
  })

  return {
    generatedAt: snapshot.generatedAt,
    agents,
    runs,
    inbox: sortRuns(dedupeById(inboxSource)),
    approvals,
    approvalBridge: snapshot.approvalBridge ?? null,
    events,
    projects: topology.projects,
    sessions: topology.sessions,
    tasks: topology.tasks,
    resources: sortResources(dedupeById(snapshot.resources ?? EMPTY_RESOURCES)),
  }
}

function deriveInboxFromRuns(runs: AgentRun[]) {
  return runs.filter(needsInboxAttention)
}

function toTaskAssignmentStates(
  tasks: DashboardSnapshot['tasks'] | undefined,
): TaskAssignmentState[] {
  if (!Array.isArray(tasks)) {
    return []
  }

  return tasks
    .filter(isTaskDescriptor)
    .flatMap((task) =>
      task.owner
        ? [
            {
              runId: task.runId,
              owner: task.owner,
              assignedAt: task.assignedAt ?? task.assignmentUpdatedAt ?? task.createdAt,
              updatedAt: task.assignmentUpdatedAt ?? task.assignedAt ?? task.createdAt,
            } satisfies TaskAssignmentState,
          ]
        : [],
    )
}

function toTaskPriorityStates(
  tasks: DashboardSnapshot['tasks'] | undefined,
): TaskPriorityState[] {
  if (!Array.isArray(tasks)) {
    return []
  }

  return tasks
    .filter(isTaskDescriptor)
    .flatMap((task) =>
      task.priority !== 'normal'
        ? [
            {
              runId: task.runId,
              priority: task.priority,
              updatedAt: task.priorityUpdatedAt ?? task.createdAt,
            } satisfies TaskPriorityState,
          ]
        : [],
    )
}

function toTaskHandoffStates(
  tasks: DashboardSnapshot['tasks'] | undefined,
): TaskHandoffState[] {
  if (!Array.isArray(tasks)) {
    return []
  }

  return tasks
    .filter(isTaskDescriptor)
    .flatMap((task) =>
      task.handoffTarget
        ? [
            {
              runId: task.runId,
              targetOwner: task.handoffTarget,
              note: task.handoffNote ?? null,
              requestedAt: task.handoffRequestedAt ?? task.handoffUpdatedAt ?? task.createdAt,
              updatedAt: task.handoffUpdatedAt ?? task.handoffRequestedAt ?? task.createdAt,
            } satisfies TaskHandoffState,
          ]
        : [],
    )
}

function dedupeById<T extends { id: string }>(items: T[]) {
  const map = new Map<string, T>()
  for (const item of items) {
    map.set(item.id, item)
  }

  return [...map.values()]
}

function mergeById<T extends { id: string }>(existing: T[], incoming: T[]) {
  const map = new Map(existing.map((item) => [item.id, item] as const))
  for (const item of incoming) {
    map.set(item.id, item)
  }

  return [...map.values()]
}

function sortResources(resources: ResourceDescriptor[]) {
  return [...resources].sort(
    (left, right) =>
      resourcePressureRank(right.pressure) - resourcePressureRank(left.pressure) ||
      getAttentionSortValue(right.attention) - getAttentionSortValue(left.attention) ||
      healthRank(right.health) - healthRank(left.health) ||
      right.activeTaskCount - left.activeTaskCount ||
      right.waitingTaskCount - left.waitingTaskCount ||
      left.platform.localeCompare(right.platform),
  )
}

function sortRuns(runs: AgentRun[]) {
  return [...runs].sort(
    (left, right) =>
      dateValue(right.lastEventAt) - dateValue(left.lastEventAt) ||
      dateValue(right.createdAt) - dateValue(left.createdAt),
  )
}

function sortApprovals(approvals: ApprovalItem[]) {
  return [...approvals].sort(
    (left, right) =>
      getAttentionSortValue(right.attention) - getAttentionSortValue(left.attention) ||
      dateValue(right.observedAt) - dateValue(left.observedAt) ||
      dateValue(right.createdAt) - dateValue(left.createdAt),
  )
}

function sortAgents(agents: AgentDescriptor[]) {
  return [...agents].sort(
    (left, right) =>
      attentionRank(left.attention) - attentionRank(right.attention) ||
      healthRank(left.health) - healthRank(right.health) ||
      left.name.localeCompare(right.name),
  )
}

function sortEvents(events: AgentEvent[]) {
  return [...events].sort(
    (left, right) => dateValue(right.createdAt) - dateValue(left.createdAt),
  )
}

function resourcePressureRank(pressure: ResourceDescriptor['pressure']) {
  switch (pressure) {
    case 'overcommitted':
      return 3
    case 'saturated':
      return 2
    case 'available':
      return 1
    default:
      return 0
  }
}

function formatStars(value: number) {
  return new Intl.NumberFormat(currentLocale, {
    notation: value >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value)
}

function describeNotificationState(health: HubHealth) {
  if (!health.desktopNotificationsEnabled) {
    return currentLanguage === 'zh' ? '已关闭' : 'Disabled'
  }

  if (health.desktopNotificationsSupported) {
    return currentLanguage === 'zh' ? '已启用' : 'Enabled'
  }

  return currentLanguage === 'zh' ? '不支持' : 'Unsupported'
}

function formatSummaryCount(value: number | null | undefined) {
  if (typeof value !== 'number') {
    return '—'
  }

  if (currentLanguage === 'zh') {
    return `${value} 个`
  }

  return `${value} ${value === 1 ? 'summary' : 'summaries'}`
}

function describeTaskFooterMeta(task: TaskDescriptor) {
  const parts: string[] = []

  if (task.priority !== 'normal') {
    parts.push(
      currentLanguage === 'zh'
        ? `优先级 ${humanizeToken(task.priority)}`
        : `Priority ${humanizeToken(task.priority)}`,
    )
  }

  if (task.owner) {
    parts.push(
      currentLanguage === 'zh'
        ? `负责人 ${task.owner}`
        : `Owner ${task.owner}`,
    )
  }

  if (task.handoffTarget) {
    parts.push(
      currentLanguage === 'zh'
        ? `交接给 ${task.handoffTarget}`
        : `Handoff to ${task.handoffTarget}`,
    )
  }

  parts.push(
    currentLanguage === 'zh'
      ? `${task.eventCount} 个事件`
      : `${task.eventCount} event${task.eventCount === 1 ? '' : 's'}`,
  )

  return parts.join(' · ')
}

function describeSessionMode(value: boolean | null | undefined) {
  if (value === true) {
    return currentLanguage === 'zh' ? '可远程接管' : 'Remote steerable'
  }

  if (value === false) {
    return currentLanguage === 'zh' ? '仅本地会话' : 'Local-only session'
  }

  return currentLanguage === 'zh' ? '未知' : 'Unknown'
}

function describeRuntimePromptInputLabel(agent: AgentDescriptor) {
  const runtimeLabel = humanizeToken(agent.platform)
  return currentLanguage === 'zh'
    ? `${runtimeLabel} prompt 输入框`
    : `${runtimeLabel} prompt input`
}

function describeRuntimePromptPlaceholder(agent: AgentDescriptor) {
  const runtimeLabel = humanizeToken(agent.platform)
  return currentLanguage === 'zh'
    ? `向当前 ${runtimeLabel} 会话发送下一条指令…`
    : `Send the next operator prompt to the active ${runtimeLabel} session…`
}

function describeAgentRuntimeControlNote(agent: AgentDescriptor) {
  switch (agent.platform) {
    case 'claude-code':
      return describeClaudeRuntimeControlNote(agent)
    case 'copilot-cli':
      return describeCopilotRuntimeControlNote(agent.sessionMetadata)
    case 'gemini-cli':
      return describeGeminiRuntimeControlNote(agent)
    case 'openclaw':
      return describeOpenClawUpstreamApprovalSupport(agent.sessionMetadata)
    default:
      return describeExternalRuntimeControlNote(agent.sessionMetadata)
  }
}

function describeClaudeRuntimeControlNote(agent: AgentDescriptor) {
  if (agent.health === 'auth_required') {
    return currentLanguage === 'zh'
      ? '这个 Claude Code 会话的本地日志已经可见，但当前机器上的 Claude CLI 未登录，所以 Agent Hub 还不会暴露 send_prompt。'
      : 'This Claude Code session has a visible local log, but the Claude CLI on this machine is not logged in, so Agent Hub will not expose send_prompt yet.'
  }

  if (!agent.sessionMetadata?.sessionId || !agent.sessionMetadata?.sessionPath) {
    return null
  }

  return currentLanguage === 'zh'
    ? '这个 Claude Code 会话通过本机 `claude --resume <sessionId> -p` 复连并派发 prompt，只有本地 session log 可验证时才会暴露控制。'
    : 'This Claude Code session is resumed and steered locally through `claude --resume <sessionId> -p`; Agent Hub only exposes control when the local session log is verifiable.'
}

function describeCopilotRuntimeControlNote(
  metadata: AgentSessionMetadata | null | undefined,
) {
  if (!metadata?.sessionId) {
    return null
  }

  return currentLanguage === 'zh'
    ? '这个 Copilot 会话通过本机 Copilot SDK 复连并派发 prompt，不依赖 remoteSteerable 网络通道。'
    : 'This Copilot session is resumed and steered locally through the Copilot SDK; it does not depend on a remoteSteerable network channel.'
}

function describeGeminiRuntimeControlNote(agent: AgentDescriptor) {
  if (agent.health === 'auth_required') {
    return currentLanguage === 'zh'
      ? '这个 Gemini CLI 会话的本地 session 文件已经可见，但当前机器上的 Gemini auth 还没配置好，所以 Agent Hub 还不会暴露 send_prompt。'
      : 'This Gemini CLI session has a visible local session file, but the Gemini auth posture on this machine is not configured yet, so Agent Hub will not expose send_prompt.'
  }

  if (!agent.sessionMetadata?.sessionId || !agent.sessionMetadata?.sessionPath) {
    return null
  }

  return currentLanguage === 'zh'
    ? '这个 Gemini CLI 会话通过本机 `gemini -p ... --resume <sessionId>` 复连并派发 prompt；只有本地 session 文件可验证时才会暴露控制。'
    : 'This Gemini CLI session is resumed and steered locally through `gemini -p ... --resume <sessionId>`; Agent Hub only exposes control when the local session file is verifiable.'
}

function describeExternalRuntimeControlNote(
  metadata: AgentSessionMetadata | null | undefined,
) {
  if (
    !metadata?.runtimeActionEndpoint ||
    !metadata.runtimeActionTargets?.includes('send_prompt')
  ) {
    return null
  }

  return currentLanguage === 'zh'
    ? '这个 sidecar 通过本机 loopback callback 接收 Agent Hub 的 send_prompt；只有 endpoint 和目标都被显式声明时才会暴露控制。'
    : 'This sidecar receives Agent Hub send_prompt calls through a local loopback callback; control is only exposed when both the endpoint and target are explicitly declared.'
}

function describeOpenClawUpstreamApprovalSupport(
  metadata: AgentSessionMetadata | null | undefined,
) {
  const support = metadata?.upstreamApprovalSupport
  if (!support) {
    return null
  }

  switch (support.code) {
    case 'openclaw-acp-session':
      return currentLanguage === 'zh'
        ? '当前 live session 是 ACP 会话；如果上游 runtime 发出 permission request，Agent Hub 可以看到对应审批。'
        : 'The current live session is ACP-backed. If the upstream runtime emits a permission request, Agent Hub can surface the resulting approval.'
    case 'openclaw-session-not-acp':
      return currentLanguage === 'zh'
        ? '当前 live session 不是 ACP 会话。通过 send_prompt 触发的工具调用不会产生上游审批项；Agent Hub 仍可处理 gateway exec approvals。'
        : 'The current live session is not ACP-backed. Tool calls triggered through send_prompt will not emit upstream approval items; Agent Hub can still resolve gateway exec approvals.'
    case 'openclaw-session-unavailable':
      return currentLanguage === 'zh'
        ? '等待可见的 live session 后，才能判断这个 OpenClaw 会话是否会产生上游审批。'
        : 'Wait until a live session is visible before Agent Hub can determine whether this OpenClaw session can emit upstream approvals.'
    default:
      return null
  }
}

function attentionRank(attention: AgentAttention) {
  switch (attention) {
    case 'urgent':
      return 0
    case 'action_needed':
      return 1
    case 'info':
      return 2
    default:
      return 3
  }
}

function getAttentionSortValue(attention: AgentAttention) {
  return 3 - attentionRank(attention)
}

function healthRank(health: AgentHealth) {
  switch (health) {
    case 'healthy':
      return 0
    case 'degraded':
      return 1
    case 'rate_limited':
      return 2
    case 'stalled':
      return 3
    case 'auth_required':
      return 4
    default:
      return 5
  }
}

function getSettledCollection<T>(result: PromiseSettledResult<T[]>) {
  return result.status === 'fulfilled' ? result.value : []
}

function parseRealtimePayload(data: MessageEvent['data']): unknown | 'ping' | 'pong' | null {
  if (typeof data !== 'string') {
    return null
  }

  const trimmed = data.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed === 'ping' || trimmed === 'pong') {
    return trimmed
  }

  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  return (
    isRecord(value) &&
    typeof value.generatedAt === 'string' &&
    Array.isArray(value.agents) &&
    Array.isArray(value.runs) &&
    Array.isArray(value.inbox) &&
    Array.isArray(value.approvals) &&
    Array.isArray(value.events) &&
    (!('resources' in value) || Array.isArray(value.resources))
  )
}

function isHubHealth(value: unknown): value is HubHealth {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.generatedAt === 'string' &&
    typeof value.mockRuntimeEnabled === 'boolean' &&
    typeof value.copilotSessionDiscoveryEnabled === 'boolean' &&
    typeof value.claudeCodeSessionDiscoveryEnabled === 'boolean' &&
    typeof value.geminiCliSessionDiscoveryEnabled === 'boolean' &&
    typeof value.openClawSessionDiscoveryEnabled === 'boolean' &&
    typeof value.desktopNotificationsEnabled === 'boolean' &&
    typeof value.desktopNotificationsSupported === 'boolean' &&
    isRecord(value.counts)
  )
}

function isApprovalBridgeStatus(value: unknown): value is ApprovalBridgeStatus {
  return (
    isRecord(value) &&
    value.platform === 'openclaw' &&
    typeof value.connected === 'boolean' &&
    typeof value.liveOnly === 'boolean' &&
    value.completeness === 'live-only'
  )
}

function isApprovalItem(value: unknown): value is ApprovalItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.platform === 'string' &&
    typeof value.state === 'string' &&
    typeof value.attention === 'string' &&
    isRecord(value.request) &&
    typeof value.request.command === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.observedAt === 'string'
  )
}

function isAgentWorkspaceActionResult(
  value: unknown,
): value is AgentWorkspaceActionResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.agentId === 'string' &&
    typeof value.target === 'string' &&
    typeof value.openedPath === 'string' &&
    typeof value.message === 'string'
  )
}

function isAgentRuntimeActionResult(
  value: unknown,
): value is AgentRuntimeActionResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.agentId === 'string' &&
    typeof value.target === 'string' &&
    typeof value.message === 'string'
  )
}

function isSessionActionResult(
  value: unknown,
): value is SessionActionResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.sessionId === 'string' &&
    typeof value.agentId === 'string' &&
    typeof value.target === 'string' &&
    typeof value.message === 'string'
  )
}

function isTaskAssignmentResult(
  value: unknown,
): value is TaskAssignmentResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.taskId === 'string' &&
    typeof value.runId === 'string' &&
    (value.owner === null || typeof value.owner === 'string') &&
    typeof value.message === 'string'
  )
}

function isTaskPriorityResult(
  value: unknown,
): value is TaskPriorityResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.taskId === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.priority === 'string' &&
    typeof value.message === 'string'
  )
}

function isResourcePolicyUpdateResult(
  value: unknown,
): value is ResourcePolicyUpdateResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.resourceId === 'string' &&
    typeof value.platform === 'string' &&
    (value.slotLimit === null || typeof value.slotLimit === 'number') &&
    typeof value.message === 'string' &&
    isResourceDescriptor(value.resource)
  )
}

function isTaskHandoffResult(
  value: unknown,
): value is TaskHandoffResult {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.taskId === 'string' &&
    typeof value.runId === 'string' &&
    (value.owner === null || typeof value.owner === 'string') &&
    (value.targetOwner === null || typeof value.targetOwner === 'string') &&
    (value.note === null || typeof value.note === 'string') &&
    typeof value.message === 'string'
  )
}

function isAgentDescriptor(value: unknown): value is AgentDescriptor {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.platform === 'string' &&
    typeof value.workspacePath === 'string' &&
    typeof value.health === 'string' &&
    typeof value.attention === 'string' &&
      typeof value.state === 'string'
  )
}

function isTaskDescriptor(value: unknown): value is TaskDescriptor {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.agentId === 'string' &&
    typeof value.sessionKey === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.platform === 'string' &&
    typeof value.workspacePath === 'string' &&
    typeof value.state === 'string' &&
    typeof value.health === 'string' &&
    typeof value.attention === 'string' &&
    typeof value.lastEventAt === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.eventCount === 'number' &&
    typeof value.priority === 'string' &&
    (value.priorityUpdatedAt === null || typeof value.priorityUpdatedAt === 'string') &&
    (value.owner === null || typeof value.owner === 'string') &&
    (value.assignedAt === null || typeof value.assignedAt === 'string') &&
    (value.assignmentUpdatedAt === null ||
      typeof value.assignmentUpdatedAt === 'string') &&
    (value.handoffTarget === null || typeof value.handoffTarget === 'string') &&
    (value.handoffNote === null || typeof value.handoffNote === 'string') &&
    (value.handoffRequestedAt === null ||
      typeof value.handoffRequestedAt === 'string') &&
    (value.handoffUpdatedAt === null ||
      typeof value.handoffUpdatedAt === 'string')
  )
}

function isResourceDescriptor(value: unknown): value is ResourceDescriptor {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.platform === 'string' &&
    typeof value.sessionCount === 'number' &&
    typeof value.projectCount === 'number' &&
    typeof value.taskCount === 'number' &&
    typeof value.activeTaskCount === 'number' &&
    typeof value.waitingTaskCount === 'number' &&
    (value.slotLimit === null || typeof value.slotLimit === 'number') &&
    (value.availableSlots === null || typeof value.availableSlots === 'number') &&
    typeof value.overCapacityTaskCount === 'number' &&
    (value.utilizationPercent === null || typeof value.utilizationPercent === 'number') &&
    typeof value.pressure === 'string' &&
    typeof value.attention === 'string' &&
    typeof value.health === 'string' &&
    (value.lastActivityAt === null || typeof value.lastActivityAt === 'string') &&
    (value.policyUpdatedAt === null || typeof value.policyUpdatedAt === 'string')
  )
}

function isAgentRun(value: unknown): value is AgentRun {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.agentId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.state === 'string' &&
    typeof value.health === 'string' &&
    typeof value.attention === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.lastEventAt === 'string'
  )
}

function isAgentEvent(value: unknown): value is AgentEvent {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.agentId === 'string' &&
    typeof value.type === 'string' &&
    typeof value.message === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.attention === 'string' &&
    (value.runId === undefined || value.runId === null || typeof value.runId === 'string') &&
    (value.state === undefined || value.state === null || typeof value.state === 'string') &&
    (value.sessionKey === undefined ||
      value.sessionKey === null ||
      typeof value.sessionKey === 'string') &&
    (value.projectId === undefined ||
      value.projectId === null ||
      typeof value.projectId === 'string') &&
    (value.sourceEventId === undefined ||
      value.sourceEventId === null ||
      typeof value.sourceEventId === 'string') &&
    (value.correlationId === undefined ||
      value.correlationId === null ||
      typeof value.correlationId === 'string')
  )
}

function isReferenceProject(value: unknown): value is ReferenceProject {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.repoUrl === 'string' &&
    typeof value.stars === 'number' &&
    typeof value.language === 'string' &&
    typeof value.category === 'string' &&
    typeof value.summary === 'string' &&
    typeof value.reuseInsteadOfBuilding === 'string' &&
    typeof value.hubIntegration === 'string'
  )
}

function isIntegrationDescriptor(value: unknown): value is IntegrationDescriptor {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.method === 'string' &&
    typeof value.path === 'string' &&
    typeof value.endpoint === 'string' &&
    typeof value.description === 'string' &&
    (value.examplePayload === undefined || isRecord(value.examplePayload)) &&
    (value.entrypoint === undefined || typeof value.entrypoint === 'string') &&
    (value.exampleStateFile === undefined || typeof value.exampleStateFile === 'string') &&
    (value.quickStartCommand === undefined || typeof value.quickStartCommand === 'string') &&
    (value.watchCommand === undefined || typeof value.watchCommand === 'string') &&
    (value.runtimeBridgeCommand === undefined ||
      typeof value.runtimeBridgeCommand === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toArray<T>(value: T | null) {
  return value ? [value] : []
}

function getErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : currentLanguage === 'zh'
      ? '未知错误'
      : 'Unknown error'
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

const TOKEN_LABELS: Record<string, { en: string; zh: string }> = {
  open: { en: 'Open', zh: '已连接' },
  connecting: { en: 'Connecting', zh: '连接中' },
  reconnecting: { en: 'Reconnecting', zh: '重连中' },
  closed: { en: 'Closed', zh: '已断开' },
  pending: { en: 'Pending', zh: '待决' },
  resolved: { en: 'Resolved', zh: '已决策' },
  expired: { en: 'Expired', zh: '已过期' },
  stale: { en: 'Stale', zh: '已失效' },
  ready: { en: 'Ready', zh: '就绪' },
  queued: { en: 'Queued', zh: '排队中' },
  starting: { en: 'Starting', zh: '启动中' },
  running: { en: 'Running', zh: '运行中' },
  waiting_input: { en: 'Waiting input', zh: '等待输入' },
  paused: { en: 'Paused', zh: '已暂停' },
  completed: { en: 'Completed', zh: '已完成' },
  failed: { en: 'Failed', zh: '失败' },
  cancelled: { en: 'Cancelled', zh: '已取消' },
  offline: { en: 'Offline', zh: '离线' },
  healthy: { en: 'Healthy', zh: '健康' },
  degraded: { en: 'Degraded', zh: '降级' },
  rate_limited: { en: 'Rate limited', zh: '受限流影响' },
  stalled: { en: 'Stalled', zh: '停滞' },
  auth_required: { en: 'Auth required', zh: '需要认证' },
  unknown: { en: 'Unknown', zh: '未知' },
  urgent: { en: 'Urgent', zh: '紧急' },
  low: { en: 'Low', zh: '低' },
  normal: { en: 'Normal', zh: '普通' },
  high: { en: 'High', zh: '高' },
  critical: { en: 'Critical', zh: '关键' },
  action_needed: { en: 'Action needed', zh: '需要动作' },
  info: { en: 'Informational', zh: '信息提示' },
  silent: { en: 'Silent', zh: '静默' },
  approval_required: { en: 'Approval required', zh: '需要审批' },
  user_input: { en: 'User input', zh: '用户输入' },
  none: { en: 'None', zh: '无' },
  approve: { en: 'Approve', zh: '批准' },
  'allow-once': { en: 'Allow once', zh: '允许一次' },
  deny: { en: 'Deny', zh: '拒绝' },
  pause: { en: 'Pause', zh: '暂停' },
  resume: { en: 'Resume', zh: '继续' },
  cancel: { en: 'Cancel', zh: '取消' },
  'approval.requested': { en: 'Approval requested', zh: '审批已请求' },
  'approval.resolved': { en: 'Approval resolved', zh: '审批已处理' },
  'approval.expired': { en: 'Approval expired', zh: '审批已过期' },
  'task.priority_changed': { en: 'Task priority changed', zh: '任务优先级已变更' },
  'approval.bridge_disconnected': {
    en: 'Approval bridge disconnected',
    zh: '审批桥已断开',
  },
  'runtime.action_acknowledged': {
    en: 'Runtime action acknowledged',
    zh: '运行时动作已受理',
  },
  'session.dispatch_text': {
    en: 'Session prompt dispatched',
    zh: '会话 prompt 已派发',
  },
  'terminal.attach': {
    en: 'Terminal attached',
    zh: '终端已附着',
  },
  'copilot-cli': { en: 'Copilot CLI', zh: 'Copilot CLI' },
  'claude-code': { en: 'Claude Code', zh: 'Claude Code' },
  'gemini-cli': { en: 'Gemini CLI', zh: 'Gemini CLI' },
  openclaw: { en: 'OpenClaw', zh: 'OpenClaw' },
  generic: { en: 'Generic ingest', zh: '通用接入' },
}

function humanizeToken(value: string) {
  const localized = TOKEN_LABELS[value]
  if (localized) {
    return currentLanguage === 'zh' ? localized.zh : localized.en
  }

  return value
    .replace(/[._-]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function formatList(values: string[]) {
  if (values.length === 0) {
    return '—'
  }

  return new Intl.ListFormat(currentLocale, {
    style: 'long',
    type: 'conjunction',
  }).format(values)
}

function getWorkspaceLabel(path: string) {
  const segments = path.split('/').filter(Boolean)
  return segments.at(-1) ?? path
}

function getAgentSourceLabel(agent: AgentDescriptor) {
  switch (getAgentSourceKind(agent)) {
    case 'copilot-session-state':
      return currentLanguage === 'zh' ? 'Copilot 会话状态' : 'Copilot session-state'
    case 'claude-project-logs':
      return currentLanguage === 'zh' ? 'Claude 项目日志' : 'Claude project logs'
    case 'gemini-project-chats':
      return currentLanguage === 'zh' ? 'Gemini 会话文件' : 'Gemini session files'
    case 'openclaw-status-cli':
      return currentLanguage === 'zh' ? 'OpenClaw 本地状态' : 'OpenClaw local status'
    case 'seeded-demo':
      return currentLanguage === 'zh' ? '预置演示数据' : 'Seeded demo'
    case 'external-ingest':
      return currentLanguage === 'zh' ? '外部接入' : 'External ingest'
    default:
      return currentLanguage === 'zh' ? '真实 adapter' : 'Live adapter'
  }
}

function formatPercent(value: number | null | undefined) {
  return typeof value === 'number' ? `${Math.round(value)}%` : '—'
}

function dateValue(value: string | null | undefined) {
  if (!value) {
    return 0
  }

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return '—'
  }

  const parsed = dateValue(value)
  if (parsed === 0) {
    return value
  }

  return new Intl.DateTimeFormat(currentLocale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed)
}

function formatRelativeTime(value: string | null | undefined) {
  if (!value) {
    return currentLanguage === 'zh' ? '从未' : 'Never'
  }

  const timestamp = dateValue(value)
  if (timestamp === 0) {
    return value
  }

  const diffMs = timestamp - Date.now()
  const diffSeconds = Math.round(diffMs / 1000)
  const absSeconds = Math.abs(diffSeconds)
  const formatter = new Intl.RelativeTimeFormat(currentLocale, { numeric: 'auto' })

  if (absSeconds < 60) {
    return formatter.format(diffSeconds, 'second')
  }

  const diffMinutes = Math.round(diffSeconds / 60)
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, 'minute')
  }

  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, 'hour')
  }

  const diffDays = Math.round(diffHours / 24)
  return formatter.format(diffDays, 'day')
}

export default App
