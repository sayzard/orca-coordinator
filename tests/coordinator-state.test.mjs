// A closed coordinator chat must not swallow requests: mail to it is stored but never read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'coord-state-'))
process.env.COORD_HOME = home
process.env.COORD_ORCA_BIN = fileURLToPath(new URL('./fixtures/fake-orca-fenced.mjs', import.meta.url))
const log = join(home, 'calls.log')
process.env.FAKE_LOG = log
const { coordinatorState, requireCoordinator } = await import('../cli/lib/data.mjs')
const { createRequest, readRequests } = await import('../cli/lib/requests.mjs')
const { answerByMail } = await import('../cli/lib/decisions.mjs')

const base = { coordinatorWorkspace: '/work/orca-coordinator', statusCacheSeconds: 0 }
const open = { ...base, coordinator: { sessionId: 'coord-open' } }
const closed = { ...base, coordinator: { sessionId: 'coord-gone' } }
const sends = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'orchestration' && a[1] === 'send')

test('coordinator state: none, open, closed', async () => {
  assert.equal(await coordinatorState(base), 'none')
  assert.equal(await coordinatorState(open, { fresh: true }), 'open')
  assert.equal(await coordinatorState(closed, { fresh: true }), 'closed')
  await assert.rejects(requireCoordinator(closed), /coordinator_closed/)
  await assert.rejects(requireCoordinator(base), /no_coordinator/)
  await requireCoordinator(open)
})

test('a request to a closed coordinator is queued, not mailed', async () => {
  writeFileSync(log, '')
  const r = await createRequest({ text: 'Fix the login bug', config: closed })
  assert.equal(r.status, 'queued')
  assert.equal(r.code, 'coordinator_closed')
  assert.equal(sends().length, 0)
  const stored = readRequests().requests.find((x) => x.id === r.id)
  assert.match(stored.deliveryError, /closed/)
})

test('a request to an open coordinator is sent', async () => {
  writeFileSync(log, '')
  const r = await createRequest({ text: 'Fix the login bug', config: open })
  assert.equal(r.status, 'sent')
  assert.equal(sends().length, 1)
})

test('handing a decision to a closed coordinator is refused', async () => {
  const card = { id: 'dec_x', status: 'open', sessionId: 's', question: 'q', evidence: null }
  writeFileSync(join(home, 'decisions.json'), JSON.stringify({ version: 1, decisions: [card], suppressed: [] }))
  await assert.rejects(answerByMail({ id: 'dec_x', text: 'do it', via: 'coordinator', sessions: [], config: closed }), /coordinator_closed/)
})
