// Several processes (the panel worker, the bot, the coordinator) write the same files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const storeUrl = new URL('../cli/lib/store.mjs', import.meta.url).href

function child(home, n) {
  const code = `
    const { updateJson } = await import(${JSON.stringify(storeUrl)})
    for (let i = 0; i < ${n}; i++) {
      await updateJson('counter.json', { n: 0 }, (c) => ({ n: c.n + 1 }))
    }`
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, COORD_HOME: home }, stdio: 'inherit' })
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child exited ${c}`))))
  })
}

test('concurrent read-modify-write from 4 processes loses no update', async () => {
  const home = mkdtempSync(join(tmpdir(), 'coord-store-'))
  await Promise.all([child(home, 25), child(home, 25), child(home, 25), child(home, 25)])
  const value = JSON.parse(readFileSync(join(home, 'counter.json'), 'utf8'))
  assert.equal(value.n, 100)
})

test('history appends newest first on read', async () => {
  process.env.COORD_HOME = mkdtempSync(join(tmpdir(), 'coord-hist-'))
  const { appendHistory, readHistory } = await import(`${storeUrl}?h`)
  appendHistory({ type: 'a' })
  appendHistory({ type: 'b' })
  assert.deepEqual(readHistory(5).map((h) => h.type), ['b', 'a'])
})

test('files are private to the user', async () => {
  const home = mkdtempSync(join(tmpdir(), 'coord-perm-'))
  process.env.COORD_HOME = home
  const { writeJson } = await import(`${storeUrl}?p`)
  writeJson('x.json', { a: 1 })
  const { statSync } = await import('node:fs')
  assert.equal(statSync(join(home, 'x.json')).mode & 0o777, 0o600)
  void fileURLToPath
})

test('temp files older than a day are pruned on the next write', async () => {
  const home = mkdtempSync(join(tmpdir(), 'coord-tmp-'))
  process.env.COORD_HOME = home
  const { tempFile, pruneTemp } = await import(`${storeUrl}?t`)
  const old = tempFile('request', 'old')
  const { utimesSync, existsSync } = await import('node:fs')
  const twoDaysAgo = (Date.now() - 2 * 86400_000) / 1000
  utimesSync(old, twoDaysAgo, twoDaysAgo)
  const fresh = tempFile('request', 'new')
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(fresh), true)
  assert.equal(pruneTemp(), 0)
})
