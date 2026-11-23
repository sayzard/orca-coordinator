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

test('progress shows a kanban with only the non-empty columns, in board order', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'progress')
  const columns = p.findAll({ type: 'List' }).map((l) => l.label)
  assert.deepEqual(columns, ['Running', 'To review', 'Needs you', 'Follow-up', 'Idle', 'Done'])
  assert.ok(p.find({ text: /Fix the README typo\?/ }))
  assert.ok(p.find({ text: /Add a Contributing section to the README/ }))
})

test('the project filter narrows every column', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'progress')
  await p.select({ label: 'Project' }, 'repo-beta')
  const columns = p.findAll({ type: 'List' }).map((l) => l.label)
  assert.deepEqual(columns, ['Running', 'Needs you', 'Idle'])
  assert.equal(p.find({ text: /Fix the README typo/ }), null)
})

test('pressing a kanban card opens its session', async () => {
  const { h, sent } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'progress')
  await p.press({ testId: 's:sess-working' })
  const open = sent.find((s) => s.name === 'session.open')?.input as { kind: string; handle: string }
  assert.deepEqual({ kind: open.kind, handle: open.handle }, { kind: 'terminal', handle: 'term_w-0004' })
})

test('the by-project view keeps the per-project list', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'en-US' })
  await p.select({ label: 'Board' }, 'progress')
  await p.select({ label: 'View' }, 'projects')
  assert.ok(p.find({ label: 'alpha' }), p.summary().join(' | '))
  assert.ok(p.find({ label: 'beta' }))
})

test('kanban columns follow a Korean UI language', async () => {
  const { h } = host()
  const p = await mount(panel, { host: h, locale: 'ko-KR' })
  await p.select({ label: '보드' }, 'progress')
  const columns = p.findAll({ type: 'List' }).map((l) => l.label)
  assert.deepEqual(columns, ['진행 중', '확인 대기', '내 결정', '결정 후속', '대기', '완료'])
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
