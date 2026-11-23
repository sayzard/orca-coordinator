// Closing a request releases its workers and stops them showing as "to review".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'coord-req-'))
process.env.COORD_HOME = home
process.env.COORD_ORCA_BIN = fileURLToPath(new URL('./fixtures/fake-orca-fenced.mjs', import.meta.url))
const log = join(home, 'calls.log')
process.env.FAKE_LOG = log
const { updateRequestStatus, closedWorktrees, deepFind } = await import('../cli/lib/requests.mjs')

writeFileSync(join(home, 'requests.json'), JSON.stringify({ version: 1, requests: [
  { id: 'req_a', text: 't', source: 'human', status: 'assigned', assignments: [{ dispatchId: 'ctx_a', worktree: 'repo-alpha::/work/alpha-task' }] },
  { id: 'req_b', text: 't', source: 'bot:triage', status: 'assigned', assignments: [{ dispatchId: 'ctx_b', worktree: 'repo-beta::/work/beta-task' }] }
] }))

test('done releases the worker and marks its workspace read', async () => {
  const r = await updateRequestStatus('req_a', 'done', 'verified')
  assert.equal(r.status, 'done')
  assert.deepEqual(r.released.map((x) => x.dispatchId), ['ctx_a'])
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(calls.some((a) => a[1] === 'worker-release' && a.includes('ctx_a')))
  assert.ok(calls.some((a) => a[0] === 'worktree' && a.includes('id:repo-alpha::/work/alpha-task') && a.includes('--read')))
})

test('only closed requests count as history', () => {
  const closed = closedWorktrees()
  assert.ok(closed.has('repo-alpha::/work/alpha-task'))
  assert.ok(!closed.has('repo-beta::/work/beta-task'))
})

test('deepFind pulls ids out of nested orca results', () => {
  assert.equal(deepFind({ result: { dispatch: { dispatchId: 'ctx_1' } } }, /^dispatchId$/, /^ctx_/), 'ctx_1')
  assert.equal(deepFind({ a: { taskId: 'nope' } }, /^taskId$/, /^task_/), null)
})
