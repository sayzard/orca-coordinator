// "My decisions" cards. Two kinds:
//   stored   — written by the coordinator (`coord decision add`): question + recommended reply
//   auto:<id> — computed from live state (a menu, a permission prompt, a question in the last
//               reply) so the board is useful before any digest runs
// Delivery is guarded: a card is only answered while its session is still where the card saw it.
import { readJson, updateJson, appendHistory, newId, tempFile } from './store.mjs'
import { orca } from './orca.mjs'
import { sendAsBoard } from './board.mjs'
import { requireCoordinator } from './data.mjs'
import { recordCardOutcome } from './signals.mjs'

const EMPTY = { version: 1, decisions: [], suppressed: [] }
const PRIORITY_RANK = { now: 0, menu: 1, permission: 1, reply: 1, today: 2, week: 3, undated: 5 }

export function readDecisions() {
  const d = readJson('decisions.json', EMPTY)
  return { ...EMPTY, ...d }
}

export function autoCardFor(session) {
  if (!session.attention) return null
  const a = session.attention
  return {
    id: `auto:${session.sessionId}`,
    source: 'auto',
    sessionId: session.sessionId,
    question: a.text,
    recommendation: '',
    reason: a.kind === 'menu' ? 'A menu is open in the session. Pick an option there.' : a.kind === 'permission' ? 'Waiting for a permission decision. Approve or deny it in the session.' : 'The last reply ends with a question. Request a digest for a suggested reply.',
    reasonKey: a.source === 'model' && a.kind === 'question' ? 'auto.model' : `auto.${a.kind}`,
    // Quick replies from the turn classifier: pressing one sends it at once.
    options: (a.options || []).map((o) => ({ label: o.label, reply: o.reply, send: true })),
    needsInput: '',
    priority: a.kind === 'question' ? 'reply' : a.kind,
    canReply: a.canReply,
    status: 'open',
    createdAt: session.stateStartedAt || session.updatedAt || Date.now(),
    evidence: { state: session.state, stateStartedAt: session.stateStartedAt, fingerprint: session.fingerprint }
  }
}

function attach(card, session) {
  return {
    ...card,
    target: session
      ? { sessionId: session.sessionId, kind: session.kind, agent: session.agent, project: session.project, workspace: session.workspace, title: session.title, state: session.state, lane: session.lane, handle: session.handle, workspaceSelector: session.workspaceSelector, path: session.path }
      : card.target || null,
    stale: Boolean(!card.askMessageId && session && card.evidence?.fingerprint && card.source !== 'auto' && session.fingerprint !== card.evidence.fingerprint && card.status === 'open')
  }
}

function handledKeys(store) {
  return new Set(store.suppressed.map((s) => `${s.sessionId}:${s.fingerprint}`))
}

/**
 * A session whose card was answered or dismissed in its current state no longer needs the
 * person: it leaves the "Needs you" lane until the session moves on (a new fingerprint).
 */
export function settleHandled(sessions, store = readDecisions()) {
  const handled = handledKeys(store)
  return sessions.map((s) => {
    if (s.lane !== 'human' || !handled.has(`${s.sessionId}:${s.fingerprint}`)) return s
    return { ...s, attention: null, handled: true, lane: s.state === 'done' && s.unread ? 'review' : 'idle' }
  })
}

/** Open cards for the board: stored ones first-class, auto ones only where no stored card covers the session. */
export function boardCards(sessions, store = readDecisions()) {
  const bySession = new Map(sessions.map((s) => [s.sessionId, s]))
  const open = store.decisions.filter((d) => d.status === 'open')
  const covered = new Set(open.map((d) => d.sessionId))
  const suppressed = handledKeys(store)
  const cards = open.map((d) => attach(d, bySession.get(d.sessionId)))
  for (const s of sessions) {
    if (covered.has(s.sessionId) || suppressed.has(`${s.sessionId}:${s.fingerprint}`)) continue
    const auto = autoCardFor(s)
    if (auto) cards.push(attach(auto, s))
  }
  cards.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 5) - (PRIORITY_RANK[b.priority] ?? 5) || (a.createdAt || 0) - (b.createdAt || 0))
  return cards
}

function parseOptions(options = []) {
  return options
    .map((o) => {
      if (typeof o === 'object') return o
      const i = o.indexOf('=')
      return i > 0 ? { label: o.slice(0, i).trim(), reply: o.slice(i + 1).trim() } : { label: o.trim(), reply: o.trim() }
    })
    .filter((o) => o.label)
    .slice(0, 6)
}

export async function addDecision({ sessions, sessionId, question, recommendation = '', reason = '', options = [], needsInput = '', priority = 'undated', askMessageId = null, dispatchId = null, fallbackTarget = null, source = 'coordinator' }) {
  if (!question?.trim()) throw new Error('question_required: --question is required')
  const session = sessions.find((s) => s.sessionId === sessionId)
  if (!session && !askMessageId) throw new Error(`session_not_found: ${sessionId} is not in orca worktree ps (managed projects only)`)
  const now = Date.now()
  let saved
  await updateJson('decisions.json', EMPTY, (store) => {
    const s = { ...EMPTY, ...store }
    const existing = s.decisions.find((d) => d.sessionId === sessionId && d.status === 'open')
    const card = {
      id: existing?.id || newId('dec'),
      source,
      sessionId,
      question: question.trim().slice(0, 1000),
      recommendation: recommendation.trim().slice(0, 4000),
      reason: reason.trim().slice(0, 1000),
      options: parseOptions(options),
      needsInput: needsInput.trim().slice(0, 500),
      priority: PRIORITY_RANK[priority] !== undefined ? priority : 'undated',
      askMessageId,
      dispatchId,
      // A worker's ask is answered through the coordinator (orchestration reply), so it is always answerable here.
      canReply: askMessageId ? true : session ? session.attention?.canReply !== false : false,
      status: 'open',
      revision: (existing?.revision || 0) + 1,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      evidence: session ? { state: session.state, stateStartedAt: session.stateStartedAt, fingerprint: session.fingerprint } : null,
      target: session ? { project: session.project, workspace: session.workspace, title: session.title, kind: session.kind } : fallbackTarget
    }
    s.decisions = s.decisions.filter((d) => d !== existing).concat(card)
    // Keep the file small: drop closed cards older than 14 days.
    s.decisions = s.decisions.filter((d) => d.status === 'open' || now - (d.updatedAt || 0) < 14 * 86400_000)
    saved = card
    return s
  })
  appendHistory({ type: 'decision.added', id: saved.id, sessionId, question: saved.question, source })
  if (session) await orca(['worktree', 'set', '--worktree', session.workspaceSelector, '--unread']).catch(() => null)
  return saved
}

function findCard(id, sessions) {
  if (id.startsWith('auto:')) {
    const session = sessions.find((s) => s.sessionId === id.slice(5))
    return { card: session ? autoCardFor(session) : null, session }
  }
  const card = readDecisions().decisions.find((d) => d.id === id)
  return { card, session: card ? sessions.find((s) => s.sessionId === card.sessionId) : null }
}

/**
 * Checks that a card can still be answered. `seenFingerprint` is what the person was looking at.
 * Throws an Error whose message starts with a stable code.
 */
export function guard(card, session, { seenFingerprint = null, via }) {
  if (!card) throw new Error('card_not_found: no such card')
  if (card.status && card.status !== 'open') throw new Error(`card_closed: the card is already ${card.status}`)
  if (via === 'coordinator') return
  if (!session) throw new Error('session_gone: the target session is no longer visible')
  if (session.state === 'working') throw new Error('session_busy: the target session is working; send after it finishes')
  const expected = seenFingerprint || card.evidence?.fingerprint
  if (expected && session.fingerprint !== expected) throw new Error('stale: the session moved on after this card was made; request a new digest')
  if (session.attention && session.attention.canReply === false) throw new Error('answer_in_session: a menu or permission prompt is open; open the session to answer it')
}

export function formatAnswer(card, session, text) {
  const project = session?.project || card.target?.project || ''
  const title = (session?.title || card.target?.title || card.question || '').slice(0, 60)
  return `[Coordinator Board · ${project} · ${title}]\n${text.trim()}`
}

/** For the plugin worker: validates and returns what to type into the session's terminal. */
export function prepareTerminalAnswer({ id, text, seenFingerprint, sessions }) {
  const { card, session } = findCard(id, sessions)
  if (card?.askMessageId) throw new Error('use_coordinator: a worker question is answered by the coordinator with orchestration reply (--via coordinator)')
  guard(card, session, { seenFingerprint, via: 'terminal' })
  if (session.kind !== 'terminal' || !session.handle?.startsWith('term_')) throw new Error('not_terminal: answer a chat session with --via mail')
  return { id, handle: session.handle, sessionId: session.sessionId, workspaceSelector: session.workspaceSelector, message: formatAnswer(card, session, text) }
}

async function closeCard(id, card, session, { text, via, receipt }) {
  const now = Date.now()
  await updateJson('decisions.json', EMPTY, (store) => {
    const s = { ...EMPTY, ...store }
    // Remember the session state the person dealt with, so neither its auto card nor its
    // "Needs you" lane comes back until the session moves on.
    s.suppressed = s.suppressed.filter((x) => now - x.at < 7 * 86400_000)
    if (session) s.suppressed.push({ sessionId: session.sessionId, fingerprint: session.fingerprint, at: now })
    if (!id.startsWith('auto:')) {
      s.decisions = s.decisions.map((d) => (d.id === id ? { ...d, status: via === 'dismiss' ? 'dismissed' : 'answered', answer: text || null, delivery: { via, at: now, receipt: receipt || null }, updatedAt: now } : d))
    }
    return s
  })
  recordCardOutcome(via === 'dismiss' ? 'dismissed' : 'card_answered', card, session)
  appendHistory({ type: via === 'dismiss' ? 'decision.dismissed' : 'decision.answered', id, sessionId: card?.sessionId, question: card?.question, answer: text || null, via, project: session?.project || card?.target?.project, title: session?.title || card?.target?.title, receipt: receipt || null })
  if (session) await orca(['worktree', 'set', '--worktree', session.workspaceSelector, '--read']).catch(() => null)
}

export async function markDelivered({ id, text, receipt, sessions }) {
  const { card, session } = findCard(id, sessions)
  if (!card) throw new Error('card_not_found')
  await closeCard(id, card, session, { text, via: 'terminal', receipt })
  return { id, status: 'answered' }
}

export async function dismissDecision({ id, sessions }) {
  const { card, session } = findCard(id, sessions)
  if (!card) throw new Error('card_not_found')
  await closeCard(id, card, session, { via: 'dismiss' })
  return { id, status: 'dismissed' }
}

/** Mail delivery: to a chat session itself, or to the coordinator to handle on the person's behalf. */
export async function answerByMail({ id, text, via, seenFingerprint, sessions, config }) {
  if (!text?.trim()) throw new Error('text_required: the answer is empty')
  const { card, session } = findCard(id, sessions)
  if (card?.askMessageId) via = 'coordinator'
  guard(card, session, { seenFingerprint, via })
  let to
  let body
  if (via === 'coordinator') {
    await requireCoordinator(config)
    to = `orca_session_id:${config.coordinator.sessionId}`
    const lines = [
      '[Coordinator Board · Delegated decision]',
      JSON.stringify({ cardId: id, sessionId: card.sessionId, askMessageId: card.askMessageId || null, project: session?.project || card.target?.project || null, language: config.language || 'en' }),
      '',
      `Question: ${card.question}`,
      card.recommendation ? `Suggested answer was: ${card.recommendation}` : null,
      '',
      `The person's answer / instruction:\n${text.trim()}`,
      '',
      card.askMessageId
        ? `Relay this answer to the worker question ${card.askMessageId} with orca orchestration reply.`
        : 'Carry this decision to the session it belongs to (orca orchestration send; terminal sessions read it as mail). Never type into another agent\'s terminal.'
    ]
    body = lines.filter((l) => l !== null).join('\n')
  } else {
    if (session.kind === 'terminal') {
      // Terminal agents read mail through `orca orchestration check`; the panel types directly instead.
      to = session.handle
    } else {
      to = `orca_session_id:${session.sessionId}`
    }
    body = `${formatAnswer(card, session, text)}\n\n(This is the person's decision, sent from the coordinator board. Continue your work accordingly.)`
  }
  const receipt = await sendAsBoard(config, { to, type: 'dispatch', subject: `[Decision] ${card.question.slice(0, 60)}`, bodyFile: tempFile('answer', body) })
  await closeCard(id, card, session, { text, via: via === 'coordinator' ? 'coordinator' : 'mail', receipt })
  return { id, status: 'answered', via, messageId: receipt.messageId }
}
