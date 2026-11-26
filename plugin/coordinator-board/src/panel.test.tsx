// The panel with a mocked worker: what the person sees and what each press asks the worker.
import { assert, mockHost, mount, test } from 'orca/testing'
import { readFileSync } from 'node:fs'
import * as panel from './panel'

const status = JSON.parse(readFileSync(new URL('../test/status.json', import.meta.url), 'utf8'))
const coordinatorCard = status.decisions.find((d: any) => d.source === 'coordinator')

function host(overrides: Record<string, unknown> = {}) {
  const sent: { name: string; input: unknown }[] = []
  const reply = (name: string, value: unknown) => (input: unknown) => {
    sent.push({ name, input })
    return value
  }
  const h = mockHost({
    requests: {
      'board.snapshot': reply('board.snapshot', { ok: true, status, at: 1 }),
      'decision.send': reply('decision.send', { ok: true, key: 'msg.sentStarted', message: 'Typed into the session; it started working.' }),
      'decision.coordinate': reply('decision.coordinate', { ok: true, key: 'msg.coordinated', message: 'Handed to the coordinator.' }),
      'decision.dismiss': reply('decision.dismiss', { ok: true, key: 'msg.dismissed', message: 'Dismissed.' }),
      'session.open': reply('session.open', { ok: true, key: 'msg.opened', message: 'Opened the session.' }),
      'digest.request': reply('digest.request', { ok: true, key: 'msg.digest', message: 'Digest requested.' }),
      'request.send': reply('request.send', { ok: true, key: 'msg.requestSent', message: 'Sent to the coordinator.' }),
      ...overrides
    } as any
  })
  return { h, sent }
}

test('decisions come first, with the coordinator card editable and menus sent to the session', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  const summary = p.summary().join('\n')
  assert.match(summary, /Coordinator Board/)
  assert.match(summary, /Answer in the session/)
  assert.ok(p.find({ text: 'Deploy with blue-green or canary?' }))
  assert.equal(p.valueOf({ testId: `reply:${coordinatorCard.id}` }), coordinatorCard.recommendation)
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.warnings, [])
})

test('an option fills the reply and Send sends it with the card fingerprint', async () => {
  const { h, sent } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.press({ testId: `opt:${coordinatorCard.id}:1` })
  assert.equal(p.valueOf({ testId: `reply:${coordinatorCard.id}` }), 'Switch with blue-green, please.')
  await p.press({ testId: `send:${coordinatorCard.id}` })
  const send = sent.find((s) => s.name === 'decision.send')?.input as { id: string; text: string; fingerprint: string }
  assert.equal(send.text, 'Switch with blue-green, please.')
  assert.equal(send.id, coordinatorCard.id)
  assert.ok(send.fingerprint)
  assert.equal(p.find({ testId: `note:${coordinatorCard.id}` })?.text, 'Typed into the session; it started working.')
})

// Seen live: a released worker's card opened its empty workspace, and Orca opened a new, unrelated tab.
test('Open session shows only for a card whose session is live', async () => {
  const card = status.decisions.find((d: any) => d.target?.sessionId)
  const orphan = { ...card, id: 'dec_orphan', sessionId: 'dispatch:ctx_gone', target: { project: 'p', workspace: 'w', title: 'worker ctx_gone', kind: 'chat', path: '/tmp/w', workspaceSelector: 'path:/tmp/w' } }
  const snapshot = { ok: true, status: { ...status, decisions: [...status.decisions, orphan] }, at: 1 }
  const { h } = host({ 'board.snapshot': () => snapshot })
  const p = await mount(panel, { host: h, locale: 'en-US' })
  assert.ok(p.find({ testId: `open:${card.id}` }))
  assert.equal(p.find({ testId: 'open:dec_orphan' }), null)
})

test('a refused send shows the reason for its code', async () => {
  const { h } = host({ 'decision.send': () => ({ ok: false, code: 'stale', message: 'stale: the session moved on' }) })
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.press({ testId: `send:${coordinatorCard.id}` })
  assert.equal(p.find({ testId: `note:${coordinatorCard.id}` })?.text, 'The session moved on after this card was made. Request a digest.')
})

test('the requests tab sends a request with the chosen project', async () => {
  const { h, sent } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'request')
  await p.type({ label: 'Request' }, 'Find out why login fails')
  await p.select({ type: 'Select' }, 'repo-alpha')
  await p.press({ text: 'Send to coordinator' })
  const req = sent.find((s) => s.name === 'request.send')?.input as { text: string; project: string }
  assert.deepEqual(req, { text: 'Find out why login fails', project: 'repo-alpha' })
  assert.ok(p.find({ text: 'Sent to the coordinator.' }))
})

test('the progress tab lists sessions by project', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'progress')
  assert.ok(p.find({ label: 'alpha' }), p.summary().join(' | '))
  assert.ok(p.find({ label: 'beta' }))
  assert.equal(p.find({ label: 'Follow-up' }), null)
})

// Seen live: a folded project's "Running 1" read like "Idle 1"; the summary now carries the lane styling.
test('a project header shows its lane counts as separate styled words and folds', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'progress')
  assert.ok(p.find({ text: '· Running 1' }), p.summary().join(' | '))
  assert.ok(p.find({ text: 'Needs you 1' }))
  // beta needs attention, so it starts open; folding it hides its rows but keeps the summary.
  assert.ok(p.find({ label: 'beta', type: 'List' }))
  await p.press({ label: 'beta', type: 'IconButton' })
  assert.equal(p.find({ label: 'beta', type: 'List' }), null)
  assert.ok(p.find({ text: '· Running 1' }))
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.warnings, [])
})

test('the header count of running sessions carries the Running styling', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  const el = p.find({ text: `Running ${status.counts.running}` }) as any
  assert.ok(el, p.summary().join(' | '))
  assert.deepEqual({ weight: el.props.weight, tone: el.props.tone }, status.counts.running > 0 ? { weight: 'semibold', tone: 'success' } : { weight: 'regular', tone: undefined })
})

test('the kanban tab shows only the non-empty columns, in board order', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'kanban')
  const columns = p.findAll({ type: 'List' }).map((l) => l.label)
  assert.deepEqual(columns, ['Running', 'To review', 'Needs you', 'Follow-up', 'Idle', 'Done'])
  assert.ok(p.find({ text: /Fix the README typo\?/ }))
  assert.ok(p.find({ text: /Add a Contributing section to the README/ }))
})

test('the project filter narrows every kanban column', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'kanban')
  await p.select({ label: 'Project' }, 'repo-beta')
  const columns = p.findAll({ type: 'List' }).map((l) => l.label)
  assert.deepEqual(columns, ['Running', 'Needs you', 'Idle'])
  assert.equal(p.find({ text: /Fix the README typo/ }), null)
})

test('pressing a kanban card opens its session', async () => {
  const { h, sent } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'kanban')
  await p.press({ testId: 's:sess-working' })
  const open = sent.find((s) => s.name === 'session.open')?.input as { kind: string; handle: string }
  assert.deepEqual({ kind: open.kind, handle: open.handle }, { kind: 'terminal', handle: 'term_w-0004' })
  // Opening is its own answer: no "Opened the session." line stays under the row.
  assert.equal(p.find({ text: 'Opened the session.' }), null)
})

// Asked by the person: a session on a paired Orca server did nothing when pressed.
test('a remote session row says to open it from the sidebar when the board cannot', async () => {
  const remote = { sessionId: 'remote:env-gpu:pane-1', kind: 'chat', agent: 'antigravity', title: 'Fix the fare loader', state: 'working', lane: 'running', updatedAt: 1, workspace: 'svc', handle: null, workspaceSelector: 'id:repo-remote::/home/me/svc', path: '/home/me/svc', environment: 'gpu-box', environmentId: 'env-gpu' }
  const group = { repoId: 'repo-remote', project: 'svc @ gpu-box', counts: { human: 0, running: 1, review: 0, idle: 0, unknown: 0 }, sessions: [remote] }
  const snapshot = { ok: true, status: { ...status, projects: [...status.projects, group] }, at: 1 }
  const { h, sent } = host({
    'board.snapshot': () => snapshot,
    'session.open': (input: unknown) => {
      sent.push({ name: 'session.open', input })
      return { ok: false, code: 'open_remote', message: 'workspace not listed' }
    }
  })
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'progress')
  const row = p.findAll({ type: 'ListItem' }).find((e) => e.key?.endsWith('p:remote:env-gpu:pane-1'))
  assert.ok(row)
  await p.press(row)
  const open = sent.find((s) => s.name === 'session.open')?.input as { environment: string }
  assert.equal(open.environment, 'env-gpu')
  assert.ok(p.find({ text: /Open it from the Orca sidebar/ }))
  assert.deepEqual(p.errors, [])
})

// Asked by the person: follow-up rows for closed sessions could be neither pressed nor removed.
test('a follow-up row opens a live session and can be cleared; a closed session shows it is gone', async () => {
  const live = status.history.find((h: any) => h.type === 'decision.answered')
  const gone = { ...live, at: live.at + 1, sessionId: 'sess-closed-chat', question: 'Run the paid eval?' }
  const snapshot = { ok: true, status: { ...status, history: [gone, ...status.history] }, at: 1 }
  const { h, sent } = host({ 'board.snapshot': () => snapshot })
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'kanban')
  const liveKey = `h:${live.at}:${live.sessionId}`
  const goneKey = `h:${gone.at}:sess-closed-chat`
  await p.press({ testId: `open:${liveKey}` })
  assert.ok(sent.some((s) => s.name === 'session.open'))
  assert.equal(p.find({ testId: `open:${goneKey}` }), null)
  assert.ok(p.find({ text: /session closed/ }))
  await p.press({ testId: `hide:${goneKey}` })
  assert.equal(p.find({ text: 'Run the paid eval?' }), null)
  await p.press({ testId: `hide:${liveKey}` })
  assert.equal(p.find({ label: 'Follow-up', type: 'List' }), null)
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.warnings, [])
})

test('kanban columns follow a Korean UI language', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'ko-KR' })
  await p.select({ label: '보드' }, 'kanban')
  const columns = p.findAll({ type: 'List' }).map((l) => l.label)
  assert.deepEqual(columns, ['진행 중', '확인 대기', '내 결정', '결정 후속', '대기', '완료'])
})

test('a closed coordinator is flagged and can be restarted from Settings', async () => {
  const closedStatus = { ...status, coordinator: { ...status.coordinator, state: 'closed' } }
  const { h, sent } = host({ 'board.snapshot': () => ({ ok: true, status: closedStatus, at: 1 }), 'coordinator.start': () => ({ ok: true, key: 'msg.coordinatorStarted', params: { model: 'claude/claude-opus-5-5' }, message: 'started' }) })
  const p = await mount(panel, { host: h, locale: 'en-US' })
  assert.match(p.summary().join('\n'), /The coordinator chat is closed/)
  assert.equal(p.find({ text: 'Request digest' })?.disabled, true)
  await p.select({ label: 'Board' }, 'settings')
  await p.press({ text: 'Start a new coordinator' })
  void sent
  assert.ok(p.find({ text: 'Coordinator started: claude/claude-opus-5-5' }))
})

test('Settings picks the classifier and takes a Jev key', async () => {
  const offStatus = { ...status, classifier: { enabled: false, provider: 'claude', model: 'claude-haiku-5-5', jevKeySet: false } }
  const { h, sent } = host({
    'board.snapshot': () => ({ ok: true, status: offStatus, at: 1 }),
    'classifier.set': (input: unknown) => (sent.push({ name: 'classifier.set', input }), { ok: true, key: 'msg.classifierOn', message: 'on' }),
    'jev.key.set': (input: unknown) => (sent.push({ name: 'jev.key.set', input }), { ok: true, key: 'msg.jevKeySaved', message: 'saved' })
  })
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'settings')
  assert.equal(p.valueOf({ label: 'Classifier' }), 'off')
  assert.equal(p.find({ label: 'TypeSafe AI API key' }), null, 'no key field while Jev is not chosen')
  await p.select({ label: 'Classifier' }, 'jev')
  assert.deepEqual(sent.filter((s) => s.name === 'classifier.set').map((s) => s.input), [{ provider: 'jev' }])
  assert.ok(p.find({ text: 'Saved: turn classification is on.' }))
})

test('the Jev key field shows once Jev is chosen and clears after saving', async () => {
  const jevStatus = { ...status, classifier: { enabled: true, provider: 'jev', model: 'jev-1.14.0', jevKeySet: false } }
  const { h, sent } = host({
    'board.snapshot': () => ({ ok: true, status: jevStatus, at: 1 }),
    'jev.key.set': (input: unknown) => (sent.push({ name: 'jev.key.set', input }), { ok: true, key: 'msg.jevKeySaved', message: 'saved' })
  })
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'settings')
  assert.ok(p.find({ text: 'No key yet: Jev cannot run until you save one.' }))
  await p.type({ label: 'TypeSafe AI API key' }, 'ts-key')
  await p.press({ text: 'Save key' })
  assert.deepEqual(sent.filter((s) => s.name === 'jev.key.set').map((s) => s.input), [{ key: 'ts-key' }])
  assert.equal(p.valueOf({ label: 'TypeSafe AI API key' }), '')
  assert.ok(p.find({ text: 'Saved the Jev key.' }))
})

test('quick replies from the classifier send at once', async () => {
  const quickCard = { ...coordinatorCard, id: 'auto:sess-quick', source: 'auto', recommendation: '', options: [{ label: 'Push', reply: 'Yes, push it.', send: true }, { label: 'Not yet', reply: "Don't push yet.", send: true }] }
  const quickStatus = { ...status, decisions: [quickCard], counts: { ...status.counts, decisions: 1 } }
  const { h, sent } = host({ 'board.snapshot': () => ({ ok: true, status: quickStatus, at: 1 }) })
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.press({ testId: 'quick:auto:sess-quick:0' })
  const send = sent.filter((s) => s.name === 'decision.send').map((s) => s.input as { id: string; text: string })
  assert.deepEqual(send.map((x) => [x.id, x.text]), [['auto:sess-quick', 'Yes, push it.']])
})

test('a worker failure shows a retry callout', async () => {
  const { h } = host({ 'board.snapshot': () => ({ ok: false, code: 'runtime_timeout', message: 'Orca is busy', at: 1 }) })
  const p = await mount(panel, { host: h, locale: 'en-US' })
  assert.match(p.summary().join('\n'), /Couldn't read the board/)
  assert.ok(p.find({ text: 'Retry' }))
})

test('the panel follows a Korean UI language', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'ko-KR' })
  const summary = p.summary().join('\n')
  assert.match(summary, /코디네이터 보드/)
  assert.match(summary, /세션에서 직접 답해야 합니다/)
  await p.press({ testId: `send:${coordinatorCard.id}` })
  assert.equal(p.find({ testId: `note:${coordinatorCard.id}` })?.text, '세션에 입력했고 작업이 시작됐습니다.')
})

// Asked by the person: "Running" must stand apart from the muted "Idle" in the progress list.
test('the lane word of a running session row has weight and color; idle rows stay plain', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'ko-KR' })
  await p.select({ label: '보드' }, 'progress')
  const running = p.findAll({ type: 'Text', text: '진행 중' })
  assert.ok(running.length > 0)
  for (const r of running) assert.deepEqual({ weight: (r as any).props.weight, tone: (r as any).props.tone }, { weight: 'semibold', tone: 'success' })
  // The rest of the row stays muted, and an idle row keeps its one plain description.
  assert.ok(p.find({ type: 'Text', text: /^· / }))
  assert.equal(p.find({ type: 'Text', text: '대기' }), null)
  assert.deepEqual(p.errors, [])
  assert.deepEqual(p.warnings, [])
})
