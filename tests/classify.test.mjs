// Turn-end classification with a fake model runner (no network, synthetic text only).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.COORD_HOME = mkdtempSync(join(tmpdir(), 'coord-classify-'))

const { parseClassification, readTurnClasses, applyTurnClasses, classifierSettings, candidateReplies, jevRequest, parseJev, classifyText } = await import('../cli/lib/classify.mjs')
const { autoCardFor } = await import('../cli/lib/decisions.mjs')
const { deriveSessions } = await import('../cli/lib/lanes.mjs')

const ps = JSON.parse(readFileSync(new URL('./fixtures/worktree-ps.json', import.meta.url), 'utf8'))
const byId = (sessions) => Object.fromEntries(sessions.map((s) => [s.sessionId, s]))
const config = { classifier: { enabled: true, model: 'test-model' } }
const settings = classifierSettings(config)

/** A fake model: answers by a marker word in the reply and counts calls. */
function fakeRun() {
  const calls = []
  const run = async (_settings, input) => {
    calls.push(input)
    if (input.includes('LAYOUTS')) return { text: '{"label":"decision","question":"Which layout, A or B?","options":[{"label":"A","reply":"Go with A."},{"label":"B","reply":"Go with B."}]}' }
    if (input.includes('IFYOUWANT')) return { text: 'Sure: {"label":"offer","question":"ignored"}' }
    if (input.includes('STEPTWO')) return { text: '{"label":"decision","question":"Go ahead with step 2?","options":[{"label":"Go ahead","reply":"Go ahead."}],"stalled":true}' }
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
  assert.equal(parseClassification('{"label":"decision","question":"Push now?"}').question, 'Push now?')
  assert.deepEqual(parseClassification('{"label":"decision","question":"Push now?"}').options, [])
  assert.deepEqual(parseClassification('ok {"label":"offer","question":"x","options":[{"label":"a","reply":"b"}]}'), { label: 'offer', question: '', options: [] })
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
  const s = byId(deriveSessions(applyTurnClasses(data, classes, settings)))
  assert.equal(s['sess-idle'].lane, 'human')
  assert.equal(s['sess-idle'].attention.text, 'Which layout, A or B?')
  assert.equal(s['sess-idle'].attention.source, 'model')
  // The model's quick replies become one-press buttons on the card.
  const card = autoCardFor(s['sess-idle'])
  assert.deepEqual(card.options, [{ label: 'A', reply: 'Go with A.', send: true }, { label: 'B', reply: 'Go with B.', send: true }])
  assert.equal(card.reasonKey, 'auto.model')
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
  const s = byId(deriveSessions(applyTurnClasses(data, first, settings)))['sess-question']
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
  const s = byId(deriveSessions(applyTurnClasses(after, classes, settings)))['sess-question']
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

test('quick-reply buttons are short, capped at four and need both a label and a reply', () => {
  const r = parseClassification(JSON.stringify({ label: 'decision', question: 'q', options: [{ label: 'One very long label that goes on and on', reply: 'x' }, { label: '', reply: 'y' }, { label: 'b', reply: 'b' }, { label: 'c', reply: 'c' }, { label: 'd', reply: 'd' }, { label: 'e', reply: 'e' }] }))
  assert.equal(r.options.length, 4)
  assert.ok(r.options[0].label.length <= 24)
  assert.ok(!r.options.some((o) => !o.label))
})

test('Jev candidates: the options a reply lists, then yes / as recommended / no in its language', () => {
  const ko = candidateReplies('두 가지 안이 있습니다.\n1. 카메라를 140mm로 변경\n2. 조명만 조정\n어느 쪽으로 할까요?')
  assert.deepEqual(ko.slice(0, 2).map((c) => c.reply), ['1번으로 진행해 주세요.', '2번으로 진행해 주세요.'])
  assert.ok(ko.some((c) => c.reply === '추천하신 대로 진행해 주세요.'))
  const en = candidateReplies('Options:\nA) keep the sidebar\nB) move it to the top\nWhich one?')
  assert.deepEqual(en.slice(0, 2).map((c) => c.reply), ['Go with option A.', 'Go with option B.'])
  assert.equal(en.at(-1).reply, "No, don't.")
})

test('a Jev request asks for the label and one yes/no question per candidate button', () => {
  const { body, candidates } = jevRequest('Shall I push it to main?', 'jev-1.14.0')
  assert.equal(body.model, 'jev-1.14.0')
  assert.equal(body.questions.label.type, 'choice')
  assert.deepEqual(Object.keys(body.questions.label.criteria), ['decision', 'offer', 'none'])
  assert.equal(Object.keys(body.questions).length, 1 + candidates.length)
  assert.ok(Object.entries(body.questions).filter(([k]) => k !== 'label').every(([, q]) => q.type === 'noul'))
})

test('a Jev decision keeps the buttons it finds fitting, most likely first; the question comes from the rules', () => {
  const tail = 'Tests pass.\nShall I push it to main?'
  const candidates = candidateReplies(tail)
  const answers = { label: { type: 'choice', choice: 'decision', confidence: 0.9 } }
  candidates.forEach((c, i) => (answers[`b${i}`] = { type: 'noul', noul: c.reply === 'Yes, go ahead.' ? 0.92 : c.reply === "No, don't." ? 0.71 : 0.2 }))
  const r = parseJev({ model: 'jev-1.14.0', answers }, candidates, tail)
  assert.equal(r.label, 'decision')
  assert.equal(r.question, 'Shall I push it to main?')
  assert.deepEqual(r.options.map((o) => o.reply), ['Yes, go ahead.', "No, don't."])
  assert.deepEqual(parseJev({ answers: { label: { choice: 'offer' } } }, candidates, tail), { label: 'offer', question: '', options: [] })
  assert.equal(parseJev({ answers: {} }, candidates, tail), null)
})

test('Jev runs only with a key; without one, cached answers still apply but nothing is sent', async () => {
  const jevConfig = { classifier: { enabled: true, provider: 'jev' } }
  assert.equal(classifierSettings(jevConfig, {}).ready, false)
  const withKey = classifierSettings(jevConfig, { TYPESAFE_API_KEY: 'k' })
  assert.equal(withKey.ready, true)
  assert.equal(withKey.model, 'jev-1.14.0')
  const sentBodies = []
  const run = async (_s, body) => {
    sentBodies.push(body)
    return { json: { answers: { label: { choice: 'decision' }, b0: { noul: 0.9 } } } }
  }
  const r = await classifyText('Shall I push?', withKey, run)
  assert.equal(r.label, 'decision')
  assert.equal(sentBodies.length, 1)
  const data = withReplies({ 'sess-idle': 'Plain report for jev.' })
  let called = 0
  await readTurnClasses(data, jevConfig, { env: {}, run: async () => (called++, { json: {} }) })
  assert.equal(called, 0)
})

// A turn that ends by announcing its next step ("stalled"): the model marks it, the card gets a
// go-ahead button, and a session whose background job is still running is left alone.
test('a stalled turn from the model becomes a go-ahead card, except while a background job runs', async () => {
  assert.equal(parseClassification('{"label":"decision","question":"Go ahead?","options":[],"stalled":true}').stalled, true)
  assert.equal(parseClassification('{"label":"none","question":"","options":[],"stalled":true}').stalled, undefined)
  // Wording the rules do not read as an announcement.
  const data = withReplies({ 'sess-idle': 'The plan has three steps. STEPTWO is what comes after this message.' })
  const { run } = fakeRun()
  const classes = await readTurnClasses(data, config, { run })
  assert.equal(classes['sess-idle'].stalled, true)
  let s = byId(deriveSessions(applyTurnClasses(data, classes, settings)))['sess-idle']
  assert.equal(s.lane, 'human')
  assert.equal(s.attention.text, 'Go ahead with step 2?')
  assert.deepEqual(autoCardFor(s).options, [{ label: 'Go ahead', reply: 'Go ahead.', send: true }])
  assert.equal(autoCardFor(s).reasonKey, 'auto.stalled')
  // The same turn with a background shell still running: Orca reports the session as working.
  const running = structuredClone(data)
  for (const ws of running.worktrees) for (const a of ws.agents) if (a.orcaSessionId === 'sess-idle') Object.assign(a, { state: 'working', mainAgent: { state: 'done', stateStartedAt: a.stateStartedAt } })
  const again = await readTurnClasses(running, config, { run })
  s = byId(deriveSessions(applyTurnClasses(running, again, settings)))['sess-idle']
  assert.equal(s.background, true)
  assert.equal(s.turnLabel, 'decision')
  assert.equal(s.attention, null)
})

test('a Jev decision on a stalled turn asks to proceed and always has a go-ahead button', () => {
  const reply = '작업을 셋으로 나눴습니다.\n위 차례대로 곧바로 착수하겠습니다. 2단계 캐시 비우기부터 시작합니다.'
  const { candidates, tail } = jevRequest(reply, 'jev-test')
  const answers = { label: { choice: 'decision' } }
  const none = parseJev({ answers }, candidates, tail)
  assert.equal(none.stalled, true)
  assert.equal(none.question, '진행할까요? “2단계 캐시 비우기부터 시작합니다.”')
  assert.deepEqual(none.options, [{ label: '진행', reply: '진행해 주세요.' }])
  // Buttons Jev finds fitting are kept as they are.
  const yes = candidates.findIndex((c) => c.reply === '네, 진행해 주세요.')
  const picked = parseJev({ answers: { ...answers, [`b${yes}`]: { noul: 0.9 } } }, candidates, tail)
  assert.deepEqual(picked.options, [{ label: '네, 진행', reply: '네, 진행해 주세요.' }])
  // A question the rules read is not a stalled turn.
  const asked = jevRequest('Two layouts are ready.\nWhich one should I go with?', 'jev-test')
  assert.equal(parseJev({ answers }, asked.candidates, asked.tail).stalled, undefined)
})

// The person's board may run a classifier that still reads an announced next step as a report.
test('a stalled turn the model calls "none" is still flagged by the rule, with the go-ahead button', async () => {
  const data = withReplies({ 'sess-idle': '작업을 셋으로 나눴습니다.\n위 차례대로 곧바로 착수하겠습니다. 2단계 캐시 비우기부터 시작합니다.', 'sess-question': 'Why did it fail? The cache was stale; fixed.' })
  const { run } = fakeRun()
  const classes = await readTurnClasses(data, config, { run })
  assert.equal(classes['sess-idle'].label, 'none')
  const s = byId(deriveSessions(applyTurnClasses(data, classes, settings)))
  assert.equal(s['sess-idle'].lane, 'human')
  assert.equal(s['sess-idle'].attention.source, 'rule')
  assert.deepEqual(autoCardFor(s['sess-idle']).options, [{ label: '진행', reply: '진행해 주세요.', send: true }])
  // The model's "none" still overrides the question rules.
  assert.equal(s['sess-question'].attention, null)
})
