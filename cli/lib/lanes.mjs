// Turns `orca worktree ps --json` (+ `orca agent list --json`) into session rows with a lane:
//   human   — needs the person (a question, a menu, a permission prompt)
//   running — working now
//   review  — finished with unread output: check the result
//   idle    — finished and already seen
//   unknown — Orca has no state for it
// Pure functions so they can be tested against captured fixtures.
import { createHash } from 'node:crypto'

const QUESTION_PATTERNS = [
  /\?\s*$/,
  // Korean request phrases ("shall I…?", "please confirm/choose/let me know/approve").
  /할까요|하시겠|원하시|괜찮을까|좋을까요|어떨까요|선택해\s*주|알려\s*주세요|확인해\s*주|결정해\s*주|어떻게\s*할|진행할까|승인해\s*주|답해\s*주/,
  /\b(shall i|should i|would you like|do you want|please confirm|let me know|which (one|option)|can you confirm|okay to proceed)\b/i
]

/** Returns the last line of `text` that reads as a question to the person, or null. */
export function detectQuestion(text) {
  if (!text) return null
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ')
  const lines = withoutCode
    .split('\n')
    .map((l) => l.trim())
    // Skip quotes and polite closers ("if you want…") that are not pending questions.
    .filter((l) => l && !l.startsWith('>') && !/^(만약|if you want|원하시면 언제든)/i.test(l))
  const tail = lines.slice(-4)
  for (let i = tail.length - 1; i >= 0; i--) {
    if (QUESTION_PATTERNS.some((re) => re.test(tail[i]))) return tail[i].slice(0, 400)
  }
  return null
}

export function fingerprint(agent) {
  const parts = [
    agent.state ?? '',
    agent.stateStartedAt ?? '',
    agent.lastAssistantMessage ?? '',
    agent.programStatus?.message ?? '',
    agent.prompt ?? ''
  ]
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16)
}

function cleanMenuText(message) {
  return (message || '').replace(/^answer:\s*/i, '').trim().slice(0, 600)
}

/** The reply to judge: the transcript's final reply when known, else what Orca reported. */
function replyOf(agent) {
  return agent.finalReply || agent.lastAssistantMessage || ''
}

function attentionFor(agent) {
  const ps = agent.programStatus || {}
  // toolName keeps the last tool after the person answers, so a working agent is never waiting.
  if (agent.state === 'working') return null
  const isMenu = agent.agentWait || ps.state === 'blocked' || (agent.state === 'waiting' && agent.toolName === 'AskUserQuestion')
  if (isMenu || agent.state === 'blocked') {
    const kind = ps.kind === 'question' || agent.toolName === 'AskUserQuestion' ? 'menu' : 'permission'
    const text = cleanMenuText(ps.message) || (kind === 'permission' ? 'A permission prompt is waiting.' : 'A menu is waiting for a choice.')
    return { kind, text, canReply: false }
  }
  if (agent.state === 'waiting') {
    return { kind: 'question', text: detectQuestion(replyOf(agent)) || cleanMenuText(ps.message) || 'Waiting for input.', canReply: true }
  }
  if (agent.state === 'done') {
    const q = detectQuestion(replyOf(agent))
    if (q) return { kind: 'question', text: q, canReply: true }
  }
  return null
}

function laneFor(agent, attention) {
  if (attention) return 'human'
  if (agent.state === 'working') return 'running'
  if (agent.state === 'done') return agent.activity?.unread ? 'review' : 'idle'
  return 'unknown'
}

function trim(text, n) {
  if (!text) return ''
  return text.length > n ? text.slice(0, n) + '…' : text
}

/** Turn key for a session: its final reply only changes when a new turn starts. */
export function turnKey(agent) {
  return `${agent.state || ''}:${agent.stateStartedAt || agent.updatedAt || ''}`
}

/** Sessions whose final reply should be read from the transcript (finished or waiting). */
export function needsFinalReply(agent) {
  return Boolean(agent.orcaSessionId) && (agent.state === 'done' || agent.state === 'waiting')
}

/**
 * Orca's `lastAssistantMessage` can be the first text block of a turn (seen for chat sessions),
 * so a question at the end of the real final reply is missed. Replace it with the final reply
 * read from the transcript when that reading belongs to the same turn. It goes in `finalReply`, not
 * over `lastAssistantMessage`, so card fingerprints do not change when the reading arrives.
 * @param {object} ps result of `orca worktree ps --json`
 * @param {Record<string, {key: string, text: string}>} finals sessionId -> final reply
 */
export function applyFinalReplies(ps, finals = {}) {
  if (!ps?.worktrees) return ps
  return {
    ...ps,
    worktrees: ps.worktrees.map((ws) => ({
      ...ws,
      agents: (ws.agents || []).map((a) => {
        const f = finals[a.orcaSessionId]
        return f && f.text && f.key === turnKey(a) ? { ...a, finalReply: f.text } : a
      })
    }))
  }
}

/**
 * @param {object} ps result of `orca worktree ps --json`
 * @param {object} opts
 * @param {object} [opts.agentList] result of `orca agent list --json`
 * @param {string[]} [opts.projects] managed repo ids (empty = all)
 * @param {string[]} [opts.excludeSessions] orcaSessionIds to leave out (the coordinator)
 */
export function deriveSessions(ps, { agentList = null, projects = [], excludeSessions = [] } = {}) {
  const kinds = new Map()
  for (const a of agentList?.agents || []) if (a.orcaSessionId) kinds.set(a.orcaSessionId, a)
  const sessions = []
  for (const ws of ps?.worktrees || []) {
    if (ws.isArchived) continue
    if (projects.length && !projects.includes(ws.repoId)) continue
    for (const agent of ws.agents || []) {
      if (!agent.orcaSessionId || excludeSessions.includes(agent.orcaSessionId)) continue
      const listed = kinds.get(agent.orcaSessionId)
      const handle = typeof agent.address === 'string' ? agent.address : null
      const kind = listed?.kind || (handle?.startsWith('term_') ? 'terminal' : 'chat')
      const attention = attentionFor(agent)
      sessions.push({
        sessionId: agent.orcaSessionId,
        kind,
        agent: agent.agentType || listed?.agent || null,
        worktreeId: ws.worktreeId,
        repoId: ws.repoId,
        project: ws.repo || ws.displayName || '',
        workspace: ws.displayName || (ws.branch || '').replace(/^refs\/heads\//, ''),
        workspaceSelector: ws.address?.worktree ? ws.address.worktree : `id:${ws.worktreeId}`,
        path: ws.path,
        paneKey: agent.paneKey || null,
        handle,
        title: agent.activity?.title || agent.conversationName || agent.taskTitle || agent.displayName || trim(agent.prompt, 60) || '(untitled)',
        state: agent.state || null,
        stateStartedAt: agent.stateStartedAt || null,
        toolName: agent.toolName || null,
        prompt: trim(agent.prompt, 600),
        lastAssistantMessage: trim(replyOf(agent), 2000),
        unread: Boolean(agent.activity?.unread),
        updatedAt: agent.updatedAt || ws.lastActivityAt || null,
        attention,
        lane: laneFor(agent, attention),
        fingerprint: fingerprint(agent)
      })
    }
  }
  sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return sessions
}

export const LANE_ORDER = ['human', 'running', 'review', 'idle', 'unknown']
export const LANE_LABELS = { human: 'Needs you', running: 'Running', review: 'To review', idle: 'Idle', unknown: 'Unknown' }

/** Groups sessions by project with lane counts. */
export function groupByProject(sessions) {
  const map = new Map()
  for (const s of sessions) {
    const key = s.repoId || s.project
    if (!map.has(key)) map.set(key, { repoId: s.repoId, project: s.project, counts: Object.fromEntries(LANE_ORDER.map((l) => [l, 0])), sessions: [] })
    const g = map.get(key)
    g.counts[s.lane] += 1
    g.sessions.push(s)
  }
  return [...map.values()].sort((a, b) => b.counts.human - a.counts.human || b.counts.running - a.counts.running || a.project.localeCompare(b.project))
}
