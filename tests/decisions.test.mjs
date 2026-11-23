// Runs against a temporary COORD_HOME and a fake `orca` that answers ok to everything.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.COORD_HOME = mkdtempSync(join(tmpdir(), 'coord-test-'))
process.env.COORD_ORCA_BIN = fileURLToPath(new URL('./fixtures/fake-orca.sh', import.meta.url))

const { deriveSessions } = await import('../cli/lib/lanes.mjs')
const { addDecision, boardCards, guard, prepareTerminalAnswer, markDelivered, dismissDecision, readDecisions, formatAnswer, settleHandled } = await import('../cli/lib/decisions.mjs')

const ps = JSON.parse(readFileSync(new URL('./fixtures/worktree-ps.json', import.meta.url), 'utf8'))
let sessions
before(() => {
  sessions = deriveSessions(ps, { excludeSessions: ['sess-coordinator'] })
})

function moved(sessionId, patch) {
  return sessions.map((s) => (s.sessionId === sessionId ? { ...s, ...patch } : s))
}

test('auto cards appear for sessions that need the person', () => {
  const cards = boardCards(sessions)
  const ids = cards.map((c) => c.id)
  assert.ok(ids.includes('auto:sess-menu'))
  assert.ok(ids.includes('auto:sess-question'))
  assert.ok(ids.includes('auto:sess-chat'))
  assert.ok(!ids.includes('auto:sess-working'))
  const menu = cards.find((c) => c.id === 'auto:sess-menu')
  assert.equal(menu.canReply, false)
  assert.equal(menu.target.project, 'alpha')
})

test('a coordinator card replaces the auto card for its session and is upserted', async () => {
  const card = await addDecision({ sessions, sessionId: 'sess-question', question: 'Deploy with blue-green or canary?', recommendation: 'Go canary, starting at 10%.', reason: 'Cheaper rollback', options: ['Canary=Go canary, please.', 'Blue-green=Go blue-green, please.'] })
  assert.equal(card.revision, 1)
  assert.equal(card.options.length, 2)
  const again = await addDecision({ sessions, sessionId: 'sess-question', question: 'Pick a deployment strategy', recommendation: 'Canary' })
  assert.equal(again.id, card.id)
  assert.equal(again.revision, 2)
  const cards = boardCards(sessions)
  assert.ok(!cards.some((c) => c.id === 'auto:sess-question'))
  assert.equal(cards.filter((c) => c.sessionId === 'sess-question').length, 1)
})

test('unknown sessions are refused unless the card answers a worker ask', async () => {
  await assert.rejects(addDecision({ sessions, sessionId: 'nope', question: 'q' }), /session_not_found/)
  const c = await addDecision({ sessions, sessionId: 'worker-x', question: 'A worker question', askMessageId: 'msg_1' })
  assert.equal(c.askMessageId, 'msg_1')
})

test('guard refuses busy, moved-on and menu sessions', () => {
  const card = readDecisions().decisions.find((d) => d.sessionId === 'sess-question')
  const session = sessions.find((s) => s.sessionId === 'sess-question')
  assert.doesNotThrow(() => guard(card, session, { via: 'terminal' }))
  assert.throws(() => guard(card, { ...session, state: 'working' }, { via: 'terminal' }), /session_busy/)
  assert.throws(() => guard(card, { ...session, fingerprint: 'other' }, { via: 'terminal' }), /^Error: stale/)
  assert.throws(() => guard(card, undefined, { via: 'terminal' }), /session_gone/)
  assert.doesNotThrow(() => guard(card, undefined, { via: 'coordinator' }))
  const menuSession = sessions.find((s) => s.sessionId === 'sess-menu')
  assert.throws(() => guard({ status: 'open', evidence: null }, menuSession, { via: 'terminal' }), /answer_in_session/)
})

test('the person must see the same fingerprint the card was made from', () => {
  const card = readDecisions().decisions.find((d) => d.sessionId === 'sess-question')
  const session = sessions.find((s) => s.sessionId === 'sess-question')
  assert.throws(() => guard(card, session, { via: 'terminal', seenFingerprint: 'old' }), /stale/)
})

test('prepare gives the terminal handle and a headed message', () => {
  const card = readDecisions().decisions.find((d) => d.sessionId === 'sess-question')
  const p = prepareTerminalAnswer({ id: card.id, text: 'Go canary, please.', sessions })
  assert.equal(p.handle, 'term_q-0003')
  assert.match(p.message, /^\[Coordinator Board · alpha · Deployment strategy\]\nGo canary, please\.$/)
  assert.throws(() => prepareTerminalAnswer({ id: card.id, text: 'x', sessions: moved('sess-question', { state: 'working' }) }), /session_busy/)
  assert.throws(() => prepareTerminalAnswer({ id: 'auto:sess-chat', text: 'x', sessions }), /not_terminal/)
})

test('delivered cards close and stop showing; a second send is refused', async () => {
  const card = readDecisions().decisions.find((d) => d.sessionId === 'sess-question' && d.status === 'open')
  await markDelivered({ id: card.id, text: 'Canary', receipt: { requestId: 'r1' }, sessions })
  const closed = readDecisions().decisions.find((d) => d.id === card.id)
  assert.equal(closed.status, 'answered')
  assert.equal(closed.delivery.via, 'terminal')
  assert.throws(() => prepareTerminalAnswer({ id: card.id, text: 'x', sessions }), /card_closed/)
})

test('dismissing an auto card hides it until the session changes', async () => {
  await dismissDecision({ id: 'auto:sess-chat', sessions })
  assert.ok(!boardCards(sessions).some((c) => c.id === 'auto:sess-chat'))
  const later = moved('sess-chat', { fingerprint: 'new-turn' })
  assert.ok(boardCards(later).some((c) => c.id === 'auto:sess-chat'))
})

// Seen live: after [Dismiss] the card was gone, but Progress still counted the session under
// "Needs you".
test('a handled session leaves the Needs you lane until it moves on', () => {
  const settled = settleHandled(sessions)
  const chat = settled.find((s) => s.sessionId === 'sess-chat')
  assert.notEqual(chat.lane, 'human')
  assert.equal(chat.attention, null)
  assert.equal(chat.handled, true)
  // The menu was never dealt with, so it still needs the person.
  assert.equal(settled.find((s) => s.sessionId === 'sess-menu').lane, 'human')
  const later = settleHandled(moved('sess-chat', { fingerprint: 'new-turn' }))
  assert.equal(later.find((s) => s.sessionId === 'sess-chat').lane, 'human')
})

test('closing a coordinator card keeps the auto card for that state from coming back', () => {
  // sess-question's coordinator card was answered above; its own question is not re-raised.
  assert.ok(!boardCards(sessions).some((c) => c.id === 'auto:sess-question'))
  assert.notEqual(settleHandled(sessions).find((s) => s.sessionId === 'sess-question').lane, 'human')
})

test('menu cards sort ahead of undated coordinator cards', async () => {
  await addDecision({ sessions, sessionId: 'sess-done-unread', question: 'Merge the result?', priority: 'week' })
  const cards = boardCards(sessions)
  const order = cards.map((c) => c.priority)
  assert.ok(order.indexOf('menu') < order.indexOf('week'))
})

test('formatAnswer keeps the header on one line', () => {
  const msg = formatAnswer({ question: 'q', target: { project: 'p', title: 't' } }, null, '  yes  ')
  assert.equal(msg, '[Coordinator Board · p · t]\nyes')
})

test('a worker ask card is always answerable and never stale, and goes through the coordinator', async () => {
  const card = await addDecision({ sessions, sessionId: 'sess-idle', question: 'May I change the schema?', recommendation: 'Yes, and add a migration.', askMessageId: 'msg_ask1', dispatchId: 'ctx_1' })
  assert.equal(card.canReply, true)
  assert.equal(card.dispatchId, 'ctx_1')
  const moved = sessions.map((s) => (s.sessionId === 'sess-idle' ? { ...s, fingerprint: 'changed' } : s))
  const shown = boardCards(moved).find((c) => c.id === card.id)
  assert.equal(shown.stale, false)
  assert.throws(() => prepareTerminalAnswer({ id: card.id, text: 'x', sessions }), /use_coordinator/)
})

test('a worker ask card without a visible session keeps the target it was given', async () => {
  const card = await addDecision({ sessions, sessionId: 'dispatch:ctx_9', question: 'q', askMessageId: 'msg_9', dispatchId: 'ctx_9', fallbackTarget: { project: 'alpha', workspace: 'task-x', title: 'worker ctx_9', kind: 'chat' } })
  assert.equal(card.canReply, true)
  const shown = boardCards(sessions).find((c) => c.id === card.id)
  assert.equal(shown.target.project, 'alpha')
})
