// Small JSON store shared by the coordinator agent, the Orca bot, the plugin worker and the person.
// Writes are atomic (temp file + rename) and serialized with a mkdir lock, because several
// processes write the same files.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync, statSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { coordHome, dataPath } from './paths.mjs'

const LOCK_STALE_MS = 15_000
const LOCK_WAIT_MS = 10_000

export function ensureHome() {
  mkdirSync(coordHome(), { recursive: true, mode: 0o700 })
  mkdirSync(dataPath('cache'), { recursive: true, mode: 0o700 })
  mkdirSync(dataPath('tmp'), { recursive: true, mode: 0o700 })
}

export function readJson(name, fallback) {
  try {
    return JSON.parse(readFileSync(dataPath(name), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(fallback)
    throw new Error(`${name} could not be read: ${error.message}`)
  }
}

export function writeJson(name, value) {
  ensureHome()
  const target = dataPath(name)
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, target)
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Runs fn while holding the store lock. fn may be async. */
export async function withLock(fn) {
  ensureHome()
  const lock = dataPath('.lock')
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true })
      } catch {}
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error('store_locked: another coord process holds the lock')
      sleepSync(50)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

/** Read-modify-write of one JSON file under the lock. mutate returns the value to keep. */
export async function updateJson(name, fallback, mutate) {
  return withLock(async () => {
    const current = readJson(name, fallback)
    const next = await mutate(current)
    writeJson(name, next)
    return next
  })
}

export function appendHistory(event) {
  ensureHome()
  appendFileSync(dataPath('history.jsonl'), JSON.stringify({ at: Date.now(), ...event }) + '\n', { mode: 0o600 })
}

export function readHistory(limit = 50) {
  try {
    const lines = readFileSync(dataPath('history.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-limit).map((line) => JSON.parse(line)).reverse()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
}

const TEMP_MAX_AGE_MS = 24 * 3600_000

/** Removes temp files older than a day; Orca has read them long before. Best effort. */
export function pruneTemp(now = Date.now()) {
  let removed = 0
  try {
    for (const name of readdirSync(dataPath('tmp'))) {
      const path = dataPath(`tmp/${name}`)
      try {
        if (now - statSync(path).mtimeMs > TEMP_MAX_AGE_MS) {
          rmSync(path, { force: true })
          removed++
        }
      } catch {}
    }
  } catch {}
  return removed
}

/** Writes text to a private temp file (for --body-file / --spec-file) and returns its path. */
export function tempFile(prefix, text) {
  ensureHome()
  pruneTemp()
  const path = dataPath(`tmp/${prefix}-${Date.now()}-${randomBytes(3).toString('hex')}.txt`)
  writeFileSync(path, text, { mode: 0o600 })
  return path
}
