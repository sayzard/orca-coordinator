// Final replies are read from transcripts once per turn, most recent sessions first, a few per call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'coord-final-'))
process.env.COORD_HOME = home
process.env.COORD_ORCA_BIN = fileURLToPath(new URL('./fixtures/fake-orca-fenced.mjs', import.meta.url))
const log = join(home, 'calls.log')
process.env.FAKE_LOG = log
const { readFinalReplies, lastAssistantText } = await import('../cli/lib/data.mjs')

const reads = () => {
  try {
    return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((a) => a[0] === 'agent' && a[1] === 'read')
  } catch {
    return []
  }
}
const agent = (id, state, at) => ({ orcaSessionId: id, state, stateStartedAt: at, updatedAt: at })
const ps = (agents) => ({ worktrees: [{ agents }] })

test('the last assistant entry is the final reply', () => {
  assert.equal(lastAssistantText({ entries: [{ role: 'assistant', text: 'a' }, { role: 'user', text: 'u' }, { role: 'assistant', text: 'b' }, { kind: 'tool' }] }), 'b')
  assert.equal(lastAssistantText({ entries: [] }), '')
})

test('finished sessions are read once per turn; working ones are skipped', async () => {
  writeFileSync(log, '')
  const first = await readFinalReplies(ps([agent('a', 'done', 1), agent('b', 'working', 2)]))
  assert.match(first.a.text, /Shall I commit and push it\?$/)
  assert.equal(first.b, undefined)
  await readFinalReplies(ps([agent('a', 'done', 1)]))
  assert.equal(reads().length, 1)
  await readFinalReplies(ps([agent('a', 'done', 5)]))
  assert.equal(reads().length, 2)
})

test('at most eight new reads per call, most recent first; gone sessions are dropped', async () => {
  writeFileSync(log, '')
  const many = Array.from({ length: 10 }, (_, i) => agent(`s${i}`, 'done', 100 + i))
  const cache = await readFinalReplies(ps(many))
  assert.equal(reads().length, 8)
  assert.equal(cache.s0, undefined)
  assert.ok(cache.s9)
  assert.equal(cache.a, undefined)
  await readFinalReplies(ps(many))
  assert.equal(reads().length, 10)
})
