// One snapshot of the whole board: what the panel draws, what the bot reports, what the
// coordinator reads at the start of a turn.
import { applyFinalReplies, deriveSessions, groupByProject, LANE_ORDER } from './lanes.mjs'
import { boardCards, settleHandled } from './decisions.mjs'
import { readWorktrees, readAgentList, readUsage, readFinalReplies } from './data.mjs'
import { readRequests, closedWorktrees } from './requests.mjs'
import { readHistory } from './store.mjs'
import { watchTurns } from './signals.mjs'
import { readTurnClasses, applyTurnClasses } from './classify.mjs'

export async function loadSessions(config, { fresh = false } = {}) {
  const [ps, agentList] = await Promise.all([readWorktrees(config, { fresh }), readAgentList(config, { fresh }).catch(() => null)])
  const exclude = config.coordinator?.sessionId ? [config.coordinator.sessionId] : []
  const finals = await readFinalReplies(ps).catch(() => ({}))
  const withFinals = applyFinalReplies(ps, finals)
  const classes = await readTurnClasses(withFinals, config, { projects: config.projects || [], excludeSessions: exclude }).catch(() => ({}))
  const sessions = deriveSessions(applyTurnClasses(withFinals, classes), { agentList, projects: config.projects || [], excludeSessions: exclude })
  const closed = closedWorktrees()
  // A finished, verified request's worker is not waiting for review any more.
  const settled = settleHandled(sessions).map((s) => (s.lane === 'review' && closed.has(s.worktreeId) ? { ...s, lane: 'idle' } : s))
  watchTurns(settled)
  return settled
}

function slimSession(s) {
  const { lastAssistantMessage, prompt, replyTail, ...rest } = s
  return { ...rest, lastAssistantMessage: (lastAssistantMessage || '').slice(0, 600), prompt: (prompt || '').slice(0, 200) }
}

export async function buildStatus(config, { fresh = false, project = null } = {}) {
  let sessions = await loadSessions(config, { fresh })
  if (project) sessions = sessions.filter((s) => s.repoId === project || s.project === project)
  const cards = boardCards(sessions)
  const projects = groupByProject(sessions).map((g) => ({ ...g, sessions: g.sessions.map(slimSession) }))
  const totals = Object.fromEntries(LANE_ORDER.map((l) => [l, sessions.filter((s) => s.lane === l).length]))
  const requests = readRequests().requests.slice(-15).reverse()
  const usage = await readUsage(config).catch(() => [])
  let coordinator = null
  if (config.coordinator?.sessionId) {
    const agents = (await readAgentList(config).catch(() => null))?.agents || []
    const row = agents.find((a) => a.orcaSessionId === config.coordinator.sessionId)
    // A closed chat is no longer listed; mail to it would be stored but never read.
    coordinator = { ...config.coordinator, state: row ? row.state || 'unknown' : agents.length ? 'closed' : 'unknown', lastReply: (row?.lastAssistantMessage || '').slice(0, 400) }
  }
  return {
    generatedAt: Date.now(),
    language: config.language || 'en',
    classifier: { enabled: Boolean(config.classifier?.enabled), model: config.classifier?.model || 'claude-haiku-5-5' },
    managedProjects: config.projects || [],
    coordinator,
    counts: { decisions: cards.length, ...totals, sessions: sessions.length },
    decisions: cards,
    projects,
    requests,
    usage,
    history: readHistory(40)
  }
}
