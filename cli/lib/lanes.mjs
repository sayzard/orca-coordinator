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
  // Korean questions ("shall I…?", "which way…?").
  /할까요|하시겠|원하시|괜찮을까|좋을까요|어떨까요|어떻게\s*할|진행할까|어느\s*(쪽|것|안)으로/,
  // Korean requests to decide or reply: "정해/골라/알려/말씀해/선택해/결정해/… 주세요 · 주시면 · 주십시오".
  /(정해|골라|알려|말씀해|선택해|결정해|확인해|승인해|답해|지정해|판단해|검토해)\s*주(세요|시면|십시오|실래요|시겠어요|시겠습니까|시길)/,
  /\b(shall i|should i|would you like|do you want|please confirm|let me know|tell me (which|whether|if)|which (one|option|would you)|can you confirm|okay to proceed|your call|up to you)\b/i
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

/** A subagent still working: the main agent picks up its result and carries on by itself. */
function hasWorkingSubagent(agent) {
  return (agent.subagents || []).some((s) => s?.state === 'working')
}

/**
 * Orca keeps a session `working` ("monitoring") while a background shell runs, even after the
 * agent's turn has ended; `mainAgent.state` says whether the agent itself is done or waiting.
 * A session with a working subagent stays running: the main agent resumes when it reports back.
 */
export function effectiveAgent(agent) {
  const main = agent.mainAgent
  if (agent.state === 'working' && main && (main.state === 'done' || main.state === 'waiting') && !hasWorkingSubagent(agent)) {
    return { ...agent, state: main.state, stateStartedAt: main.stateStartedAt || agent.stateStartedAt, background: true }
  }
  return agent
}

/** Turn key for a session: its final reply only changes when a new turn starts. */
export function turnKey(agent) {
  const a = effectiveAgent(agent)
  return `${a.state || ''}:${a.stateStartedAt || a.updatedAt || ''}`
}

/** Sessions whose final reply should be read from the transcript (finished or waiting). */
export function needsFinalReply(agent) {
  const a = effectiveAgent(agent)
  return Boolean(a.orcaSessionId) && (a.state === 'done' || a.state === 'waiting')
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
    for (const raw of ws.agents || []) {
      if (!raw.orcaSessionId || excludeSessions.includes(raw.orcaSessionId)) continue
      const agent = effectiveAgent(raw)
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
        background: Boolean(agent.background),
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
