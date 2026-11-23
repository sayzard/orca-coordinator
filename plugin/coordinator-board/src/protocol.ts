// The panel <-> worker contract. The board data itself comes from `coord status --json`.
export {}

export type Target = {
  sessionId: string
  kind: 'terminal' | 'chat'
  agent: string | null
  project: string
  workspace: string
  title: string
  state: string | null
  lane: string
  handle: string | null
  workspaceSelector: string
}

export type Card = {
  id: string
  source: 'coordinator' | 'auto' | string
  sessionId: string
  question: string
  recommendation: string
  reason: string
  options: { label: string; reply: string }[]
  needsInput: string
  priority: string
  canReply: boolean
  stale: boolean
  createdAt: number
  evidence: { fingerprint: string } | null
  askMessageId?: string | null
  reasonKey?: string
  target: Target | null
}

export type SessionRow = {
  sessionId: string
  kind: string
  agent: string | null
  title: string
  state: string | null
  lane: 'human' | 'running' | 'review' | 'idle' | 'unknown'
  updatedAt: number | null
  workspace: string
  handle: string | null
  workspaceSelector: string
}

export type ProjectGroup = {
  repoId: string
  project: string
  counts: Record<string, number>
  sessions: SessionRow[]
}

export type UsageRow = {
  provider: string
  status: string
  plan: string | null
  windows: { id: string; usedPercent: number; resetsAt: number | null; resetDescription: string | null }[]
}

export type BoardStatus = {
  generatedAt: number
  /** Board language from `coord setup --language`. */
  language?: string
  managedProjects: string[]
  coordinator: { sessionId: string; agent?: string; model?: string; state: string; lastReply?: string } | null
  counts: { decisions: number; human: number; running: number; review: number; idle: number; unknown: number; sessions: number }
  decisions: Card[]
  projects: ProjectGroup[]
  requests: { id: string; text: string; status: string; source: string; createdAt: number; assignments?: { agent: string; model: string; grade: string }[] }[]
  usage: UsageRow[]
  history: { at: number; type: string; question?: string; answer?: string | null; via?: string; project?: string; title?: string; text?: string }[]
}

export type Snapshot = { ok: true; status: BoardStatus; at: number } | { ok: false; code: string; message: string; at: number }
/** `key`/`params` name a message in ./i18n; `message` is the English (or raw error) text. */
export type ActionResult = { ok: boolean; message: string; code?: string; key?: string; params?: Record<string, string | number> }
export type RepoRow = { id: string; name: string; kind: string; managed: boolean }

declare module 'orca' {
  interface PluginRequests {
    'board.snapshot': { input: { fresh?: boolean }; output: Snapshot }
    'decision.send': { input: { id: string; text: string; fingerprint?: string | null }; output: ActionResult }
    'decision.coordinate': { input: { id: string; text: string }; output: ActionResult }
    'decision.dismiss': { input: { id: string }; output: ActionResult }
    'request.send': { input: { text: string; project?: string | null }; output: ActionResult }
    'digest.request': { output: ActionResult }
    'session.open': { input: { kind: string; handle: string | null; workspaceSelector: string }; output: ActionResult }
    'projects.list': { output: { ok: boolean; repos: RepoRow[]; message?: string } }
    'projects.set': { input: { ids: string[] }; output: ActionResult }
    'coordinator.start': { output: ActionResult }
  }
  interface PluginPanelEvents {
    'board.snapshot': Snapshot
  }
}
