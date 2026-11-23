// The worker against a mock host, with fake coord/orca scripts standing in for the CLIs.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as main from './worker'

const fake = (name: string) => fileURLToPath(new URL(`../test/${name}`, import.meta.url))
process.env.COORD_ORCA_BIN = fake('fake-orca.mjs')

function setup(coord = 'fake-coord.mjs') {
  const log = join(mkdtempSync(join(tmpdir(), 'coord-board-')), 'calls.log')
  process.env.FAKE_COORD_LOG = log
  const host = mockHost({
    settings: { coordPath: fake(coord), notify: true, language: 'en' },
    results: { 'statusBar.update': { ok: true }, 'notifications.show': { delivered: true }, 'commands.run': { ran: true } }
  })
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
  return { host, calls }
}

test('snapshot updates the status bar with the decision count', async () => {
  const { host } = setup()
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  const snap = await worker.request('board.snapshot', { fresh: true })
  assert.equal(snap.ok, true)
  if (snap.ok) assert.equal(snap.status.counts.decisions, 3)
  const bar = (host.callsOf('statusBar.update') as { text?: string; tone?: string }[])
  assert.ok(bar.some((p) => p.text === 'Decisions 3' && p.tone === 'warning'))
  // Menu cards are urgent: one desktop notification each, not repeated on the next refresh.
  const first = host.callsOf('notifications.show').length
  assert.ok(first >= 1)
  await worker.request('board.snapshot', { fresh: true })
  assert.equal(host.callsOf('notifications.show').length, first)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('a terminal answer is validated by coord, typed, then recorded', async () => {
  const { host, calls } = setup()
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  await worker.request('board.snapshot', { fresh: true })
  const r = await worker.request('decision.send', { id: 'dec_x', text: 'Go canary, please.', fingerprint: 'fp1' })
  assert.equal(r.ok, true)
  assert.equal(r.key, 'msg.sentStarted')
  assert.match(r.message, /started working/)
  const c = calls()
  const prepare = c.find((a) => a[0] === 'decision' && a[1] === 'prepare')
  assert.ok(prepare && prepare.includes('--fingerprint') && prepare.includes('fp1'))
  const mark = c.find((a) => a[0] === 'decision' && a[1] === 'mark-delivered')
  assert.ok(mark && mark[mark.indexOf('--receipt') + 1].includes('turn_started'))
  await worker.deactivate()
})

test('a chat answer goes by mail and an empty answer is refused', async () => {
  const { host, calls } = setup()
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  await worker.request('board.snapshot', { fresh: true })
  const r = await worker.request('decision.send', { id: 'auto:sess-chat', text: 'Open a PR, please.' })
  assert.equal(r.ok, true)
  const answer = calls().find((a) => a[0] === 'decision' && a[1] === 'answer')
  assert.ok(answer && answer.includes('mail'))
  const empty = await worker.request('decision.send', { id: 'auto:sess-chat', text: '   ' })
  assert.equal(empty.ok, false)
  await worker.deactivate()
})

test('requests, digest and coordinator handoff reach coord', async () => {
  const { host, calls } = setup()
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  assert.equal((await worker.request('request.send', { text: 'Investigate the login bug', project: 'repo-alpha' })).ok, true)
  assert.equal((await worker.request('digest.request')).ok, true)
  assert.equal((await worker.request('decision.coordinate', { id: 'dec_x', text: 'Handle it.' })).ok, true)
  const c = calls()
  assert.ok(c.some((a) => a[0] === 'request' && a.includes('repo-alpha') && a.includes('human')))
  assert.ok(c.some((a) => a[0] === 'digest'))
  assert.ok(c.some((a) => a[0] === 'decision' && a[1] === 'answer' && a.includes('coordinator')))
  await worker.deactivate()
})

test('a coord failure shows on the status bar instead of throwing', async () => {
  const { host } = setup('fake-coord-error.mjs')
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  const snap = await worker.request('board.snapshot', { fresh: true })
  assert.equal(snap.ok, false)
  const bar = (host.callsOf('statusBar.update') as { text?: string; tone?: string }[])
  assert.ok(bar.some((p) => p.text === 'Decisions ?' && p.tone === 'danger'))
  await worker.deactivate()
})

test('the toggle command opens the right sidebar', async () => {
  const { host } = setup()
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  await worker.command('coordinator-board.toggle')
  assert.deepEqual(host.callsOf('commands.run'), [{ action: 'sidebar.right.toggle' }])
  await worker.deactivate()
})

test('a worker ask card is answered through the coordinator, never typed into a terminal', async () => {
  const { host, calls } = setup('fake-coord-ask.mjs')
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  const snap = await worker.request('board.snapshot', { fresh: true })
  const card = snap.ok ? snap.status.decisions.find((d) => d.askMessageId) : null
  assert.ok(card)
  const r = await worker.request('decision.send', { id: card!.id, text: 'Use Apache-2.0.' })
  assert.equal(r.ok, true)
  const c = calls()
  assert.ok(c.some((a) => a[0] === 'decision' && a[1] === 'answer' && a.includes('coordinator')))
  assert.ok(!c.some((a) => a[0] === 'decision' && a[1] === 'prepare'))
  await worker.deactivate()
})

test('the status bar follows the language setting', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'coord-board-')), 'calls.log')
  process.env.FAKE_COORD_LOG = log
  const host = mockHost({
    settings: { coordPath: fake('fake-coord.mjs'), notify: false, language: 'ko' },
    results: { 'statusBar.update': { ok: true }, 'notifications.show': { delivered: true }, 'commands.run': { ran: true } }
  })
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  await worker.request('board.snapshot', { fresh: true })
  const bar = host.callsOf('statusBar.update') as { text?: string }[]
  assert.ok(bar.some((p) => p.text === '내 결정 3'))
  await worker.deactivate()
})
