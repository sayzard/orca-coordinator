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

test('Settings picks the classifier through coord setup', async () => {
  const { host, calls } = setup()
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  assert.equal((await worker.request('classifier.set', { provider: 'jev' })).key, 'msg.classifierOn')
  assert.equal((await worker.request('classifier.set', { provider: 'off' })).key, 'msg.classifierOff')
  const setups = calls().filter((a) => a[0] === 'setup' && a.includes('--classifier'))
  assert.deepEqual(setups.map((a) => a[a.indexOf('--classifier') + 1]), ['jev', 'off'])
  await worker.deactivate()
})

test('the Jev key is kept in plugin secrets and reaches coord only as an environment variable', async () => {
  const { host, calls } = setup()
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  const saved = await worker.request('jev.key.set', { key: '  ts-secret-1  ' })
  assert.equal(saved.key, 'msg.jevKeySaved')
  const snap = await worker.request('board.snapshot', { fresh: true })
  assert.equal(snap.ok && snap.status.classifier?.jevKeySet, true)
  const status = calls().filter((a) => a[0] === 'status').pop() || []
  assert.ok(status.includes('env:TYPESAFE_API_KEY=ts-secret-1'))
  assert.ok(!calls().some((a) => a.some((x) => x === 'ts-secret-1')), 'the key is never a command-line argument')
  assert.equal((await worker.request('jev.key.set', { key: '' })).key, 'msg.jevKeyCleared')
  const after = await worker.request('board.snapshot', { fresh: true })
  assert.equal(after.ok && after.status.classifier?.jevKeySet, false)
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

test('auto language follows the board language from coord status', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'coord-board-')), 'calls.log')
  process.env.FAKE_COORD_LOG = log
  process.env.FAKE_COORD_LANGUAGE = 'ko'
  const host = mockHost({
    settings: { coordPath: fake('fake-coord.mjs'), notify: false, language: 'auto' },
    results: { 'statusBar.update': { ok: true }, 'notifications.show': { delivered: true }, 'commands.run': { ran: true } }
  })
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  await worker.request('board.snapshot', { fresh: true })
  const bar = host.callsOf('statusBar.update') as { text?: string }[]
  assert.ok(bar.some((p) => p.text === '내 결정 3'))
  delete process.env.FAKE_COORD_LANGUAGE
  await worker.deactivate()
})

test('a chat in a folder workspace opens through the host API, by its folder path', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'coord-board-')), 'calls.log')
  process.env.FAKE_COORD_LOG = log
  const host = mockHost({
    settings: { coordPath: fake('fake-coord.mjs'), notify: false, language: 'en' },
    results: {
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true },
      'commands.run': { ran: true },
      'workspace.list': { workspaces: [{ id: 'ws-other', kind: 'worktree', name: 'x', path: '/work/x', branch: 'main', hostId: 'local' }, { id: 'ws-bots', kind: 'folder', name: 'Bots', path: '/work/bots', branch: null, hostId: 'local' }], truncated: false },
      'workspace.open': { opened: true }
    }
  })
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  const r = await worker.request('session.open', { kind: 'chat', handle: 'orca_session_id:abc', workspaceSelector: 'folder:abc', path: '/work/bots' })
  assert.equal(r.ok, true)
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'ws-bots' }])
  await worker.deactivate()
})

test('a session on a paired server opens in this window, by its row on that server', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'coord-board-')), 'calls.log')
  process.env.FAKE_COORD_LOG = log
  const host = mockHost({
    settings: { coordPath: fake('fake-coord.mjs'), notify: false, language: 'en' },
    results: {
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true },
      'commands.run': { ran: true },
      'workspace.list': {
        workspaces: [
          { id: 'ws-same-path', kind: 'worktree', name: 'svc', path: '/home/me/svc', branch: 'main', hostId: 'local' },
          { id: 'ws-remote', kind: 'worktree', name: 'svc', path: '/home/me/svc', branch: null, hostId: 'runtime:env-gpu' }
        ],
        truncated: false
      },
      'workspace.open': { opened: true }
    }
  })
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  const input = { kind: 'chat', handle: null, workspaceSelector: 'id:remote-repo::/home/me/svc', path: '/home/me/svc' }
  // Opened in this window, by the row on that server, not the local one with the same path.
  assert.equal((await worker.request('session.open', { ...input, environment: 'env-gpu' })).ok, true)
  assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: 'ws-remote' }])
  // A local session with the same path opens the local row.
  assert.equal((await worker.request('session.open', input)).ok, true)
  assert.deepEqual(host.callsOf('workspace.open').at(-1), { workspaceId: 'ws-same-path' })
  // No row on that server: refused rather than activated on the server out of sight.
  const refused = await worker.request('session.open', { ...input, environment: 'env-other' })
  assert.equal(refused.ok, false)
  assert.equal((refused as { code?: string }).code, 'open_remote')
  await worker.deactivate()
})

// Seen live (Orca 2026-11): workspace.list has no rows for paired servers; the board says to
// open the session from the sidebar instead of switching to an unrelated terminal tab.
test('a remote session with no workspace row gets the sidebar hint', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'coord-board-')), 'calls.log')
  process.env.FAKE_COORD_LOG = log
  const host = mockHost({
    settings: { coordPath: fake('fake-coord.mjs'), notify: false, language: 'en' },
    results: {
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true },
      'commands.run': { ran: true },
      'workspace.list': { workspaces: [{ id: 'ws-ssh', kind: 'worktree', name: 'svc', path: '/home/me/svc', branch: null, hostId: 'ssh:ssh-1' }], truncated: false },
      'workspace.open': { opened: true }
    }
  })
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  const r = await worker.request('session.open', { kind: 'chat', handle: null, workspaceSelector: 'id:remote-repo::/home/me/svc', path: '/home/me/svc', environment: 'env-gpu' })
  assert.equal((r as { code?: string }).code, 'open_remote')
  assert.deepEqual(host.callsOf('workspace.open'), [])
  await worker.deactivate()
})

/** What the Orca host accepts from a handler: plain JSON only. `undefined` (even as an object
 * field), functions, non-finite numbers and class instances make it answer "non-JSON value". */
function assertJsonClean(value: unknown, path = 'result'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') return assert.ok(Number.isFinite(value), `${path} is a non-finite number`)
  if (Array.isArray(value)) return value.forEach((v, i) => assertJsonClean(v, `${path}[${i}]`))
  assert.ok(typeof value === 'object', `${path} is ${typeof value}`)
  const proto = Object.getPrototypeOf(value)
  assert.ok(proto === Object.prototype || proto === null, `${path} is not a plain object`)
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertJsonClean(v, `${path}.${k}`)
}

test('every handler success result is plain JSON the host accepts', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'coord-board-')), 'calls.log')
  process.env.FAKE_COORD_LOG = log
  const host = mockHost({
    settings: { coordPath: fake('fake-coord.mjs'), notify: false, language: 'en' },
    results: {
      'statusBar.update': { ok: true },
      'notifications.show': { delivered: true },
      'commands.run': { ran: true },
      'workspace.list': { workspaces: [{ id: 'ws-bots', kind: 'folder', name: 'Bots', path: '/work/bots', branch: null, hostId: 'local' }], truncated: false },
      'workspace.open': { opened: true }
    }
  })
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  const results: [string, unknown][] = []
  const call = async (name: string, input?: unknown) => {
    const r = await (worker.request as any)(name, input)
    results.push([name, r])
    return r
  }
  await call('board.snapshot', { fresh: true })
  // decision.send: terminal (done), chat mail (result); the ask relay is covered below.
  assert.equal((await call('decision.send', { id: 'dec_x', text: 'Go canary, please.', fingerprint: 'fp1' })).ok, true)
  assert.equal((await call('decision.send', { id: 'auto:sess-chat', text: 'Open a PR, please.' })).ok, true)
  assert.equal((await call('decision.coordinate', { id: 'dec_x', text: 'Handle it.' })).ok, true)
  assert.equal((await call('decision.dismiss', { id: 'dec_x' })).ok, true)
  assert.equal((await call('request.send', { text: 'Investigate the login bug', project: 'repo-alpha' })).ok, true)
  process.env.FAKE_COORD_REQUEST_QUEUED = '1'
  const queued = await call('request.send', { text: 'Later', project: null })
  delete process.env.FAKE_COORD_REQUEST_QUEUED
  assert.equal(queued.key, 'msg.requestQueued')
  assert.equal((await call('digest.request')).ok, true)
  // session.open: terminal switch, host workspace.open by folder path, worktree activate.
  assert.equal((await call('session.open', { kind: 'terminal', handle: 'term_q-0003', workspaceSelector: 'path:/work/x' })).ok, true)
  assert.equal((await call('session.open', { kind: 'chat', handle: 'orca_session_id:abc', workspaceSelector: 'folder:abc', path: '/work/bots' })).ok, true)
  assert.equal((await call('session.open', { kind: 'chat', handle: null, workspaceSelector: 'path:/work/x', path: null })).ok, true)
  const repos = await call('projects.list')
  assert.equal(repos.ok, true)
  // A repo the orca CLI lists without displayName/kind still gets string fields.
  assert.deepEqual(repos.repos.find((r: any) => r.id === 'repo-bare'), { id: 'repo-bare', name: 'repo-bare', kind: '', managed: false })
  assert.equal((await call('projects.set', { ids: ['repo-alpha'] })).ok, true)
  assert.equal((await call('coordinator.start')).ok, true)
  for (const [name, r] of results) {
    assertJsonClean(r, name)
    assert.deepStrictEqual(r, JSON.parse(JSON.stringify(r)), `${name} does not survive a JSON round trip`)
  }
  await worker.deactivate()
})

test('the ask relay success result is plain JSON', async () => {
  const { host } = setup('fake-coord-ask.mjs')
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  const snap = await worker.request('board.snapshot', { fresh: true })
  const card = snap.ok ? snap.status.decisions.find((d) => d.askMessageId) : null
  const r = await worker.request('decision.send', { id: card!.id, text: 'Use Apache-2.0.' })
  assert.equal(r.ok, true)
  assertJsonClean(r, 'decision.send')
  await worker.deactivate()
})

test('a coord error envelope without strings still yields a JSON error result', async () => {
  const { host } = setup('fake-coord-bad-error.mjs')
  const worker = await mountWorker(main, { host, events: ['agent.status.changed', 'workspace.created', 'workspace.removed'], commands: ['coordinator-board.toggle', 'coordinator-board.digest'] })
  const r = await worker.request('decision.dismiss', { id: 'dec_x' })
  assert.equal(r.ok, false)
  assertJsonClean(r, 'decision.dismiss')
  assert.equal(typeof r.code, 'string')
  assert.equal(typeof r.message, 'string')
  const snap = await worker.request('board.snapshot', { fresh: true })
  assertJsonClean(snap, 'board.snapshot')
  await worker.deactivate()
})
