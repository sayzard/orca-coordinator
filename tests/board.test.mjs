// The board sends mail as its own terminal; an attested caller (a bot chat) falls back to itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const home = mkdtempSync(join(tmpdir(), 'coord-board-'))
process.env.COORD_HOME = home
process.env.COORD_ORCA_BIN = fileURLToPath(new URL('./fixtures/fake-orca-fenced.mjs', import.meta.url))
const log = join(home, 'calls.log')
process.env.FAKE_LOG = log
const { sendAsBoard } = await import('../cli/lib/board.mjs')
const config = { coordinatorWorkspace: '/work/orca-coordinator' }
const body = join(home, 'body.txt')
writeFileSync(body, 'hi')
const sends = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a[1] === 'send')

test('sends as the board terminal when allowed', async () => {
  process.env.FAKE_FENCED = '0'
  const r = await sendAsBoard(config, { to: 'orca_session_id:c', type: 'dispatch', subject: 's', bodyFile: body })
  assert.equal(r.sender, 'board')
  assert.equal(r.messageId, 'msg_board')
  assert.ok(sends().at(-1).includes('term_board'))
})

test('an attested caller that may not speak for the board sends as itself', async () => {
  process.env.FAKE_FENCED = '1'
  const r = await sendAsBoard(config, { to: 'orca_session_id:c', type: 'dispatch', subject: 's', bodyFile: body })
  assert.equal(r.sender, 'self')
  assert.equal(r.messageId, 'msg_self')
  assert.ok(!sends().at(-1).includes('--from'))
})
