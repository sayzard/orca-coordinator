// Synthetic text only: the real corpus is private and never leaves the coordinator home.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.COORD_HOME = mkdtempSync(join(tmpdir(), 'coord-eval-'))

const { claudeTurnEnds, codexTurnEnds, splitOf, itemId, latestLabels, score, signalItems, toItem } = await import('../scripts/detection-eval.mjs')
const { watchTurns, readSignals, recordCardOutcome } = await import('../cli/lib/signals.mjs')

const assistant = (text, stop) => ({ type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: stop } })
const toolUse = () => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }], stop_reason: 'tool_use' } })
const person = (text) => ({ type: 'user', message: { content: text } })

test('Claude Code turn ends: the final text of an ended turn and the next message the person typed', async () => {
  const records = [
    person('Fix the build.'),
    assistant('Looking at the logs first.', null),
    toolUse(),
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    assistant('Fixed it.\nShall I push?', 'end_turn'),
    person('<command-name>/clear</command-name>'),
    person('yes'),
    assistant('Working on it.', 'tool_use'),
    person('also update the docs'), // typed mid-turn: not a turn end
    { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued…' } }
  ]
  const ends = await claudeTurnEnds(records)
  assert.equal(ends.length, 1)
  assert.equal(ends[0].reply, 'Fixed it.\nShall I push?')
  assert.equal(ends[0].next, 'yes')
})

test('Codex turn ends come from task_complete and the next user message', async () => {
  const records = [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Done. Which option do you want?', completed_at: '1795133469' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'option B' }] } }
  ]
  const ends = await codexTurnEnds(records)
  assert.deepEqual(ends.map((e) => [e.reply, e.next]), [['Done. Which option do you want?', 'option B']])
})

test('the split is stable and holds out roughly a third', () => {
  const ids = Array.from({ length: 2000 }, (_, i) => itemId(`reply ${i}`, 'next'))
  assert.equal(splitOf(ids[0]), splitOf(ids[0]))
  const held = ids.filter((id) => splitOf(id) === 'holdout').length / ids.length
  assert.ok(held > 0.25 && held < 0.36, `holdout share ${held}`)
})

test('a person label beats a model label for the same item', () => {
  const labels = latestLabels([
    { id: 'a', label: 'offer', by: 'person' },
    { id: 'a', label: 'decision', by: 'llm:opus' },
    { id: 'b', label: 'none', by: 'llm:opus' },
    { id: 'b', label: 'decision', by: 'llm:opus' },
    { id: 'c', label: 'maybe', by: 'person' }
  ])
  assert.equal(labels.get('a').label, 'offer')
  assert.equal(labels.get('b').label, 'decision')
  assert.ok(!labels.has('c'))
})

test('score reports decision recall and precision, offers and false alarms separately', () => {
  const items = [
    toItem('claude', 'p', { reply: 'Done.\nShall I push?', next: 'yes' }),
    toItem('claude', 'p', { reply: 'Two designs above, A and B.', next: 'A' }),
    // An offer the rules still flag: "what next" closers read like a request.
    toItem('claude', 'p', { reply: 'Done.\nLet me know what to pick up next.', next: 'thanks' }),
    toItem('claude', 'p', { reply: 'All tests pass.', next: 'next task' }),
    toItem('claude', 'p', { reply: 'Why did it fail?\nBecause the cache was stale.', next: 'ok' })
  ]
  const labels = latestLabels([
    { id: items[0].id, label: 'decision' },
    { id: items[1].id, label: 'decision' },
    { id: items[2].id, label: 'offer' },
    { id: items[3].id, label: 'none' },
    { id: items[4].id, label: 'none' }
  ])
  const s = score(items, labels)
  assert.equal(s.labeled, 5)
  assert.equal(s.decisionRecall, 50)
  assert.equal(s.counts.offer.flagged, 1)
  assert.equal(s.noneFalseAlarmRate, 50)
  assert.deepEqual(s.errors.map((e) => e.kind).sort(), ['flagged', 'flagged', 'missed'])
})

test('board signals become corpus items with the signal kept as evidence', () => {
  const items = signalItems([{ type: 'dismissed', project: 'p', reply: 'Done.\nIf you need more, tell me.', line: 'If you need more, tell me.', at: 1 }, { type: 'dismissed', reply: '' }])
  assert.equal(items.length, 1)
  assert.equal(items[0].signal, 'dismissed')
  assert.equal(items[0].source, 'board')
})

test('a reply to a finished turn without a card is recorded as a possible miss', () => {
  const base = { sessionId: 's1', kind: 'terminal', agent: 'claude', project: 'p', attention: null, handled: false }
  watchTurns([{ ...base, state: 'done', lane: 'idle', prompt: 'first ask', replyTail: 'Two designs above, A and B.' }])
  watchTurns([{ ...base, state: 'done', lane: 'idle', prompt: 'first ask', replyTail: 'Two designs above, A and B.' }]) // no change, no signal
  watchTurns([{ ...base, state: 'working', lane: 'running', prompt: 'A please', replyTail: '' }])
  watchTurns([{ ...base, state: 'working', lane: 'running', prompt: 'A please', replyTail: '' }])
  const s = readSignals()
  assert.equal(s.length, 1)
  assert.equal(s[0].type, 'answered_unflagged')
  assert.equal(s[0].reply, 'Two designs above, A and B.')
  assert.equal(s[0].next, 'A please')
})

test('card outcomes are recorded with the end of the reply', () => {
  recordCardOutcome('dismissed', { sessionId: 's2', question: 'Let me know if you want more.', source: 'auto' }, { sessionId: 's2', project: 'p', replyTail: 'Done.\nLet me know if you want more.' })
  const last = readSignals().at(-1)
  assert.equal(last.type, 'dismissed')
  assert.equal(last.line, 'Let me know if you want more.')
  assert.match(readFileSync(join(process.env.COORD_HOME, 'eval/signals.jsonl'), 'utf8'), /dismissed/)
})
