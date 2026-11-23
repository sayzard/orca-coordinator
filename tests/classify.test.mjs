// Turn-end classification with a fake model runner (no network, synthetic text only).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.COORD_HOME = mkdtempSync(join(tmpdir(), 'coord-classify-'))

const { parseClassification, readTurnClasses, applyTurnClasses, classifierSettings } = await import('../cli/lib/classify.mjs')
const { deriveSessions } = await import('../cli/lib/lanes.mjs')

const ps = JSON.parse(readFileSync(new URL('./fixtures/worktree-ps.json', import.meta.url), 'utf8'))
const byId = (sessions) => Object.fromEntries(sessions.map((s) => [s.sessionId, s]))
const config = { classifier: { enabled: true, model: 'test-model' } }

/** A fake model: answers by a marker word in the reply and counts calls. */
function fakeRun() {
  const calls = []
  const run = async (_settings, input) => {
    calls.push(input)
    if (input.includes('LAYOUTS')) return { text: '{"label":"decision","question":"Which layout, A or B?"}' }
    if (input.includes('IFYOUWANT')) return { text: 'Sure: {"label":"offer","question":"ignored"}' }
    if (input.includes('BROKEN')) return { text: 'not json' }
    return { text: '{"label":"none","question":""}' }
  }
  return { run, calls }
}

function withReplies(replies) {
  const clone = structuredClone(ps)
  for (const ws of clone.worktrees) {
    for (const a of ws.agents) {
      if (replies[a.orcaSessionId] !== undefined) Object.assign(a, { state: 'done', agentWait: null, programStatus: { state: 'done' }, toolName: null, lastAssistantMessage: replies[a.orcaSessionId] })
    }
  }
  return clone
}

test('parseClassification keeps only known labels and drops questions outside decisions', () => {
  assert.deepEqual(parseClassification('{"label":"decision","question":"Push now?"}'), { label: 'decision', question: 'Push now?' })
  assert.deepEqual(parseClassification('ok {"label":"offer","question":"x"}'), { label: 'offer', question: '' })
  assert.equal(parseClassification('{"label":"maybe"}'), null)
  assert.equal(parseClassification('no json'), null)
})

test('the classifier is off unless turned on', () => {
  assert.equal(classifierSettings({}), null)
  assert.equal(classifierSettings({ classifier: { enabled: false } }), null)
  assert.equal(classifierSettings({ classifier: { enabled: true } }).model, 'claude-haiku-5-5')
})

test('a model decision raises a question the rules missed; offers and reports stay quiet', async () => {
  // Rules see no question in either reply.
  const data = withReplies({ 'sess-idle': 'I made two LAYOUTS in docs/shots/.', 'sess-chat': 'Done. IFYOUWANT I can add docs.' })
  assert.equal(byId(deriveSessions(data))['sess-idle'].lane, 'idle')
  const { run, calls } = fakeRun()
  const classes = await readTurnClasses(data, config, { run })
  const s = byId(deriveSessions(applyTurnClasses(data, classes, 'test-model')))
  assert.equal(s['sess-idle'].lane, 'human')
  assert.equal(s['sess-idle'].attention.text, 'Which layout, A or B?')
  assert.equal(s['sess-idle'].attention.source, 'model')
  assert.equal(s['sess-chat'].turnLabel, 'offer')
  assert.notEqual(s['sess-chat'].lane, 'human')
  // Menus are structured signals: the model is never asked about them.
  assert.ok(!calls.some((c) => c.includes('Fix it?')))
  assert.equal(s['sess-menu'].attention.kind, 'menu')
})

test('a model "none" overrides a rule match, and each turn is classified only once', async () => {
  const data = withReplies({ 'sess-question': 'Why did it fail? The cache was stale; fixed.' })
  const { run, calls } = fakeRun()
  const first = await readTurnClasses(data, config, { run })
  const n = calls.length
  const again = await readTurnClasses(data, config, { run })
  assert.equal(calls.length, n, 'cached turns are not sent again')
  assert.equal(again['sess-question'].label, 'none')
  const s = byId(deriveSessions(applyTurnClasses(data, first, 'test-model')))['sess-question']
  assert.equal(s.attention, null)
})

test('a changed reply or a new turn is classified again; an unparseable answer falls back to the rules', async () => {
  const { run, calls } = fakeRun()
  const before = withReplies({ 'sess-question': 'Plain report.' })
  await readTurnClasses(before, config, { run })
  const n = calls.length
  const after = withReplies({ 'sess-question': 'BROKEN reply.\nShall I push?' })
  const classes = await readTurnClasses(after, config, { run })
  assert.equal(calls.length, n + 1)
  assert.ok(classes['sess-question'].error)
  const s = byId(deriveSessions(applyTurnClasses(after, classes, 'test-model')))['sess-question']
  assert.equal(s.attention.source, 'rule')
  assert.equal(s.attention.text, 'Shall I push?')
})

test('excluded sessions and unmanaged projects are not classified', async () => {
  const data = withReplies({ 'sess-coordinator': 'Coordinator report LAYOUTS.', 'sess-idle': 'Another report.' })
  const { run, calls } = fakeRun()
  await readTurnClasses(data, { classifier: { enabled: true, model: 'other-model' } }, { run, excludeSessions: ['sess-coordinator'], projects: ['repo-alpha'] })
  assert.ok(calls.length > 0, 'managed sessions are classified')
  assert.ok(!calls.some((c) => c.includes('Coordinator report')))
})
